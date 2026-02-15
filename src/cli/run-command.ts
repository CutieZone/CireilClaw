import { Agent } from "$/agent/index.js";
import { startDiscord } from "$/channels/discord.js";
import { loadAgents, loadEngine, watcher } from "$/config/index.js";
import { initDb } from "$/db/index.js";
import { flushAllSessions, loadSessions } from "$/db/sessions.js";
import { Harness } from "$/harness/index.js";
import color from "$/output/colors.js";
import { config, info } from "$/output/log.js";
import { onShutdown, registerSigint } from "$/util/shutdown.js";
import { buildCommand } from "@stricli/core";

interface Flags {
  logLevel: "error" | "warning" | "info" | "debug";
}

async function run(flags: Flags): Promise<void> {
  config.level = flags.logLevel;

  info("Initializing", color.keyword("cireilclaw"));

  initDb();

  const sc = new AbortController();

  registerSigint();
  onShutdown(() => {
    info("Shutting down...");
    flushAllSessions();
    sc.abort("SIGINT");
  });

  const slugs = await loadAgents();
  const agents = new Map<string, Agent>();

  for (const slug of slugs) {
    const cfg = await loadEngine(slug);
    const sessions = loadSessions(slug);
    agents.set(slug, new Agent(slug, cfg, sessions));
    info("Loaded agent", color.keyword(slug));
  }

  const watchers = await watcher(sc.signal);
  const harness = Harness.init(agents, watchers);

  await startDiscord(harness);

  for await (const message of harness.watcher) {
    info("Config change", color.keyword(message.eventType), color.path(message.filename ?? ""));
  }
}

export const runCommand = buildCommand({
  docs: {
    brief: "Start the agent harness",
  },
  func: run,
  parameters: {
    flags: {
      logLevel: {
        brief: "Which log level to use",
        default: "debug",
        kind: "enum",
        values: ["error", "warning", "info", "debug"],
      },
    },
  },
});
