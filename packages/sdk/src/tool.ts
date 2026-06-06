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

/**
 * A key normalized for Web Crypto import.
 * - `format: "pkcs8"` with the PEM string for private keys
 * - `format: "spki"` with the PEM string for public keys
 */
interface WebCryptoFormat {
  format: "pkcs8" | "spki";
  data: string;
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
  crypto: {
    /**
     * Normalize a PEM/DER key to a Web-Crypto-compatible format.
     *
     * Accepts a sandbox path (read via ctx.fs) or an inline data string.
     * Returns the key in PKCS#8 (private) or SPKI (public) PEM format,
     * auto-detecting the input format (PKCS#1, PKCS#8, SEC1, SPKI…).
     */
    loadNormalizedKey(
      this: void,
      opts: { path: string } | { data: string },
    ): Promise<WebCryptoFormat>;
  };
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
  PluginToolContext,
  Tool,
  ToolDef,
  ToolErrorResult,
  ToolResult,
  WebCryptoFormat,
};
