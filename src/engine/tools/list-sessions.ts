import { sessions } from "$/db/schema.js";
import type { Message } from "$/engine/message.js";
import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";
import { and, asc, desc, gte, like, notLike, or } from "drizzle-orm";
import * as vb from "valibot";

const Schema = vb.strictObject({
  limit: vb.optional(
    vb.pipe(
      vb.number(),
      vb.minValue(1),
      vb.maxValue(30),
      vb.description("Max sessions to return (1-30)."),
    ),
    15,
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
  origin: vb.optional(
    vb.pipe(
      vb.union([vb.string(), vb.array(vb.string())]),
      vb.description("Prefix-match against session ID (e.g. 'discord' matches 'discord:*')."),
    ),
  ),
  since: vb.optional(
    vb.pipe(vb.string(), vb.description("ISO-8601 timestamp; filter by lastActivity >= since.")),
  ),
});

export const listSessions: ToolDef = {
  description:
    "List available sessions with metadata and a preview of the last message.\n\n" +
    "Use this to find relevant past conversations before reading them with `read-session`.\n" +
    "Ephemeral cron sessions are automatically excluded.",
  // oxlint-disable-next-line require-await
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    try {
      const data = vb.parse(Schema, input);

      const filters = [notLike(sessions.id, "cron:%")];

      if (data.since !== undefined) {
        filters.push(gte(sessions.lastActivity, data.since));
      }

      if (data.origin !== undefined) {
        const origins = Array.isArray(data.origin) ? data.origin : [data.origin];
        const originFilters = origins.map((org) => like(sessions.id, `${org}%`));
        const combined = or(...originFilters);
        if (combined !== undefined) {
          filters.push(combined);
        }
      }

      const orderBy =
        data.order === "asc" ? asc(sessions.lastActivity) : desc(sessions.lastActivity);

      const { limit, offset } = data;

      const rows = ctx.db
        .select()
        .from(sessions)
        .where(and(...filters))
        .orderBy(orderBy)
        .limit(limit)
        .offset(offset)
        .all();

      const results = rows.map((row) => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const history = JSON.parse(row.history) as Message[];
        const chatMessages = history.filter(
          (msg) => msg.role === "user" || msg.role === "assistant",
        );
        const lastMsg = chatMessages.at(-1);

        let preview = "";
        if (lastMsg !== undefined) {
          const content = Array.isArray(lastMsg.content) ? lastMsg.content[0] : lastMsg.content;
          if (content !== undefined && "content" in content) {
            preview = content.content.slice(0, 100);
            if (content.content.length > 100) {
              preview += "...";
            }
          }
        }

        return {
          channel: row.channel,
          id: row.id,
          lastActivity: row.lastActivity,
          messageCount: chatMessages.length,
          preview,
        };
      });

      return { sessions: results, success: true };
    } catch (error: unknown) {
      if (error instanceof vb.ValiError) {
        return { error: error.message, issues: error.issues, success: false };
      }
      return { error: String(error), success: false };
    }
  },
  name: "list-sessions",
  parameters: Schema,
};
