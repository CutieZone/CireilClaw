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
- **Matrix** — Stub only (`MatrixSession` class exists but no channel handler).
- **Internal** — Ephemeral sessions for heartbeat and isolated cron jobs. Never persisted to DB.

### Turn Execution

Each agent turn:

1. Loads config (engine settings, tool toggles)
2. Builds system prompt from core instructions + memory blocks + skills + opened files
3. Runs tool loop with OpenAI-compatible API
4. Processes tool outputs (file I/O, exec, search, respond)
5. Persists session to SQLite

### Key Modules

- **`src/engine/`** — LLM interaction core. Builds system prompts from base instructions + memory blocks + opened files + skills, manages tool registry, calls OpenAI-compatible APIs via `src/engine/provider/oai.ts`. Uses `tool_choice: "required"` — agents must call tools, cannot respond with plain text.
- **`src/engine/tools/`** — Extensible tool system (12 tools). Each tool implements `ToolDef` with a Valibot schema. Tools include: `read`, `write`, `open-file`, `close-file`, `str-replace`, `list-dir`, `exec` (sandboxed), `brave-search`, `read-skill`, `respond`, `schedule`, and `session-info`.
- **`src/scheduler/`** — Manages heartbeat and cron jobs. Heartbeat runs `HEARTBEAT.md` checklist in target session. Cron jobs execute in main or isolated sessions with configurable delivery (announce/webhook).
- **`src/agent/`** — Wraps Engine with a slug identifier and per-channel session management.
- **`src/harness/`** — Multi-agent orchestrator with file watcher for config hot-reload. Manages Discord channels and internal sessions. Delegates to channel handlers for sending responses.
- **`src/harness/session.ts`** — Abstract session base class with `DiscordSession`, `MatrixSession` (stub), and `InternalSession` implementations. Tracks conversation history, opened files, pending messages/images, and channel-specific metadata.
- **`src/channels/discord.ts`** — Discord integration with oceanic.js. Handles message creation/updates/deletes, image attachment fetching, typing indicators, and message chunking for Discord's 2000-char limit.
- **`src/config/`** — Loads and validates TOML config via Valibot. Global configs: `engine.toml`, `integrations.toml` (Brave Search), `channels/discord.toml`. Agent configs: `engine.toml`, `tools.toml`, `heartbeat.toml`, `cron.toml`. Watches both global and agent-specific directories for hot-reload.
- **`src/db/`** — SQLite persistence with Drizzle ORM. WAL-mode enabled for concurrent read safety. Three tables: `sessions` (history, opened files), `images` (blake3 hash-based image index for deduplication), and `cron_jobs` (recurring and one-shot scheduled jobs).
- **`src/util/paths.ts`** — Sandbox enforcement. Only 4 paths are allowed: `/blocks/`, `/memories/`, `/workspace/`, `/skills/`. Prevents symlink escape and path traversal. Maps sandbox paths to real filesystem under `~/.cireilclaw/`.
- **`src/util/sandbox.ts`** — Bubblewrap sandbox builder. NixOS-aware with `nix-store` queries for dependency binding. Generic Linux fallback binds `/usr`, `/bin`, `/lib`. Reads `.env` from workspace for environment variables. 64MB tmpfs for `/tmp`, timeout enforcement via `SIGKILL`.
- **`src/util/load.ts`** — Loads memory blocks (person, identity, long-term, soul, style-notes) and skills with TOML frontmatter + markdown content into the system prompt.
- **`src/util/image.ts`** — WebP image conversion (quality 90) for vision API. Handles format conversion and buffer management.
- **`src/output/`** — Logging and color utilities for console output.
- **`src/cli/`** — CLI commands built with `@stricli/core`. `init` interactively sets up a new agent directory, `run` starts the harness, `clear` deletes one or all sessions from DB.

### Agent Directory Layout (`~/.cireilclaw/agents/{slug}/`)

```
blocks/          # Memory blocks (person.md, identity.md, long-term.md, soul.md, style-notes.md)
config/          # engine.toml (API config), tools.toml (tool toggles, exec config), heartbeat.toml, cron.toml
core.md          # Base system instructions
skills/          # Reusable skill documents (markdown with TOML frontmatter)
workspace/       # Sandboxed workspace for agent operations (includes HEARTBEAT.md if using heartbeat)
memories/        # Session-specific memory (persisted across turns)
```

### Persistence

Session history and state are persisted to `~/.cireilclaw/sessions.db` (SQLite with WAL mode) via Drizzle ORM migrations. Session saves are debounced (2 seconds) with `flushAllSessions()` for graceful shutdown. Images are stored as files using blake3 hash filenames with DB index for deduplication across sessions. Cron jobs (one-shot) are also persisted for recovery after restart.

### Validation

Valibot is used throughout for schema validation — config parsing, tool input validation, and `@valibot/to-json-schema` for generating JSON schemas from Valibot definitions.

## Code Style

- Comments explain _why_, not _what_ or _how_.
- TypeScript strict mode with `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`.
- Use `import type` for type-only imports (enforced by `verbatimModuleSyntax`).
