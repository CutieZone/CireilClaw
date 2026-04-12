import type { GenericSchema } from "valibot";

import type { KeyPool } from "./key-pool.js";

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

type ChannelResolution =
  | { readonly channel: "discord" | "matrix" | "tui" | "internal"; id(): string }
  | { error: string };

type HistoryDirection = "after" | "around" | "before";

interface HistoryMessage {
  authorId: string;
  authorName: string;
  content: string;
  formatted: string;
  id: string;
  timestamp: string;
}

interface Mount {
  mode: "ro" | "rw";
  source: string;
  target: string;
}

interface BasicSession {
  readonly channel: "discord" | "matrix" | "tui" | "internal";
  readonly history: readonly unknown[];
  readonly openedFiles: ReadonlySet<string>;
  id(): string;
}

interface PluginToolContext {
  session: BasicSession;
  agentSlug: string;
  reply: {
    send: (content: string, attachments?: string[]) => Promise<void>;
    sendTo: (targetSession: BasicSession, content: string, attachments?: string[]) => Promise<void>;
    react?: (emoji: string, messageId?: string) => Promise<void>;
  };
  channel: {
    downloadAttachments?: (messageId: string) => Promise<{ filename: string; data: Buffer }[]>;
    fetchHistory?: (
      messageId: string,
      direction: HistoryDirection,
      limit?: number,
    ) => Promise<HistoryMessage[]>;
    resolveChannel: (spec: string) => Promise<ChannelResolution>;
  };
  cfg: {
    globalPlugin: (name: string) => Promise<Record<string, unknown> | undefined>;
    agentPlugin: (name: string) => Promise<Record<string, unknown> | undefined>;
  };
  createKeyPool: (keys: string | string[], cooldownMs?: number) => KeyPool;
  mounts?: readonly Mount[];
  addImage: (data: Uint8Array, mediaType: string) => void;
  addVideo: (data: Uint8Array, mediaType: string) => void;
  addToolMessage: (content: string) => void;
}

interface ToolDef extends Tool {
  execute(input: unknown, ctx: PluginToolContext): Promise<ToolResult>;
}

export type {
  BasicSession,
  ChannelResolution,
  HistoryDirection,
  HistoryMessage,
  Mount,
  PluginToolContext,
  Tool,
  ToolDef,
  ToolErrorResult,
  ToolResult,
};
