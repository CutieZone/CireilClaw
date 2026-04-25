# Granular Context Management

## Motivation

Users running agents against large codebases or long-running sessions frequently hit context-window limits. Current mitigations in the runtime (see `packages/runtime/src/engine/prune.ts`) are reactive: when the budget is exceeded, whole turns are dropped or tool responses are replaced with stubs. This is coarse — an early turn might contain both critical decisions _and_ discardable process garbage, and the system has no way to tell the difference.

The goal is to give both the user and the agent **proactive, fine-grained control** over what occupies the context window, before the reactive pruner has to make destructive choices.

Two complementary mechanisms are proposed:

1. **Section-based file reading** — Large files are exposed as a table of contents; the agent opens only the sections it needs.
2. **User-driven topic compaction** — Completed work is summarized and collapsed, preserving decisions while evicting process noise.

## 1. Section-Based File Reading

### Problem

A single `read` or `open-file` on a 10k-line source file can consume 15k+ tokens. The agent rarely needs every function, import, or comment. Loading the entire file is wasteful and pushes other useful context out of the window.

### Design

#### File Outline Generation

When a file exceeds a configurable token threshold (e.g. 2k tokens), the `read` tool returns an **outline** instead of full content. The outline is generated locally via tree-sitter, regex header extraction, or XML parsing — no LLM call required.

Example for a large markdown document:

```xml
<file path="docs/runbooks/database-failover.md" lines="1240" est_tokens="18000">
  <section id="overview" line="1" type="h1">Overview (45 lines)</section>
  <section id="prerequisites" line="47" type="h1">Prerequisites (120 lines)</section>
  <section id="manual-failover" line="168" type="h1">Manual Failover Procedure (340 lines)</section>
  <section id="automatic-failover" line="509" type="h1">Automatic Failover Configuration (280 lines)</section>
  <section id="rollback-procedures" line="790" type="h1">Rollback Procedures (210 lines)</section>
  <section id="post-incident" line="1001" type="h1">Post-Incident Review Template (180 lines)</section>
  <section id="appendix-a" line="1182" type="h1">Appendix A: Connection String Formats (58 lines)</section>
</file>
```

Citations use a fully-qualified ID: `path:sectionIdFromOutliner` (e.g. `docs/runbooks/database-failover.md:manual-failover`). This is unambiguous even when multiple files define sections with the same local name.

#### Selective Opening

The agent then calls `open-file` with a section filter:

```json
{
  "path": "docs/runbooks/database-failover.md",
  "sections": ["manual-failover", "rollback-procedures"]
}
```

Only the requested sections are injected into the context window. The file remains "partially open" in session state as `(path, section_ids[], full_text_cache)`.

The agent can iteratively add sections:

```json
{
  "path": "docs/runbooks/database-failover.md",
  "sections": ["post-incident"]
}
```

Or remove them:

```json
{
  "path": "docs/runbooks/database-failover.md",
  "close_sections": ["rollback-procedures"]
}
```

#### Cache Invalidation

After any file mutation (`str-replace`, `write-file`, `exec` with side effects), the cached outline for that file is marked dirty. The outline is regenerated on the next access (`read`, `open-file`, or section extraction). The agent always sees the modified content in its current-turn context; stale outlines cannot propagate across turns.

#### Context Assembly

During prompt construction, pinned files are rendered by extracting only the open sections from the cached full text. If no sections are specified, the entire file is included (backward-compatible behavior for small files).

#### Pluggable Extractors

Outline generation is not tied to a single syntax. Extractors may be provided by plugins (see `docs/plugins/developers.md`). The runtime ships with built-in support for:

| File type | Extractor strategy                                |
| --------- | ------------------------------------------------- |
| Markdown  | Header hierarchy (`#`, `##`)                      |
| XML       | Top-level elements with `id` or `name` attributes |

All other file types (code, config, etc.) are left to plugin extractors. Extractors are registered by file-extension glob and priority. Users may opt into XML section markers in any file for maximum control over IDs and nesting.

Plugins may be upstreamed into the runtime later with owner permission.

### Edge Cases

- **Intentional isolation** — Sections do not reference each other. An agent that opens `manual-failover` and encounters a reference to `rollback-procedures` must explicitly open `rollback-procedures` if it needs that context. There is no automatic cross-section resolution; adding it introduces ambiguity about what is actually in context and complicates cache invalidation.
- **Editing partially-opened files** — `str-replace` reads the full file from disk and performs exact string matching, so edits are always applied to the real file regardless of what sections are open in context. The agent must still craft its replacement from accurate file contents, but there is no risk of the tool operating on a stale or filtered view.
- **Preamble inclusion** — Imports, license headers, and file-level docstrings are automatically included when any section is open, to preserve type context and top-level declarations.

## 2. Topic Compaction

### Problem

Long sessions accumulate "process garbage": failed attempts, exploratory tangents, back-and-forth corrections. The existing `prune.ts` drops entire turns when over budget, which can lose the original request, the final decision, or both.

### Design

A **topic** is a user-described slice of conversation that the user wants compacted. Instead of manually marking start/end boundaries, the user describes what they want summarized (e.g. "the auth refactor discussion" or "everything before the postgres migration decision"). The LLM (or a dedicated summarizer) uses the description to identify relevant turns, then calls a tool back to the harness with the exact boundaries and summary text.

#### Discord Interface

```
... agent and user discuss auth refactoring ...
User: /summarize auth-refactor — clean up the auth refactor discussion, keep the JWT decision and file changes
```

The command takes an identifier and a natural language description. The runtime then:

1. Invokes the summarizer with the description and access to recent conversation history.
2. The summarizer may call `read-session` if it needs to examine history beyond the current context window.
3. The summarizer identifies the relevant message range and calls the `prune-boundaries` tool.
4. The harness stores the summary and boundary information, then replaces the identified range with a single summary message in the prompt assembly phase.

#### Summarization Backend

The summarization call is an internal engine invocation using the existing provider adapters. It uses the same engine configuration as the host agent by default, but can be overridden per-agent via a dedicated config file (e.g. `summarization.toml`) using the same top-level `model` / `provider` pattern as `heartbeat.toml`. This allows a cheaper or faster model to handle compaction while the main agent runs on a premium model.

The summarizer receives a system prompt like:

> You are a context compaction assistant. The user wants to summarize a portion of the conversation. Use the provided description to identify which turns are relevant. Call `read-session` if you need to examine history beyond the current context window. When you have identified the boundaries, call `prune-boundaries(start, end, preserve, summary, identifier)` with the first and last message IDs in the range, any message IDs that must be preserved verbatim, the summary text, and the identifier provided by the user. Preserve exact values, constraints, interface signatures, and file paths. Do not paraphrase technical specifics.

#### `prune-boundaries` Tool

The summarizer calls this tool to commit the compaction:

```json
{
  "start": "msg_abc123",
  "end": "msg_def456",
  "preserve": ["msg_tool_output_789"],
  "summary": "User requested refactoring the auth system from session cookies to JWT. Decision: adopt JWT with refresh tokens stored in httpOnly cookies. Files modified: src/auth.ts (login/logout handlers), src/middleware.ts (token verification).",
  "identifier": "auth-refactor"
}
```

`preserve` is optional. Any message IDs listed are kept verbatim inside the summary envelope rather than summarized. Use this for strict outputs: schemas, generated code, exact config values, or interface definitions that must survive compaction without paraphrase.

The harness:

- Validates that both message IDs exist in the session history.
- Slugifies the identifier for storage (`auth-refactor`).
- Stores both the slug and the original display name.
- Replaces the message range `[start, end]` with a single summary message during prompt assembly.

The full original turns remain in SQLite for forensics; only the LLM-visible prompt is affected.

#### Prompt Assembly

When building the message array for the LLM:

1. Identify all summarized topics for the session.
2. For each topic, emit one message (role `user` or `system`) containing the summary.
3. Emit all non-summarized turns verbatim.
4. Pass the result to `prune.ts` as the safety net.

This is a **view-layer optimization**: the full history stays in the database, but the LLM only sees the compacted view.

### Edge Cases

- **Ownership** — Summaries are owner-scoped. Discord `/` commands are already restricted to the configured owner ID, so only the owner can request summarization. No additional multi-user isolation is required.
- **Ambiguous descriptions** — If the description matches no turns or matches too many, the summarizer should either ask for clarification or produce a conservative summary that errs on the side of inclusion.
- **Invalid boundaries** — If the summarizer returns message IDs that do not exist or are out of order, the harness rejects the `prune-boundaries` call and returns an error to the summarizer.
- **Reverting summaries** — `/unsummarize <name>` removes the summary and restores the full turn range to the prompt. The lookup matches on the slugified identifier. Useful if the summary was lossy or the user wants to revisit the details.
- **Epistemic drift** — Summarization is inherently lossy. Exact values (signing algorithms, cookie flags, config keys) may be silently generalized. Use the `preserve` field in `prune-boundaries` to keep strict outputs verbatim. If the agent later hallucinates constraints from a summarized topic, `/unsummarize` restores the full detail.
- **Model-initiated compaction** — A future extension could let the agent itself suggest summarization ("we are done with X, shall I summarize?"). This requires explicit user confirmation before any compaction occurs.

## 3. Relationship to Existing Infrastructure

### `packages/runtime/src/engine/prune.ts`

The reactive pruner remains the **safety net**, not the primary strategy. It handles:

- Stale read supersession
- Tool response eviction
- Turn dropping when the hard cap is exceeded

The new features reduce pressure on the pruner by shrinking the payload _before_ it reaches the budget check. In a well-managed session, the pruner should rarely need to drop turns.

### Order of Operations

During prompt assembly:

1. **Section filtering** — Render only open sections of pinned files.
2. **Topic substitution** — Replace closed topic ranges with summaries.
3. **Squash & estimate** — Combine adjacent user/assistant messages, estimate tokens.
4. **Prune** — If still over budget, apply `prune.ts` (supersede reads, evict tools, drop turns).

## 4. Data Model

### Session State Extension

```sql
-- Active section filters for pinned files
ALTER TABLE sessions ADD COLUMN active_file_sections TEXT; -- JSON: {path: [section_ids]}

-- Summaries table (replacements for compacted message ranges)
CREATE TABLE summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  start_message_id TEXT NOT NULL,
  end_message_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(session_id, slug)
);
```

### Session Loading

When hydrating a session from SQLite:

- Load `active_file_sections` into the session object.
- Load all summaries for the session. During prompt assembly, replace each `[start_message_id, end_message_id]` range with the summary text.

## 5. Decisions

1. **Section syntax standardization** — Pluggable extractors, not a mandated format. Built-in extractors cover markdown (headers) and XML. All other file types are left to plugin extractors. Section IDs are namespaced as `path:sectionIdFromOutliner`.
2. **Token estimation accuracy** — Retain the existing `CHARS_PER_TOKEN = 3` heuristic. It is sufficient for rough-sizing and outline-trigger decisions. The accurate token budget is enforced downstream by `prune.ts`.
3. **Summarization cost** — Full LLM summarization. Cost is accepted as the price of quality compaction. The summarization backend is configurable per-agent via a dedicated config file (e.g. `summarization.toml`) using the same top-level `model` / `provider` pattern as `heartbeat.toml`, allowing cheaper models to be used for compaction.
4. **Concurrency in shared channels** — Topics are owner-scoped. Discord `/` commands are already restricted to the configured owner ID, so only the owner can start or close topics. No additional multi-user isolation is required.

## 6. Migration Path

Large workloads (e.g. 400k tokens) quickly exhaust even generous context windows. Without proactive management, the reactive pruner is forced to make destructive cuts. These features help keep the agent within budget while preserving the signal.

Implementation order:

1. **Section filtering** — Highest impact on static context bloat. Start with a header extractor for markdown and XML. Plugin hook for custom extractors.
2. **Topic compaction** — Solves dynamic history bloat. Implement `/summarize` with natural language targeting and a dedicated summarizer backend.
3. **Integration testing** — Run parallel sessions (full context vs. managed context) to validate that compaction does not materially degrade output quality.
