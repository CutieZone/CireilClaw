import { and, gte, like, notLike, or } from "drizzle-orm";
import * as vb from "valibot";

import { sessions } from "#db/schema.js";
import { isMessage } from "#engine/message.js";
import type { ToolContext, ToolDef } from "#engine/tools/tool-def.js";

const Schema = vb.strictObject({
  limit: vb.optional(
    vb.pipe(
      vb.number(),
      vb.minValue(1),
      vb.maxValue(30),
      vb.description("Max results to return (1-30)."),
    ),
    15,
  ),
  mode: vb.optional(
    vb.pipe(
      vb.union([vb.literal("raw"), vb.literal("glob"), vb.literal("regex")]),
      vb.description("Search mode (raw, glob, regex)."),
    ),
    "glob",
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
  query: vb.pipe(vb.string(), vb.nonEmpty(), vb.description("The search query.")),
  since: vb.optional(
    vb.pipe(vb.string(), vb.description("ISO-8601 timestamp; filter by lastActivity >= since.")),
  ),
});

function getMatchFn(query: string, mode: "raw" | "glob" | "regex"): (text: string) => boolean {
  switch (mode) {
    case "raw":
      return (text) => text.includes(query);
    case "glob": {
      // Simple glob-to-regex conversion (supporting * and ?)
      const escaped = query.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`);
      const regexStr = escaped.replaceAll(String.raw`\*`, ".*").replaceAll(String.raw`\?`, ".");
      const regex = new RegExp(`^${regexStr}$`, "i");
      return (text) => regex.test(text);
    }
    case "regex": {
      const regex = new RegExp(query, "i");
      return (text) => regex.test(text);
    }
    default:
      return (text) => text.includes(query);
  }
}

export const querySessions: ToolDef = {
  description:
    "Search message contents across multiple sessions.\n\n" +
    "Use this to find specific information or past discussions by keyword.\n" +
    "Returns matched messages with their session ID and timestamp.",
  // oxlint-disable-next-line require-await
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
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

    if (data.mode === "raw") {
      filters.push(like(sessions.history, `%${data.query}%`));
    }

    const rows = ctx.db
      .select()
      .from(sessions)
      .where(and(...filters))
      .all();

    const matchFn = getMatchFn(data.query, data.mode);
    const results: {
      channel: string;
      content: string;
      role: string;
      sessionId: string;
      timestamp?: number;
    }[] = [];

    for (const row of rows) {
      const rawHistory = vb.parse(vb.array(vb.unknown()), JSON.parse(row.history));
      const history = rawHistory.filter((it) => isMessage(it));

      const chatMessages = history.filter((msg) => msg.role === "user" || msg.role === "assistant");

      for (const msg of chatMessages) {
        const contents = Array.isArray(msg.content) ? msg.content : [msg.content];
        const fullText = contents
          .filter((part) => "content" in part)
          .map((part) => part.content)
          .join("\n");

        if (matchFn(fullText)) {
          results.push({
            channel: row.channel,
            content: fullText,
            role: msg.role,
            sessionId: row.id,
            timestamp: msg.timestamp,
          });
        }
      }
    }

    // Sort globally
    results.sort((first, second) => {
      const tsA = first.timestamp ?? 0;
      const tsB = second.timestamp ?? 0;
      return data.order === "asc" ? tsA - tsB : tsB - tsA;
    });

    const { offset, limit } = data;
    const paginated = results.slice(offset, offset + limit);

    return {
      matches: paginated,
      success: true,
      totalMatches: results.length,
    };
  },
  name: "query-sessions",
  parameters: Schema,
};
