import * as vb from "valibot";

import { ToolError } from "#engine/errors.js";
import { commitSummary } from "#engine/summarizer.js";
import type { ToolContext, ToolDef } from "#engine/tools/tool-def.js";

const Schema = vb.strictObject({
  end: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description("Last message ID in the range to compact."),
  ),
  identifier: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description("Short name for this topic (e.g. 'auth-refactor')."),
  ),
  preserve: vb.pipe(
    vb.exactOptional(vb.array(vb.pipe(vb.string(), vb.nonEmpty())), []),
    vb.description("Message IDs to keep verbatim inside the summary envelope."),
  ),
  start: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description("First message ID in the range to compact."),
  ),
  summary: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description("Concise summary preserving decisions, constraints, and file changes."),
  ),
});

export const pruneBoundaries: ToolDef = {
  description:
    "Commit a topic compaction range. Called by the summarizer to replace a range of messages with a summary in the LLM-visible prompt. " +
    "The full messages remain in the database for forensics.\n\n" +
    "Parameters:\n" +
    "- start/end: first and last message IDs in the range\n" +
    "- preserve: message IDs to keep verbatim (exact outputs, schemas, config)\n" +
    "- summary: concise summary preserving decisions, constraints, and file changes\n" +
    "- identifier: short name for this topic (e.g. 'auth-refactor')",
  // oxlint-disable-next-line typescript/require-await
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    const data = vb.parse(Schema, input);

    const messageIds = new Set(ctx.session.history.map((msg) => msg.id));
    const missing: string[] = [];

    if (!messageIds.has(data.start)) {
      missing.push(`start: ${data.start}`);
    }
    if (!messageIds.has(data.end)) {
      missing.push(`end: ${data.end}`);
    }
    if (missing.length > 0) {
      throw new ToolError(
        `Message ID(s) not found in session history: ${missing.join(", ")}`,
        "Use read-session to verify message IDs.",
      );
    }

    const startIdx = ctx.session.history.findIndex((msg) => msg.id === data.start);
    const endIdx = ctx.session.history.findIndex((msg) => msg.id === data.end);
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
      throw new ToolError(
        "Start message must come before end message in session history.",
        "Check message ordering with read-session.",
      );
    }

    const invalidPreserve = data.preserve.filter((id) => !messageIds.has(id));
    if (invalidPreserve.length > 0) {
      throw new ToolError(
        `Preserved message ID(s) not found: ${invalidPreserve.join(", ")}`,
        "Verify preserved message IDs with read-session.",
      );
    }

    const slug = data.identifier
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, "-")
      .replaceAll(/^-+|-+$/gu, "");

    if (slug.length === 0) {
      throw new ToolError(
        "Identifier produces an empty slug.",
        "Use a more descriptive identifier.",
      );
    }

    commitSummary(ctx.agentSlug, ctx.session, {
      displayName: data.identifier,
      endMessageId: data.end,
      preserve: data.preserve,
      slug,
      startMessageId: data.start,
      summary: data.summary,
    });

    return {
      identifier: data.identifier,
      messagesCompacted: endIdx - startIdx + 1,
      slug,
      success: true,
    };
  },
  name: "prune-boundaries",
  parameters: Schema,
};
