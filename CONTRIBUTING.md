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

## CI

The CI pipeline runs three checks: formatting (OxFmt), linting (OxLint, type-aware), and tests (Vitest). All three must pass.

Before submitting, run locally:

```bash
pnpm format       # Auto-format
pnpm lint:fix     # Lint and auto-fix
pnpm test         # Run tests
```

Editing the CI configuration is discouraged. If you believe a change is necessary, open an issue to discuss it first.

## Development Setup

The project uses NixOS with `direnv` for the best development experience, but any platform with Node.js and pnpm works for development. The dev stack (linting, formatting, tests) is cross-platform.

- Package manager: **pnpm** (not npm, not yarn). **Bun cannot be used** due to incompatible dependencies.
- No build step. TypeScript runs directly via `tsx`.
- Path alias: `$/*` maps to `./src/*`.

Note: *Running* CireilClaw (`pnpm start`, `pnpm start tui`, etc.) requires Linux, as the sandbox depends on Linux kernel features. Development and testing work on any platform.

## Code Style

- TypeScript strict mode is enforced.
- Comments explain *why*, not *what* or *how*. The code should speak for itself.
- Use `import type` for type-only imports.
- Run `pnpm format` and `pnpm lint:fix` before committing.

## Tests

Tests are colocated with source files using a `.test.ts` suffix. If your change touches behavior that has existing tests, make sure they still pass. If you are adding new behavior, consider adding tests for it.

Run `pnpm test` (or `pnpm test:watch` during development) to verify.

## Security-Sensitive Changes

Changes that touch security boundaries (sandbox configuration, path allowlists, privilege boundaries, access control) require explicit maintainer sign-off. These paths are security-critical and will receive thorough review. If you are unsure whether your change falls into this category, ask.

## Pull Requests

- Keep PRs focused. One logical change per PR.
- Describe what the change does and why it is needed.
- If the PR addresses an issue, reference it.
- If adding a dependency, document the reasoning in the PR description. Dependency additions are at maintainer discretion.
