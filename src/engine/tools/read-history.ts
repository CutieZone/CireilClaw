import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";
import * as vb from "valibot";

const Schema = vb.strictObject({
  direction: vb.optional(
    vb.pipe(
      vb.picklist(["after", "around", "before"]),
      vb.description("Direction to fetch: 'before' (older), 'after' (newer), or 'around' (both)."),
    ),
    "before",
  ),
  limit: vb.optional(
    vb.pipe(
      vb.number(),
      vb.minValue(1),
      vb.maxValue(100),
      vb.description("Number of messages to fetch (1-100, default 50)."),
    ),
    50,
  ),
  message_id: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description("ID of the message to use as reference point for fetching history."),
  ),
});

const readHistory: ToolDef = {
  description:
    "Fetch message history from the current channel. " +
    "Returns messages in chronological order (oldest first). " +
    "Use this to read older or newer messages around a specific message ID. " +
    "Only works on platforms that support history fetching (check capabilities in system prompt).",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    if (ctx.fetchHistory === undefined) {
      return { error: "This channel does not support history fetching", success: false };
    }

    const { direction, limit, message_id } = vb.parse(Schema, input);

    const messages = await ctx.fetchHistory(message_id, direction, limit);

    if (messages.length === 0) {
      return { messages: [], success: true };
    }

    // Use channel-formatted content
    const formatted = messages.map((msg) => msg.formatted).join("\n");

    return {
      count: messages.length,
      direction,
      messages: formatted,
      success: true,
    };
  },
  name: "read-history",
  parameters: Schema,
};

export { readHistory };
