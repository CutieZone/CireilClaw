/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/promise-function-async
   -- RPC boundary: args arrive as unknown[] and are coerced via trust contract with worker.ts */

import { createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import type { Section } from "@cireilclaw/sdk";
import { parse } from "smol-toml";
import * as vb from "valibot";

import type { PluginEntry } from "#config/schemas/plugins.js";
import { PluginsConfigSchema } from "#config/schemas/plugins.js";
import { ToolError } from "#engine/errors.js";
import { registerExtractor } from "#engine/outline.js";
import { builtinToolRegistry, setToolRegistry } from "#engine/tools/index.js";
import type { ToolContext, ToolDef } from "#engine/tools/tool-def.js";
import colors from "#output/colors.js";
import { info, warning } from "#output/log.js";
import { checkConditionalAccess, checkMountWriteAccess, root, sandboxToReal } from "#util/paths.js";

import { RpcChannel } from "./rpc.js";
import type { CtxData, InvokeArgs, ManifestPayload } from "./worker-main.js";

// Safety net for wedged plugins: a single tool invocation cannot hang the engine turn forever.
// Generous to accommodate long scrapes / network work; worker crashes already reject immediately.
const INVOKE_TIMEOUT_MS = 10 * 60 * 1000;

const runtimeRequire = createRequire(import.meta.url);
const RUNTIME_SDK_PKG = realpathSync(runtimeRequire.resolve("@cireilclaw/sdk/package.json"));
const WORKER_URL = new URL("worker.ts", import.meta.url);

const SdkPackageJsonSchema = vb.looseObject({
  version: vb.pipe(vb.string(), vb.nonEmpty()),
});

function readSdkVersion(pkgPath: string): string {
  const pkg: unknown = runtimeRequire(pkgPath);
  return vb.parse(SdkPackageJsonSchema, pkg).version;
}

const RUNTIME_SDK_VERSION = readSdkVersion(RUNTIME_SDK_PKG);

async function loadPluginsConfig(): Promise<vb.InferOutput<typeof PluginsConfigSchema>> {
  const file = path.join(root(), "config", "plugins.toml");
  if (!existsSync(file)) {
    return { plugins: [] };
  }
  const content = await readFile(file, "utf8");
  const parsed = parse(content);
  return vb.parse(PluginsConfigSchema, parsed);
}

async function ensureLocalPackageJson(): Promise<string> {
  const pkgPath = path.join(root(), "package.json");
  if (!existsSync(pkgPath)) {
    const skeleton = {
      dependencies: {},
      name: "cireilclaw-local",
      private: true,
      type: "module",
    };
    await writeFile(pkgPath, `${JSON.stringify(skeleton, undefined, 2)}\n`, "utf8");
  }
  return pkgPath;
}

function resolvePluginSdkPkg(id: string, pluginPkgPath: string): string {
  const req = createRequire(pluginPkgPath);
  try {
    return realpathSync(req.resolve("@cireilclaw/sdk/package.json"));
  } catch {
    throw new Error(
      `Plugin ${colors.keyword(id)} cannot resolve ${colors.keyword("@cireilclaw/sdk")}. ` +
        `Add it as a peerDependency and install it.`,
    );
  }
}

function assertSdkMatches(id: string, pluginPkgPath: string): void {
  const pluginSdkPkg = resolvePluginSdkPkg(id, pluginPkgPath);
  if (pluginSdkPkg === RUNTIME_SDK_PKG) {
    return;
  }
  const pluginSdkVersion = readSdkVersion(pluginSdkPkg);
  throw new Error(
    `Plugin ${colors.keyword(id)} resolved a different ${colors.keyword("@cireilclaw/sdk")} copy ` +
      `(plugin: ${colors.keyword(pluginSdkVersion)} at ${colors.keyword(pluginSdkPkg)}; ` +
      `runtime: ${colors.keyword(RUNTIME_SDK_VERSION)} at ${colors.keyword(RUNTIME_SDK_PKG)}). ` +
      `Two copies break instanceof checks and schema identity even at matching versions. ` +
      `Run ${colors.keyword("pnpm dedupe")} or ensure the plugin uses the runtime's SDK.`,
  );
}

async function resolveEntryUrl(
  entry: PluginEntry,
): Promise<{ id: string; pluginPkgPath: string; url: URL }> {
  if (entry.name !== undefined) {
    const dir = path.join(root(), "plugins", entry.name);
    const pkgPath = path.join(dir, "package.json");
    if (!existsSync(pkgPath)) {
      throw new Error(
        `Plugin ${colors.keyword(entry.name)} not found at ${colors.keyword(dir)}. ` +
          `Clone it there: git clone <url> ${dir}`,
      );
    }
    if (!existsSync(path.join(dir, "node_modules"))) {
      throw new Error(
        `Plugin ${colors.keyword(entry.name)} is missing dependencies. ` +
          `Run: cd ${dir} && pnpm install`,
      );
    }
    const req = createRequire(pkgPath);
    return { id: entry.name, pluginPkgPath: pkgPath, url: pathToFileURL(req.resolve(".")) };
  }

  const pkgPath = await ensureLocalPackageJson();
  const req = createRequire(pkgPath);
  const { package: pkgName } = entry;
  if (pkgName === undefined) {
    throw new Error("Plugin entry has neither name nor package");
  }
  try {
    return { id: pkgName, pluginPkgPath: pkgPath, url: pathToFileURL(req.resolve(pkgName)) };
  } catch {
    throw new Error(
      `Plugin package ${colors.keyword(pkgName)} is not installed. ` +
        `Run: cd ${root()} && pnpm add ${pkgName}`,
    );
  }
}

interface PluginLoadResult {
  allowOverride: boolean;
  name: string;
  tools: Record<string, ToolDef>;
}

class PluginProcess {
  public readonly id: string;
  public readonly ready: Promise<ManifestPayload>;
  public extractorEntries: { glob: string; priority?: number }[] = [];
  private readonly worker: Worker;
  private readonly rpc: RpcChannel;
  private readonly pending = new Map<string, ToolContext>();
  private nextInvocation = 1;

  public constructor(id: string, worker: Worker, rpc: RpcChannel) {
    this.id = id;
    this.worker = worker;
    this.rpc = rpc;

    this.ready = new Promise<ManifestPayload>((resolve, reject) => {
      this.rpc.handle("manifest", (args) => {
        const [raw] = args;
        // Shape is the worker's ManifestPayload; trust the channel contract.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- internal RPC contract
        resolve(raw as ManifestPayload);
        return Promise.resolve(undefined);
      });
      this.rpc.handle("fatal", (args) => {
        const [message] = args;
        reject(new Error(`Plugin ${id} worker fatal: ${String(message)}`));
        return Promise.resolve(undefined);
      });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) {
          reject(new Error(`Plugin ${id} worker exited with code ${code}`));
        }
      });
    });

    // Persistent handlers: when the worker dies for any reason, reject in-flight RPC calls so
    // the engine's tool loop doesn't hang forever. RpcChannel.close() is idempotent.
    worker.on("exit", () => {
      this.rpc.close();
    });
    worker.on("error", () => {
      this.rpc.close();
    });

    this.registerCallbackHandlers();
  }

  public buildStubs(manifest: ManifestPayload, allowOverride: boolean): PluginLoadResult {
    const tools: Record<string, ToolDef> = {};
    for (const entry of manifest.tools) {
      const toolName = entry.name;
      tools[toolName] = {
        description: entry.description,
        execute: async (input, ctx): Promise<Record<string, unknown>> => {
          const invocationId = `${this.id}#${this.nextInvocation++}`;
          this.pending.set(invocationId, ctx);
          try {
            const ctxData: CtxData = {
              agentSlug: ctx.agentSlug,
              mounts: ctx.mounts,
              session: { channel: ctx.session.channel, id: ctx.session.id() },
            };
            const args: InvokeArgs = { ctx: ctxData, input, invocationId, toolName };
            try {
              return await this.rpc.call<Record<string, unknown>>(
                "invoke-tool",
                [args],
                INVOKE_TIMEOUT_MS,
              );
            } catch (error: unknown) {
              // Re-hydrate ToolError across the RPC boundary so the engine's instanceof check works.
              if (error instanceof Error && error.name === "ToolError") {
                const hint =
                  "hint" in error && typeof error.hint === "string" ? error.hint : undefined;
                throw new ToolError(error.message, hint);
              }
              throw error;
            }
          } finally {
            this.pending.delete(invocationId);
          }
        },
        jsonSchema: entry.jsonSchema,
        name: toolName,
        parameters: vb.unknown(),
      };
    }
    return { allowOverride, name: manifest.pluginName, tools };
  }

  public async extract(filePath: string, content: string): Promise<Section[]> {
    return await this.rpc.call<Section[]>("extract", [filePath, content]);
  }

  public async terminate(): Promise<void> {
    this.rpc.close();
    await this.worker.terminate();
  }

  private requireCtx(invocationId: unknown): ToolContext {
    if (typeof invocationId !== "string") {
      throw new TypeError("invocationId must be a string");
    }
    const ctx = this.pending.get(invocationId);
    if (ctx === undefined) {
      throw new Error(`Unknown invocationId: ${invocationId}`);
    }
    return ctx;
  }

  private registerCallbackHandlers(): void {
    this.rpc.handle("reply.send", async (args) => {
      const [invocationId, content, attachments] = args;
      await this.requireCtx(invocationId).reply.send(
        content as string,
        attachments as string[] | undefined,
      );
      return undefined;
    });
    this.rpc.handle("reply.react", async (args) => {
      const [invocationId, emoji, messageId] = args;
      const { react } = this.requireCtx(invocationId).reply;
      if (react === undefined) {
        throw new Error("react not supported on this channel");
      }
      await react(emoji as string, messageId as string | undefined);
      return undefined;
    });
    this.rpc.handle("channel.resolveChannel", async (args) => {
      const [invocationId, spec] = args;
      const resolved = await this.requireCtx(invocationId).channel.resolveChannel(spec as string);
      if ("error" in resolved) {
        return { error: resolved.error };
      }
      return { channel: resolved.channel, id: resolved.id() };
    });
    this.rpc.handle("cfg.globalPlugin", async (args) => {
      const [invocationId, name] = args;
      return await this.requireCtx(invocationId).cfg.globalPlugin(name as string);
    });
    this.rpc.handle("cfg.agentPlugin", async (args) => {
      const [invocationId, name] = args;
      return await this.requireCtx(invocationId).cfg.agentPlugin(name as string);
    });
    this.rpc.handle("addImage", (args) => {
      const [invocationId, data, mediaType] = args;
      this.requireCtx(invocationId).addImage(data as Uint8Array, mediaType as string);
      return Promise.resolve(undefined);
    });
    this.rpc.handle("addVideo", (args) => {
      const [invocationId, data, mediaType] = args;
      this.requireCtx(invocationId).addVideo(data as Uint8Array, mediaType as string);
      return Promise.resolve(undefined);
    });
    this.rpc.handle("addToolMessage", (args) => {
      const [invocationId, content] = args;
      this.requireCtx(invocationId).addToolMessage(content as string);
      return Promise.resolve(undefined);
    });
    this.rpc.handle("paths.resolve", (args) => {
      const [invocationId, sandboxPath] = args;
      const ctx = this.requireCtx(invocationId);
      return Promise.resolve(sandboxToReal(sandboxPath as string, ctx.agentSlug, ctx.mounts));
    });
    this.rpc.handle("paths.checkWriteAccess", (args) => {
      const [invocationId, sandboxPath] = args;
      const ctx = this.requireCtx(invocationId);
      checkMountWriteAccess(sandboxPath as string, ctx.mounts ?? []);
      return Promise.resolve(undefined);
    });
    this.rpc.handle("paths.checkConditionalAccess", (args) => {
      const [invocationId, sandboxPath] = args;
      const ctx = this.requireCtx(invocationId);
      if (ctx.conditions !== undefined) {
        checkConditionalAccess(sandboxPath as string, ctx.agentSlug, ctx.conditions, ctx.session);
      }
      return Promise.resolve(undefined);
    });
    this.rpc.handle("fs.readTextFile", async (args) => {
      const [invocationId, sandboxPath] = args;
      const ctx = this.requireCtx(invocationId);
      const realPath = sandboxToReal(sandboxPath as string, ctx.agentSlug, ctx.mounts);
      if (ctx.conditions !== undefined) {
        checkConditionalAccess(sandboxPath as string, ctx.agentSlug, ctx.conditions, ctx.session);
      }
      return await readFile(realPath, "utf8");
    });
    this.rpc.handle("fs.writeTextFile", async (args) => {
      const [invocationId, sandboxPath, content] = args;
      const ctx = this.requireCtx(invocationId);
      const realPath = sandboxToReal(sandboxPath as string, ctx.agentSlug, ctx.mounts);
      checkMountWriteAccess(sandboxPath as string, ctx.mounts ?? []);
      if (ctx.conditions !== undefined) {
        checkConditionalAccess(sandboxPath as string, ctx.agentSlug, ctx.conditions, ctx.session);
      }
      await mkdir(path.dirname(realPath), { recursive: true });
      await writeFile(realPath, content as string, "utf8");
      return undefined;
    });
    this.rpc.handle("fs.stat", async (args) => {
      const [invocationId, sandboxPath] = args;
      const ctx = this.requireCtx(invocationId);
      const realPath = sandboxToReal(sandboxPath as string, ctx.agentSlug, ctx.mounts);
      if (ctx.conditions !== undefined) {
        checkConditionalAccess(sandboxPath as string, ctx.agentSlug, ctx.conditions, ctx.session);
      }
      const stats = await stat(realPath);
      return {
        ctimeMs: stats.ctimeMs,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        mtimeMs: stats.mtimeMs,
        size: stats.size,
      };
    });
    this.rpc.handle("fs.listDir", async (args) => {
      const [invocationId, sandboxPath] = args;
      const ctx = this.requireCtx(invocationId);
      const realPath = sandboxToReal(sandboxPath as string, ctx.agentSlug, ctx.mounts);
      if (ctx.conditions !== undefined) {
        checkConditionalAccess(sandboxPath as string, ctx.agentSlug, ctx.conditions, ctx.session);
      }
      const entries = await readdir(realPath, { withFileTypes: true });
      return entries.map((entry) => ({
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        name: entry.name,
      }));
    });
    this.rpc.handle("crypto.loadNormalizedKey", async (args) => {
      const [invocationId, opts] = args;
      const ctx = this.requireCtx(invocationId);
      const raw = opts as { path?: string; data?: string; kind?: string };

      let rawKey = "";
      if (typeof raw.path === "string") {
        const realPath =
          raw.kind === "host"
            ? path.normalize(raw.path)
            : sandboxToReal(raw.path, ctx.agentSlug, ctx.mounts);
        if (ctx.conditions !== undefined) {
          checkConditionalAccess(raw.path, ctx.agentSlug, ctx.conditions, ctx.session);
        }
        rawKey = await readFile(realPath, "utf8");
      } else if (typeof raw.data === "string") {
        rawKey = raw.data;
      } else {
        throw new TypeError("crypto.loadNormalizedKey requires either `path` or `data`");
      }

      // Try as private key (auto-detects PKCS#1, PKCS#8, SEC1).
      try {
        const key = createPrivateKey(rawKey);
        return {
          data: key.export({ format: "pem", type: "pkcs8" }),
          format: "pkcs8",
        };
      } catch {
        // Not a private key.
      }

      const pubKey = createPublicKey(rawKey);
      return {
        data: pubKey.export({ format: "pem", type: "spki" }),
        format: "spki",
      };
    });
  }
}

const activePlugins: PluginProcess[] = [];

async function spawnPluginProcess(entry: PluginEntry): Promise<PluginProcess> {
  const { id, pluginPkgPath, url } = await resolveEntryUrl(entry);
  assertSdkMatches(id, pluginPkgPath);
  const worker = new Worker(WORKER_URL, {
    execArgv: process.execArgv,
    workerData: { entryUrl: url.href, pluginId: id },
  });
  const rpc = new RpcChannel(worker);
  return new PluginProcess(id, worker, rpc);
}

async function loadPlugins(): Promise<PluginLoadResult[]> {
  const config = await loadPluginsConfig();
  const results: PluginLoadResult[] = [];
  for (const entry of config.plugins) {
    const proc = await spawnPluginProcess(entry);
    try {
      const manifest = await proc.ready;
      if (manifest.extractors !== undefined) {
        proc.extractorEntries = manifest.extractors.map((ext) => ({
          glob: ext.glob,
          priority: ext.priority ?? 0,
        }));
      }
      activePlugins.push(proc);
      results.push(proc.buildStubs(manifest, entry.allowOverride));
    } catch (error) {
      await proc.terminate().catch(() => undefined);
      throw error;
    }
  }
  return results;
}

function mergeToolRegistries(
  builtinRegistry: Record<string, ToolDef>,
  pluginResults: PluginLoadResult[],
): Record<string, ToolDef> {
  // Registry merge is single-process / single-harness by design.
  const merged: Record<string, ToolDef> = { ...builtinRegistry };
  for (const { allowOverride, name: pluginName, tools } of pluginResults) {
    for (const [toolName, toolDef] of Object.entries(tools)) {
      const existingBuiltin = builtinRegistry[toolName];
      if (existingBuiltin !== undefined && !allowOverride) {
        throw new Error(
          `Plugin ${colors.keyword(pluginName)} tool ${colors.keyword(toolName)} collides with builtin. ` +
            `Set allowOverride = true in plugins.toml to permit this.`,
        );
      }
      const existingPlugin = merged[toolName];
      if (existingPlugin !== undefined && existingBuiltin === undefined) {
        throw new Error(
          `Plugin ${colors.keyword(pluginName)} tool ${colors.keyword(toolName)} collides with another plugin. ` +
            `Tool name collisions between plugins are not allowed.`,
        );
      }
      merged[toolName] = toolDef;
    }
  }
  return merged;
}

async function initializePlugins(): Promise<void> {
  const pluginResults = await loadPlugins();
  if (pluginResults.length > 0) {
    const merged = mergeToolRegistries(builtinToolRegistry, pluginResults);
    setToolRegistry(merged);
    const toolNames = pluginResults.flatMap((plugin) => Object.keys(plugin.tools));
    info(
      "Loaded",
      colors.number(pluginResults.length),
      "plugins with",
      colors.number(toolNames.length),
      "tools:",
      toolNames.join(", "),
    );

    // Register plugin extractors — forward extraction calls to the worker via RPC.
    for (const proc of activePlugins) {
      for (const extractor of proc.extractorEntries) {
        registerExtractor({
          extract: async (filePath: string, content: string) =>
            await proc.extract(filePath, content),
          glob: extractor.glob,
          priority: extractor.priority ?? 0,
        });
      }
    }
  }
}

async function destroyPlugins(): Promise<void> {
  const procs = activePlugins.splice(0);
  await Promise.all(
    procs.map(async (proc) => {
      try {
        await proc.terminate();
      } catch (error) {
        warning(`Plugin ${proc.id} terminate failed:`, String(error));
      }
    }),
  );
}

export { destroyPlugins, initializePlugins, loadPlugins, mergeToolRegistries, PluginProcess };
