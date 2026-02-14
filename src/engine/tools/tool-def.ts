import type { Tool } from "$/engine/tool.js";

export interface ToolDef extends Tool {
  execute(input: unknown): Promise<Record<string, unknown>>;
}
