import type { CommandInteraction, CreateApplicationCommandOptions } from "oceanic.js";
import { ApplicationCommandTypes, MessageFlags } from "oceanic.js";

import type { HandlerCtx } from "#channels/discord/handler-ctx.js";
import { sanitizeError } from "#util/paths.js";

const definition: CreateApplicationCommandOptions = {
  description: "Generate an invite link for this bot",
  name: "invite",
  type: ApplicationCommandTypes.CHAT_INPUT,
};

async function handle(interaction: CommandInteraction, ctx: HandlerCtx): Promise<void> {
  try {
    const clientId = ctx.client.application.id;
    const permissions = 563_465_349_875_776n;

    const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=${permissions}&scope=bot%20applications.commands`;

    await interaction.createFollowup({
      content: `Invite link: ${inviteUrl}`,
      flags: MessageFlags.EPHEMERAL,
    });
  } catch (error) {
    await interaction.createFollowup({
      content: `Failed to generate invite link: ${sanitizeError(error, ctx.agentSlug)}`,
      flags: MessageFlags.EPHEMERAL,
    });
  }
}

export { definition, handle };
