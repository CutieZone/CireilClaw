import { createRequire } from "node:module";

import { select } from "@inquirer/prompts";
import { buildCommand } from "@stricli/core";
import * as vb from "valibot";

import { loadAgents, loadChannel } from "#config/index.js";
import { getDb, initDb } from "#db/index.js";
import { sessions } from "#db/schema.js";
import colors from "#output/colors.js";
import { error as logError, info, warning } from "#output/log.js";
import type { RepairResult } from "#util/repair-session.js";
import { fetchSessionDisplayName, repairSession } from "#util/repair-session.js";

// oceanic.js's ESM shim breaks under tsx's module loader (.default.default chain
// resolves to undefined). Force CJS to get the real constructors.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const { Client, Intents } = createRequire(import.meta.url)(
  "oceanic.js",
  // oxlint-disable-next-line typescript/consistent-type-imports
) as typeof import("oceanic.js");

type OceanicClient = InstanceType<typeof Client>;

interface DiscordSessionRow {
  channelId: string;
  guildId?: string;
  id: string;
}

interface Flags {
  agent?: string;
  all: boolean;
}

const MetaSchema = vb.object({
  channelId: vb.string(),
  guildId: vb.exactOptional(vb.string(), undefined),
});

// Create REST-only Discord client (no gateway connection needed for fetching messages)
function createDiscordClient(token: string): OceanicClient {
  return new Client({
    auth: `Bot ${token}`,
    gateway: {
      intents: Intents.GUILD_MESSAGES | Intents.DIRECT_MESSAGES,
    },
    rest: {},
  });
}

function queryDiscordSessions(agentSlug: string): DiscordSessionRow[] {
  const db = getDb(agentSlug);
  const rows = db.select().from(sessions).all();

  const discordSessions: DiscordSessionRow[] = [];
  for (const row of rows) {
    if (row.channel !== "discord") {
      continue;
    }

    const meta = vb.parse(MetaSchema, JSON.parse(row.meta));
    discordSessions.push({
      channelId: meta.channelId,
      guildId: meta.guildId,
      id: row.id,
    });
  }

  return discordSessions;
}

async function repairAgentAllDiscordSessions(
  agentSlug: string,
  client: OceanicClient,
): Promise<RepairResult> {
  const discordSessions = queryDiscordSessions(agentSlug);

  if (discordSessions.length === 0) {
    info("No Discord sessions found for agent", colors.keyword(agentSlug));
    return { failed: 0, reordered: 0, skipped: 0, updated: 0 };
  }

  let total: RepairResult = { failed: 0, reordered: 0, skipped: 0, updated: 0 };

  for (const session of discordSessions) {
    info("Repairing session", colors.keyword(session.id), "...");
    const result = await repairSession(agentSlug, session.id, client);
    total = {
      failed: total.failed + result.failed,
      reordered: total.reordered + result.reordered,
      skipped: total.skipped + result.skipped,
      updated: total.updated + result.updated,
    };
  }

  return total;
}

async function interactiveRepair(): Promise<void> {
  const slugs = await loadAgents();

  if (slugs.length === 0) {
    warning("No agents found.");
    return;
  }

  const agentSlug = await select({
    choices: slugs.map((slug) => ({ name: slug, value: slug })),
    message: "Which agent?",
  });

  let token: string | undefined = undefined;
  try {
    const { token: configToken } = await loadChannel("discord", agentSlug);
    token = configToken;
  } catch {
    logError("Failed to load Discord config for agent", agentSlug);
    return;
  }

  const client = createDiscordClient(token);

  initDb(agentSlug);

  const discordSessions = queryDiscordSessions(agentSlug);

  if (discordSessions.length === 0) {
    info("No Discord sessions found for agent", colors.keyword(agentSlug));
    return;
  }

  info("Connecting to Discord...");
  await client.connect();

  await new Promise<void>((resolve) => {
    client.once("ready", () => {
      resolve();
    });
  });

  info("Fetching session info...");
  const sessionChoices: { name: string; value: string }[] = [];

  for (const session of discordSessions) {
    const { channelName, guildName } = await fetchSessionDisplayName(
      client,
      session.channelId,
      session.guildId,
    );

    const displayName = guildName === "" ? channelName : `${channelName} (${guildName})`;
    sessionChoices.push({
      name: `${displayName} [${session.id}]`,
      value: session.id,
    });
  }

  const sessionId = await select({
    choices: sessionChoices,
    message: "Which session to repair?",
  });

  info("Repairing session", colors.keyword(sessionId), "...");
  const result = await repairSession(agentSlug, sessionId, client);

  info(
    "Repair complete:",
    colors.keyword(result.reordered.toString()),
    "reordered,",
    colors.keyword(result.updated.toString()),
    "updated,",
    colors.keyword(result.failed.toString()),
    "failed,",
    colors.keyword(result.skipped.toString()),
    "skipped",
  );

  client.disconnect(false);
}

async function run(flags: Flags): Promise<void> {
  // Interactive path: neither --agent nor --all specified
  if (flags.agent === undefined && !flags.all) {
    await interactiveRepair();
    return;
  }

  // Non-interactive path: --agent and/or --all
  const slugs = await loadAgents();

  if (slugs.length === 0) {
    warning("No agents found.");
    return;
  }

  const targetAgents = flags.agent === undefined ? slugs : [flags.agent];

  let grandTotal: RepairResult = { failed: 0, reordered: 0, skipped: 0, updated: 0 };

  for (const agentSlug of targetAgents) {
    if (!slugs.includes(agentSlug)) {
      warning("Unknown agent", colors.keyword(agentSlug), "— skipping");
      continue;
    }

    let token: string | undefined = undefined;
    try {
      const { token: configToken } = await loadChannel("discord", agentSlug);
      token = configToken;
    } catch {
      warning("No Discord config for agent", colors.keyword(agentSlug), "— skipping");
      continue;
    }

    const client = createDiscordClient(token);

    initDb(agentSlug);

    info("Connecting to Discord for agent", colors.keyword(agentSlug), "...");
    await client.connect();
    await new Promise<void>((resolve) => {
      client.once("ready", () => {
        resolve();
      });
    });

    const result = await repairAgentAllDiscordSessions(agentSlug, client);

    info(
      "Agent",
      colors.keyword(agentSlug),
      "repair complete:",
      colors.keyword(result.reordered.toString()),
      "reordered,",
      colors.keyword(result.updated.toString()),
      "updated,",
      colors.keyword(result.failed.toString()),
      "failed,",
      colors.keyword(result.skipped.toString()),
      "skipped",
    );

    grandTotal = {
      failed: grandTotal.failed + result.failed,
      reordered: grandTotal.reordered + result.reordered,
      skipped: grandTotal.skipped + result.skipped,
      updated: grandTotal.updated + result.updated,
    };

    client.disconnect(false);
  }

  if (targetAgents.length > 1) {
    info(
      "Grand total:",
      colors.keyword(grandTotal.reordered.toString()),
      "reordered,",
      colors.keyword(grandTotal.updated.toString()),
      "updated,",
      colors.keyword(grandTotal.failed.toString()),
      "failed,",
      colors.keyword(grandTotal.skipped.toString()),
      "skipped",
    );
  }
}

export const repairCommand = buildCommand({
  docs: {
    brief: "Repair a session: re-fetch media attachments from Discord and sort history",
  },
  func: run,
  parameters: {
    flags: {
      agent: {
        brief: "Repair all Discord sessions for the given agent (non-interactive)",
        kind: "parsed",
        optional: true,
        parse: String,
      },
      all: {
        brief: "Repair all Discord sessions across all agents (non-interactive)",
        default: false,
        kind: "boolean",
      },
    },
  },
});
