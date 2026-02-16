# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is cireilclaw?

An opinionated, security-focused agent system for running sandboxed AI assistants across multiple channels (Discord, Matrix). Emphasizes safety (least privilege, bubblewrap sandboxing), sanity (debuggable code), speed, and composability (hot-reloadable config, no code edits needed). Features multi-agent orchestration, persistent session management, vision API support with image preprocessing, and extensible tool system.

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

CLI (`@stricli/core`) → Config (TOML) → Harness (multi-channel) → Agent (per-channel sessions) → Engine → OpenAI-compatible API

### Channel Support

- **Discord** — Full integration via oceanic.js with message handling, image attachments, typing indicators, and automatic message chunking.
- **Matrix** — Session support (implementation via harness abstraction).

### Turn Execution

Each agent turn:

1. Loads config (engine settings, tool toggles)
2. Builds system prompt from core instructions + memory blocks + skills + opened files
3. Runs tool loop with OpenAI-compatible API
4. Processes tool outputs (file I/O, exec, search, respond)
5. Persists session to SQLite

### Key Modules

- **`src/engine/`** — LLM interaction core. Builds system prompts from base instructions + memory blocks + opened files + skills, manages tool registry, calls OpenAI-compatible APIs via `src/engine/provider/oai.ts`.
- **`src/engine/tools/`** — Extensible tool system (10+ tools). Each tool implements `ToolDef` with a Valibot schema. Tools include: `read`, `write`, `open-file`, `close-file`, `str-replace`, `list-dir`, `exec` (sandboxed), `brave-search`, `read-skill`, and `respond`.
- **`src/agent/`** — Wraps Engine with a slug identifier and per-channel session management.
- **`src/harness/`** — Multi-agent orchestrator with file watcher for config hot-reload. Manages both Discord and Matrix channels. Delegates to channel handlers for sending responses.
- **`src/harness/session.ts`** — Abstract session base class with Discord and Matrix implementations. Tracks conversation history and channel-specific metadata (e.g., NSFW flags, typing intervals).
- **`src/channels/discord.ts`** — Discord integration with oceanic.js. Handles message creation/updates/deletes, image attachment fetching, typing indicators, and message chunking for Discord's 2000-char limit.
- **`src/config/`** — Loads and validates TOML config (engine settings, tool toggles) via Valibot. Watches both global and agent-specific config directories.
- **`src/db/`** — SQLite session persistence with Drizzle ORM. WAL-mode enabled for concurrent read safety.
- **`src/util/paths.ts`** — Sandbox enforcement. Only 4 paths are allowed: `/blocks/`, `/memories/`, `/workspace/`, `/skills/`. Prevents symlink escape and path traversal. Maps sandbox paths to real filesystem under `~/.cireilclaw/`.
- **`src/util/sandbox.ts`** — Bubblewrap sandbox builder. NixOS-aware with `nix-store` queries for dependency binding. Generic Linux fallback binds `/usr`, `/bin`, `/lib`.
- **`src/util/load.ts`** — Loads memory blocks (person, identity, long-term, soul) and skills with TOML frontmatter + markdown content into the system prompt.
- **`src/util/image.ts`** — WebP image conversion (quality 90) for vision API. Handles format conversion and buffer management.
- **`src/output/`** — Logging and color utilities for console output.
- **`src/cli/`** — CLI commands built with `@stricli/core`. `init` sets up a new agent, `run` watches config, `clear` clears session history.

### Agent Directory Layout (`~/.cireilclaw/agents/{slug}/`)

```
blocks/          # Memory blocks (person.md, identity.md, long-term.md, soul.md)
config/          # engine.toml (API config), tools.toml (tool toggles)
core.md          # Base system instructions
skills/          # Reusable skill documents (markdown with TOML frontmatter)
workspace/       # Sandboxed workspace for agent operations
memories/        # Session-specific memory (persisted across turns)
```

### Persistence

Session history and state are persisted to `~/.cireilclaw/sessions.db` (SQLite with WAL mode) via Drizzle ORM migrations. This allows agents to maintain context across restarts per channel/guild.

### Validation

Valibot is used throughout for schema validation — config parsing, tool input validation, and `@valibot/to-json-schema` for generating JSON schemas from Valibot definitions.

## Code Style

- Comments explain _why_, not _what_ or _how_.
- TypeScript strict mode with `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`.
- Use `import type` for type-only imports (enforced by `verbatimModuleSyntax`).
