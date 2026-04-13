import type { GenericSchema } from "valibot";

import type { KeyPool } from "./key-pool.js";

interface Tool<TParameters = GenericSchema> {
  name: string;
  description: string;
  parameters: TParameters;
  // Pre-computed JSON Schema. Providers prefer this over converting `parameters`.
  // Used by plugin stubs to carry worker-computed schemas across the worker boundary.
  jsonSchema?: Record<string, unknown>;
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

interface Mount {
  mode: "ro" | "rw";
  source: string;
  target: string;
}

interface BasicSession {
  readonly channel: "discord" | "matrix" | "tui" | "internal";
  id(): string;
}

interface PluginToolContext {
  session: BasicSession;
  agentSlug: string;
  reply: {
    send: (content: string, attachments?: string[]) => Promise<void>;
    react?: (emoji: string, messageId?: string) => Promise<void>;
  };
  channel: {
    resolveChannel: (spec: string) => Promise<ChannelResolution>;
  };
  cfg: {
    globalPlugin: (name: string) => Promise<Record<string, unknown> | undefined>;
    agentPlugin: (name: string) => Promise<Record<string, unknown> | undefined>;
  };
  createKeyPool: (keys: string | string[], cooldownMs?: number) => KeyPool;
  // Plugins should use ctx.net.fetch instead of the global fetch. This is the mediation point
  // for future isolation (worker/subprocess); today it's a passthrough.
  net: {
    fetch: typeof fetch;
  };
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
  Mount,
  PluginToolContext,
  Tool,
  ToolDef,
  ToolErrorResult,
  ToolResult,
};
