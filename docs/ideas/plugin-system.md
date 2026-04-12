# Plugin System

A way to add tools (and more) without touching core code.

## Package split: `@cireilclaw/sdk` and `cireilclaw-runtime`

To let plugins import types, utilities, and shared logic without depending on the full application, CireilClaw becomes a pnpm workspace monorepo with two packages:

- **`packages/sdk/`** (`@cireilclaw/sdk`) — The public surface: type definitions, re-exported Valibot, `definePlugin()` helper, and shared utilities (sandboxing, path resolution, image processing, etc.). Everything a plugin author builds against.
- **`packages/runtime/`** (`cireilclaw-runtime`) — The application itself (harness, channels, engine, DB, CLI). Depends on `@cireilclaw/sdk`. Implements the concrete classes behind the SDK's interfaces.

### What lives in `-sdk`

```typescript
// packages/sdk/src/index.ts
export { definePlugin } from "./plugin.ts";
export type { Plugin, PluginFactory } from "./plugin.ts";
export type { Tool, ToolDef, ToolContext } from "./tool.ts";
export type { PluginSession } from "./session.ts";

// Re-export valibot so plugin authors don't need to install it separately
export * as v from "valibot";

// Shared utilities — usable by both plugins and runtime
export { resolveSandboxPath, allowedPaths } from "./paths.ts";
export { buildSandbox } from "./sandbox.ts";
export { convertToWebP } from "./image.ts";
```

The key abstraction: `PluginSession` is a narrow interface extracted from `BaseSession` — only the surface plugins should see:

```typescript
// packages/sdk/src/session.ts
interface PluginSession {
  readonly channel: "discord" | "matrix" | "internal";
  readonly history: ReadonlyArray<Message>;
  readonly openedFiles: ReadonlySet<string>;
  id(): string;
}
```

`BaseSession` in `-runtime` implements `PluginSession`. Plugin authors never see `pendingToolMessages`, `busy`, `typingInterval`, or any other internal state.

### What lives in `-runtime`

Everything that's application-specific: harness, channel handlers, engine loop, DB layer, CLI. The only structural change: `BaseSession implements PluginSession`, and `ToolContext.session` is typed as `PluginSession` at the plugin boundary (internally it's still the full `BaseSession`). Utilities that were in `src/util/` move to `-sdk`; `-runtime` imports them from there.

## Plugin contract

```typescript
// packages/sdk/src/plugin.ts
import type { ToolDef } from "./tool.ts";

interface Plugin {
  name: string;
  tools?: Record<string, ToolDef>;
  // Future: systemPromptBlocks?, channelHandlers?
}

type PluginFactory = () => Plugin | Promise<Plugin>;

function definePlugin(factory: PluginFactory): PluginFactory {
  return factory;
}
```

Plugin authors write:

```typescript
import { definePlugin, v } from "@cireilclaw/sdk";

export default definePlugin(() => ({
  name: "weather",
  tools: {
    weather: {
      name: "weather",
      description: "Get current weather for a location",
      parameters: v.object({ location: v.string() }),
      execute: async (input, ctx) => {
        // ctx.session is PluginSession — typed, autocomplete works
        return { temperature: 72 };
      },
    },
  },
}));
```

Plugin authors reference `-sdk` as a path dependency:

```json
{ "dependencies": { "@cireilclaw/sdk": "file:../cireilclaw/packages/sdk" } }
```

Or a git URL for remote plugin authors. No npm publish needed.

## Loading: file-based dynamic imports

```toml
# ~/.cireilclaw/config/plugins.toml
[[plugins]]
path = "/home/user/.cireilclaw/plugins/my-tool.js"

[[plugins]]
path = "cireilclaw-plugin-custom-exec"
allowOverride = true  # this plugin may replace builtin tools
```

`allowOverride` is an operator-level flag — the person deploying the instance decides which plugins are trusted to shadow builtins. If a plugin's tool names collide with builtins and `allowOverride` is not set, loading fails with an error.

A `loadPlugins()` function dynamically `import()`s each path, validates the export is a `PluginFactory`, calls it, and returns the merged tool map. This runs once at startup before the harness boots.

## Integration point

`toolRegistry` in `engine/tools/index.ts` is currently a static import. It becomes a runtime-built map in `Harness.init()`:

```typescript
const pluginTools = await loadPlugins();
const registry = mergeToolRegistries(builtinToolRegistry, pluginTools);
```

`mergeToolRegistries` checks for key collisions — plugins without `allowOverride` cannot shadow builtins. Plugin tools then appear in the registry like any built-in. Per-agent `tools.toml` handles enable/disable the same way — no plugin-specific config layer needed.

## Hot-reload

ESM caches imports by URL. Cache-busting (`import(`${path}?v=${Date.now()}`)`) is a hack. Plugin changes require a process restart — document it, don't engineer around it. Everything else in the system hot-reloads; plugins are the deliberate exception.

## Security

Plugins run with full host process permissions. They are **not** sandboxed. Bubblewrap already handles the AI's tool execution — plugin authors are trusted developers, not the AI. Document this clearly in the plugin API.

## Future extension points

Beyond tools, two other natural seams exist:

**System prompt contributions** — `buildSystemPrompt()` in `engine/index.ts` is a procedural builder. Plugins could contribute blocks via a `systemPromptBlocks?(session: PluginSession): Promise<string>` hook. Low-complexity addition.

**Channel handlers** — Plugins could register new channel types (beyond Discord/Matrix). Higher complexity — requires `Harness` to be more abstract about channel initialization. Probably a v2 concern.

## What to skip

- WASM/subprocess isolation for plugins — "debuggable" is a core value and bubblewrap already covers the AI's own execution surface.
- Plugin-provided config schemas — keeps validation complexity in core.
- Auto-discovery (scanning a dir without a manifest) — an explicit `plugins.toml` list is better for the security-focused ethos. You know exactly what's loaded.
- Publishing `-sdk` to npm — path/git references are sufficient until there's external demand.

## Scope

The package split is the structural prerequisite. Once that's done, the plugin loader itself is ~100 lines: `plugins.toml` parsing + `loadPlugins()` + merge into registry. The split also pays for itself independently — it enforces a clean boundary between "what's public API" and "what's internal."
