import { createRequire } from "node:module";

import { select } from "@inquirer/prompts";
import { buildCommand } from "@stricli/core";
import * as vb from "valibot";

import { loadAgents, loadChannel } from "#config/index.js";
import { getDb, initDb } from "#db/index.js";
import { sessions } from "#db/schema.js";
import colors from "#output/colors.js";
import { error as logError, info, warning } from "#output/log.js";
import { fetchSessionDisplayName, repairSession } from "#util/repair-session.js";

// oceanic.js's ESM shim breaks under tsx's module loader (.default.default chain
// resolves to undefined). Force CJS to get the real constructors.
// oxlint-disable-next-line typescript/no-unsafe-type-assertions
const { Client, Intents } = createRequire(import.meta.url)(
  "oceanic.js",
  // oxlint-disable-next-line typescript/consistent-type-imports
) as typeof import("oceanic.js");

// Type alias for the client from the CJS require
type OceanicClient = InstanceType<typeof Client>;

interface DiscordSessionRow {
  channelId: string;
  guildId?: string;
  id: string;
}

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

async function run(): Promise<void> {
  const slugs = await loadAgents();

  if (slugs.length === 0) {
    warning("No agents found.");
    return;
  }

  // Select agent
  const agentSlug = await select({
    choices: slugs.map((slug) => ({ name: slug, value: slug })),
    message: "Which agent?",
  });

  // Load Discord config
  let token: string | undefined = undefined;
  try {
    const { token: configToken } = await loadChannel("discord", agentSlug);
    token = configToken;
  } catch {
    logError("Failed to load Discord config for agent", agentSlug);
    return;
  }

  // Create Discord client and connect
  const client = createDiscordClient(token);

  // Initialize DB for this agent
  initDb(agentSlug);

  // Get Discord sessions from DB
  const db = getDb(agentSlug);
  const rows = db.select().from(sessions).all();
  const MetaSchema = vb.object({
    channelId: vb.string(),
    guildId: vb.exactOptional(vb.string(), undefined),
  });

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

  if (discordSessions.length === 0) {
    info("No Discord sessions found for agent", colors.keyword(agentSlug));
    return;
  }

  // Connect to Discord
  info("Connecting to Discord...");
  await client.connect();

  // Wait for ready
  await new Promise<void>((resolve) => {
    client.once("ready", () => {
      resolve();
    });
  });

  // Fetch display names for all sessions
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

  // Select session to repair
  const sessionId = await select({
    choices: sessionChoices,
    message: "Which session to repair?",
  });

  // Repair the session
  info("Repairing session", colors.keyword(sessionId), "...");
  const result = await repairSession(agentSlug, sessionId, client);

  info(
    "Repair complete:",
    colors.keyword(result.updated.toString()),
    "updated,",
    colors.keyword(result.failed.toString()),
    "failed,",
    colors.keyword(result.skipped.toString()),
    "skipped",
  );

  // Disconnect
  client.disconnect(false);
}

export const repairCommand = buildCommand({
  docs: {
    brief: "Repair media attachments by re-fetching from Discord",
  },
  func: run,
  parameters: {},
});
