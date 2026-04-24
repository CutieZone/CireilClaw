import * as vb from "valibot";

import { ToolError } from "#engine/errors.js";
import type { ToolContext, ToolDef } from "#engine/tools/tool-def.js";
import { DiscordSession, InternalSession, MatrixSession, TuiSession } from "#harness/session.js";

// No input parameters needed — this just returns session context.
const Schema = vb.strictObject({});

export const sessionInfo: ToolDef = {
  description:
    "Get information about the current session context.\n\n" +
    "Returns:\n" +
    '- `platform`: The platform type ("discord", "matrix", "tui", or "internal")\n' +
    "- `channel_id` (Discord only): The Discord channel ID\n" +
    "- `guild_id` (Discord only, optional): The Discord guild/server ID (undefined for DMs)\n" +
    "- `room_id` (Matrix only): The Matrix room ID\n" +
    "- `is_nsfw` (Discord only): Whether the channel is marked NSFW\n\n" +
    "Use this to get the IDs needed for other platform-specific operations.",
  // oxlint-disable-next-line typescript/require-await
  async execute(_input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    const { session } = ctx;

    if (session instanceof DiscordSession) {
      return {
        channel_id: session.channelId,
        guild_id: session.guildId,
        is_nsfw: session.isNsfw,
        platform: "discord",
        session_id: session.id(),
        success: true,
      };
    }

    if (session instanceof MatrixSession) {
      return {
        platform: "matrix",
        room_id: session.roomId,
        session_id: session.id(),
        success: true,
      };
    }

    if (session instanceof TuiSession) {
      return {
        platform: "tui",
        session_id: session.id(),
        success: true,
      };
    }

    if (session instanceof InternalSession) {
      return {
        platform: "internal",
        session_id: session.id(),
        success: true,
      };
    }

    throw new ToolError("Unknown session type");
  },
  name: "session-info",
  parameters: Schema,
};
