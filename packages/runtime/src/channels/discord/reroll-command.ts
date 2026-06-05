import type {
  AnyTextableChannel,
  CommandInteraction,
  CreateApplicationCommandOptions,
  Message as DiscordMessage,
} from "oceanic.js";
import { ApplicationCommandTypes, MessageFlags } from "oceanic.js";

import type { HandlerCtx } from "#channels/discord/handler-ctx.js";
import { runDiscordRestWithRetries } from "#channels/discord/rest-retry.js";
import { saveSession } from "#db/sessions.js";
import { DiscordSession } from "#harness/session.js";
import { sanitizeError } from "#util/paths.js";

const TYPING_INTERVAL_MS = 5000;

const definition: CreateApplicationCommandOptions = {
  name: "Reroll Response",
  type: ApplicationCommandTypes.MESSAGE,
};

async function handle(interaction: CommandInteraction, ctx: HandlerCtx): Promise<void> {
  // Track whether a rollback occurred so the error message can report it.
  let didRollback = false;
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
        content: "Can only reroll responses from this bot.",
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
        content: "A generation is already running. Wait for it to finish.",
        flags: MessageFlags.EPHEMERAL,
      });
      return;
    }

    session.busy = true;
    let typingInterval: ReturnType<typeof setInterval> | undefined = undefined;
    try {
      const msgIndex = session.history.findIndex(
        (entry) => entry.id === targetMsg.id || (entry.messageIds?.includes(targetMsg.id) ?? false),
      );
      if (msgIndex === -1) {
        await interaction.createFollowup({
          content: "Could not find this message in session history.",
          flags: MessageFlags.EPHEMERAL,
        });
        return;
      }

      await targetMsg.delete("Reroll triggered by owner");

      // Wipe this message and everything after from history
      session.history.splice(msgIndex);
      // Clamp cursor so it doesn't point past the new end of history
      if (session.historyCursor >= session.history.length) {
        session.historyCursor = Math.max(0, session.history.length - 1);
      }
      session.pendingToolMessages = [];
      session.pendingImages = [];
      session.pendingVideos = [];

      const lastUserMsg = session.history.findLast(
        (entry) => entry.role === "user" && entry.id !== undefined,
      );
      session.lastMessageId = lastUserMsg?.id;

      if (lastUserMsg === undefined) {
        saveSession(ctx.agentSlug, session);
        await interaction.createFollowup({
          content: "No user message to reroll from. Message deleted.",
          flags: MessageFlags.EPHEMERAL,
        });
        return;
      }

      session.stopRequested = false;

      // Best-effort typing indicator — don't let failures abort the reroll
      try {
        const channel = await runDiscordRestWithRetries(
          "GET /channels/{id}",
          async () => await ctx.client.rest.channels.get(interaction.channelID),
        );
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const textChannel = channel as AnyTextableChannel;
        await textChannel.sendTyping();
        typingInterval = setInterval(() => {
          // oxlint-disable-next-line promise/prefer-await-to-then
          textChannel.sendTyping().catch(() => {
            // Intentionally ignored
          });
        }, TYPING_INTERVAL_MS);
      } catch {
        // Typing setup failed — proceed without it
      }

      // Save history length before the turn so we can roll back if it fails.
      // Unlike the normal Discord turn path (discord.ts), the reroll has
      // already deleted the original bot message from Discord and spliced
      // history — we cannot restore the message, but we can restore session
      // state back to the user message the reroll was triggered from.
      const historyLengthBeforeTurn = session.history.length;

      try {
        await agent.runTurn(session);
      } catch (error) {
        // Roll back any history entries the failed turn may have pushed, clear
        // pending tool/media state, and re-throw so the outer catch sends the
        // error response to the user.
        session.history.length = historyLengthBeforeTurn;
        session.pendingToolMessages.length = 0;
        session.pendingImages.length = 0;
        session.pendingVideos.length = 0;
        session.lastMessageId = session.history.findLast((entry) => entry.id !== undefined)?.id;
        didRollback = true;
        throw error;
      }
    } finally {
      if (typingInterval !== undefined) {
        clearInterval(typingInterval);
      }
      session.busy = false;
      saveSession(ctx.agentSlug, session);
    }
  } catch (error) {
    // didRollback is set inside a nested catch before re-throw; TS can't
    // track assignments through that control-flow path into this outer catch.
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    const rollbackNote = didRollback
      ? " Session state has been rolled back to before the reroll target."
      : "";
    await interaction.createFollowup({
      content: `Reroll failed: ${sanitizeError(error, ctx.agentSlug)}${rollbackNote}`,
      flags: MessageFlags.EPHEMERAL,
    });
  }
}

export { definition, handle };
