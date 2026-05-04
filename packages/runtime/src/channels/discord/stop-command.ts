import type { CommandInteraction, CreateApplicationCommandOptions } from "oceanic.js";
import { ApplicationCommandTypes, MessageFlags } from "oceanic.js";

import type { HandlerCtx } from "#channels/discord/handler-ctx.js";
import { DiscordSession } from "#harness/session.js";
import { sanitizeError } from "#util/paths.js";

const definition: CreateApplicationCommandOptions = {
  description: "Gracefully stop the current generation",
  name: "stop",
  type: ApplicationCommandTypes.CHAT_INPUT,
};

async function handle(interaction: CommandInteraction, ctx: HandlerCtx): Promise<void> {
  try {
    const channelId = interaction.channelID;
    const guildId = interaction.guildID ?? undefined;
    const sessionId =
      guildId === undefined ? `discord:${channelId}` : `discord:${channelId}|${guildId}`;

    const agent = ctx.owner.agents.get(ctx.agentSlug);
    if (agent === undefined) {
      await interaction.createFollowup({
        content: "Failed to find valid session: no such agent exists here.",
        flags: MessageFlags.EPHEMERAL,
      });
      return;
    }

    const session = agent.sessions.get(sessionId);
    if (session === undefined || !(session instanceof DiscordSession)) {
      await interaction.createFollowup({
        content: "No active session in this channel.",
        flags: MessageFlags.EPHEMERAL,
      });
      return;
    }

    if (!session.busy) {
      await interaction.createFollowup({
        content: "No generation is currently running.",
        flags: MessageFlags.EPHEMERAL,
      });
      return;
    }

    session.stopRequested = true;

    await interaction.createFollowup({
      content: "Stopping the current generation gracefully...",
      flags: MessageFlags.EPHEMERAL,
    });
  } catch (error) {
    await interaction.createFollowup({
      content: `Stop failed: ${sanitizeError(error, ctx.agentSlug)}`,
      flags: MessageFlags.EPHEMERAL,
    });
  }
}

export { definition, handle };
