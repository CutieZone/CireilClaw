import { loadAgents } from "$/config/index.js";
import { initDb } from "$/db/index.js";
import { deleteSession, loadSessions } from "$/db/sessions.js";
import colors from "$/output/colors.js";
import { info, warning } from "$/output/log.js";
import { confirm, select } from "@inquirer/prompts";
import { buildCommand } from "@stricli/core";

interface Flags {
  agent?: string;
}

async function run(flags: Flags): Promise<void> {
  const slugs = await loadAgents();

  if (slugs.length === 0) {
    warning("No agents found.");
    return;
  }

  let agentSlug: string | undefined = undefined;

  if (flags.agent !== undefined) {
    if (!slugs.includes(flags.agent)) {
      warning("Unknown agent", colors.keyword(flags.agent));
      return;
    }
    agentSlug = flags.agent;
  } else if (slugs.length === 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion
    agentSlug = slugs[0]!;
  } else {
    agentSlug = await select({
      choices: slugs.map((sl) => ({ name: sl, value: sl })),
      message: "Which agent?",
    });
  }

  initDb(agentSlug);
  const sessions = loadSessions(agentSlug);

  if (sessions.size === 0) {
    info("No sessions for", colors.keyword(agentSlug));
    return;
  }

  const sessionId = await select({
    choices: [
      ...sessions.keys().map((id) => ({ name: id, value: id })),
      { name: "(clear all)", value: "__all__" },
    ],
    message: "Which session to clear?",
  });

  const targets = sessionId === "__all__" ? [...sessions.keys()] : [sessionId];

  const confirmed = await confirm({
    default: false,
    message:
      targets.length === 1
        ? `Clear session ${targets[0]}?`
        : `Clear all ${targets.length} sessions for ${agentSlug}?`,
  });

  if (!confirmed) {
    return;
  }

  for (const id of targets) {
    deleteSession(agentSlug, id);
    info("Cleared", colors.keyword(id));
  }
}

export const clearCommand = buildCommand({
  docs: {
    brief: "Clear one or all sessions for an agent",
  },
  func: run,
  parameters: {
    flags: {
      agent: {
        brief: "Agent slug to clear sessions for",
        kind: "parsed",
        optional: true,
        parse: String,
      },
    },
  },
});
