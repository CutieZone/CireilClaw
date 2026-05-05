import { ApplicationCommandOptionTypes, ApplicationCommandTypes, MessageFlags } from "oceanic.js";
import type { CommandInteraction, CreateApplicationCommandOptions } from "oceanic.js";

import { saveSession } from "#db/sessions.js";
import { sanitizeError } from "#util/paths.js";

import type { HandlerCtx } from "./handler-ctx.js";

const definition: CreateApplicationCommandOptions = {
  description: "Summarize a portion of the conversation to save context space",
  name: "summarize",
  options: [
    {
      description: "Short name for this topic (e.g. auth-refactor)",
      name: "name",
      required: true,
      type: ApplicationCommandOptionTypes.STRING,
    },
    {
      description: "Natural language description of what to summarize",
      name: "description",
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
        content: "No active session to summarize.",
        flags: MessageFlags.EPHEMERAL,
      });
      return;
    }

    const name = interaction.data.options.getString("name");
    const description = interaction.data.options.getString("description");

    if (name === undefined || description === undefined) {
      await interaction.createFollowup({
        content: "Both name and description are required.",
        flags: MessageFlags.EPHEMERAL,
      });
      return;
    }

    // Slugify the name to check for existing summaries
    const slug = name
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "");

    if (slug.length === 0) {
      await interaction.createFollowup({
        content: "Name must contain at least one alphanumeric character.",
        flags: MessageFlags.EPHEMERAL,
      });
      return;
    }

    // Check if a summary with this slug already exists
    const existing = session.summaries.find((summary) => summary.slug === slug);
    if (existing !== undefined) {
      await interaction.createFollowup({
        content: `A summary named "${existing.displayName}" already exists. Use \`/unsummarize ${name}\` to remove it first, or choose a different name.`,
        flags: MessageFlags.EPHEMERAL,
      });
      return;
    }

    // The summarization is requested via the engine. We inject a system
    // message into the session that tells the agent to invoke the summarizer.
    // The agent receives a special prompt instructing it to identify the
    // topic boundaries and call prune-boundaries.
    session.pendingToolMessages.push({
      content: {
        content: `<summarization-request name="${name}">${description}</summarization-request>`,
        type: "text",
      },
      role: "user",
    });

    saveSession(ctx.agentSlug, session);

    await interaction.createFollowup({
      content: `Summarization requested for "${name}". The agent will identify the relevant conversation range and compact it. Use \`/unsummarize ${name}\` to undo.`,
      flags: MessageFlags.EPHEMERAL,
    });
  } catch (error) {
    await interaction.createFollowup({
      content: `Summarize failed: ${sanitizeError(error, ctx.agentSlug)}`,
      flags: MessageFlags.EPHEMERAL,
    });
  }
}

export { definition, handleCommand };
