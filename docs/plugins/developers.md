# Plugins: Developer Guide

You are writing a plugin. This document covers the SDK surface, authoring conventions, publishing mechanics, and the caveats of worker isolation.

If you are _installing_ a plugin, see [`operators.md`](operators.md).

## Starting a New Plugin

The fastest path is to fork `@cireilclaw/plugin-template`:

```bash
git clone https://github.com/CutieZone/CireilClaw
cp -r CireilClaw/packages/template cireilclaw-plugin-myname
cd cireilclaw-plugin-myname
# edit package.json: rename to @yourscope/plugin-myname
pnpm install
```

Or start from scratch with the minimal `package.json`:

```json
{
  "name": "@yourscope/plugin-myname",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "files": ["src", "dist"],
  "scripts": { "build": "tsdown", "prepublishOnly": "tsdown" },
  "publishConfig": {
    "access": "public",
    "main": "./dist/index.mjs",
    "types": "./dist/index.d.mts",
    "exports": {
      ".": { "types": "./dist/index.d.mts", "default": "./dist/index.mjs" }
    }
  },
  "peerDependencies": { "@cireilclaw/sdk": "^0.2.0" },
  "devDependencies": {
    "@cireilclaw/sdk": "^0.2.0",
    "tsdown": "^0.21.7",
    "typescript": "^6.0.2"
  }
}
```

The `publishConfig` swap is the trick that keeps dev easy: you author in TypeScript under `src/`, but the published tarball advertises `dist/index.mjs` + `.d.mts` so consumers get prebuilt JS without a tsx runtime. `tsdown` emits both on `prepublishOnly`.

### The `@cireilclaw` Scope

To be allowed to publish under the `@cireilclaw` scope, you must be a contributor to the main CireilClaw project, as well as trusted by the primary maintainer(s).

## Authoring a Plugin

```typescript
import { definePlugin, ToolError, vb } from "@cireilclaw/sdk";

const SearchSchema = vb.strictObject({
  query: vb.pipe(vb.string(), vb.nonEmpty()),
  count: vb.optional(vb.pipe(vb.number(), vb.integer(), vb.minValue(1), vb.maxValue(20)), 5),
});

export default definePlugin(() => ({
  name: "example",
  tools: {
    "example-search": {
      name: "example-search",
      description: "Search for stuff.",
      parameters: SearchSchema,
      async execute(rawInput, ctx) {
        const input = vb.parse(SearchSchema, rawInput);
        const config = await ctx.cfg.globalPlugin("example");
        if (config?.apiKey === undefined) {
          throw new ToolError("example plugin is not configured");
        }

        const response = await ctx.net.fetch(
          `https://example.com/search?q=${encodeURIComponent(input.query)}`,
          {
            headers: { Authorization: `Bearer ${config.apiKey}` },
          },
        );
        if (!response.ok) {
          throw new ToolError(`example API returned ${response.status}`);
        }

        return { success: true, results: await response.json() };
      },
    },
  },
}));
```

Conventions:

- **Validate input with Valibot inside `execute`.** The runtime does not pre-validate. Parse the raw `input` against your schema; unknown shape → `ToolError`.
- **Throw `ToolError` for anything the model should see as a failed tool call.** Regular `Error` also works, but `ToolError` is the idiomatic "this is a tool-level failure, tell the model" signal.
- **Return shape is `{ success: true, ... }` for success.** For failures, either throw `ToolError` or return `{ success: false, error, hint? }`.
- **Use `ctx.net.fetch`, not global `fetch`.** Same behavior today, but this is the mediation point for future work.

## `PluginToolContext` Surface

Every tool's `execute(input, ctx)` receives a `PluginToolContext`:

```typescript
interface PluginToolContext {
  agentSlug: string;
  session: BasicSession; // { channel, id(): string }
  reply: {
    send(content: string, attachments?: string[]): Promise<void>;
    react?(emoji: string, messageId?: string): Promise<void>;
  };
  channel: {
    resolveChannel(spec: string): Promise<ChannelResolution>;
  };
  cfg: {
    globalPlugin(name: string): Promise<Record<string, unknown> | undefined>;
    agentPlugin(name: string): Promise<Record<string, unknown> | undefined>;
  };
  createKeyPool(keys: string | string[], cooldownMs?: number): KeyPool;
  net: { fetch: typeof fetch };
  mounts?: readonly Mount[];
  addImage(data: Uint8Array, mediaType: string): void;
  addVideo(data: Uint8Array, mediaType: string): void;
  addToolMessage(content: string): void;
}
```

Notes:

- `session` is deliberately narrow. Plugins do not see conversation history, opened files, or channel-specific internals.
- `reply.react` is optional, since not every channel supports it. Check for `undefined` before calling.
- `createKeyPool` returns a per-worker instance (see caveats below).

## SDK Exports

From `@cireilclaw/sdk`:

- `definePlugin(factory)`: an identity helper; gives you type inference.
- `Plugin`, `PluginFactory`: the factory's return shape.
- `ToolDef`, `Tool`, `ToolResult`, `ToolErrorResult`: tool definition types.
- `PluginToolContext`, `BasicSession`, `ChannelResolution`, `Mount`: context types.
- `KeyPool`, `KeyPoolManager`: API key rotation with cooldown.
- `ToolError`: semantic tool-failure exception.
- `toWebp`, `toJpeg`, `scaleForAnthropic`: image helpers for vision-capable agents.
- `vb`: reexport of `valibot`, so you don't need a separate dependency.

## Worker Isolation: What It Gives You, What It Doesn't

Each plugin runs in a dedicated Node worker thread. The runtime talks to it over a small RPC layer.

**What isolation buys:**

- **Crash isolation.** A plugin throwing inside `execute` rejects the RPC; the runtime keeps running.
- **Forced API discipline.** All callbacks (`reply.*`, `channel.*`, `cfg.*`, `addImage`, etc.) go through RPC. There is no way to reach into runtime internals from a plugin.

**What isolation does _not_ buy:**

- **Security.** Workers have full Node API access, so they can `import("node:fs")`, open network sockets, etc. The isolation prevents programming accidents, not malicious code.

### Caveats Worth Knowing

**`ctx.createKeyPool` is per-worker.** Each worker has its own `KeyPoolManager` singleton. Rate-limit state does not cross workers or reach the runtime. Fine if your plugin owns its keys. If two plugins share a key, failure tracking drifts silently.

**`ctx.net.fetch` runs locally in the worker.** It's `globalThis.fetch.bind(globalThis)` today. The surface is intentionally abstracted so that network mediation can be added later without changing plugin code.

**Fire-and-forget callbacks (`addImage`/`addVideo`/`addToolMessage`) don't await.** The RPC fires, you move on. If delivery matters, call them early in `execute`, not in a `finally`.

**`instanceof ToolError` does not cross the boundary.** Every module has its own copy of SDK classes inside the worker's module cache (even at the same realpath, Node workers have separate module state). Throw a `ToolError` inside `execute`; the runtime decodes the serialized form on the other side. Don't build logic on `err instanceof ToolError` in plugin code that catches its own errors. Instead, check `err.name === "ToolError"` if you must, or just rethrow.

## Publishing a Plugin

One-time:

```bash
npm login
npm whoami
```

Each release:

```bash
# bump version in package.json
pnpm publish --dry-run --no-git-checks     # inspect the tarball
pnpm publish --access public --otp=XXXXXX
```

`prepublishOnly` runs `tsdown` automatically; pnpm applies `publishConfig` to swap `main`/`exports` → `dist/` at publish time.

### Semver Policy During 0.X

The SDK is `0.x`, only bump **minor** on any breaking change. Plugins pin peerDep to `^0.x.0` (compatible with any `0.x.y`). When the SDK bumps to `0.(x+1).0`, you update your peerDep range and publish a new plugin version.

There is _no compatibility bridge_: the runtime's realpath check forbids two SDK copies even at the same version. Operators might need `pnpm dedupe` after your update; document this in your plugin's changelog.

## Debugging

**Stack traces across RPC.** Errors carry `message`, `name`, `stack`, and `hint`; stack traces are now preserved.

**Worker fatal errors.** If the plugin's initial load (factory call, manifest computation) throws, the worker sends a `fatal` RPC and exits with code 1. The runtime logs it and refuses to start. Fix: check your factory for throws and your tool schemas for Valibot errors.

**SDK version mismatch.** If the plugin fails to load with a `realpath`/version mismatch, the runtime prints both paths. Compare them, since one is coming from the plugin's `node_modules/` and the other from the runtime's. Run `pnpm dedupe` in `~/.cireilclaw/`, or update your `peerDep` range.

## Known Limitations

- No plugin lifecycle hooks (`onStart`, `onShutdown`).
- No crash recovery, so if a worker dies, the plugin is dead until process restart.
- No per-plugin sandboxing (network, filesystem).
- `ctx.net.fetch` is a local passthrough today.

Want any of these? File an issue. Subprocess+bubblewrap OR WASM is the natural next step and covers most of them.
