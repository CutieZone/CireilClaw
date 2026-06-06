import type {
  CommandInteraction,
  CreateApplicationCommandOptions,
  Message as DiscordMessage,
} from "oceanic.js";
import { ApplicationCommandTypes, MessageFlags } from "oceanic.js";

import type { HandlerCtx } from "#channels/discord/handler-ctx.js";
import { saveSession } from "#db/sessions.js";
import { DiscordSession } from "#harness/session.js";
import { sanitizeError } from "#util/paths.js";

const definition: CreateApplicationCommandOptions = {
  name: "Delete Message",
  type: ApplicationCommandTypes.MESSAGE,
};

async function handle(interaction: CommandInteraction, ctx: HandlerCtx): Promise<void> {
  try {
    const { target } = interaction.data;
    if (!target || !("author" in target)) {
      await interaction.createFollowup({
        content: "Could not resolve the target message.",
        flags: MessageFlags.EPHEMERAL,
      });
      return;
    }

    // Narrow from User | Message to Message — message commands always target
    // a message, and the "author" in-check above excludes the User variant.
    const targetMsg = target as DiscordMessage;

    if (targetMsg.author.id !== ctx.client.application.id) {
      await interaction.createFollowup({
        content: "Can only delete messages from this bot.",
        flags: MessageFlags.EPHEMERAL,
      });
      return;
    }

    const sessionId =
      // undefined semantics are better than null semantics
      (interaction.guildID ?? undefined) === undefined
        ? `discord:${interaction.channelID}`
        : `discord:${interaction.channelID}|${interaction.guildID}`;

    if (!ctx.owner.agents.has(ctx.agentSlug)) {
      await interaction.createFollowup({
        content: "Failed to find the agent session.",
        flags: MessageFlags.EPHEMERAL,
      });
      return;
    }
    const agent = ctx.owner.agents.get(ctx.agentSlug);

    if (agent === undefined) {
      throw new Error("Agent is (for some reason) undefined. Should be impossible if we're here.");
    }

    const session = agent.sessions.get(sessionId);
    if (session === undefined || !(session instanceof DiscordSession)) {
      await interaction.createFollowup({
        content: "No active session in this channel.",
        flags: MessageFlags.EPHEMERAL,
      });
      return;
    }

    if (session.busy) {
      await interaction.createFollowup({
        content: "A generation is in progress. Try again when it finishes.",
        flags: MessageFlags.EPHEMERAL,
      });
      return;
    }

    session.busy = true;
    saveSession(ctx.agentSlug, session);
    try {
      // Always try to delete from Discord — ownership & permission already verified
      await targetMsg.delete("Deleted by owner");

      // Best-effort cleanup from session history
      const msgIndex = session.history.findIndex(
        (entry) => entry.id === targetMsg.id || (entry.messageIds?.includes(targetMsg.id) ?? false),
      );
      if (msgIndex !== -1) {
        if (session.historyCursor > msgIndex) {
          session.historyCursor--;
        }
        session.history.splice(msgIndex, 1);
        session.lastMessageId = session.history.findLast((entry) => entry.id !== undefined)?.id;
      }
      saveSession(ctx.agentSlug, session);
    } finally {
      session.busy = false;
      saveSession(ctx.agentSlug, session);
    }

    await interaction.createFollowup({
      content: "Message deleted.",
      flags: MessageFlags.EPHEMERAL,
    });
  } catch (error) {
    await interaction.createFollowup({
      content: `Delete failed: ${sanitizeError(error, ctx.agentSlug)}`,
      flags: MessageFlags.EPHEMERAL,
    });
  }
}

export { definition, handle };
