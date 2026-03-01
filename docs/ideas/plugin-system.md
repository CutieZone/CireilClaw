# Plugin System

A way to add tools (and more) without touching core code.

## Plugin contract

```typescript
// src/engine/plugin.ts
interface Plugin {
  name: string;
  tools?: Record<string, ToolDef>;
  // Future: systemPromptContributions?, schedulerHooks?
}
```

Deliberately minimal. Tools are the most natural first extension point — `ToolDef` is already clean and stable.

## Loading: file-based dynamic imports

Add `~/.cireilclaw/plugins/` and a global manifest:

```toml
# ~/.cireilclaw/config/plugins.toml
plugins = [
  "/home/user/.cireilclaw/plugins/my-tool.js",
  # or npm packages: "cireilclaw-plugin-weather"
]
```

A `loadPlugins()` function dynamically `import()`s each path, validates the export against `Plugin`, and returns the merged tool map. This runs once at startup before the harness boots.

## Integration point

`toolRegistry` in `engine/tools/index.ts` is currently a static import. It becomes a runtime-built map in `Harness.init()`:

```typescript
const pluginTools = await loadPlugins();
const registry = { ...builtinToolRegistry, ...pluginTools };
```

Plugin tools then appear in the registry like any built-in. Per-agent `tools.toml` handles enable/disable the same way — no plugin-specific config layer needed.

## Hot-reload

ESM caches imports by URL. Cache-busting (`import(\`${path}?v=${Date.now()}\`)`) is a hack. Plugin changes require a process restart — document it, don't engineer around it. Everything else in the system hot-reloads; plugins are the deliberate exception.

## Security

Plugins run with full host process permissions. They are **not** sandboxed. Bubblewrap already handles the AI's tool execution — plugin authors are trusted developers, not the AI. Document this clearly in the plugin API.

## Future extension points

Beyond tools, two other natural seams exist:

**System prompt contributions** — `buildSystemPrompt()` in `engine/index.ts` is a procedural builder. Plugins could contribute blocks via a `systemPromptBlocks?(session: Session): Promise<string>` hook. Low-complexity addition.

**Channel handlers** — Plugins could register new channel types (beyond Discord/Matrix). Higher complexity — requires `Harness` to be more abstract about channel initialization. Probably a v2 concern.

## What to skip

- WASM/subprocess isolation for plugins — "debuggable" is a core value and bubblewrap already covers the AI's own execution surface.
- Plugin-provided config schemas — keeps validation complexity in core.
- Auto-discovery (scanning a dir without a manifest) — an explicit `plugins.toml` list is better for the security-focused ethos. You know exactly what's loaded.

## Scope

Minimum viable: `plugins.toml` + `loadPlugins()` + merge into registry. ~100 lines of new code, no changes to existing tool files.
