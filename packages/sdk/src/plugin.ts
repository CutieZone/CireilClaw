import type { Section } from "#outline.js";
import type { ToolDef } from "#tool.js";

interface ExtractorDef {
  glob: string;
  priority?: number;
  extract(filePath: string, content: string): Section[] | Promise<Section[]>;
}

interface Plugin {
  name: string;
  tools?: Record<string, ToolDef>;
  extractors?: ExtractorDef[];
}

type PluginFactory = () => Plugin | Promise<Plugin>;

function definePlugin(factory: PluginFactory): PluginFactory {
  return factory;
}

export { definePlugin };
export type { Plugin, PluginFactory, ExtractorDef };
export type { Section } from "#outline.js";
