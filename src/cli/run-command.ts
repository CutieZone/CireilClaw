import path from "node:path";

import { Agent } from "$/agent/index.js";
import { startDiscord } from "$/channels/discord.js";
import { loadAgents, loadEngine, watcher } from "$/config/index.js";
import type { ConfigChangeEvent } from "$/config/schemas.js";
import { initDb } from "$/db/index.js";
import { flushAllSessions, loadSessions } from "$/db/sessions.js";
import { Harness } from "$/harness/index.js";
import colors from "$/output/colors.js";
import { config, debug, info, setLogFile } from "$/output/log.js";
import { root } from "$/util/paths.js";
import { onShutdown, registerSigint } from "$/util/shutdown.js";
import { buildCommand } from "@stricli/core";

// Extracts agent slug from a config directory path
// e.g., "/home/user/.cireilclaw/agents/mybot/config" -> "mybot"
// Returns undefined for global config path
function extractSlugFromPath(configPath: string): string | undefined {
  const agentsDir = path.join(root(), "agents");
  if (!configPath.startsWith(agentsDir)) {
    return undefined;
  }

  const relative = path.relative(agentsDir, configPath);
  const parts = relative.split(path.sep);
  return parts[0];
}

async function handleConfigChange(
  event: ConfigChangeEvent,
  agents: Map<string, Agent>,
): Promise<void> {
  // Handle both "change" and "rename" events (some editors use atomic renames)
  if (event.filename !== "engine.toml") {
    return;
  }

  const slug = extractSlugFromPath(event.basePath);
  if (slug === undefined) {
    // Global config changed - would need to reload all agents
    // For now, skip as agent-specific config overrides global
    info("Global engine.toml changed - restart required to apply");
    return;
  }

  const agent = agents.get(slug);
  if (agent === undefined) {
    info("Unknown agent", colors.keyword(slug), "- skipping reload");
    return;
  }

  try {
    const cfg = await loadEngine(slug);
    agent.updateEngine(cfg);
    info("Reloaded engine config for", colors.keyword(slug));
  } catch (error) {
    info("Failed to reload engine config for", colors.keyword(slug), "-", error);
  }
}

interface Flags {
  logLevel: "error" | "warning" | "info" | "debug";
}

async function run(flags: Flags): Promise<void> {
  config.level = flags.logLevel;
  setLogFile(path.join(root(), "logs", "cireilclaw.log"));

  info("Initializing", colors.keyword("cireilclaw"));

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
    initDb(slug);
    const cfg = await loadEngine(slug);
    const sessions = loadSessions(slug);
    agents.set(slug, new Agent(slug, cfg, sessions));
    info("Loaded agent", colors.keyword(slug));
  }

  const watchers = await watcher(sc.signal);
  const harness = Harness.init(agents, watchers);

  // Register after harness is created so the reference is valid at shutdown.
  onShutdown(() => {
    harness.stopSchedulers();
  });

  for (const slug of agents.keys()) {
    await startDiscord(harness, slug);
  }
  await harness.startSchedulers(sc.signal);

  info("Running with", colors.number(agents.size), "agents");

  for await (const event of harness.watcher) {
    info("Config change", colors.keyword(event.eventType), colors.path(event.filename ?? ""));
    await handleConfigChange(event, agents);

    const filename = event.filename ?? "";
    if (filename === "heartbeat.toml" || filename === "cron.toml") {
      const slug = extractSlugFromPath(event.basePath);
      if (slug !== undefined) {
        debug("Reloading scheduler for agent", colors.keyword(slug));
        await harness.reloadScheduler(slug);
      }
    }
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
