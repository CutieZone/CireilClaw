import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { PluginsConfigSchema } from "$/config/schemas/plugins.js";
import type { ToolDef } from "$/engine/tools/tool-def.js";
import colors from "$/output/colors.js";
import { root } from "$/util/paths.js";
import type { Plugin, PluginFactory } from "cireilclaw-sdk";
import { parse } from "smol-toml";
import * as vb from "valibot";

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

function isPluginModule(value: unknown): value is PluginModule {
  return typeof value === "object" && value !== null && "default" in value;
}

async function loadSinglePlugin(pluginPath: string): Promise<Plugin> {
  const mod = await import(pluginPath);

  if (!isPluginModule(mod)) {
    throw new Error(`Plugin at ${colors.keyword(pluginPath)} does not have a default export`);
  }

  const factory = mod.default;
  if (typeof factory !== "function") {
    throw new Error(`Plugin at ${colors.keyword(pluginPath)} default export is not a function`);
  }

  const plugin = await factory();
  if (typeof plugin.name !== "string") {
    throw new Error(`Plugin at ${colors.keyword(pluginPath)} did not return a valid Plugin object`);
  }

  return plugin;
}

export async function loadPlugins(): Promise<
  { allowOverride: boolean; name: string; tools: Record<string, ToolDef> }[]
> {
  const config = await loadPluginsConfig();
  const results: { allowOverride: boolean; name: string; tools: Record<string, ToolDef> }[] = [];

  for (const entry of config.plugins) {
    const plugin = await loadSinglePlugin(entry.path);
    const tools: Record<string, ToolDef> = {};

    if (plugin.tools !== undefined) {
      for (const [toolName, toolDef] of Object.entries(plugin.tools)) {
        if (typeof toolDef.execute !== "function") {
          throw new Error(
            `Plugin ${colors.keyword(plugin.name)} tool ${colors.keyword(toolName)} has no execute function`,
          );
        }

        // Plugin tools accept PluginToolContext; runtime passes InternalToolContext
        // which extends it. Safe by Liskov — the assertion is structural.
        // oxlint-disable-next-line no-unsafe-type-assertion
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

export function mergeToolRegistries(
  builtinRegistry: Record<string, ToolDef>,
  pluginResults: { allowOverride: boolean; name: string; tools: Record<string, ToolDef> }[],
): Record<string, ToolDef> {
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
