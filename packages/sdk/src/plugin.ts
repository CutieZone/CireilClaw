import type { ToolDef } from "./tool.js";

interface Plugin {
  name: string;
  tools?: Record<string, ToolDef>;
}

type PluginFactory = () => Plugin | Promise<Plugin>;

function definePlugin(factory: PluginFactory): PluginFactory {
  return factory;
}

export { definePlugin };
export type { Plugin, PluginFactory };
