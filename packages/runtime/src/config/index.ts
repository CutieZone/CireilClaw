import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { CronConfig } from "$/config/cron.js";
import { CronConfigSchema } from "$/config/cron.js";
import type { HeartbeatConfig } from "$/config/heartbeat.js";
import { HeartbeatConfigSchema } from "$/config/heartbeat.js";
import type { ConditionsConfig } from "$/config/schemas/conditions.js";
import { ConditionsConfigSchema } from "$/config/schemas/conditions.js";
import { DiscordConfigSchema } from "$/config/schemas/discord.js";
import type { DiscordConfig } from "$/config/schemas/discord.js";
import { ProvidersConfigSchema } from "$/config/schemas/engine.js";
import type { ProvidersConfig } from "$/config/schemas/engine.js";
import { IntegrationsConfigSchema } from "$/config/schemas/integrations.js";
import { SandboxConfigSchema } from "$/config/schemas/sandbox.js";
import type { SandboxConfig } from "$/config/schemas/sandbox.js";
import { SystemConfigSchema } from "$/config/schemas/system.js";
import { ToolsConfigSchema } from "$/config/schemas/tools.js";
import type { ToolsConfig } from "$/config/schemas/tools.js";
import type { ChannelType } from "$/harness/session.js";
import colors from "$/output/colors.js";
import { root } from "$/util/paths.js";
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
async function loadEngine(agentSlug?: string): Promise<ProvidersConfig> {
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

  const cfg = vb.parse(ProvidersConfigSchema, obj);

  // Validate that a global default provider exists
  const defaultProvider = Object.values(cfg).filter((it) => it.isGlobalDefault);

  if (defaultProvider.length === 0) {
    if (agentSlug === undefined) {
      throw new Error(
        `There is no global default provider in the loaded global engine configuration. Assign a provider the 'isGlobalDefault' tag`,
      );
    } else {
      throw new Error(
        `There is no global default provider in the loaded engine configuration for agent ${colors.keyword(agentSlug)}. Assign a provider the 'isGlobalDefault' tag`,
      );
    }
  }

  if (defaultProvider.length > 1) {
    if (agentSlug === undefined) {
      throw new Error(
        `There is more than 1  global default provider in the loaded global engine configuration. Assign only one provider the 'isGlobalDefault' tag`,
      );
    } else {
      throw new Error(
        `There is more than 1 global default provider in the loaded engine configuration for agent ${colors.keyword(agentSlug)}. Assign only one provider the 'isGlobalDefault' tag`,
      );
    }
  }

  return cfg;
}

type IntegrationsConfig = vb.InferOutput<typeof IntegrationsConfigSchema>;

async function loadIntegrations(): Promise<IntegrationsConfig> {
  const file = join(root(), "config", "integrations.toml");

  if (!existsSync(file)) {
    return {};
  }

  const data = await readFile(file, { encoding: "utf8" });
  const obj = parse(data);

  return vb.parse(IntegrationsConfigSchema, obj);
}

interface ChannelConfigMap {
  discord: DiscordConfig;

  [index: string]: unknown;
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
      schema = DiscordConfigSchema;
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

async function loadConditions(agentSlug: string): Promise<ConditionsConfig> {
  const file = join(root(), "agents", agentSlug, "config", "conditions.toml");

  if (!existsSync(file)) {
    return { blocks: {}, memories: {}, workspace: {} };
  }

  const data = await readFile(file, { encoding: "utf8" });
  const obj = parse(data);

  return vb.parse(ConditionsConfigSchema, obj);
}

type SystemConfig = vb.InferOutput<typeof SystemConfigSchema>;

async function loadSystem(): Promise<SystemConfig> {
  const file = join(root(), "config", "system.toml");

  if (!existsSync(file)) {
    return vb.parse(SystemConfigSchema, {});
  }

  const data = await readFile(file, { encoding: "utf8" });
  const obj = parse(data);

  return vb.parse(SystemConfigSchema, obj);
}

function expandTilde(path: string): string {
  if (path.startsWith("~/")) {
    const home = process.env["HOME"];
    if (home === undefined) {
      throw new Error("Cannot expand ~ in path: $HOME is not set");
    }
    return home + path.slice(1);
  }
  return path;
}

async function loadSandboxConfig(agentSlug: string): Promise<SandboxConfig> {
  const file = join(root(), "agents", agentSlug, "config", "sandbox.toml");

  if (!existsSync(file)) {
    return { mounts: [] };
  }

  const data = await readFile(file, { encoding: "utf8" });
  const obj = parse(data);
  const config = vb.parse(SandboxConfigSchema, obj);

  const targets = new Set<string>();
  for (const mount of config.mounts) {
    if (targets.has(mount.target)) {
      throw new Error(
        `Duplicate mount target '${mount.target}' in sandbox.toml for agent '${agentSlug}'`,
      );
    }
    targets.add(mount.target);

    mount.source = expandTilde(mount.source);
  }

  return config;
}

async function loadGlobalPluginConfig(name: string): Promise<Record<string, unknown> | undefined> {
  const file = join(root(), "config", "plugins", `${name}.toml`);

  if (!existsSync(file)) {
    return undefined;
  }

  const data = await readFile(file, { encoding: "utf8" });
  const obj = parse(data);

  return obj as Record<string, unknown>;
}

async function loadAgentPluginConfig(
  agentSlug: string,
  name: string,
): Promise<Record<string, unknown> | undefined> {
  const file = join(root(), "agents", agentSlug, "config", "plugins", `${name}.toml`);

  if (!existsSync(file)) {
    return undefined;
  }

  const data = await readFile(file, { encoding: "utf8" });
  const obj = parse(data);

  return obj as Record<string, unknown>;
}

export {
  loadAgents,
  loadChannel,
  loadConditions,
  loadCron,
  loadEngine,
  loadGlobalPluginConfig,
  loadAgentPluginConfig,
  loadHeartbeat,
  loadIntegrations,
  loadSandboxConfig,
  loadSystem,
  loadTools,
};
