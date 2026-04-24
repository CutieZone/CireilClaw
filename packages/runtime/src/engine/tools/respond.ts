import * as vb from "valibot";

import { ToolError } from "#engine/errors.js";
import type { ToolContext, ToolDef } from "#engine/tools/tool-def.js";
import type { ChannelResolution } from "#harness/channel-handler.js";

const RespondSchema = vb.strictObject({
  attachments: vb.pipe(
    vb.optional(vb.nullable(vb.array(vb.pipe(vb.string(), vb.nonEmpty())))),
    vb.transform((val) => val ?? undefined),
    vb.description(
      'Sandbox file paths to attach to the outgoing message (e.g. ["/workspace/report.pdf"]). Only used on platforms that support file attachments.',
    ),
  ),
  channel: vb.pipe(
    vb.optional(vb.nullable(vb.string())),
    vb.transform((val) => val ?? "current"),
    vb.description(
      'Target channel for the message. "current" (default) = send to this conversation; "last" = most recently active session; "owner" = DM the bot owner; or explicit like "discord:{channelId}|{guildId}" for a specific Discord channel (channel ID first, then guild ID — use session-info or list-sessions to get the correct session ID).',
    ),
  ),
  content: vb.pipe(vb.string(), vb.nonEmpty(), vb.description("Your message in plain Markdown.")),
  final: vb.pipe(
    vb.optional(vb.nullable(vb.boolean())),
    vb.transform((val) => val ?? true),
    vb.description(
      "Whether this message ends your turn. true = stop after sending; false = send an intermediate update and continue working. Defaults to true.",
    ),
  ),
});

type RespondInput = vb.InferOutput<typeof RespondSchema>;

function isChannelResolution(value: unknown): value is ChannelResolution {
  return typeof value === "object" && value !== null && ("channel" in value || "error" in value);
}

const respond: ToolDef = {
  description:
    "Send a message to a channel. This is the ONLY way to communicate — text written to files is not delivered.\n\n" +
    'Set `final: false` to send an intermediate status update and keep working (e.g. "Looking into it..." before a long task); `true` (default) ends the turn.\n\n' +
    'Use the `channel` parameter for cross-channel messaging: "current" (default) for this conversation, "last" for the most recently active session, "owner" to DM the bot owner, or an explicit session ID like "discord:123|456" for a specific channel.\n\n' +
    "You must call this tool at least once per turn. Every turn must end with either a `final: true` respond call or a `no-response` call.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    const parsed = vb.parse(RespondSchema, input);
    const { content, final, attachments } = parsed;
    // Channel is always a string after the transform (defaults to "current")
    const channel = parsed.channel ?? "current";

    if (attachments !== undefined) {
      for (const attachment of attachments) {
        await ctx.paths.checkConditionalAccess(attachment);
      }
    }

    const resolution = await ctx.channel.resolveChannel(channel);

    if (!isChannelResolution(resolution)) {
      throw new ToolError("invalid channel resolution from handler");
    }

    if ("error" in resolution) {
      throw new ToolError(resolution.error);
    }

    await ctx.reply.sendTo(resolution, content, attachments);
    // Cross-channel sends never end the turn — the agent still needs to respond to the current channel.
    const isCrossChannel = channel !== "current" && resolution !== ctx.session;
    return { final: isCrossChannel ? false : final, sent: true };
  },
  name: "respond",
  parameters: RespondSchema,
};

export { respond };
export type { RespondInput };
