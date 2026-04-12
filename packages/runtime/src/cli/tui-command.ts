import path from "node:path";

import { Agent } from "$/agent/index.js";
import { startTui } from "$/channels/tui/TuiApp.js";
import { loadAgents, loadConditions } from "$/config/index.js";
import { runMigrations } from "$/config/migrations/runner.js";
import { initDb } from "$/db/index.js";
import { flushAllSessions, loadSessions } from "$/db/sessions.js";
import colors from "$/output/colors.js";
import { error, config, setLogFile } from "$/output/log.js";
import { root } from "$/util/paths.js";
import { onShutdown, registerSigint } from "$/util/shutdown.js";
import { input, select } from "@inquirer/prompts";
import { buildCommand } from "@stricli/core";

// oxlint-disable-next-line typescript/ban-types, typescript/no-empty-object-type
async function run(_noFlags: {}, agentSlug: string): Promise<void> {
  config.level = "warning";
  setLogFile(path.join(root(), "logs", "cireilclaw.log"));

  await runMigrations();

  registerSigint();
  onShutdown(() => {
    flushAllSessions();
  });

  const slugs = await loadAgents();

  if (!slugs.includes(agentSlug)) {
    error(`Failed to find agent with slug "${colors.keyword(agentSlug)}"`);
    return;
  }

  initDb(agentSlug);
  const conditions = await loadConditions(agentSlug);
  const sessions = await loadSessions(agentSlug);

  const choices: { name: string; value: string }[] = [];

  // Add existing sessions
  for (const session of sessions.values()) {
    const id = session.id();
    const lastActivityStr =
      session.lastActivity > 0 ? new Date(session.lastActivity).toLocaleString() : "never";
    choices.push({
      name: `${colors.keyword(id)} (last active: ${lastActivityStr}, messages: ${session.history.length})`,
      value: id,
    });
  }

  // Add options for new sessions
  choices.push({
    name: colors.keyword("New: TUI session"),
    value: "new:tui",
  });
  choices.push({
    name: colors.keyword("New: Named internal session"),
    value: "new:internal",
  });

  const selectedValue = await select({
    choices,
    message: "Select a session to run:",
  });

  let sessionId = selectedValue;
  if (selectedValue === "new:tui") {
    sessionId = "tui";
  } else if (selectedValue === "new:internal") {
    const name = await input({
      message: "Enter internal session name:",
      validate: (value) => (value.trim().length > 0 ? true : "Name cannot be empty"),
    });
    sessionId = `internal:${name.trim()}`;
  }

  const agent = new Agent(agentSlug, sessions, undefined, conditions);

  await startTui(agent, sessionId);
}

export const tuiCommand = buildCommand({
  docs: {
    brief: "Runs a TUI session with the given agent.",
  },
  func: run,
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "the agent to run",
          parse: String,
          placeholder: "agent",
        },
      ],
    },
  },
});
