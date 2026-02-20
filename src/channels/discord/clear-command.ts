import { deleteSession } from "$/db/sessions.js";
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

  let found = false;
  const agent = ctx.owner.agents.get(ctx.agentSlug);
  if (agent === undefined) {
    await interaction.createMessage({
      content: "Failed to find valid session: no such agent exists here.",
    });
    return;
  }

  if (agent.sessions.has(sessionId)) {
    agent.sessions.delete(sessionId);
    deleteSession(ctx.agentSlug, sessionId);
    found = true;
  }

  await interaction.createMessage({
    content: found ? "Session cleared." : "No active session to clear.",
  });
}

export { definition, handle };
