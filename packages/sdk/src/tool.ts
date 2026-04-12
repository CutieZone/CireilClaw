import type { GenericSchema } from "valibot";

interface Tool<TParameters = GenericSchema> {
  name: string;
  description: string;
  parameters: TParameters;
}

interface ToolResult {
  success: true;
  [key: string]: unknown;
}

interface ToolErrorResult {
  success: false;
  error: string;
  hint?: string;
}

interface ToolDef extends Tool {
  execute(input: unknown, ctx: unknown): Promise<ToolResult>;
}

export type { Tool, ToolDef, ToolResult, ToolErrorResult };
