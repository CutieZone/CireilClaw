/* oxlint-disable eslint-plugin-unicorn/require-post-message-target-origin,
   eslint-plugin-promise/prefer-await-to-then
   -- node:worker_threads has no targetOrigin; fire-and-forget RPCs are intentional */

import { parentPort, workerData } from "node:worker_threads";

import { toJsonSchema } from "@valibot/to-json-schema";
import { KeyPoolManager } from "@cireilclaw/sdk";
import type {
  BasicSession,
  ChannelResolution,
  HistoryDirection,
  HistoryMessage,
  KeyPool,
  Mount,
  Plugin,
  PluginFactory,
  PluginToolContext,
} from "@cireilclaw/sdk";

import { RpcChannel } from "./rpc.js";

interface WorkerInit {
  entryUrl: string;
  pluginId: string;
}

interface CtxData {
  agentSlug: string;
  session: { channel: BasicSession["channel"]; id: string };
  mounts?: readonly Mount[];
}

interface ToolManifestEntry {
  name: string;
  description: string;
  jsonSchema: Record<string, unknown>;
}

interface ManifestPayload {
  pluginName: string;
  tools: ToolManifestEntry[];
}

interface InvokeArgs {
  invocationId: string;
  toolName: string;
  input: unknown;
  ctx: CtxData;
}

interface PluginModule {
  default?: PluginFactory;
}

function isPluginModule(value: unknown): value is PluginModule {
  return typeof value === "object" && value !== null && "default" in value;
}

function isInvokeArgs(value: unknown): value is InvokeArgs {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { invocationId, toolName, ctx } = value as {
    invocationId?: unknown;
    toolName?: unknown;
    ctx?: unknown;
  };
  return (
    typeof invocationId === "string" &&
    typeof toolName === "string" &&
    typeof ctx === "object" &&
    ctx !== null
  );
}

function buildCtx(rpc: RpcChannel, invocationId: string, data: CtxData): PluginToolContext {
  const session: BasicSession = {
    channel: data.session.channel,
    id: (): string => data.session.id,
  };

  return {
    addImage: (imageData: Uint8Array, mediaType: string): void => {
      rpc.call("addImage", [invocationId, imageData, mediaType]).catch(() => undefined);
    },
    addToolMessage: (content: string): void => {
      rpc.call("addToolMessage", [invocationId, content]).catch(() => undefined);
    },
    addVideo: (videoData: Uint8Array, mediaType: string): void => {
      rpc.call("addVideo", [invocationId, videoData, mediaType]).catch(() => undefined);
    },
    agentSlug: data.agentSlug,
    cfg: {
      agentPlugin: async (name) =>
        await rpc.call<Record<string, unknown> | undefined>("cfg.agentPlugin", [
          invocationId,
          name,
        ]),
      globalPlugin: async (name) =>
        await rpc.call<Record<string, unknown> | undefined>("cfg.globalPlugin", [
          invocationId,
          name,
        ]),
    },
    channel: {
      downloadAttachments: async (messageId) =>
        await rpc.call<{ filename: string; data: Buffer }[]>("channel.downloadAttachments", [
          invocationId,
          messageId,
        ]),
      fetchHistory: async (messageId, direction: HistoryDirection, limit) =>
        await rpc.call<HistoryMessage[]>("channel.fetchHistory", [
          invocationId,
          messageId,
          direction,
          limit,
        ]),
      resolveChannel: async (spec): Promise<ChannelResolution> => {
        const resolved = await rpc.call<
          { channel: BasicSession["channel"]; id: string } | { error: string }
        >("channel.resolveChannel", [invocationId, spec]);
        if ("error" in resolved) {
          return { error: resolved.error };
        }
        return {
          channel: resolved.channel,
          id: (): string => resolved.id,
        };
      },
    },
    // KeyPool lives in the worker's process, not the runtime's. Each worker has its own
    // KeyPoolManager singleton, so rate-limit state does not cross workers or reach back
    // to the runtime. Fine as long as each plugin owns its keys. If two plugins share a
    // key, failure tracking is per-worker and will drift.
    createKeyPool: (keys, cooldownMs): KeyPool => KeyPoolManager.getPool(keys, cooldownMs),
    mounts: data.mounts,
    net: {
      fetch: globalThis.fetch.bind(globalThis),
    },
    reply: {
      react: async (emoji, messageId) => {
        await rpc.call("reply.react", [invocationId, emoji, messageId]);
      },
      send: async (content, attachments) => {
        await rpc.call("reply.send", [invocationId, content, attachments]);
      },
      sendTo: async (target, content, attachments) => {
        await rpc.call("reply.sendTo", [
          invocationId,
          { channel: target.channel, id: target.id() },
          content,
          attachments,
        ]);
      },
    },
    session,
  };
}

async function main(parent: NonNullable<typeof parentPort>, init: WorkerInit): Promise<void> {
  const rpc = new RpcChannel(parent);

  const mod: unknown = await import(init.entryUrl);
  if (!isPluginModule(mod)) {
    throw new Error(`Plugin ${init.pluginId} has no default export`);
  }
  const factory = mod.default;
  if (typeof factory !== "function") {
    throw new TypeError(`Plugin ${init.pluginId} default export is not a function`);
  }

  const plugin: Plugin = await factory();
  const toolMap = plugin.tools ?? {};
  const manifestEntries: ToolManifestEntry[] = [];
  for (const [registeredName, def] of Object.entries(toolMap)) {
    manifestEntries.push({
      description: def.description,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JsonSchema is structurally compatible with Record<string, unknown>
      jsonSchema: toJsonSchema(def.parameters, {
        target: "openapi-3.0",
        typeMode: "input",
      }) as unknown as Record<string, unknown>,
      name: registeredName,
    });
  }

  rpc.handle("invoke-tool", async (args) => {
    const [raw] = args;
    if (!isInvokeArgs(raw)) {
      throw new Error("invoke-tool called with invalid args");
    }
    const def = toolMap[raw.toolName];
    if (def === undefined) {
      throw new Error(`Plugin ${plugin.name} has no tool ${raw.toolName}`);
    }
    const ctx = buildCtx(rpc, raw.invocationId, raw.ctx);
    // Plugin tools accept PluginToolContext; ctx built above matches that shape exactly.
    return await def.execute(raw.input, ctx);
  });

  const manifest: ManifestPayload = { pluginName: plugin.name, tools: manifestEntries };
  await rpc.call("manifest", [manifest]);
}

if (parentPort === null) {
  throw new Error("plugin worker must be spawned with a parentPort");
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- workerData is any-typed
const init = workerData as WorkerInit;

try {
  await main(parentPort, init);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  parentPort.postMessage({
    args: [message],
    id: -1,
    kind: "req",
    method: "fatal",
  });
  process.exit(1);
}

export type { CtxData, InvokeArgs, ManifestPayload, ToolManifestEntry, WorkerInit };
