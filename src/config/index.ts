import type { CronConfig } from "$/config/cron.js";
import type { HeartbeatConfig } from "$/config/heartbeat.js";
import type { ChannelType } from "$/harness/session.js";
import type { TomlTable } from "smol-toml";

import { CronConfigSchema } from "$/config/cron.js";
import { HeartbeatConfigSchema } from "$/config/heartbeat.js";
import colors from "$/output/colors.js";
import { root } from "$/util/paths.js";
import merge from "fast-merge-async-iterators";
import { existsSync } from "node:fs";
import { readdir, readFile, watch } from "node:fs/promises";
import path, { join } from "node:path";
import { parse } from "smol-toml";
import * as vb from "valibot";

const EngineConfigSchema = vb.strictObject({
  apiBase: vb.pipe(vb.string(), vb.nonEmpty(), vb.url()),
  apiKey: vb.exactOptional(vb.pipe(vb.string(), vb.nonEmpty()), "not-needed"),
  model: vb.pipe(vb.string(), vb.nonEmpty()),
});

type EngineConfig = vb.InferOutput<typeof EngineConfigSchema>;

const ExecToolConfigSchema = vb.strictObject({
  binaries: vb.array(vb.pipe(vb.string(), vb.nonEmpty())),
  enabled: vb.exactOptional(vb.boolean(), true),
  timeout: vb.exactOptional(vb.pipe(vb.number(), vb.integer(), vb.minValue(1000)), 60_000),
});

type ExecToolConfig = vb.InferOutput<typeof ExecToolConfigSchema>;

const ToolConfigSchema = vb.union([vb.boolean(), ExecToolConfigSchema]);

type ToolConfig = vb.InferOutput<typeof ToolConfigSchema>;

const ToolsConfigSchema = vb.record(
  vb.pipe(vb.string(), vb.nonEmpty()),
  vb.exactOptional(ToolConfigSchema, true),
);

type ToolsConfig = vb.InferOutput<typeof ToolsConfigSchema>;

async function loadTools(agentSlug: string): Promise<ToolsConfig> {
  const file = path.join(root(), "agents", agentSlug, "config", "tools.toml");

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
    const file = path.join(root(), "config", "engine.toml");

    if (existsSync(file)) {
      const data = await readFile(file, { encoding: "utf8" });

      obj = parse(data);
    } else {
      throw new Error(`Could not find config file at path: ${colors.path(file)}`);
    }
  } else {
    const file = path.join(root(), "agents", agentSlug, "config", "engine.toml");

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

const IntegrationsConfigSchema = vb.strictObject({
  brave: vb.exactOptional(
    vb.strictObject({
      apiKey: vb.pipe(vb.string(), vb.nonEmpty()),
    }),
  ),
});
type IntegrationsConfig = vb.InferOutput<typeof IntegrationsConfigSchema>;

async function loadIntegrations(): Promise<IntegrationsConfig> {
  const file = path.join(root(), "config", "integrations.toml");

  if (!existsSync(file)) {
    return {};
  }

  const data = await readFile(file, { encoding: "utf8" });
  const obj = parse(data);

  return vb.parse(IntegrationsConfigSchema, obj);
}

const DiscordSchema = vb.strictObject({
  ownerId: vb.pipe(vb.string(), vb.nonEmpty(), vb.regex(/[0-9]+/)),
  token: vb.pipe(vb.string(), vb.nonEmpty()),
});
type DiscordConfig = vb.InferOutput<typeof DiscordSchema>;
const MatrixSchema = vb.strictObject({});
type MatrixConfig = vb.InferOutput<typeof MatrixSchema>;

interface ChannelConfigMap {
  discord: DiscordConfig;
  matrix: MatrixConfig;
}

async function loadChannel<Key extends ChannelType>(
  channel: Key,
  agentSlug?: string,
): Promise<ChannelConfigMap[Key]> {
  const origin = root();
  let path: string | undefined = undefined;
  let schema: vb.GenericSchema | undefined = undefined;

  // oxlint-disable-next-line typescript/switch-exhaustiveness-check
  switch (channel) {
    case "discord":
      path = join(origin, "config", "channels", `${channel}.toml`);
      schema = DiscordSchema;
      break;

    default:
      throw new Error(`Channel ${channel} is unimplemented.`);
  }

  if (!existsSync(path) && agentSlug !== undefined) {
    const maybe = join(origin, "agents", agentSlug, "config", "channels", `${channel}.toml`);
    if (existsSync(maybe)) {
      path = maybe;
    } else {
      throw new Error(`No channel config found for ${channel}.`);
    }
  }

  const tomlData = await readFile(path, "utf8");
  const obj = parse(tomlData);

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return vb.parse(schema, obj) as ChannelConfigMap[Key];
}

interface ConfigChangeEvent {
  eventType: "change" | "rename";
  filename: string | null;
  basePath: string;
}

type Watchers = AsyncIterableIterator<ConfigChangeEvent>;

// Tags events from a watcher with the base path being watched
async function* tagWatcher(
  watcher: AsyncIterableIterator<{ eventType: "change" | "rename"; filename: string | null }>,
  basePath: string,
): AsyncGenerator<ConfigChangeEvent> {
  for await (const event of watcher) {
    yield { ...event, basePath };
  }
}

async function watcher(signal: AbortSignal): Promise<Watchers> {
  const globalConfigDir = path.join(root(), "config");
  const globalConfigWatcher = watch(globalConfigDir, {
    encoding: "utf8",
    recursive: true,
    signal: signal,
  });

  if (!existsSync(path.join(root(), "agents"))) {
    return tagWatcher(globalConfigWatcher, globalConfigDir);
  }

  const agentsFiles = await readdir(path.join(root(), "agents"), {
    encoding: "utf8",
    withFileTypes: true,
  });

  const taggedWatchers = [
    tagWatcher(globalConfigWatcher, globalConfigDir),
    ...agentsFiles
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(entry.parentPath, entry.name, "config"))
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
  const file = path.join(root(), "agents", agentSlug, "config", "heartbeat.toml");

  if (!existsSync(file)) {
    return vb.parse(HeartbeatConfigSchema, {});
  }

  const data = await readFile(file, { encoding: "utf8" });
  const obj = parse(data);

  return vb.parse(HeartbeatConfigSchema, obj);
}

async function loadCron(agentSlug: string): Promise<CronConfig> {
  const file = path.join(root(), "agents", agentSlug, "config", "cron.toml");

  if (!existsSync(file)) {
    return vb.parse(CronConfigSchema, {});
  }

  const data = await readFile(file, { encoding: "utf8" });
  const obj = parse(data);

  return vb.parse(CronConfigSchema, obj);
}

async function loadAgents(): Promise<string[]> {
  const agentsDir = path.join(root(), "agents");

  if (!existsSync(agentsDir)) {
    return [];
  }

  const entries = await readdir(agentsDir, { encoding: "utf8", withFileTypes: true });
  return entries.filter((it) => it.isDirectory()).map((it) => it.name);
}

export {
  EngineConfigSchema,
  ExecToolConfigSchema,
  IntegrationsConfigSchema,
  ToolConfigSchema,
  ToolsConfigSchema,
  loadAgents,
  loadChannel,
  loadCron,
  loadEngine,
  loadHeartbeat,
  loadIntegrations,
  loadTools,
  watcher,
};
export type {
  ConfigChangeEvent,
  CronConfig,
  EngineConfig,
  ExecToolConfig,
  HeartbeatConfig,
  IntegrationsConfig,
  ToolConfig,
  ToolsConfig,
  Watchers,
};
