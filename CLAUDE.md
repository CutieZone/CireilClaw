# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is cireilclaw?

An opinionated, security-focused agent system for running sandboxed AI assistants across multiple channels (Discord, Matrix). Emphasizes safety (least privilege, bubblewrap sandboxing), sanity (debuggable code), speed, and composability (hot-reloadable config, no code edits needed).

## Commands

```bash
pnpm start              # Run via tsx (tsx ./src/entrypoint.ts)
pnpm lint               # Lint with OxLint (type-aware)
pnpm lint:fix           # Lint and auto-fix
pnpm format             # Format with OxFmt
```

There is no build step for development — `tsx` runs TypeScript directly. There is no test framework configured.

## Development Environment

NixOS-based — `flake.nix` provides nodejs, pnpm, and bubblewrap via direnv. Use `pnpm` as the package manager.

## Path Alias

`$/*` maps to `./src/*` in tsconfig (e.g., `import { foo } from "$/engine/index.ts"`).

## Architecture

### Core Flow

CLI (`@stricli/core`) → Config (TOML) → Harness → Agent → Engine → OpenAI-compatible API

### Key Modules

- **`src/engine/`** — LLM interaction core. Builds system prompts from base instructions + memory blocks + opened files, manages tool registry, calls OpenAI-compatible APIs via `src/engine/provider/oai.ts`.
- **`src/engine/tools/`** — Extensible tool system. Each tool implements `ToolDef` with a Valibot schema. Tools are registered centrally and toggled per-agent via `tools.toml`.
- **`src/agent/`** — Wraps Engine with a slug identifier and per-channel session management.
- **`src/harness/`** — Multi-agent orchestrator with file watcher for config hot-reload. Sessions are abstract with Discord and Matrix implementations.
- **`src/config/`** — Loads and validates TOML config (engine settings, tool toggles) via Valibot. Watches both global and agent-specific config directories.
- **`src/util/paths.ts`** — Sandbox enforcement. Only 4 paths are allowed: `/blocks/`, `/memories/`, `/workspace/`, `/skills/`. Prevents symlink escape and path traversal. Maps sandbox paths to real filesystem under `~/.cireilclaw/`.
- **`src/util/load.ts`** — Loads memory blocks (person, identity, long-term, soul) with TOML frontmatter + markdown content into the system prompt.
- **`src/cli/`** — CLI commands built with `@stricli/core`. `init` sets up a new agent, `run` watches config.

### Agent Directory Layout (`~/.cireilclaw/agents/{slug}/`)

```
blocks/          # Memory blocks (person.md, identity.md, long-term.md, soul.md)
config/          # engine.toml (API config), tools.toml (tool toggles)
core.md          # Base system instructions
```

### Validation

Valibot is used throughout for schema validation — config parsing, tool input validation, and `@valibot/to-json-schema` for generating JSON schemas from Valibot definitions.

## Code Style

- Comments explain _why_, not _what_ or _how_.
- TypeScript strict mode with `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`.
- Use `import type` for type-only imports (enforced by `verbatimModuleSyntax`).
