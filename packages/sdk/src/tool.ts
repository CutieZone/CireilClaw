import type { GenericSchema } from "valibot";

import type { PluginCryptoApi, PluginIdsApi } from "#crypto.js";
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

interface FsStat {
  size: number;
  isDirectory: boolean;
  isFile: boolean;
  mtimeMs: number;
  ctimeMs: number;
}

interface FsDirent {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

interface FsApi {
  readTextFile(this: void, sandboxPath: string): Promise<string>;
  writeTextFile(this: void, sandboxPath: string, content: string): Promise<void>;
  stat(this: void, sandboxPath: string): Promise<FsStat>;
  listDir(this: void, sandboxPath: string): Promise<FsDirent[]>;
}

/**
 * Private, persistent runtime data scoped to `(agent, plugin)`.
 *
 * The runtime derives the on-disk path as
 * `~/.cireilclaw/agents/<agentSlug>/state/<plugin-slug>/<name>`; the
 * plugin supplies only `name` (a relative path). State is not
 * reachable from the sandboxed `ctx.fs` surface and is not visible to
 * exec'd commands. Files are written atomically with mode 0o600;
 * total usage per plugin is capped by a per-entry quota (default 16
 * MiB). Reads of missing files return `undefined`; `remove` is a
 * no-op for missing files. Paths may nest, but absolute paths,
 * traversal, and symlink escape are rejected, and the top-level name
 * `.id` is reserved as a runtime sentinel.
 */
interface PluginStateApi {
  readText(this: void, name: string): Promise<string | undefined>;
  writeText(this: void, name: string, content: string): Promise<void>;
  remove(this: void, name: string): Promise<void>;
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
  crypto: PluginCryptoApi;
  ids: PluginIdsApi;
  // Plugins should use ctx.net.fetch instead of the global fetch. This is the mediation point
  // for future isolation (worker/subprocess); today it's a passthrough.
  net: {
    fetch: typeof fetch;
  };
  mounts?: readonly Mount[];
  addImage(this: void, data: Uint8Array, mediaType: string): void;
  addVideo(this: void, data: Uint8Array, mediaType: string): void;
  addToolMessage(this: void, content: string): void;
  fs: FsApi;
  pluginState: PluginStateApi;
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
  FsApi,
  FsDirent,
  FsStat,
  Mount,
  PluginStateApi,
  PluginToolContext,
  Tool,
  ToolDef,
  ToolErrorResult,
  ToolResult,
};
