import { resetSession } from "$/db/sessions.js";
import type { CommandInteraction, CreateApplicationCommandOptions } from "oceanic.js";
import { ApplicationCommandTypes } from "oceanic.js";

import type { HandlerCtx } from "./handler-ctx.js";

const definition: CreateApplicationCommandOptions = {
  description: "Clear the current channel's conversation history",
  name: "clear",
  type: ApplicationCommandTypes.CHAT_INPUT,
};

async function handle(interaction: CommandInteraction, ctx: HandlerCtx): Promise<void> {
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

  session.reset();
  resetSession(ctx.agentSlug, sessionId);

  await interaction.createFollowup({ content: "Session cleared." });
}

export { definition, handle };
