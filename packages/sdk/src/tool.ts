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

interface PluginToolContext {
  session: {
    readonly channel: "discord" | "matrix" | "tui" | "internal";
    readonly history: ReadonlyArray<unknown>;
    readonly openedFiles: ReadonlySet<string>;
    id(): string;
  };
  agentSlug: string;
  send: (content: string, attachments?: string[]) => Promise<void>;
  sendTo: (
    targetSession: { readonly channel: string; id(): string },
    content: string,
    attachments?: string[],
  ) => Promise<void>;
  react?: (emoji: string, messageId?: string) => Promise<void>;
  downloadAttachments?: (
    messageId: string,
  ) => Promise<{ filename: string; data: Buffer }[]>;
  fetchHistory?: (
    messageId: string,
    direction: HistoryDirection,
    limit?: number,
  ) => Promise<HistoryMessage[]>;
  resolveChannel: (spec: string) => Promise<ChannelResolution>;
  mounts?: readonly Mount[];
  addImage: (data: Buffer, mediaType: string) => void;
  addVideo: (data: Buffer, mediaType: string) => void;
  addToolMessage: (content: string) => void;
}

interface ToolDef extends Tool {
  execute(input: unknown, ctx: PluginToolContext): Promise<ToolResult>;
}

export type {
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
