import type { CommandInteraction, CreateApplicationCommandOptions } from "oceanic.js";
import { ApplicationCommandTypes, MessageFlags } from "oceanic.js";

import { initDb } from "#db/index.js";
import { discordSessionId } from "#harness/session.js";
import { sanitizeError } from "#util/paths.js";
import { repairSession } from "#util/repair-session.js";

import type { HandlerCtx } from "./handler-ctx.js";

const definition: CreateApplicationCommandOptions = {
  description: "Repair a session: re-fetch attachments from Discord and sort history",
  name: "repair",
  type: ApplicationCommandTypes.CHAT_INPUT,
};

async function handle(interaction: CommandInteraction, ctx: HandlerCtx): Promise<void> {
  const channelId = interaction.channelID;
  const guildId = interaction.guildID ?? undefined;
  const sessionId = discordSessionId(channelId, guildId);

  initDb(ctx.agentSlug);

  try {
    const result = await repairSession(ctx.agentSlug, sessionId, ctx.client);

    await interaction.createFollowup({
      content: `Repair complete: ${result.reordered} reordered, ${result.updated} updated, ${result.failed} failed, ${result.skipped} skipped`,
      flags: MessageFlags.EPHEMERAL,
    });
  } catch (error) {
    await interaction.createFollowup({
      content: `Repair failed: ${sanitizeError(error, ctx.agentSlug)}`,
      flags: MessageFlags.EPHEMERAL,
    });
  }
}

export { definition, handle };
