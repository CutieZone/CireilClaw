# Hybrid Memory System — Proposal

Discussion date: 2026-03-11

## Background

CireilClaw currently uses manually-curated markdown files in `blocks/` and `memories/` as agent memory. These are loaded into the system prompt every turn. This is fully auditable and simple, but doesn't scale — as memories grow, every turn burns context on irrelevant entries. Agents also rarely self-update these files in practice.

Luna Agent (https://github.com/nonatofabio/luna-agent) takes the opposite approach: automatic LLM-driven fact extraction into SQLite with vector+FTS hybrid search. Scales well, but memories are opaque (raw SQL to audit), no deduplication, and no human review step.

## Design Goals

1. **Auditable** — Memories stored as human-readable files, editable with any text editor.
2. **Context-efficient** — Only relevant memories injected per turn, not the entire store.
3. **Deduplication** — Prevent redundant entries at write time.
4. **Opt-in embeddings** — System works without an embedding endpoint (falls back to current behavior). Embedding-based retrieval is an enhancement, not a requirement.
5. **Automatic extraction** — Agent can extract and store facts from conversations without manual curation, but stored facts are inspectable.

## Architecture

### Source of Truth: Memory Files

Memories live as structured entries in the filesystem under `memories/`. Format TBD, but each entry needs:

- Fact content (the actual text)
- Importance score (1-10, set by extraction or manually)
- Source session / timestamp
- Memory type tag (fact, preference, event, etc.)

Options for file format:
- **Single file with delimited entries** (e.g. TOML array-of-tables, or markdown with frontmatter per entry) — simple, easy to read, but merge conflicts and large diffs as it grows.
- **One file per entry** in a directory (e.g. `memories/auto/001.md`) — easier dedup/deletion, but lots of small files.
- **Grouped files by type** (e.g. `memories/facts.md`, `memories/preferences.md`) — middle ground.

Recommendation: grouped files by type, with structured entries inside each. Keeps the directory clean while remaining readable. Example:

```toml
# memories/facts.toml

[[fact]]
content = "User's birthday is March 15"
importance = 7
source = "discord-session-abc123"
created = 2026-03-11T14:30:00Z

[[fact]]
content = "User prefers dark mode in all applications"
importance = 4
source = "discord-session-def456"
created = 2026-03-10T09:00:00Z
```

### Search Index: SQLite (Derived, Rebuildable)

A SQLite database serves as a **search index** over the memory files. It is not the source of truth — if deleted, it can be rebuilt by re-reading and re-indexing the files.

Tables:
- `memory_index` — rowid, content, file_path, entry_index, importance, memory_type, created_at
- `memory_fts` — FTS5 virtual table over content (Porter stemming)
- `memory_vec` — Vector embeddings (only populated when embedding endpoint is configured)

### Two Retrieval Modes

**Mode 1: No embeddings (default)**
- If no embedding endpoint is configured in `engine.toml`, the memory files are read and injected into the system prompt verbatim, exactly as CireilClaw works today.
- The FTS index can still optionally be used for keyword-based retrieval if the memory store is large, but this is a lighter optimization — not required.

**Mode 2: Embeddings enabled**
- Embedding endpoint configured (e.g. koboldcpp `/v1/embeddings` route).
- On each turn, the user's message is embedded and searched against `memory_vec` + `memory_fts` using hybrid retrieval.
- Top-k results injected into system prompt instead of the full file.
- Reciprocal Rank Fusion (RRF) combines keyword and vector results, with recency and importance boosts (see Luna's implementation for reference).

Configuration in `engine.toml`:

```toml
[memory]
mode = "auto"  # "raw" = always load full files, "auto" = use embeddings if available
embedding_endpoint = ""  # e.g. "http://localhost:5001/v1/embeddings"
embedding_model = ""     # e.g. "snowflake-arctic-embed-s"
top_k = 10
```

### Deduplication at Write Time

Before storing a new memory:
1. If embeddings are available: embed the new fact, search existing memories, skip/merge if cosine similarity > threshold (e.g. 0.85).
2. If no embeddings: do a simple normalized string similarity check (or FTS match) as a rougher dedup.
3. If a near-duplicate is found with higher importance, keep the existing one. If the new one has meaningfully different wording or higher importance, update the existing entry.

### Automatic Extraction

A new tool or post-turn hook triggers periodically (e.g. every N messages, configurable):
1. Collects recent unsummarized conversation history.
2. Sends it to the LLM with an extraction prompt requesting structured facts + importance scores.
3. Runs dedup check against existing memories.
4. Writes surviving new facts to the appropriate memory file.
5. Updates the search index.

The extraction prompt should be tunable per agent (could live in the agent's config or as a skill).

### Core Memory Blocks (Unchanged)

The existing `blocks/` files (person.md, identity.md, soul.md, style-notes.md) remain as high-trust, always-loaded context. These are the agent's identity and are not subject to retrieval filtering. The hybrid system only applies to `memories/` — the long-tail factual recall.

## Implementation Phases

### Phase 1: Structured Memory File Format
- Define the TOML/markdown format for memory entries.
- Update the `write` / `str-replace` tools or add a dedicated `remember` tool for writing structured entries.
- No embedding or indexing yet — files loaded raw as today.

### Phase 2: FTS Index
- Add SQLite FTS5 index over memory files.
- Add index rebuild command (re-read files, re-index).
- Optionally use FTS for keyword retrieval when memory files exceed a size threshold.

### Phase 3: Embedding-Based Retrieval
- Add embedding endpoint config to `engine.toml`.
- Add `memory_vec` table and hybrid search (RRF).
- Switch to top-k retrieval when embeddings are available.
- Add dedup at write time using vector similarity.

### Phase 4: Automatic Extraction
- Add extraction prompt and periodic trigger.
- Write extracted facts to memory files through the structured format.
- Log extractions for auditability.

## Embedding Model Considerations

Since koboldcpp can serve embeddings alongside the main model, the embedding model should be small to minimize VRAM competition:

- `snowflake-arctic-embed-s` (33M params) — small, good quality for retrieval
- `bge-small-en-v1.5` (33M params) — well-tested, widely used
- `nomic-embed-text-v1.5` (137M params) — what Luna uses, slightly larger but strong performance

For a personal memory store (hundreds to low thousands of entries), the quality difference between these is marginal. Prefer the smallest model that fits comfortably alongside your main model.

## Reference

- Luna Agent memory implementation: https://github.com/nonatofabio/luna-agent/blob/main/luna/memory.py
- Luna's RRF search, extraction prompt, and schema are documented in the source above.
- sqlite-vec: https://github.com/asg017/sqlite-vec
- better-sqlite3 (Node.js) supports loadable extensions including sqlite-vec.
