import { sessions } from "$/db/schema.js";
import { ToolError } from "$/engine/errors.js";
import type { Message } from "$/engine/message.js";
import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";
import { eq } from "drizzle-orm";
import * as vb from "valibot";

const Schema = vb.strictObject({
  id: vb.pipe(vb.string(), vb.nonEmpty(), vb.description("The session ID to read.")),
  limit: vb.optional(
    vb.pipe(
      vb.number(),
      vb.minValue(1),
      vb.maxValue(100),
      vb.description("Max messages to return (1-100)."),
    ),
    50,
  ),
  offset: vb.optional(
    vb.pipe(vb.number(), vb.minValue(0), vb.description("Offset for pagination.")),
    0,
  ),
  order: vb.optional(
    vb.pipe(
      vb.union([vb.literal("asc"), vb.literal("desc")]),
      vb.description("Sort order (asc or desc)."),
    ),
    "desc",
  ),
  since: vb.optional(
    vb.pipe(
      vb.string(),
      vb.description("ISO-8601 timestamp; filter by message timestamp >= since."),
    ),
  ),
});

export const readSession: ToolDef = {
  description:
    "Read the full message history of a specific session.\n\n" +
    "Use this to get detailed context on a past conversation found via `list-sessions` or `query-sessions`.\n" +
    "Returns only user and assistant messages.",
  // oxlint-disable-next-line require-await
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    const data = vb.parse(Schema, input);

    const row = ctx.db.select().from(sessions).where(eq(sessions.id, data.id)).get();

    if (row === undefined) {
      throw new ToolError(`Session not found: ${data.id}`);
    }

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const history = JSON.parse(row.history) as Message[];
    let chatMessages = history.filter((msg) => msg.role === "user" || msg.role === "assistant");

    if (data.since !== undefined) {
      const sinceTs = Date.parse(data.since);
      if (!Number.isNaN(sinceTs)) {
        chatMessages = chatMessages.filter(
          (msg) => msg.timestamp === undefined || msg.timestamp >= sinceTs,
        );
      }
    }

    if (data.order === "desc") {
      chatMessages.reverse();
    }

    const { offset, limit } = data;
    const paginated = chatMessages.slice(offset, offset + limit);

    const results = paginated.map((msg) => {
      const content = Array.isArray(msg.content) ? msg.content : [msg.content];
      return {
        content: content
          .filter((part) => "content" in part)
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          .map((part) => (part as { content: string }).content)
          .join("\n"),
        role: msg.role,
        timestamp: msg.timestamp,
      };
    });

    return {
      id: row.id,
      messages: results,
      success: true,
      totalMessages: chatMessages.length,
    };
  },
  name: "read-session",
  parameters: Schema,
};
