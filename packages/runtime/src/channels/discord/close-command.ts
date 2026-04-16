import { saveSession } from "$/db/sessions.js";
import { sanitizeError } from "$/util/paths.js";
import type {
  AutocompleteInteraction,
  CommandInteraction,
  CreateApplicationCommandOptions,
} from "oceanic.js";
import { ApplicationCommandOptionTypes, ApplicationCommandTypes, MessageFlags } from "oceanic.js";

import type { HandlerCtx } from "./handler-ctx.js";

const definition: CreateApplicationCommandOptions = {
  description: "Close an open file in the current session",
  name: "close",
  options: [
    {
      autocomplete: true,
      description: "Path of the open file to close",
      name: "path",
      required: true,
      type: ApplicationCommandOptionTypes.STRING,
    },
  ],
  type: ApplicationCommandTypes.CHAT_INPUT,
};

async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  ctx: HandlerCtx,
): Promise<void> {
  const channelId = interaction.channelID;
  const guildId = interaction.guildID ?? undefined;
  const sessionId =
    guildId === undefined ? `discord:${channelId}` : `discord:${channelId}|${guildId}`;

  const agent = ctx.owner.agents.get(ctx.agentSlug);
  if (agent === undefined) {
    await interaction.result([{ name: "No agent found", value: "" }]);
    return;
  }

  const session = agent.sessions.get(sessionId);
  if (session === undefined || session.openedFiles.size === 0) {
    await interaction.result([{ name: "No open files", value: "" }]);
    return;
  }

  const focused = interaction.data.options.getFocused(true).value;
  const openFiles = [...session.openedFiles];
  const filtered = openFiles
    .filter((path) => path.toLowerCase().includes(String(focused).toLowerCase()))
    .map((path) => ({ name: path, value: path }));

  if (filtered.length === 0) {
    await interaction.result([{ name: "No matching open files", value: "" }]);
    return;
  }

  // Autocomplete choices are capped at 25 by Discord
  if (filtered.length > 25) {
    filtered.length = 25;
  }

  await interaction.result(filtered);
}

async function handleCommand(interaction: CommandInteraction, ctx: HandlerCtx): Promise<void> {
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
    if (session === undefined) {
      await interaction.createFollowup({
        content: "No active session to close files in.",
        flags: MessageFlags.EPHEMERAL,
      });
      return;
    }

    const path = interaction.data.options.getString("path");
    if (path === undefined) {
      await interaction.createFollowup({
        content: "No file path provided.",
        flags: MessageFlags.EPHEMERAL,
      });
      return;
    }

    if (!session.openedFiles.has(path)) {
      await interaction.createFollowup({
        content: `File \`${path}\` is not currently open.`,
        flags: MessageFlags.EPHEMERAL,
      });
      return;
    }

    session.openedFiles.delete(path);
    saveSession(ctx.agentSlug, session);

    await interaction.createFollowup({
      content: `Closed \`${path}\`. Remaining open files: ${session.openedFiles.size}`,
      flags: MessageFlags.EPHEMERAL,
    });
  } catch (error) {
    await interaction.createFollowup({
      content: `Close failed: ${sanitizeError(error, ctx.agentSlug)}`,
      flags: MessageFlags.EPHEMERAL,
    });
  }
}

export { definition, handleAutocomplete, handleCommand };
