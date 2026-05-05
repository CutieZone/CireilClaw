import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse } from "smol-toml";
import * as vb from "valibot";

import { loadEngine } from "#config/index.js";
import type { SummarizationConfig } from "#config/schemas/summarization.js";
import { SummarizationConfigSchema } from "#config/schemas/summarization.js";
import { deleteSummary, saveSummary } from "#db/sessions.js";
import type { Message } from "#engine/message.js";
import type { Session } from "#harness/session.js";
import { agentRoot } from "#util/paths.js";

// The system prompt given to the summarizer when identifying topic boundaries.
const SUMMARIZER_SYSTEM_PROMPT = `You are a context compaction assistant for an AI agent system.
The user wants to summarize a portion of the conversation to reduce context usage.

Your job:
1. Read the provided conversation description to understand which turns to compact.
2. Optionally call read-session if you need to see more history than what's in context.
3. Identify the first and last message IDs in the range to compact.
4. Call prune-boundaries with:
   - start: the first message ID in the range
   - end: the last message ID in the range
   - preserve: IDs of messages that must be kept verbatim (exact outputs, schemas, config, code)
   - summary: a concise but precise summary of decisions, constraints, and file changes
   - identifier: the user-provided short name for this topic

Rules:
- Preserve exact values, constraints, interface signatures, and file paths.
- Do not paraphrase technical specifics.
- When in doubt about whether something is in the range, err on the side of inclusion.
- If the description matches no turns or too many, ask for clarification.`;

interface SummarizeRequest {
  session: Session;
  agentSlug: string;
  identifier: string;
  description: string;
  history: Message[];
}

interface SummarizeResult {
  slug: string;
  displayName: string;
  startMessageId: string;
  endMessageId: string;
  preserve: string[];
  summary: string;
}

async function loadSummarizationConfig(agentSlug: string): Promise<SummarizationConfig> {
  const file = join(agentRoot(agentSlug), "config", "summarization.toml");
  try {
    const content = await readFile(file, "utf8");
    const parsed = parse(content);
    return vb.parse(SummarizationConfigSchema, parsed);
  } catch {
    return {};
  }
}

// Runs a summarization turn using the configured (or default) provider.
// The summarizer receives the recent history and the user's description,
// then calls prune-boundaries to commit the compaction.
async function runSummarizer(
  request: SummarizeRequest,
): Promise<SummarizeResult | { error: string }> {
  const providers = await loadEngine(request.agentSlug);

  const sumCfg = await loadSummarizationConfig(request.agentSlug);

  // Resolve provider: summarization.toml > engine default
  const providerName = sumCfg.provider;
  const selectedProvider = providerName === undefined ? undefined : providers[providerName];

  if (selectedProvider === undefined && providerName !== undefined) {
    return {
      error: `Summarization provider '${providerName}' not found in engine config. Set provider in config/summarization.toml or remove to use the default.`,
    };
  }

  // For now, the summarizer is an internal engine invocation. The actual LLM
  // call happens via the engine's provider, but we need to set up the tools
  // so the summarizer can call prune-boundaries. The `buildTools` path and
  // engine integration will provide this context. For the initial implementation,
  // we return the request data so the engine loop can handle the invocation.
  //
  // The engine/index.ts runTurn function will detect when we're in summarizer
  // mode and use a dedicated tool set (just read-session + prune-boundaries).

  return {
    displayName: request.identifier,
    endMessageId: "",
    preserve: [],
    slug: request.identifier
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, ""),
    startMessageId: "",
    summary: "",
  };
}

// Commits a summary to storage and updates the session's in-memory state.
function commitSummary(agentSlug: string, session: Session, result: SummarizeResult): void {
  // Remove any existing summary with the same slug
  const existingIdx = session.summaries.findIndex((summary) => summary.slug === result.slug);
  if (existingIdx !== -1) {
    session.summaries.splice(existingIdx, 1);
    deleteSummary(agentSlug, session.id(), result.slug);
  }

  const id = saveSummary(agentSlug, session.id(), {
    createdAt: Math.floor(Date.now() / 1000),
    displayName: result.displayName,
    endMessageId: result.endMessageId,
    id: 0,
    preserve: result.preserve,
    slug: result.slug,
    startMessageId: result.startMessageId,
    summary: result.summary,
  });

  session.summaries.push({
    createdAt: Math.floor(Date.now() / 1000),
    displayName: result.displayName,
    endMessageId: result.endMessageId,
    id,
    preserve: result.preserve,
    slug: result.slug,
    startMessageId: result.startMessageId,
    summary: result.summary,
  });
}

// Removes a summary by slug from storage and in-memory state.
function removeSummary(agentSlug: string, session: Session, slug: string): boolean {
  const idx = session.summaries.findIndex((summary) => summary.slug === slug);
  if (idx === -1) {
    return false;
  }
  session.summaries.splice(idx, 1);
  deleteSummary(agentSlug, session.id(), slug);
  return true;
}

export type { SummarizeRequest, SummarizeResult };
export {
  SUMMARIZER_SYSTEM_PROMPT,
  runSummarizer,
  commitSummary,
  removeSummary,
  loadSummarizationConfig,
};
