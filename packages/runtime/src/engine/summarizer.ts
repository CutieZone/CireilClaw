import { deleteSummary, saveSummary } from "#db/sessions.js";
import type { Session } from "#harness/session.js";
import colors from "#output/colors.js";
import { debug } from "#output/log.js";

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

interface SummarizeResult {
  slug: string;
  displayName: string;
  startMessageId: string;
  endMessageId: string;
  preserve: string[];
  summary: string;
}

function commitSummary(agentSlug: string, session: Session, result: SummarizeResult): void {
  const existingIdx = session.summaries.findIndex((summary) => summary.slug === result.slug);
  if (existingIdx !== -1) {
    debug(
      "Replacing existing summary",
      colors.keyword(agentSlug),
      colors.keyword(session.id()),
      `slug=${result.slug}`,
    );
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

  debug(
    "Summary committed",
    colors.keyword(agentSlug),
    colors.keyword(session.id()),
    `slug=${result.slug}`,
    `range=[${result.startMessageId}, ${result.endMessageId}]`,
    `preserved=${result.preserve.length} messages`,
    `summary=${result.summary.length} chars`,
  );
}

function removeSummary(agentSlug: string, session: Session, slug: string): boolean {
  const idx = session.summaries.findIndex((summary) => summary.slug === slug);
  if (idx === -1) {
    return false;
  }
  const removed = session.summaries[idx];
  session.summaries.splice(idx, 1);
  deleteSummary(agentSlug, session.id(), slug);

  debug(
    "Summary removed",
    colors.keyword(agentSlug),
    colors.keyword(session.id()),
    `slug=${slug}`,
    `displayName=${removed?.displayName}`,
  );
  return true;
}

export { SUMMARIZER_SYSTEM_PROMPT, commitSummary, removeSummary };
