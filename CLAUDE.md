# AGENTS.md

This file provides guidance to AI Agents when working with code in this repository.

## What is CireilClaw?

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

## Rules

- Never use `pnpm lint` piped through `grep`, `tail`, or `head`. It only makes it harder to find problems. Run it directly and read the full output.
- Use `eza --git-ignore --tree` to get a project tree that respects `.gitignore`.
- When editing configuration schemas, the edits should also be made to the example configs _and_ to any related documentation files if there are applicable ones.

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
