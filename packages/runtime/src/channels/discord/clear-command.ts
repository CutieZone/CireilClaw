import { ApplicationCommandOptionTypes, ApplicationCommandTypes, MessageFlags } from "oceanic.js";
import type { CommandInteraction, CreateApplicationCommandOptions } from "oceanic.js";

import type { HandlerCtx } from "#channels/discord/handler-ctx.js";
import { resetSession } from "#db/sessions.js";
import { sanitizeError } from "#util/paths.js";

const definition: CreateApplicationCommandOptions = {
  description: "Clear the current channel's conversation history",
  name: "clear",
  options: [
    {
      description: "Also prevent earlier Discord messages from appearing in context",
      name: "super",
      required: false,
      type: ApplicationCommandOptionTypes.BOOLEAN,
    },
  ],
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
      });
      return;
    }

    const session = agent.sessions.get(sessionId);
    if (session === undefined) {
      await interaction.createFollowup({ content: "No active session to clear." });
      return;
    }

    const isSuper = interaction.data.options.getBoolean("super") ?? false;
    if (isSuper) {
      session.historyBarrier = Date.now();
    }

    session.reset();
    resetSession(ctx.agentSlug, sessionId);

    await interaction.createFollowup({
      content: isSuper ? "Session super-cleared." : "Session cleared.",
    });
  } catch (error) {
    await interaction.createFollowup({
      content: `Clear failed: ${sanitizeError(error, ctx.agentSlug)}`,
      flags: MessageFlags.EPHEMERAL,
    });
  }
}

export { definition, handle };
