import { ApplicationCommandOptionTypes, ApplicationCommandTypes, MessageFlags } from "oceanic.js";
import type { CommandInteraction, CreateApplicationCommandOptions } from "oceanic.js";

import { saveSession } from "#db/sessions.js";
import { removeSummary } from "#engine/summarizer.js";
import { sanitizeError } from "#util/paths.js";

import type { HandlerCtx } from "./handler-ctx.js";

const definition: CreateApplicationCommandOptions = {
  description: "Remove a topic summary and restore the full conversation to context",
  name: "unsummarize",
  options: [
    {
      description: "Name of the summary to remove",
      name: "name",
      required: true,
      type: ApplicationCommandOptionTypes.STRING,
    },
  ],
  type: ApplicationCommandTypes.CHAT_INPUT,
};

async function handleCommand(interaction: CommandInteraction, ctx: HandlerCtx): Promise<void> {
  try {
    const channelId = interaction.channelID;
    const guildId = interaction.guildID ?? undefined;
    const sessionId =
      guildId === undefined ? `discord:${channelId}` : `discord:${channelId}|${guildId}`;

    const agent = ctx.owner.agents.get(ctx.agentSlug);
    if (agent === undefined) {
      await interaction.createFollowup({
        content: "No agent found for this channel.",
        flags: MessageFlags.EPHEMERAL,
      });
      return;
    }

    const session = agent.sessions.get(sessionId);
    if (session === undefined) {
      await interaction.createFollowup({
        content: "No active session.",
        flags: MessageFlags.EPHEMERAL,
      });
      return;
    }

    const name = interaction.data.options.getString("name");
    if (name === undefined) {
      await interaction.createFollowup({
        content: "Name is required.",
        flags: MessageFlags.EPHEMERAL,
      });
      return;
    }

    const slug = name
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, "-")
      .replaceAll(/^-+|-+$/gu, "");

    let removed = removeSummary(ctx.agentSlug, session, slug);
    let matchedName = name;

    if (!removed) {
      const match = session.summaries.find(
        (summary) => summary.displayName.toLowerCase() === name.toLowerCase(),
      );
      if (match !== undefined) {
        removed = removeSummary(ctx.agentSlug, session, match.slug);
        matchedName = match.displayName;
      }
    }

    if (!removed) {
      await interaction.createFollowup({
        content: `No summary named "${name}" found.`,
        flags: MessageFlags.EPHEMERAL,
      });
      return;
    }

    saveSession(ctx.agentSlug, session);

    await interaction.createFollowup({
      content: `Removed summary "${matchedName}". The full conversation range is restored to context.`,
      flags: MessageFlags.EPHEMERAL,
    });
  } catch (error) {
    await interaction.createFollowup({
      content: `Unsummarize failed: ${sanitizeError(error, ctx.agentSlug)}`,
      flags: MessageFlags.EPHEMERAL,
    });
  }
}

export { definition, handleCommand };
