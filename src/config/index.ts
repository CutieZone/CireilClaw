import type { ChannelType } from "$/harness/session.js";
import type { FileChangeInfo } from "node:fs/promises";
import type { TomlTable } from "smol-toml";

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

const ToolsConfigSchema = vb.record(
  vb.pipe(vb.string(), vb.nonEmpty()),
  vb.exactOptional(vb.boolean(), true),
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

type Watchers = AsyncIterableIterator<FileChangeInfo<string>>;
async function watcher(signal: AbortSignal): Promise<Watchers> {
  const globalConfigWatcher = watch(path.join(root(), "config"), {
    encoding: "utf8",
    recursive: true,
    signal: signal,
  });

  if (!existsSync(path.join(root(), "agents"))) {
    return globalConfigWatcher;
  }

  const agentsFiles = await readdir(path.join(root(), "agents"), {
    encoding: "utf8",
    withFileTypes: true,
  });

  const agentsWatchers = agentsFiles
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(entry.parentPath, entry.name, "config"))
    .filter((configPath) => existsSync(configPath))
    .map((configPath) =>
      watch(configPath, {
        encoding: "utf8",
        recursive: true,
        signal: signal,
      }),
    );

  return merge.default("iters-close-wait", globalConfigWatcher, ...agentsWatchers);
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
  ToolsConfigSchema,
  loadAgents,
  loadChannel,
  loadEngine,
  loadTools,
  watcher,
};
export type { EngineConfig, ToolsConfig, Watchers };
