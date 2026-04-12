import { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { PluginEntry } from "$/config/schemas/plugins.js";
import { PluginsConfigSchema } from "$/config/schemas/plugins.js";
import { builtinToolRegistry, setToolRegistry } from "$/engine/tools/index.js";
import type { ToolDef } from "$/engine/tools/tool-def.js";
import colors from "$/output/colors.js";
import { info } from "$/output/log.js";
import { root } from "$/util/paths.js";
import type { Plugin, PluginFactory } from "@cireilclaw/sdk";
import { parse } from "smol-toml";
import * as vb from "valibot";

const runtimeRequire = createRequire(import.meta.url);
const RUNTIME_SDK_PKG = realpathSync(runtimeRequire.resolve("@cireilclaw/sdk/package.json"));

const SdkPackageJsonSchema = vb.looseObject({
  version: vb.pipe(vb.string(), vb.nonEmpty()),
});

function readSdkVersion(pkgPath: string): string {
  const pkg: unknown = runtimeRequire(pkgPath);
  return vb.parse(SdkPackageJsonSchema, pkg).version;
}

const RUNTIME_SDK_VERSION = readSdkVersion(RUNTIME_SDK_PKG);

interface PluginModule {
  default?: PluginFactory;
}

async function loadPluginsConfig(): Promise<vb.InferOutput<typeof PluginsConfigSchema>> {
  const file = join(root(), "config", "plugins.toml");
  if (!existsSync(file)) {
    return { plugins: [] };
  }

  const content = await readFile(file, "utf8");
  const parsed = parse(content);
  return vb.parse(PluginsConfigSchema, parsed);
}

async function ensureLocalPackageJson(): Promise<string> {
  const pkgPath = join(root(), "package.json");
  if (!existsSync(pkgPath)) {
    const skeleton = {
      dependencies: {},
      name: "cireilclaw-local",
      private: true,
      type: "module",
    };
    await writeFile(pkgPath, `${JSON.stringify(skeleton, undefined, 2)}\n`, "utf8");
  }
  return pkgPath;
}

function resolvePluginSdkPkg(id: string, pluginPkgPath: string): string {
  const req = createRequire(pluginPkgPath);
  try {
    return realpathSync(req.resolve("@cireilclaw/sdk/package.json"));
  } catch {
    throw new Error(
      `Plugin ${colors.keyword(id)} cannot resolve ${colors.keyword("@cireilclaw/sdk")}. ` +
        `Add it as a peerDependency and install it.`,
    );
  }
}

function assertSdkMatches(id: string, pluginPkgPath: string): void {
  const pluginSdkPkg = resolvePluginSdkPkg(id, pluginPkgPath);

  if (pluginSdkPkg === RUNTIME_SDK_PKG) {
    return;
  }

  const pluginSdkVersion = readSdkVersion(pluginSdkPkg);
  throw new Error(
    `Plugin ${colors.keyword(id)} resolved a different ${colors.keyword("@cireilclaw/sdk")} copy ` +
      `(plugin: ${colors.keyword(pluginSdkVersion)} at ${colors.keyword(pluginSdkPkg)}; ` +
      `runtime: ${colors.keyword(RUNTIME_SDK_VERSION)} at ${colors.keyword(RUNTIME_SDK_PKG)}). ` +
      `Two copies break instanceof checks and schema identity even at matching versions. ` +
      `Run ${colors.keyword("pnpm dedupe")} or ensure the plugin uses the runtime's SDK.`,
  );
}

async function resolveEntryUrl(
  entry: PluginEntry,
): Promise<{ id: string; pluginPkgPath: string; url: URL }> {
  if (entry.name !== undefined) {
    const dir = join(root(), "plugins", entry.name);
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) {
      throw new Error(
        `Plugin ${colors.keyword(entry.name)} not found at ${colors.keyword(dir)}. ` +
          `Clone it there: git clone <url> ${dir}`,
      );
    }
    if (!existsSync(join(dir, "node_modules"))) {
      throw new Error(
        `Plugin ${colors.keyword(entry.name)} is missing dependencies. ` +
          `Run: cd ${dir} && pnpm install`,
      );
    }
    const req = createRequire(pkgPath);
    return { id: entry.name, pluginPkgPath: pkgPath, url: pathToFileURL(req.resolve(".")) };
  }

  const pkgPath = await ensureLocalPackageJson();
  const req = createRequire(pkgPath);
  const { package: pkgName } = entry;
  if (pkgName === undefined) {
    throw new Error("Plugin entry has neither name nor package");
  }
  try {
    return {
      id: pkgName,
      pluginPkgPath: pkgPath,
      url: pathToFileURL(req.resolve(pkgName)),
    };
  } catch {
    throw new Error(
      `Plugin package ${colors.keyword(pkgName)} is not installed. ` +
        `Run: cd ${root()} && pnpm add ${pkgName}`,
    );
  }
}

function isPluginModule(value: unknown): value is PluginModule {
  return typeof value === "object" && value !== null && "default" in value;
}

async function loadSinglePlugin(entry: PluginEntry): Promise<Plugin> {
  const { id, pluginPkgPath, url } = await resolveEntryUrl(entry);
  assertSdkMatches(id, pluginPkgPath);
  const mod: unknown = await import(url.href);

  if (!isPluginModule(mod)) {
    throw new Error(`Plugin ${colors.keyword(id)} does not have a default export`);
  }

  const factory = mod.default;
  if (typeof factory !== "function") {
    throw new TypeError(`Plugin ${colors.keyword(id)} default export is not a function`);
  }

  const plugin = await factory();
  if (typeof plugin.name !== "string") {
    throw new TypeError(`Plugin ${colors.keyword(id)} did not return a valid Plugin object`);
  }

  return plugin;
}

async function loadPlugins(): Promise<
  { allowOverride: boolean; name: string; tools: Record<string, ToolDef> }[]
> {
  const config = await loadPluginsConfig();
  const results: { allowOverride: boolean; name: string; tools: Record<string, ToolDef> }[] = [];

  for (const entry of config.plugins) {
    const plugin = await loadSinglePlugin(entry);
    const tools: Record<string, ToolDef> = {};

    if (plugin.tools !== undefined) {
      for (const [toolName, toolDef] of Object.entries(plugin.tools)) {
        if (typeof toolDef.execute !== "function") {
          throw new TypeError(
            `Plugin ${colors.keyword(plugin.name)} tool ${colors.keyword(toolName)} has no execute function`,
          );
        }

        // Plugin tools accept PluginToolContext; runtime passes InternalToolContext
        // which extends it. Safe by Liskov: the assertion is structural.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        tools[toolName] = toolDef as unknown as ToolDef;
      }
    }

    results.push({
      allowOverride: entry.allowOverride,
      name: plugin.name,
      tools,
    });
  }

  return results;
}

function mergeToolRegistries(
  builtinRegistry: Record<string, ToolDef>,
  pluginResults: { allowOverride: boolean; name: string; tools: Record<string, ToolDef> }[],
): Record<string, ToolDef> {
  // Registry merge is single-process / single-harness by design. See docs/plugin-system.md.
  const merged: Record<string, ToolDef> = { ...builtinRegistry };

  for (const { allowOverride, name: pluginName, tools } of pluginResults) {
    for (const [toolName, toolDef] of Object.entries(tools)) {
      const existingBuiltin = builtinRegistry[toolName];

      if (existingBuiltin !== undefined && !allowOverride) {
        throw new Error(
          `Plugin ${colors.keyword(pluginName)} tool ${colors.keyword(toolName)} collides with builtin. ` +
            `Set allowOverride = true in plugins.toml to permit this.`,
        );
      }

      const existingPlugin = merged[toolName];
      if (existingPlugin !== undefined && existingBuiltin === undefined) {
        throw new Error(
          `Plugin ${colors.keyword(pluginName)} tool ${colors.keyword(toolName)} collides with another plugin. ` +
            `Tool name collisions between plugins are not allowed.`,
        );
      }

      merged[toolName] = toolDef;
    }
  }

  return merged;
}

async function initializePlugins(): Promise<void> {
  const pluginResults = await loadPlugins();
  if (pluginResults.length > 0) {
    const merged = mergeToolRegistries(builtinToolRegistry, pluginResults);
    setToolRegistry(merged);
    const toolNames = pluginResults.flatMap((plugin) => Object.keys(plugin.tools));
    info(
      "Loaded",
      colors.number(pluginResults.length),
      "plugins with",
      colors.number(toolNames.length),
      "tools:",
      toolNames.join(", "),
    );
  }
}

export { initializePlugins, loadPlugins, mergeToolRegistries };
