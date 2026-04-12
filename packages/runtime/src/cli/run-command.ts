import { watch } from "node:fs/promises";
import path, { join } from "node:path";

import { Agent } from "$/agent/index.js";
import { startDiscord } from "$/channels/discord.js";
import { loadAgents, loadConditions } from "$/config/index.js";
import { runMigrations } from "$/config/migrations/runner.js";
import { initDb } from "$/db/index.js";
import { flushAllSessions, loadSessions } from "$/db/sessions.js";
import { Harness } from "$/harness/index.js";
import colors from "$/output/colors.js";
import { config, debug, info, setLogFile, warning } from "$/output/log.js";
import { initializePlugins } from "$/plugin/loader.js";
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

interface ConfigChangeEvent {
  filename?: string;
  basePath: string;
}

async function handleConfigChange(event: ConfigChangeEvent): Promise<void> {
  const { agents } = Harness.get();

  // Handle both "change" and "rename" events (some editors use atomic renames)
  const filename = event.filename ?? "";
  if (filename === "conditions.toml") {
    const slug = extractSlugFromPath(event.basePath);
    if (slug === undefined) {
      info("Global conditions.toml changed - restart required to apply");
      return;
    }

    const agent = agents.get(slug);
    if (agent === undefined) {
      info("Unknown agent", colors.keyword(slug), "- skipping reload");
      return;
    }

    try {
      await agent.updateConditions();
      info("Reloaded conditions config for", colors.keyword(slug));
    } catch (error) {
      info("Failed to reload conditions config for", colors.keyword(slug), "-", error);
    }
  } else if (filename === "sandbox.toml") {
    info("sandbox.toml changed - mounts will be picked up on next turn");
  }
}

interface Flags {
  logLevel: "error" | "warning" | "info" | "debug";
}

async function runWatcher(agentSlug: string, signal: AbortSignal): Promise<void> {
  const agentDir = join(root(), "agents", agentSlug, "config");
  const watcher = watch(agentDir, {
    encoding: "utf8",
    recursive: true,
    signal: signal,
  });

  for await (const event of watcher) {
    info("Config change", colors.keyword(event.eventType), colors.path(event.filename ?? ""));
    const evt = {
      basePath: agentDir,
      filename: event.filename ?? undefined,
    };
    await handleConfigChange(evt);

    const filename = event.filename ?? "";
    if (filename === "heartbeat.toml" || filename === "cron.toml") {
      const slug = extractSlugFromPath(evt.basePath);
      if (slug !== undefined) {
        debug("Reloading scheduler for agent", colors.keyword(slug));
        await Harness.get().reloadScheduler(slug);
      }
    }
  }
}

async function run(flags: Flags): Promise<void> {
  config.level = flags.logLevel;
  setLogFile(path.join(root(), "logs", "cireilclaw.log"));

  info("Initializing", colors.keyword("cireilclaw"));

  // RUN MIGRATIONS FIRST - before any config loading
  await runMigrations();

  // LOAD PLUGINS - before agents start
  await initializePlugins();

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
    const conditions = await loadConditions(slug);
    const sessions = await loadSessions(slug);
    agents.set(slug, new Agent(slug, sessions, sc.signal, conditions));

    // oxlint-disable-next-line promise/prefer-await-to-then
    runWatcher(slug, sc.signal).catch((error: unknown) => {
      warning("Failed to watch changes", error);
    });

    info("Loaded agent", colors.keyword(slug));
  }

  const harness = Harness.init(agents);

  // Register after harness is created so the reference is valid at shutdown.
  onShutdown(() => {
    harness.stopSchedulers();
  });

  for (const slug of agents.keys()) {
    await startDiscord(harness, slug);
  }
  await harness.startSchedulers();

  info("Running with", colors.number(agents.size), "agents");
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
