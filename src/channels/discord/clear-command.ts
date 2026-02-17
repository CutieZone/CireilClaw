import type { Harness } from "$/harness/index.js";
import type { CommandInteraction, CreateApplicationCommandOptions } from "oceanic.js";

import { deleteSession } from "$/db/sessions.js";
import { ApplicationCommandTypes } from "oceanic.js";

const definition: CreateApplicationCommandOptions = {
  description: "Clear the current channel's conversation history",
  name: "clear",
  type: ApplicationCommandTypes.CHAT_INPUT,
};

async function handle(interaction: CommandInteraction, owner: Harness): Promise<void> {
  const channelId = interaction.channelID;
  const guildId = interaction.guildID ?? undefined;
  const sessionId =
    guildId === undefined ? `discord:${channelId}` : `discord:${channelId}|${guildId}`;

  let found = false;
  for (const agent of owner.agents.values()) {
    if (agent.sessions.has(sessionId)) {
      agent.sessions.delete(sessionId);
      deleteSession(sessionId);
      found = true;
      break;
    }
  }

  await interaction.createMessage({
    content: found ? "Session cleared." : "No active session to clear.",
  });
}

export { definition, handle };
