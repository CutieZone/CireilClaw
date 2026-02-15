import type { Tool } from "$/engine/tool.js";
import type { Session } from "$/harness/session.js";

interface ToolContext {
  session: Session;
  agentSlug: string;
}

interface ToolDef extends Tool {
  execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>>;
}

export type { ToolContext, ToolDef };
