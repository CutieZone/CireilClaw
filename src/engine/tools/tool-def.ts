import type { ConditionsConfig } from "$/config/index.js";
import type { Database } from "$/db/index.js";
import type { Tool } from "$/engine/tool.js";
import type {
  ChannelResolution,
  HistoryDirection,
  HistoryMessage,
} from "$/harness/channel-handler.js";
import type { Session } from "$/harness/session.js";

interface ToolContext {
  db: Database;
  session: Session;
  agentSlug: string;
  conditions?: ConditionsConfig;
  send: (content: string, attachments?: string[]) => Promise<void>;
  sendTo: (targetSession: Session, content: string, attachments?: string[]) => Promise<void>;
  react?: (emoji: string, messageId?: string) => Promise<void>;
  downloadAttachments?: (messageId: string) => Promise<{ filename: string; data: Buffer }[]>;
  fetchHistory?: (
    messageId: string,
    direction: HistoryDirection,
    limit?: number,
  ) => Promise<HistoryMessage[]>;
  resolveChannel: (spec: string) => Promise<ChannelResolution>;
}

interface ToolDef extends Tool {
  execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>>;
}

export type { ToolContext, ToolDef };
