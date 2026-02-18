import type { ConfigChangeEvent } from "$/config/index.js";

import { Agent } from "$/agent/index.js";
import { startDiscord } from "$/channels/discord.js";
import { loadAgents, loadEngine, watcher } from "$/config/index.js";
import { initDb } from "$/db/index.js";
import { flushAllSessions, loadSessions } from "$/db/sessions.js";
import { Harness } from "$/harness/index.js";
import color from "$/output/colors.js";
import { config, debug, info } from "$/output/log.js";
import { root } from "$/util/paths.js";
import { onShutdown, registerSigint } from "$/util/shutdown.js";
import { buildCommand } from "@stricli/core";
import path from "node:path";

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
    info("Unknown agent", color.keyword(slug), "- skipping reload");
    return;
  }

  try {
    const cfg = await loadEngine(slug);
    agent.updateEngine(cfg);
    info("Reloaded engine config for", color.keyword(slug));
  } catch (error) {
    info("Failed to reload engine config for", color.keyword(slug), "-", error);
  }
}

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

  // Register after harness is created so the reference is valid at shutdown.
  onShutdown(() => {
    harness.stopSchedulers();
  });

  await startDiscord(harness);
  await harness.startSchedulers(sc.signal);

  for await (const event of harness.watcher) {
    info("Config change", color.keyword(event.eventType), color.path(event.filename ?? ""));
    await handleConfigChange(event, agents);

    const filename = event.filename ?? "";
    if (filename === "heartbeat.toml" || filename === "cron.toml") {
      const slug = extractSlugFromPath(event.basePath);
      if (slug !== undefined) {
        debug("Reloading scheduler for agent", color.keyword(slug));
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
