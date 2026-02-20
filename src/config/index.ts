import { existsSync } from "node:fs";
import { readdir, readFile, watch } from "node:fs/promises";
import { join } from "node:path";

import type { CronConfig } from "$/config/cron.js";
import { CronConfigSchema } from "$/config/cron.js";
import type { HeartbeatConfig } from "$/config/heartbeat.js";
import { HeartbeatConfigSchema } from "$/config/heartbeat.js";
import type {
  ChannelConfigMap,
  ConfigChangeEvent,
  EngineConfig,
  IntegrationsConfig,
  ToolsConfig,
  Watchers,
} from "$/config/schemas.js";
import {
  DiscordSchema,
  EngineConfigSchema,
  IntegrationsConfigSchema,
  ToolsConfigSchema,
} from "$/config/schemas.js";
import type { ChannelType } from "$/harness/session.js";
import colors from "$/output/colors.js";
import { root } from "$/util/paths.js";
import merge from "fast-merge-async-iterators";
import type { TomlTable } from "smol-toml";
import { parse } from "smol-toml";
import * as vb from "valibot";

async function loadTools(agentSlug: string): Promise<ToolsConfig> {
  const file = join(root(), "agents", agentSlug, "config", "tools.toml");

  if (existsSync(file)) {
    const data = await readFile(file, { encoding: "utf8" });
    const obj = parse(data);

    return vb.parse(ToolsConfigSchema, obj);
  }

  throw new Error(`Tools config at path ${colors.path(file)} does not exist.`);
}

/**
 * Load and parses the appropriate engine config.
 * @param agentSlug Optional slug to specify the agent for which to load the engine config for
 */
async function loadEngine(agentSlug?: string): Promise<EngineConfig> {
  let obj: TomlTable | undefined = undefined;
  if (agentSlug === undefined) {
    const file = join(root(), "config", "engine.toml");

    if (existsSync(file)) {
      const data = await readFile(file, { encoding: "utf8" });

      obj = parse(data);
    } else {
      throw new Error(`Could not find config file at path: ${colors.path(file)}`);
    }
  } else {
    const file = join(root(), "agents", agentSlug, "config", "engine.toml");

    if (existsSync(file)) {
      const data = await readFile(file, { encoding: "utf8" });

      obj = parse(data);
    } else {
      throw new Error(`Could not find config file at path: ${colors.path(file)}`);
    }
  }

  const cfg = vb.parse(EngineConfigSchema, obj);

  return cfg;
}

async function loadIntegrations(): Promise<IntegrationsConfig> {
  const file = join(root(), "config", "integrations.toml");

  if (!existsSync(file)) {
    return {};
  }

  const data = await readFile(file, { encoding: "utf8" });
  const obj = parse(data);

  return vb.parse(IntegrationsConfigSchema, obj);
}

async function loadChannel<Key extends ChannelType>(
  channel: Key,
  agentSlug: string,
): Promise<ChannelConfigMap[Key]> {
  const origin = root();
  let path: string | undefined = undefined;
  let schema: vb.GenericSchema | undefined = undefined;

  // oxlint-disable-next-line typescript/switch-exhaustiveness-check
  switch (channel) {
    case "discord":
      schema = DiscordSchema;
      break;

    default:
      throw new Error(`Channel ${channel} is unimplemented.`);
  }

  const maybe = join(origin, "agents", agentSlug, "config", "channels", `${channel}.toml`);
  if (existsSync(maybe)) {
    path = maybe;
  } else {
    throw new Error(`No channel config found for ${channel}.`);
  }

  const tomlData = await readFile(path, "utf8");
  const obj = parse(tomlData);

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return vb.parse(schema, obj) as ChannelConfigMap[Key];
}

// Tags events from a watcher with the base path being watched
async function* tagWatcher(
  toTag: AsyncIterableIterator<{ eventType: "change" | "rename"; filename: string | null }>,
  basePath: string,
): AsyncGenerator<ConfigChangeEvent> {
  for await (const event of toTag) {
    yield { ...event, basePath };
  }
}

async function watcher(signal: AbortSignal): Promise<Watchers> {
  const globalConfigDir = join(root(), "config");
  const globalConfigWatcher = watch(globalConfigDir, {
    encoding: "utf8",
    recursive: true,
    signal: signal,
  });

  if (!existsSync(join(root(), "agents"))) {
    return tagWatcher(globalConfigWatcher, globalConfigDir);
  }

  const agentsFiles = await readdir(join(root(), "agents"), {
    encoding: "utf8",
    withFileTypes: true,
  });

  const taggedWatchers = [
    tagWatcher(globalConfigWatcher, globalConfigDir),
    ...agentsFiles
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(entry.parentPath, entry.name, "config"))
      .filter((configPath) => existsSync(configPath))
      .map((configPath) =>
        tagWatcher(
          watch(configPath, {
            encoding: "utf8",
            recursive: true,
            signal: signal,
          }),
          configPath,
        ),
      ),
  ];

  return merge.default("iters-close-wait", ...taggedWatchers);
}

async function loadHeartbeat(agentSlug: string): Promise<HeartbeatConfig> {
  const file = join(root(), "agents", agentSlug, "config", "heartbeat.toml");

  if (!existsSync(file)) {
    return vb.parse(HeartbeatConfigSchema, {});
  }

  const data = await readFile(file, { encoding: "utf8" });
  const obj = parse(data);

  return vb.parse(HeartbeatConfigSchema, obj);
}

async function loadCron(agentSlug: string): Promise<CronConfig> {
  const file = join(root(), "agents", agentSlug, "config", "cron.toml");

  if (!existsSync(file)) {
    return vb.parse(CronConfigSchema, {});
  }

  const data = await readFile(file, { encoding: "utf8" });
  const obj = parse(data);

  return vb.parse(CronConfigSchema, obj);
}

async function loadAgents(): Promise<string[]> {
  const agentsDir = join(root(), "agents");

  if (!existsSync(agentsDir)) {
    return [];
  }

  const entries = await readdir(agentsDir, { encoding: "utf8", withFileTypes: true });
  return entries.filter((it) => it.isDirectory()).map((it) => it.name);
}

export {
  loadAgents,
  loadChannel,
  loadCron,
  loadEngine,
  loadHeartbeat,
  loadIntegrations,
  loadTools,
  watcher,
};
