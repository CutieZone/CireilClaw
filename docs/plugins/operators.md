# Plugins: Operator Guide

You are installing and running plugins that somebody else wrote. This document covers the install flow, `plugins.toml` syntax, and troubleshooting.

Plugins are trusted host extensions. They are not sandboxed like agent tool calls, and installing one moves trust to the plugin author. Only install plugins you would be comfortable running as local Node code.

If you are _writing_ a plugin, see [`developers.md`](developers.md).

## Two Install Modes

A plugin entry in `plugins.toml` is either a npm package or a local directory. Pick exactly one per entry.

### Npm Package

For plugins published to npm (scope or otherwise):

```bash
cd ~/.cireilclaw
pnpm add @cireilclaw/plugin-brave-search
```

`~/.cireilclaw/` is its own tiny pnpm project; the runtime creates a skeleton `package.json` on first use if one doesn't exist. The plugin's SDK `peerDep` (`@cireilclaw/sdk`) auto-installs because pnpm v7+ defaults to `auto-install-peers=true`.

Then add the entry to `~/.cireilclaw/config/plugins.toml`:

```toml
[[plugins]]
package = "@cireilclaw/plugin-brave-search"
```

### Local Git Clone

For plugins that aren't on npm, or plugins you're developing:

```bash
git clone https://github.com/someone/cireilclaw-plugin-foo ~/.cireilclaw/plugins/foo
cd ~/.cireilclaw/plugins/foo
pnpm install
```

Then:

```toml
[[plugins]]
name = "foo"    # resolves to ~/.cireilclaw/plugins/foo/
```

The runtime enforces: if a plugin ships only TypeScript (no `dist/`), it won't run. Published plugins always ship prebuilt JS via their `publishConfig`; for git-cloned dev plugins, run their `pnpm build` first.

## Optional Entry Flags

```toml
[[plugins]]
package = "@cireilclaw/plugin-replacement-respond"
allowOverride = true
stateQuotaBytes = 16777216  # 16 MiB; default if omitted
```

`allowOverride` permits this plugin's tools to shadow built-in tools of the same name. Without it, a name collision against a builtin fails loudly at startup. Two plugins with the same tool name always fail regardless.

Treat overrides as security-sensitive: replacing a built-in tool changes part of the boundary CireilClaw presents to the agent.

`stateQuotaBytes` caps the total size of `ctx.pluginState` files per agent for this plugin. Defaults to `16 MiB`. The plugin never sees the host path or the quota value; on overflow its `writeText` call rejects with an error.

## Plugin State

`ctx.pluginState` is private, persistent per-`(agent, plugin)` storage. Files live under:

```
~/.cireilclaw/agents/<agent-slug>/state/<plugin-slug>/
```

The plugin only supplies a relative name; the runtime derives the agent and plugin namespaces. A `.id` file inside that folder records the plugin id (used for collision detection and reverse mapping when an operator needs to identify a state folder manually). Plugins cannot read, write, or remove `.id`.

State survives restarts. The folder itself is deleted only when an operator removes it manually or when the agent is uninstalled; `ctx.pluginState.remove` deletes contents, never the folder.

State is not reachable from `ctx.fs` (the sandbox) and is not bind-mounted into the bubblewrap exec sandbox.

## Plugin Configuration

Changes to `plugins.toml` require a full process restart. They are not hot-reloaded like agent configs.

Each plugin reads its own config via `ctx.cfg.globalPlugin(name)` and `ctx.cfg.agentPlugin(name)`. By convention these live at:

- `~/.cireilclaw/config/plugins/<name>.toml`: global
- `~/.cireilclaw/agents/<slug>/config/plugins/<name>.toml`: per-agent override

The plugin decides what `<name>` it uses and what keys it expects. Read the plugin's README.

## SDK Version Matching

Every plugin declares `@cireilclaw/sdk` as a `peerDep` with a semver range (typically `^0.2.0`). At load time, the runtime computes the realpath of the plugin's resolved `@cireilclaw/sdk/package.json` and compares it to its own. If they differ, it **refuses to load** and prints both paths and versions.

Even matching versions fail if there are two _copies_ of the SDK, since `instanceof` checks and Valibot schema identity don't cross a module-cache boundary.

### `pnpm dedupe` Troubleshooting

```
Plugin @cireilclaw/plugin-foo resolved a different @cireilclaw/sdk copy
  (plugin: 0.2.0 at /.../sdk-0.2.0/package.json;
   runtime: 0.2.0 at /.../sdk-0.2.1/package.json).
Two copies break instanceof checks and schema identity even at matching versions.
Run `pnpm dedupe` or ensure the plugin uses the runtime's SDK.
```

Fix:

```bash
cd ~/.cireilclaw
pnpm dedupe
```

If `pnpm dedupe` can't collapse the copies (different semver ranges), update the plugin to a version that matches the runtime's SDK major/minor. During `0.x`, treat every SDK minor bump as breaking.

## Shutdown

`Ctrl-C` triggers `destroyPlugins()`, which closes RPC channels and terminates worker threads. If workers hang, `Ctrl-C` a second time force-exits.

## Troubleshooting

### `Plugin <name> not found at <dir>`

You listed `name = "..."` but the directory doesn't exist at `~/.cireilclaw/plugins/<name>/`. Clone it there or fix the name.

### `Plugin <name> is missing dependencies`

The plugin directory exists, but has no `node_modules/`. Run `pnpm install` inside the plugin dir.

### `Plugin package <pkg> is not installed`

You listed `package = "..."` but haven't run `pnpm add <pkg>` in `~/.cireilclaw/`. Do that.

### `Plugin <name> cannot resolve @cireilclaw/sdk`

The plugin's peerDep isn't installed. For npm plugins this normally auto-installs; check `auto-install-peers` in your `.npmrc`. For git-cloned plugins, `pnpm install` in the plugin dir.
