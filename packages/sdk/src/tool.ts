import type { GenericSchema } from "valibot";

import type { KeyPool } from "#key-pool.js";

interface Tool<TParameters = GenericSchema> {
  name: string;
  description: string;
  parameters: TParameters;
  // Pre-computed JSON Schema. Providers prefer this over converting `parameters`.
  // Used by plugin stubs to carry worker-computed schemas across the worker boundary.
  jsonSchema?: Record<string, unknown>;
}

interface ToolResult {
  success: boolean;
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
    send(this: void, content: string, attachments?: string[]): Promise<void>;
    react?(this: void, emoji: string, messageId?: string): Promise<void>;
  };
  channel: {
    resolveChannel(this: void, spec: string): Promise<ChannelResolution>;
  };
  cfg: {
    globalPlugin(this: void, name: string): Promise<Record<string, unknown> | undefined>;
    agentPlugin(this: void, name: string): Promise<Record<string, unknown> | undefined>;
  };
  createKeyPool(this: void, keys: string | string[], cooldownMs?: number): KeyPool;
  // Plugins should use ctx.net.fetch instead of the global fetch. This is the mediation point
  // for future isolation (worker/subprocess); today it's a passthrough.
  net: {
    fetch: typeof fetch;
  };
  mounts?: readonly Mount[];
  addImage(this: void, data: Uint8Array, mediaType: string): void;
  addVideo(this: void, data: Uint8Array, mediaType: string): void;
  addToolMessage(this: void, content: string): void;
  paths: {
    resolve(this: void, sandboxPath: string): Promise<string>;
    checkWriteAccess(this: void, sandboxPath: string): Promise<void>;
    checkConditionalAccess(this: void, sandboxPath: string): Promise<void>;
  };
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
