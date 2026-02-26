import type { Tool } from "$/engine/tool.js";
import type { Session } from "$/harness/session.js";

interface ToolContext {
  session: Session;
  agentSlug: string;
  send: (content: string, attachments?: string[]) => Promise<void>;
  react?: (emoji: string, messageId?: string) => Promise<void>;
  downloadDiscordAttachments?: (messageId: string) => Promise<{ filename: string; data: Buffer }[]>;
}

interface ToolDef extends Tool {
  execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>>;
}

export type { ToolContext, ToolDef };
