# Plugins

`cireilclaw` supports third-party plugins that extend the agent with new tools. Each plugin runs in its own Node worker thread; the runtime talks to it over a small RPC layer. Tool invocations cross the boundary, callbacks (sending replies, reading config, fetching channel history) come back as RPCs.

## Trust Model

Worker isolation only buys _crash isolation_ and a _clean API boundary_, not a security boundary. Plugins still have full Node API access: they can read your filesystem, open network sockets, etc.

Sooo... Only install plugins you trust. Subprocess sandboxing (e.g. `bubblewrap`) is not yet implemented.

## Two Kinds of Audience

- [Operators](plugins/operators.md): if you're installing and running plugins someone else wrote. You want the install flow, `plugins.toml` syntax, and troubleshooting.
- [Developers](plugins/developers.md): if you're writing a plugin. You want the SDK reference, the `PluginToolContext` surface, publishing mechanics, and the isolation caveats (KeyPool divergence being the primary one).

## Quick Reference

- SDK package: [`@cireilclaw/sdk`](https://www.npmjs.com/package/@cireilclaw/sdk), version `0.x`, breaking changes allowed on every minor bump.
- Template: [`@cireilclaw/plugin-template`](https://www.npmjs.com/package/@cireilclaw/plugin-template), copy the code from this to start a new plugin.
- Reference plugin: [`@cireilclaw/plugin-brave-search`](https://www.npmjs.com/package/@cireilclaw/plugin-brave-search), the official CireilClaw Brave Search integration, migrated out of the runtime in the 0.2.0 era.
- Config file: `~/.cireilclaw/config/plugins.toml`. Every plugin must be explicitly listed — there is no auto-discovery.

## Future Plans

- WASM (probably likelier than the alternative)
- subprocess + `bwrap`
