# Contributing

Guidelines for contributing to CireilClaw.

## LLM-Assisted Contributions

LLM-generated code is welcome, with conditions:

- **Disclose it.** If part of your contribution was written by an LLM, say so in the PR description, a `Co-Authored-By` trailer, or both.
- **Own it.** You are the representative for your LLM's code. Understand what it wrote and be ready to stand behind it.
- **Review it.** LLMs produce plausible-looking output that can be subtly wrong. Read the diff before you push.

Documentation contributions (fixes, examples, config templates) are generally more acceptable with lighter review, but the same disclosure rules apply.

## Before You Start

For anything beyond small fixes, **open an issue first** to discuss the change. This avoids wasted effort if the direction doesn't align with the project's goals or if similar work is already planned.

There ~~is~~ will be a template specifically for proposals.

## Development Setup

The project uses NixOS with `direnv` for the best development experience, but any platform with Node.js and pnpm works for development. The dev stack (linting, formatting, tests) is cross-platform.

- Package manager: `pnpm` (not npm, not yarn). **Bun cannot be used** due to incompatible dependencies (`better-sqlite3` is the [primary culprit](https://github.com/oven-sh/bun/issues/4290)).
- No build step. TypeScript runs directly via `tsx`.
- Path alias: `#` maps to `./src/` (e.g., `import { foo } from "#engine/index.js"`). **Always use the `.js` extension in imports** even for `.ts` files (due to NodeNext requirement).
- Prefer absolute imports whenever possible. `#...` instead of `./...`

Note: _Running_ CireilClaw (via `pnpm start`) requires Linux, as the sandbox depends on Linux kernel features (bubblewrap). Development and testing work on any platform, but `exec` and sandbox-related changes **must** be verified on Linux.

## Code Style

- TypeScript strict mode is enforced, including `noUncheckedIndexedAccess`.
- Comments explain _why_, not _what_ or _how_. The code should speak for itself.
- Use `import type` for type-only imports.
- Use `valibot` for all schema validation and type inference from schemas. Prefer parsing over plain validation, but ideally do both.
- Run `pnpm format` and `pnpm lint:fix` before committing.

## CI & Verification

The CI pipeline runs three checks: formatting (OxFmt), linting (OxLint, type-aware), and tests (Vitest). All three must pass.

Before submitting, run locally:

```bash
pnpm format       # Auto-format
pnpm lint:fix     # Lint and auto-fix (includes type-check)
pnpm test         # Run tests
```

## Migrations

CireilClaw has two distinct migration systems. If your change modifies persistent state or configuration, you **must** include the appropriate migration.

### Database Migrations (Drizzle)

Used for `sessions.db`. If you modify `src/db/schema.ts`:

1. Generate a migration: `pnpm drizzle-kit generate`
2. Verify the generated SQL in `./drizzle/`.

### Config Migrations

Used for TOML files (e.g., `engine.toml`, `tools.toml`). If you change a config schema in `src/config/schemas/`:

1. Add a new migration in `src/config/migrations/YYYYMMDDHHMMSS_name/migration.ts`.

- Note: just use local time. If there's an ordering issue _or_ somehow a timestamp collision, that will be addressed as needed.

2. Register it in the migration system.
3. Test it using `pnpm start migrate --dry-run`.

## Adding New Tools

Tools live in `src/engine/tools/`. Each tool requires:

1. A `ToolDef` implementation.
2. A Valibot schema for input validation.
3. Registration in `src/engine/tools/index.ts`.

Adding tests to tools is greatly encouraged, however we acknowledge that not _all_ behavior can be tested outside of integration tests.

## Tests

Tests are colocated with source files using a `.test.ts` suffix.

- **Bug fixes**: Must include a regression test.
- **New features**: Must include comprehensive test coverage.
- **Refactors**: Must ensure all existing tests pass.

Run `pnpm test` (or `pnpm test:watch` during development) to verify.

This project, due to its nature, cannot be effectively integration-tested. The best way to make sure nothing breaks is throwing LLM tokens at it by way of running the project. This might not be feasible for everyone, but a maintainer generally can help.

## Security-Sensitive Changes

Changes that touch security boundaries (sandbox configuration, path allowlists, privilege boundaries, access control) require explicit maintainer sign-off. These paths are security-critical and will receive thorough review.

Key security files:

- `src/util/paths.ts` (Path allowlists and sandbox mapping)
- `src/util/sandbox.ts` (Bubblewrap configuration)
- `src/engine/tools/exec.ts` (Command execution logic)

### Maintainers Accepting Pings

- @lyssieth: I'm a solo developer

## Pull Requests

- Keep PRs focused. One logical change per PR.
- Describe what the change does and why it is needed.
- If the PR addresses an issue, reference it.
- If adding a dependency, document the reasoning in the PR description. Dependency additions are at maintainer discretion.
