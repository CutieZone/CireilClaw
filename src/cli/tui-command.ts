import path from "node:path";

import { Agent } from "$/agent/index.js";
import { startTui } from "$/channels/tui/TuiApp.js";
import { loadAgents, loadConditions, loadEngine } from "$/config/index.js";
import { runMigrations } from "$/config/migrations/runner.js";
import { initDb } from "$/db/index.js";
import { flushAllSessions, loadSessions } from "$/db/sessions.js";
import colors from "$/output/colors.js";
import { config, error, setLogFile } from "$/output/log.js";
import { root } from "$/util/paths.js";
import { onShutdown, registerSigint } from "$/util/shutdown.js";
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
  const cfg = await loadEngine(agentSlug);
  const conditions = await loadConditions(agentSlug);
  const sessions = loadSessions(agentSlug);
  const agent = new Agent(agentSlug, cfg, sessions, conditions);

  await startTui(agent);
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
