import { initDb } from "$/db/index.js";
import { repairSessionImages } from "$/util/repair-session.js";
import type { CommandInteraction, CreateApplicationCommandOptions } from "oceanic.js";
import { ApplicationCommandTypes, MessageFlags } from "oceanic.js";

import type { HandlerCtx } from "./handler-ctx.js";

const definition: CreateApplicationCommandOptions = {
  description: "Repair corrupted images by re-fetching from Discord",
  name: "repair",
  type: ApplicationCommandTypes.CHAT_INPUT,
};

async function handle(interaction: CommandInteraction, ctx: HandlerCtx): Promise<void> {
  const channelId = interaction.channelID;
  const guildId = interaction.guildID ?? undefined;
  const sessionId =
    guildId === undefined ? `discord:${channelId}` : `discord:${channelId}|${guildId}`;

  initDb(ctx.agentSlug);

  try {
    const result = await repairSessionImages(ctx.agentSlug, sessionId, ctx.client);

    await interaction.createMessage({
      content: `Repair complete: ${result.updated} updated, ${result.failed} failed, ${result.skipped} skipped`,
      flags: MessageFlags.EPHEMERAL,
    });
  } catch (error) {
    await interaction.createMessage({
      content: `Repair failed: ${error instanceof Error ? error.message : String(error)}`,
      flags: MessageFlags.EPHEMERAL,
    });
  }
}

export { definition, handle };
