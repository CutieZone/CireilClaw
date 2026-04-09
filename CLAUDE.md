# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is cireilclaw?

An opinionated, security-focused agent system for running sandboxed AI assistants across multiple channels (Discord, Matrix). Emphasizes safety (least privilege, bubblewrap sandboxing), sanity (debuggable code), speed, and composability (hot-reloadable config, no code edits needed). Features multi-agent orchestration, persistent session management, vision API support with image preprocessing, and extensible tool system.

## Commands

```bash
pnpm start              # Run via tsx (tsx ./src/entrypoint.ts)
pnpm start tui <agent>  # Run interactive TUI session with a single agent
pnpm start migrate      # Apply pending config migrations
pnpm start repair       # Repair Discord media attachments for a session
pnpm test               # Run tests with vitest
pnpm test:watch         # Run tests in watch mode
pnpm lint               # Lint with OxLint (type-aware)
pnpm lint:fix           # Lint and auto-fix
pnpm format             # Format with OxFmt
```

There is no build step for development — `tsx` runs TypeScript directly. Tests use vitest and are colocated with source files (`.test.ts` suffix).

## Development Environment

NixOS-based — `flake.nix` provides nodejs, pnpm, and bubblewrap via direnv. Use `pnpm` as the package manager.

## Path Alias

`$/*` maps to `./src/*` in tsconfig (e.g., `import { foo } from "$/engine/index.ts"`).

## Architecture

### Core Flow

CLI (`@stricli/core`) → Config (TOML) → Harness (multi-channel) → Agent (per-channel sessions) → Engine → API Providers

### API Providers

- **`openai`** (default) — OpenAI-compatible API via `src/engine/provider/oai.ts`. Supports any OAI-compatible endpoint.
- **`anthropic-oauth`** — Anthropic API with OAuth authentication via `src/engine/provider/anthropic-oauth.ts`. Supports Anthropic-specific features like prompt caching and extended thinking.

### Channel Support

- **Discord** — Full integration via oceanic.js with message handling, image attachments, typing indicators, and automatic message chunking.
- **TUI** — Interactive terminal UI built with Ink (React). Single-agent mode via `tui` CLI command. No attachment or reaction support.
- **Matrix** — Stub only (`MatrixSession` class exists but no channel handler).
- **Internal** — Ephemeral sessions for heartbeat and isolated cron jobs. Never persisted to DB.

### Turn Execution

Each agent turn:

1. Loads config (engine settings, tool toggles)
2. Builds system prompt from core instructions + memory blocks + skills + opened files
3. Runs tool loop with configured API provider
4. Processes tool outputs (file I/O, exec, search, respond, react, download Discord attachments)
5. Persists session to SQLite

### Key Modules

- **`src/engine/`** — LLM interaction core. Builds system prompts from base instructions + memory blocks + opened files + skills, manages tool registry, calls APIs via provider abstraction (`openai` or `anthropic-oauth`). Uses `tool_choice: "required"` — agents must call tools, cannot respond with plain text. Key sub-files: `block.ts` (MemoryBlock type), `content.ts` (all content block types — text, image, video, tool calls, thinking, redacted thinking), `message.ts` (UserMessage, AssistantMessage, ToolMessage), `context.ts` (Context and UsageInfo), `errors.ts` (GenerationNoToolCallsError, ToolError, ParseError), `role.ts` (Role type).
- **`src/engine/tools/`** — Extensible tool system (20 tools). Each tool implements `ToolDef` with a Valibot schema. Tools include: `read`, `write`, `open-file`, `close-file`, `str-replace`, `list-dir`, `exec` (sandboxed), `brave-search`, `read-skill`, `respond`, `schedule`, `session-info`, `download-attachments`, `react`, `no-response`, `list-sessions`, `query-sessions`, `read-session`, `read-history`.
- **`src/scheduler/`** — Manages heartbeat and cron jobs. Heartbeat runs `HEARTBEAT.md` checklist in target session. Cron jobs execute in main or isolated sessions with configurable delivery (announce/webhook).
- **`src/agent/`** — Wraps Engine with a slug identifier and per-channel session management.
- **`src/harness/`** — Multi-agent orchestrator with file watcher for config hot-reload. Manages Discord channels and internal sessions. Delegates to channel handlers for sending responses.
- **`src/harness/session.ts`** — Abstract session base class with `DiscordSession`, `MatrixSession` (stub), and `InternalSession` implementations. Tracks conversation history, opened files, pending messages/images/videos, and channel-specific metadata including `selectedModel`/`selectedProvider`.
- **`src/channels/discord.ts`** — Discord integration with oceanic.js. Handles message creation/updates/deletes, image/video attachment fetching, typing indicators, and message chunking for Discord's 2000-char limit. The `src/channels/discord/` subdirectory contains handler utilities for message clearing, model command (`/model` — live provider/model switching with autocomplete), and repair command (`/repair` — re-fetch broken media attachments).
- **`src/channels/tui.ts`** — TUI channel handler (Ink/React). Used exclusively by the `tui` CLI command for interactive single-agent terminal sessions. The `src/channels/tui/` subdirectory contains the Ink app, bridge, and message types.
- **`src/config/`** — Loads and validates TOML config via Valibot. Schemas live in `src/config/schemas/` (engine, tools, discord, conditions, integrations, matrix, system, shared). Global configs: `engine.toml`, `integrations.toml` (Brave Search), `channels/discord.toml`. Agent configs: `engine.toml`, `tools.toml`, `heartbeat.toml`, `cron.toml`, `conditions.toml` (conditional access rules). Engine config supports per-channel overrides (Discord guild, Matrix room) for provider, API base, model, and API key pools. Watches both global and agent-specific directories for hot-reload.
- **`src/config/schemas/conditions.ts`** — Schema for `conditions.toml` which enables conditional block loading and path access control based on session context (e.g., `discord:nsfw`, `discord:dm`, `discord:guild:<id>`, `discord:channel:<id>`, `tui`, `internal`).
- **`src/util/conditions.ts`** — Evaluates conditions against session context. Used for loading conditional memory blocks (`blocks/conditional/`) and enforcing path access rules for `/memories/` and `/workspace/`. Note: Does NOT affect the `exec` tool due to the difficulty of reliably restricting sandboxed command execution.
- **`src/config/migrations/`** — Config migration system. Migrations transform TOML config files in-place (both global and per-agent). Each migration has a timestamped ID (`YYYYMMDDHHMMSS_name`), declares which config files it targets, and implements a `transform` function. Applied automatically on `run`/`tui` startup and manually via `pnpm migrate`.
- **`src/db/`** — SQLite persistence with Drizzle ORM. WAL-mode enabled for concurrent read safety. Three tables: `sessions` (history, opened files), `images` (blake3 hash-based image index for deduplication), and `cron_jobs` (recurring and one-shot scheduled jobs with status and retry tracking).
- **`src/util/paths.ts`** — Sandbox enforcement. Only 5 paths are allowed: `/blocks/`, `/memories/`, `/workspace/`, `/skills/`, `/tasks/`. Prevents symlink escape and path traversal. Maps sandbox paths to real filesystem under `~/.cireilclaw/`. Enforces conditional access rules for `/memories/` and `/workspace/` via `checkConditionalAccess()`.
- **`src/util/sandbox.ts`** — Bubblewrap sandbox builder. NixOS-aware with `nix-store` queries for dependency binding. Generic Linux fallback binds `/usr`, `/bin`, `/lib`. Reads `.env` from workspace for environment variables. 64MB tmpfs for `/tmp`, timeout enforcement via `SIGKILL`. Binds `/workspace`, `/memories`, `/skills`, and `/tasks` into the sandbox.
- **`src/util/key-pool.ts`** — API key pooling with failover and cooldown. Rotates through multiple keys, tracking rate-limited keys (429 responses) with 30-minute cooldown before retry.
- **`src/util/load.ts`** — Loads memory blocks (person, identity, long-term, soul, style-notes) and skills with TOML frontmatter + markdown content into the system prompt.
- **`src/util/image.ts`** — WebP image conversion (quality 90) for vision API. Handles format conversion and buffer management.
- **`src/util/repair-session.ts`** — Repairs Discord session media by re-fetching attachments from Discord CDN, converting images to WebP, and updating the DB. Used by both the CLI `repair` command and the Discord `/repair` slash command.
- **`src/supports.ts`** — Media type support constants: `SUPPORTED_IMAGE_TYPES`, `SUPPORTED_VIDEO_TYPES`, `VIDEO_SIZE_CAP` (10MB), and `IMAGE_EXT_TO_MEDIA_TYPE` mapping. Referenced across the codebase when detecting and validating media before API submission.
- **`src/output/`** — Logging and color utilities for console output.
- **`src/cli/`** — CLI commands built with `@stricli/core`. `init` interactively sets up a new agent directory, `run` starts the harness, `tui <agent>` runs an interactive TUI session with a single agent, `migrate` applies pending config migrations without starting the harness, `clear` deletes one or all sessions from DB, `repair` re-fetches broken Discord media for a chosen session.

### Agent Directory Layout (`~/.cireilclaw/agents/{slug}/`)

```
blocks/          # Memory blocks (person.md, identity.md, long-term.md, soul.md, style-notes.md)
  conditional/   # Conditional blocks loaded based on conditions.toml rules
config/          # engine.toml (API config), tools.toml (tool toggles, exec config), heartbeat.toml, cron.toml, conditions.toml
core.md          # Base system instructions
skills/          # Reusable skill documents (markdown with TOML frontmatter)
tasks/           # Scheduled task checklists (HEARTBEAT.md) and related data
workspace/       # Sandboxed workspace for agent operations
memories/        # Session-specific memory (persisted across turns)
```

### Persistence

Session history and state are persisted to `~/.cireilclaw/agents/{slug}/sessions.db` (SQLite with WAL mode) — one database per agent — via Drizzle ORM migrations. Session saves are debounced (2 seconds) with `flushAllSessions()` for graceful shutdown. Images are stored as files using blake3 hash filenames with DB index for deduplication across sessions. Cron jobs (one-shot) are also persisted for recovery after restart.

### Validation

Valibot is used throughout for schema validation — config parsing, tool input validation, and `@valibot/to-json-schema` for generating JSON schemas from Valibot definitions.

## Code Style

- Comments explain _why_, not _what_ or _how_.
- TypeScript strict mode with `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`.
- Use `import type` for type-only imports (enforced by `verbatimModuleSyntax`).
