import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import type {
  AnyInteractionGateway,
  AnyTextableChannel,
  Client as OceanicClient,
  CommandInteraction,
  Message as DiscordMessage,
  PossiblyUncachedMessage,
  Uncached,
  User,
  Member,
  EventReaction,
  AutocompleteInteraction,
} from "oceanic.js";
import {
  ChannelTypes,
  InteractionTypes,
  MessageFlags,
  StickerFormatTypes,
  TextableChannelTypes,
} from "oceanic.js";

import * as clearCommand from "#channels/discord/clear-command.js";
import * as closeCommand from "#channels/discord/close-command.js";
import type { HandlerCtx } from "#channels/discord/handler-ctx.js";
import * as inviteCommand from "#channels/discord/invite-command.js";
import * as modelCommand from "#channels/discord/model-command.js";
import * as repairCommand from "#channels/discord/repair-command.js";
import { runDiscordRestWithRetries } from "#channels/discord/rest-retry.js";
import * as stopCommand from "#channels/discord/stop-command.js";
import * as summarizeCommand from "#channels/discord/summarize-command.js";
import * as unsummarizeCommand from "#channels/discord/unsummarize-command.js";
import { sendDiscordWarningMessage } from "#channels/discord/warning-message.js";
import { loadChannel, loadEngine } from "#config/index.js";
import { saveSession } from "#db/sessions.js";
import type { ImageContent, TextContent, VideoContent } from "#engine/content.js";
import type { Message } from "#engine/message.js";
import type { ChannelHandler } from "#harness/channel-handler.js";
import type { Harness } from "#harness/index.js";
import { DiscordSession } from "#harness/session.js";
import colors from "#output/colors.js";
import { debug, error as logError, info, warning } from "#output/log.js";
import { SUPPORTED_IMAGE_TYPES, SUPPORTED_VIDEO_TYPES, VIDEO_SIZE_CAP } from "#supports.js";
import { formatDate } from "#util/date.js";
import { getDefaultProviderAndModel } from "#util/default-provider-and-model.js";
import { toWebp } from "#util/image.js";
import { agentRoot, sandboxToReal } from "#util/paths.js";

// oceanic.js's ESM shim breaks under tsx's module loader (.default.default chain
// resolves to undefined). Force CJS to get the real constructors.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const { Client, Intents } = createRequire(import.meta.url)(
  "oceanic.js",
  // oxlint-disable-next-line typescript/consistent-type-imports
) as typeof import("oceanic.js");

// 200-char safety buffer below Discord's 2000-char hard limit.
const CHUNK_LIMIT = 1800;
const TYPING_INTERVAL_MS = 5000;

// All registered slash commands. Add new command modules here — the hash
// check on startup will detect changes and re-register with Discord's API.
const SLASH_COMMANDS = [
  clearCommand.definition,
  closeCommand.definition,
  inviteCommand.definition,
  modelCommand.definition,
  repairCommand.definition,
  stopCommand.definition,
  summarizeCommand.definition,
  unsummarizeCommand.definition,
];

type SlashHandler = (interaction: CommandInteraction, ctx: HandlerCtx) => Promise<void>;
const SLASH_HANDLERS = new Map<string, SlashHandler>([
  ["clear", clearCommand.handle],
  ["close", closeCommand.handleCommand],
  ["invite", inviteCommand.handle],
  ["model", modelCommand.handleCommand],
  ["repair", repairCommand.handle],
  ["stop", stopCommand.handle],
  ["summarize", summarizeCommand.handleCommand],
  ["unsummarize", unsummarizeCommand.handleCommand],
]);

const SILENT_COMMANDS = new Set(["model", "invite", "close", "stop", "summarize", "unsummarize"]);

type AutocompleteHandler = (interaction: AutocompleteInteraction, ctx: HandlerCtx) => Promise<void>;
const AUTOCOMPLETE_HANDLERS = new Map<string, AutocompleteHandler>([
  ["close", closeCommand.handleAutocomplete],
  ["model", modelCommand.handleAutocomplete],
]);

// Persisted hash of SLASH_COMMANDS to avoid re-registering on every startup.
const COMMANDS_HASH = createHash("sha256").update(JSON.stringify(SLASH_COMMANDS)).digest("hex");

function commandsHashFile(agentSlug: string): string {
  return path.join(agentRoot(agentSlug), "discord-commands.hash");
}

function installedCommandsFingerprint(appId: string): string {
  return `${appId}:${COMMANDS_HASH}`;
}

function readCommandsHash(agentSlug: string): string | undefined {
  try {
    return readFileSync(commandsHashFile(agentSlug), "utf8").trim();
  } catch {
    return undefined;
  }
}

function writeCommandsHash(agentSlug: string, hash: string): void {
  writeFileSync(commandsHashFile(agentSlug), hash, "utf8");
}

// Resolves the best display name for a message author. Prefers the guild
// nickname, then the global display name, then the username. Falls back to the
// cached guild member when `msg.member` is missing; if the member isn't cached,
// fetches it via REST (which also populates the cache).
async function resolveDisplayName(msg: DiscordMessage): Promise<string> {
  const { member: msgMember, guildID, author, client } = msg;
  let member = msgMember;
  if (member === undefined && guildID !== null) {
    member = client.guilds.get(guildID)?.members.get(author.id);
  }
  if (member === undefined && guildID !== null) {
    try {
      member = await runDiscordRestWithRetries(
        `GET /guilds/${guildID}/members/${author.id}`,
        async () => await client.rest.guilds.getMember(guildID, author.id),
      );
    } catch {
      // Member may have left or we lack permissions; fall through to author info.
    }
  }
  return member?.nick ?? author.globalName ?? author.username;
}

// Wraps an incoming Discord message's content with sender metadata so the
// agent has full context about who sent what and when, without needing to
// parse it out of the message history separately. Includes attachment metadata
// so the model knows what files/images are present.
async function formatUserMessage(
  msg: DiscordMessage,
  opts?: { directReply?: DiscordMessage; isMentioned?: boolean },
): Promise<TextContent> {
  const { username } = msg.author;
  const authorId = msg.author.id;
  const displayName = await resolveDisplayName(msg);
  const timestamp = await formatDate(msg.createdAt);

  let innerContent = msg.content;

  // Append attachment metadata so the model knows what files are present
  const attachments = [...msg.attachments.values()];
  if (attachments.length > 0) {
    const attachmentInfo = attachments
      .map(
        (att) =>
          `<attachment id="${att.id}" filename="${att.filename}" contentType="${att.contentType ?? "unknown"}" size="${att.size}" description="${att.description ?? ""}">`,
      )
      .join("\n");
    innerContent += `\n${attachmentInfo}`;
  }

  // Append sticker metadata so the model knows what stickers are present
  if (msg.stickerItems && msg.stickerItems.length > 0) {
    const stickerInfo = msg.stickerItems
      .map((sticker) => {
        const hint =
          sticker.format_type === StickerFormatTypes.LOTTIE ? ' hint="cannot be displayed"' : "";
        return `<sticker name="${sticker.name}"${hint}>`;
      })
      .join("\n");
    innerContent += `\n${stickerInfo}`;
  }

  // Build optional attributes for reply/mention context
  let replyAttr = "";
  if (opts?.directReply !== undefined) {
    const isReplyingToBot = opts.directReply.author.id === msg.client.application.id;
    if (isReplyingToBot) {
      replyAttr = ` in-reply-to="YOU"`;
    } else {
      const replyDisplayName = await resolveDisplayName(opts.directReply);
      replyAttr = ` in-reply-to="${replyDisplayName}"`;
    }
  }

  const mentionAttr = (opts?.isMentioned ?? false) ? ` mentions="YOU"` : "";

  return {
    content: `<msg msgId="${msg.id}" from="${username} <${authorId}>" displayName="${displayName}" timestamp="${timestamp}"${replyAttr}${mentionAttr}>${innerContent}</msg>`,
    type: "text",
  };
}

// Includes attachment metadata so the model knows what files/images are present.
async function formatHistoryContext(msg: DiscordMessage): Promise<TextContent> {
  const { username } = msg.author;
  const authorId = msg.author.id;
  const displayName = await resolveDisplayName(msg);
  const timestamp = await formatDate(msg.createdAt);

  let innerContent = msg.content;

  // Append attachment metadata so the model knows what files are present
  const attachments = [...msg.attachments.values()];
  if (attachments.length > 0) {
    const attachmentInfo = attachments
      .map(
        (att) =>
          `<attachment id="${att.id}" filename="${att.filename}" contentType="${att.contentType ?? "unknown"}" size="${att.size}" description="${att.description ?? ""}">`,
      )
      .join("\n");
    innerContent += `\n${attachmentInfo}`;
  }

  // Append sticker metadata so the model knows what stickers are present
  if (msg.stickerItems && msg.stickerItems.length > 0) {
    const stickerInfo = msg.stickerItems
      .map((sticker) => {
        const hint =
          sticker.format_type === StickerFormatTypes.LOTTIE ? ' hint="cannot be displayed"' : "";
        return `<sticker name="${sticker.name}"${hint}>`;
      })
      .join("\n");
    innerContent += `\n${stickerInfo}`;
  }

  return {
    content: `<history-context msgId="${msg.id}" from="${username} <${authorId}>" displayName="${displayName}" timestamp="${timestamp}">${innerContent}</history-context>`,
    type: "text",
  };
}

async function formatAssistantContext(msg: DiscordMessage): Promise<TextContent> {
  const timestamp = await formatDate(msg.createdAt);

  return {
    content: `<assistant-context msgId="${msg.id}" timestamp="${timestamp}">${msg.content}</assistant-context>`,
    type: "text",
  };
}

async function crawlReplyTree(
  client: OceanicClient,
  startMsg: DiscordMessage,
): Promise<DiscordMessage[]> {
  const messages: DiscordMessage[] = [];
  const seen = new Set<string>();
  let nextRef = startMsg.messageReference;

  while (nextRef?.channelID !== undefined && nextRef.messageID !== undefined) {
    const { channelID, messageID } = nextRef;

    // Prevent infinite loops
    if (seen.has(messageID)) {
      break;
    }
    seen.add(messageID);

    try {
      const parent = await client.rest.channels.getMessage(channelID, messageID);
      messages.push(parent);
      nextRef = parent.messageReference;
    } catch {
      // Failed to fetch parent (deleted, no permission, etc.) - stop crawling
      break;
    }
  }

  return messages.toReversed();
}

function isMessageInHistory(history: Message[], messageId: string): boolean {
  for (const entry of history) {
    if (entry.id === messageId) {
      return true;
    }
  }
  return false;
}

// Silently drops failures and sorts by attachment ID for consistent ordering.
async function fetchAttachmentImages(msg: DiscordMessage): Promise<ImageContent[]> {
  const fetchPromises = [...msg.attachments.values()].map(
    async (attachment): Promise<(ImageContent & { id: string }) | undefined> => {
      const mediaType = attachment.contentType?.split(";")[0]?.trim();
      if (mediaType === undefined || !SUPPORTED_IMAGE_TYPES.has(mediaType)) {
        return undefined;
      }
      try {
        const response = await fetch(attachment.url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const raw = await response.arrayBuffer();
        const data = await toWebp(raw, mediaType);
        return {
          data,
          id: attachment.id,
          mediaType: "image/webp",
          type: "image",
        } as const;
      } catch (error) {
        warning(
          "Failed to fetch attachment:",
          attachment.url,
          error instanceof Error ? error.message : String(error),
        );
        return undefined;
      }
    },
  );

  const results = await Promise.all(fetchPromises);
  return results
    .filter((img): img is NonNullable<typeof img> => img !== undefined)
    .toSorted((first, second) => first.id.localeCompare(second.id))
    .map(({ id: _id, ...imageContent }) => imageContent);
}

// LOTTIE format stickers are skipped (cannot be displayed as raster images).
async function fetchStickerImages(msg: DiscordMessage): Promise<ImageContent[]> {
  if (!msg.stickerItems || msg.stickerItems.length === 0) {
    return [];
  }

  const fetchPromises = msg.stickerItems.map(
    async (sticker): Promise<(ImageContent & { id: string }) | undefined> => {
      if (sticker.format_type === StickerFormatTypes.LOTTIE) {
        return undefined;
      }

      try {
        const url =
          sticker.format_type === StickerFormatTypes.GIF
            ? `https://media.discordapp.net/stickers/${sticker.id}.gif`
            : `https://cdn.discordapp.com/stickers/${sticker.id}.png`;

        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const raw = await response.arrayBuffer();
        const data = await toWebp(raw);
        return {
          data,
          id: sticker.id,
          mediaType: "image/webp",
          type: "image",
        } as const;
      } catch (error) {
        warning(
          "Failed to fetch sticker:",
          sticker.name,
          error instanceof Error ? error.message : String(error),
        );
        return undefined;
      }
    },
  );

  const results = await Promise.all(fetchPromises);
  return results
    .filter((img): img is NonNullable<typeof img> => img !== undefined)
    .toSorted((first, second) => first.id.localeCompare(second.id))
    .map(({ id: _id, ...imageContent }) => imageContent);
}

async function fetchAllImages(msg: DiscordMessage): Promise<ImageContent[]> {
  const [attachmentImages, stickerImages] = await Promise.all([
    fetchAttachmentImages(msg),
    fetchStickerImages(msg),
  ]);
  return [...attachmentImages, ...stickerImages];
}

// Skips attachments exceeding VIDEO_SIZE_CAP to avoid sending huge payloads to the API.
async function fetchAttachmentVideos(msg: DiscordMessage): Promise<VideoContent[]> {
  const fetchPromises = [...msg.attachments.values()].map(
    async (attachment): Promise<(VideoContent & { sortId: string }) | undefined> => {
      const mediaType = attachment.contentType?.split(";")[0]?.trim();
      if (mediaType === undefined || !SUPPORTED_VIDEO_TYPES.has(mediaType)) {
        return undefined;
      }
      if (attachment.size > VIDEO_SIZE_CAP) {
        warning(
          `Skipping video attachment '${attachment.filename}' — ${attachment.size} bytes exceeds ${VIDEO_SIZE_CAP}-byte cap`,
        );
        return undefined;
      }
      try {
        const response = await fetch(attachment.url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = new Uint8Array(await response.arrayBuffer());
        return {
          attachmentId: attachment.id,
          data,
          mediaType,
          sortId: attachment.id,
          type: "video",
          url: attachment.url,
        } as const;
      } catch (error) {
        warning(
          "Failed to fetch video attachment:",
          attachment.url,
          error instanceof Error ? error.message : String(error),
        );
        return undefined;
      }
    },
  );

  const results = await Promise.all(fetchPromises);
  return results
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .toSorted((first, second) => first.sortId.localeCompare(second.sortId))
    .map(({ sortId: _sortId, ...videoContent }) => videoContent);
}

async function fetchMessageHistory(
  client: OceanicClient,
  channelId: string,
  limit = 30,
): Promise<DiscordMessage[]> {
  try {
    const fetched = await client.rest.channels.getMessages(channelId, {
      limit,
    });
    return fetched.toReversed();
  } catch {
    // Channel may not be readable, permissions issues, etc.
    return [];
  }
}

// Discord message flag for suppress notifications (silent messages)
const SUPPRESS_NOTIFICATIONS = 4096;

function isSuppressNotifications(msg: DiscordMessage): boolean {
  return (msg.flags & SUPPRESS_NOTIFICATIONS) !== 0;
}

async function populateHistoryFromDiscord(
  client: OceanicClient,
  session: DiscordSession,
  botId: string,
  currentMessageId: string,
  limit = 30,
): Promise<void> {
  const messages = await fetchMessageHistory(client, session.channelId, limit);

  for (const msg of messages) {
    // Skip the current message - it's being processed separately
    if (msg.id === currentMessageId) {
      continue;
    }

    // Skip messages already in history (shouldn't happen on new sessions, but safe to check)
    if (isMessageInHistory(session.history, msg.id)) {
      continue;
    }

    // Skip messages before the history barrier (super-clear)
    if (session.historyBarrier !== undefined && msg.createdAt.getTime() < session.historyBarrier) {
      continue;
    }

    // Skip suppressed notification messages (silent messages) - they shouldn't
    // make it to the LLM unless they're in the reply chain (which is handled
    // separately by crawlReplyTree)
    if (isSuppressNotifications(msg)) {
      continue;
    }

    const hasImages = msg.attachments.some(
      (attachment) =>
        attachment.contentType !== undefined &&
        SUPPORTED_IMAGE_TYPES.has(attachment.contentType.split(";")[0]?.trim() ?? ""),
    );
    const hasText = msg.content.trim().length > 0;

    if (!hasText && !hasImages) {
      continue;
    }

    const isFromBot = msg.author.id === botId;
    const role = isFromBot ? ("assistant" as const) : ("user" as const);

    const textContent = isFromBot
      ? await formatAssistantContext(msg)
      : await formatHistoryContext(msg);
    const images = await fetchAllImages(msg);

    session.history.push({
      content: images.length > 0 ? [textContent, ...images] : textContent,
      id: msg.id,
      persist: false, // Historical context, don't persist to DB
      role,
      timestamp: Date.now(),
    });
  }
}

// When a split happens inside a fenced code block, close the chunk with
// ``` and reopen the next chunk with the same fence so the reader never
// sees a dangling unclosed block.
function splitMessage(content: string): string[] {
  if (content.length <= CHUNK_LIMIT) {
    return [content];
  }

  const result: string[] = [];
  const lines = content.split("\n");

  let currentLines: string[] = [];
  // Tracks currentLines.join("\n").length without recomputing each iteration.
  let currentLen = 0;
  let openFence: string | undefined = undefined;

  function emit(): void {
    if (currentLines.length > 0) {
      result.push(currentLines.join("\n"));
    }
    currentLines = [];
    currentLen = 0;
  }

  for (const line of lines) {
    const isFence = line.startsWith("```");

    const addedLen = currentLines.length === 0 ? line.length : 1 + line.length;
    // If we're inside an open fence we'll need to close it ("\n```" = 4 chars)
    // before emitting, so account for that headroom.
    const fenceCloseLen = openFence === undefined ? 0 : 4;

    if (currentLen + addedLen + fenceCloseLen > CHUNK_LIMIT && currentLines.length > 0) {
      if (openFence !== undefined) {
        currentLines.push("```");
      }
      emit();
      if (openFence !== undefined) {
        currentLines = [openFence];
        currentLen = openFence.length;
      }
    }

    currentLen = currentLines.length === 0 ? line.length : currentLen + 1 + line.length;
    currentLines.push(line);

    if (isFence) {
      openFence = openFence === undefined ? line : undefined;
    }
  }

  emit();
  return result;
}

async function handleMessageCreate(
  { access, agentSlug, client, directMessages, owner, ownerId }: HandlerCtx,
  msg: DiscordMessage,
): Promise<void> {
  const hasAttachmentsWeWant = msg.attachments.some(
    (attachment) =>
      attachment.contentType !== undefined &&
      (SUPPORTED_IMAGE_TYPES.has(attachment.contentType.split(";")[0]?.trim() ?? "") ||
        SUPPORTED_VIDEO_TYPES.has(attachment.contentType.split(";")[0]?.trim() ?? "") ||
        attachment.contentType.includes("text")),
  );
  const hasStickers = msg.stickerItems !== undefined && msg.stickerItems.length > 0;
  if (msg.content.trim().length === 0 && !hasAttachmentsWeWant && !hasStickers) {
    return;
  }

  const userId = msg.author.id;

  // Owner always bypasses access control.
  if (userId !== ownerId) {
    const { mode, users } = access;
    if (mode === "allowlist" && !users.includes(userId)) {
      debug("Ignoring message from", colors.keyword(userId), ": not in allowlist");
      return;
    }
    if (mode === "denylist" && users.includes(userId)) {
      debug("Ignoring message from", colors.keyword(userId), ": denylisted");
      return;
    }
  }

  const isDm = (msg.guildID ?? undefined) === undefined;

  // DMs bypass the mention/reply requirement but are still subject to mode restrictions.
  const shouldProcess = isDm;
  if (isDm) {
    const { mode, users } = directMessages;
    if (mode === "owner" && userId !== ownerId) {
      return;
    }
    if (mode === "allowlist" && userId !== ownerId && !users.includes(userId)) {
      return;
    }
    if (mode === "denylist" && userId !== ownerId && users.includes(userId)) {
      return;
    }
  }

  const isDirectMessage = isDm && msg.author.id === ownerId;

  const { mentions } = msg;
  const memberIdMentioned = mentions.members.some((it) => it.id === client.application.id);
  const userIdMentioned = mentions.users.some((it) => it.id === client.application.id);

  let mentionedInReference = false;
  let directReply: DiscordMessage | undefined = undefined;
  const ref = msg.messageReference;
  if (ref?.channelID !== undefined && ref.messageID !== undefined) {
    try {
      const refMsg = await client.rest.channels.getMessage(ref.channelID, ref.messageID);
      directReply = refMsg;
      mentionedInReference = refMsg.author.id === client.application.id;
    } catch (error: unknown) {
      warning("Failed to fetch message reference for", ref, error);
    }
  }

  if (
    !(
      shouldProcess ||
      mentionedInReference ||
      memberIdMentioned ||
      userIdMentioned ||
      isDirectMessage
    )
  ) {
    return;
  }

  const msgChannel = await runDiscordRestWithRetries(
    "GET /channels/{id}",
    async () => await client.rest.channels.get(msg.channelID),
  ).catch(async (error: unknown) => {
    warning(
      "Failed to fetch Discord channel",
      colors.keyword(msg.channelID),
      "after retries:",
      error,
    );
    await sendDiscordWarningMessage(
      client,
      msg,
      "Discord error",
      "Could not fetch channel metadata after retrying Discord REST timeouts; this message was not processed. Details were written to the console logs.",
    );
    return undefined;
  });
  if (msgChannel === undefined) {
    return;
  }

  if (
    msgChannel.type === ChannelTypes.GROUP_DM ||
    msgChannel.type === ChannelTypes.GUILD_CATEGORY ||
    msgChannel.type === ChannelTypes.GUILD_FORUM ||
    msgChannel.type === ChannelTypes.GUILD_MEDIA ||
    !TextableChannelTypes.includes(msgChannel.type)
  ) {
    logError(
      "An unexpected failure case occurred, msgChannel type is not textable. Was:",
      msgChannel.type,
    );
    return;
  }

  const agent = owner.agents.get(agentSlug);

  if (agent === undefined) {
    logError(
      "There was no agent to be found with slug",
      colors.keyword(agentSlug),
      "are you certain you have everything set up correctly?",
    );
    return;
  }

  const guildId = msg.guildID ?? undefined;

  const sessionId =
    guildId === undefined ? `discord:${msg.channelID}` : `discord:${msg.channelID}|${msg.guildID}`;

  let session = agent.sessions.get(sessionId);
  if (session !== undefined && !(session instanceof DiscordSession)) {
    throw new TypeError(`invalid session type: expected discord, got ${session.channel}`);
  }

  const defaults = getDefaultProviderAndModel(await loadEngine(agentSlug));

  const isNsfw =
    msgChannel.type === ChannelTypes.DM ||
    msgChannel.type === ChannelTypes.ANNOUNCEMENT_THREAD ||
    msgChannel.type === ChannelTypes.PUBLIC_THREAD ||
    msgChannel.type === ChannelTypes.PRIVATE_THREAD
      ? false
      : msgChannel.nsfw;

  if (session === undefined) {
    session = new DiscordSession({
      channelId: msg.channelID,
      guildId: msg.guildID ?? undefined,
      isNsfw,
    });

    agent.sessions.set(sessionId, session);
  } else {
    session.isNsfw = isNsfw;
  }

  // Populate message history for both new and existing sessions. The function
  // skips messages already in history, so this is safe to call every turn.
  const botId = client.application.id;
  await populateHistoryFromDiscord(client, session, botId, msg.id, 50);

  if (!(session instanceof DiscordSession)) {
    throw new Error("Somehow, session was not a DiscordSession");
  }
  const ds = session;

  // If a scheduled turn (e.g. heartbeat) is running, wait up to 5 s for it
  // to finish before proceeding. If it's still busy after that, give up.
  if (ds.busy) {
    const WAIT_MS = 5000;
    const POLL_MS = 500;
    let waited = 0;
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    while (ds.busy && waited < WAIT_MS) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, POLL_MS);
      });
      waited += POLL_MS;
    }
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    if (ds.busy) {
      debug("Ignoring message — session still busy after wait for", colors.keyword(sessionId));
      return;
    }
  }

  session.lastActivity = Date.now();
  session.lastMessageId = msg.id;
  session.busy = true;
  try {
    // Crawl the full reply tree and add ancestor messages as context.
    // These messages help the agent understand the conversation flow but
    // aren't persisted to avoid polluting long-term history.
    if (directReply !== undefined) {
      // Crawl ancestors (messages older than the direct reply)
      const ancestors = await crawlReplyTree(client, directReply);

      for (const ancestor of ancestors) {
        if (isMessageInHistory(ds.history, ancestor.id)) {
          continue;
        }

        if (ds.historyBarrier !== undefined && ancestor.createdAt.getTime() < ds.historyBarrier) {
          continue;
        }

        const isFromBot = ancestor.author.id === botId;
        const ancestorContent = isFromBot
          ? await formatAssistantContext(ancestor)
          : await formatHistoryContext(ancestor);
        const ancestorImages = await fetchAllImages(ancestor);
        ds.history.push({
          content:
            ancestorImages.length > 0 ? [ancestorContent, ...ancestorImages] : ancestorContent,
          id: ancestor.id,
          persist: false,
          role: isFromBot ? "assistant" : "user",
          timestamp: Date.now(),
        });
      }

      if (!isMessageInHistory(ds.history, directReply.id)) {
        if (
          ds.historyBarrier !== undefined &&
          directReply.createdAt.getTime() < ds.historyBarrier
        ) {
          // Direct reply is before the barrier — skip it entirely.
        } else {
          const isFromBot = directReply.author.id === botId;
          const replyContent = isFromBot
            ? await formatAssistantContext(directReply)
            : await formatHistoryContext(directReply);
          const replyImages = await fetchAllImages(directReply);
          ds.history.push({
            content: replyImages.length > 0 ? [replyContent, ...replyImages] : replyContent,
            id: directReply.id,
            persist: true,
            role: isFromBot ? "assistant" : "user",
            timestamp: Date.now(),
          });
        }
      }
    }

    const textContent = await formatUserMessage(msg, {
      directReply,
      isMentioned: memberIdMentioned || userIdMentioned,
    });
    const imageContents = await fetchAllImages(msg);

    const engineConfig = await loadEngine(agentSlug);

    const provider = engineConfig[session.selectedProvider ?? defaults.provider.name];
    if (provider === undefined) {
      throw new Error(
        `Could not load the provider ${session.selectedProvider} from the engine config: check your configuration`,
      );
    }
    const { models } = provider;
    const modelSupportsVideo =
      models?.[session.selectedModel ?? defaults.model.name] === undefined
        ? false
        : models[session.selectedModel ?? defaults.model.name]?.supportsVideo;

    const supportsVideo = models === undefined ? false : (modelSupportsVideo ?? false);
    const videoContents = supportsVideo ? await fetchAttachmentVideos(msg) : [];
    session.pendingVideos.push(...videoContents);
    const mediaContents = [...imageContents];
    const historyLengthBeforeTurn = session.history.length;
    session.history.push({
      content: mediaContents.length > 0 ? [textContent, ...mediaContents] : textContent,
      id: msg.id,
      persist: true,
      role: "user",
      timestamp: Date.now(),
    });

    // Start typing indicator — Discord shows "Bot is typing…" for ~5 s, so we
    // refresh it on an interval for the duration of the turn.
    try {
      await msgChannel.sendTyping();
    } catch (error) {
      warning(
        "Got error while trying to send typing",
        error instanceof Error ? error.message : String(error),
      );
      warning(error);
      // Non-fatal — typing indicators are best-effort.
    }
    ds.typingInterval = setInterval(() => {
      // oxlint-disable-next-line promise/prefer-await-to-then
      msgChannel.sendTyping().catch(() => {
        // Intentionally ignored
      });
    }, TYPING_INTERVAL_MS);

    try {
      await agent.runTurn(session);
    } catch (error) {
      // Roll back any history entries added during this failed turn so that the
      // next message doesn't see a stranded user message with no response.
      // Also clear pending tool/media messages — they reference the rolled-back
      // turn and must not leak into the next turn.
      session.history.length = historyLengthBeforeTurn;
      session.pendingToolMessages.length = 0;
      session.pendingVideos.length = 0;
      warning("Error during agent turn:", error instanceof Error ? error.message : String(error));
      if (error instanceof Error && error.stack !== undefined) {
        warning("Stack trace:", error.stack);
      }
      await sendDiscordWarningMessage(
        client,
        msg,
        "Engine error",
        "The turn failed before a response could be produced. Details were written to the console logs.",
      );
    }
  } finally {
    saveSession(agent.slug, session);
    clearInterval(ds.typingInterval);
    ds.typingInterval = undefined;
    session.busy = false;
  }
}

async function handleMessageReactionAdd(
  ctx: HandlerCtx,
  msg: PossiblyUncachedMessage,
  reactor: Uncached | User | Member,
  reaction: EventReaction,
): Promise<void> {
  try {
    const realMsg = await ctx.client.rest.channels.getMessage(msg.channelID, msg.id);

    if (realMsg.author.id !== ctx.client.application.id) {
      return;
    }

    if (reactor.id !== ctx.ownerId) {
      return;
    }

    if (reaction.emoji.name === "✨") {
      if (
        realMsg.content.startsWith("⚠️ Engine error") ||
        realMsg.content.startsWith(":warning: Engine error") ||
        realMsg.content.startsWith("⚠️ Discord error") ||
        realMsg.content.startsWith(":warning: Discord error")
      ) {
        await realMsg.delete("No longer necessary");
      }
      return;
    }

    // ❌ delete-only vs 🔄 delete + reroll: shared history cleanup
    if (reaction.emoji.name === "❌" || reaction.emoji.name === "🔄") {
      const isReroll = reaction.emoji.name === "🔄";

      const agent = ctx.owner.agents.get(ctx.agentSlug);
      if (agent === undefined) {
        return;
      }

      const sessionId =
        msg.guildID === undefined
          ? `discord:${msg.channelID}`
          : `discord:${msg.channelID}|${msg.guildID}`;

      const session = agent.sessions.get(sessionId);
      if (session === undefined || !(session instanceof DiscordSession)) {
        return;
      }

      if (session.busy) {
        return;
      }

      const msgIndex = session.history.findIndex((entry) => entry.id === msg.id);
      if (msgIndex === -1) {
        return;
      }

      await realMsg.delete(isReroll ? "Reroll triggered by owner" : "Deleted by owner");

      // Wipe the message and everything that followed so history is consistent
      session.history.splice(msgIndex);
      session.pendingToolMessages = [];
      session.pendingVideos = [];

      // Point lastMessageId at the preceding user message so future turns work
      const lastUserMsg = session.history.findLast(
        (entry) => entry.role === "user" && entry.id !== undefined,
      );
      session.lastMessageId = lastUserMsg?.id;

      if (!isReroll) {
        // ❌ — delete only
        saveSession(ctx.agentSlug, session);
        return;
      }

      // 🔄 — reroll: regenerate response to the last user message
      if (lastUserMsg === undefined) {
        saveSession(ctx.agentSlug, session);
        return;
      }

      session.stopRequested = false;

      // Keep the channel alive while the turn runs
      const channel = await runDiscordRestWithRetries(
        "GET /channels/{id}",
        async () => await ctx.client.rest.channels.get(msg.channelID),
      );
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const textChannel = channel as AnyTextableChannel;
      await textChannel.sendTyping();

      const typingInterval = setInterval(() => {
        // oxlint-disable-next-line promise/prefer-await-to-then
        textChannel.sendTyping().catch(() => {
          // Intentionally ignored
        });
      }, TYPING_INTERVAL_MS);

      session.busy = true;
      try {
        await agent.runTurn(session);
      } finally {
        clearInterval(typingInterval);
        session.busy = false;
        saveSession(ctx.agentSlug, session);
      }
    }
  } catch (error: unknown) {
    warning(
      "Failed during reaction add handler:",
      error instanceof Error ? error.message : String(error),
    );

    if (error instanceof Error) {
      warning(error);
    }
  }
}

async function handleMessageUpdate(
  ctx: HandlerCtx,
  msg: DiscordMessage | PossiblyUncachedMessage,
): Promise<void> {
  try {
    const { agentSlug, owner, client } = ctx;
    const agent = owner.agents.get(agentSlug);
    if (agent === undefined) {
      return;
    }

    const sessionId =
      msg.guildID === undefined
        ? `discord:${msg.channelID}`
        : `discord:${msg.channelID}|${msg.guildID}`;

    const session = agent.sessions.get(sessionId);
    if (session === undefined || !(session instanceof DiscordSession)) {
      return;
    }

    const entryIndex = session.history.findIndex((historyMsg) => historyMsg.id === msg.id);
    if (entryIndex === -1) {
      return;
    }

    // oxlint-disable-next-line typescript/no-non-null-assertion
    const entry = session.history[entryIndex]!;

    // Fetch full message to ensure we have content/author/attachments
    let realMsg: DiscordMessage | undefined = undefined;
    if ("author" in msg) {
      realMsg = msg as DiscordMessage;
    } else {
      try {
        realMsg = await client.rest.channels.getMessage(msg.channelID, msg.id);
      } catch {
        return; // Failed to fetch, can't update
      }
    }

    const botId = client.application.id;
    const isFromBot = realMsg.author.id === botId;

    const role = isFromBot ? ("assistant" as const) : ("user" as const);

    // We should NOT update the role, but just the content.
    // Actually, if a message was updated, it's likely still the same role.
    if (entry.role !== role) {
      // This shouldn't really happen in Discord unless someone's doing something very weird.
      return;
    }

    const textContent = isFromBot
      ? await formatAssistantContext(realMsg)
      : await formatHistoryContext(realMsg);
    const images = await fetchAllImages(realMsg);
    const media = [...images];

    entry.content = media.length > 0 ? [textContent, ...media] : textContent;

    saveSession(agentSlug, session);
  } catch (error: unknown) {
    warning("Error in messageUpdate handler:", error instanceof Error ? error.message : error);
    if (error instanceof Error) {
      warning(error);
    }
  }
}

async function handleMessageDelete(ctx: HandlerCtx, msg: PossiblyUncachedMessage): Promise<void> {
  try {
    const { agentSlug, owner } = ctx;
    const agent = owner.agents.get(agentSlug);
    if (agent === undefined) {
      return;
    }

    const sessionId =
      msg.guildID === undefined
        ? `discord:${msg.channelID}`
        : `discord:${msg.channelID}|${msg.guildID}`;

    const session = agent.sessions.get(sessionId);
    if (session === undefined || !(session instanceof DiscordSession)) {
      return;
    }

    const entryIndex = session.history.findIndex((historyMsg) => historyMsg.id === msg.id);
    if (entryIndex === -1) {
      return;
    }

    session.history.splice(entryIndex, 1);

    if (session.lastMessageId === msg.id) {
      const lastUserMsg = session.history.findLast((historyMsg) => historyMsg.id !== undefined);
      session.lastMessageId = lastUserMsg?.id;
    }

    // Dummy await to satisfy require-await lint rule
    await Promise.resolve();
    saveSession(agentSlug, session);
  } catch (error: unknown) {
    warning("Error in messageDelete handler:", error instanceof Error ? error.message : error);
    if (error instanceof Error) {
      warning(error);
    }
  }
}

async function handleInteractionCreate(
  ctx: HandlerCtx,
  interaction: AnyInteractionGateway,
): Promise<void> {
  // Only respond to the configured owner.
  if (interaction.user.id !== ctx.ownerId) {
    return;
  }

  if (interaction.type === InteractionTypes.APPLICATION_COMMAND) {
    const handler = SLASH_HANDLERS.get(interaction.data.name);
    if (handler !== undefined) {
      await interaction.defer(
        SILENT_COMMANDS.has(interaction.data.name) ? MessageFlags.EPHEMERAL : 0,
      );

      await handler(interaction, ctx);
    }
  } else if (interaction.type === InteractionTypes.APPLICATION_COMMAND_AUTOCOMPLETE) {
    const handler = AUTOCOMPLETE_HANDLERS.get(interaction.data.name);
    if (handler !== undefined) {
      await handler(interaction, ctx);
    }
  }
}

async function startDiscord(owner: Harness, agentSlug: string): Promise<OceanicClient> {
  const { access, directMessages, token, ownerId, timeout } = await loadChannel(
    "discord",
    agentSlug,
  );

  const agent = owner.agents.get(agentSlug);
  if (agent === undefined) {
    throw new Error(`Agent ${agentSlug} not found`);
  }

  const client = new Client({
    auth: `Bot ${token}`,
    gateway: {
      intents:
        Intents.GUILD_MESSAGES |
        Intents.DIRECT_MESSAGES |
        Intents.MESSAGE_CONTENT |
        Intents.GUILD_MESSAGE_REACTIONS |
        Intents.DIRECT_MESSAGE_REACTIONS,
    },
    rest: {
      requestTimeout: timeout,
    },
  });

  // Store client and ownerId on the agent for channel resolution
  agent.discordClient = client;
  agent.ownerId = ownerId;

  const discordHandler: ChannelHandler = {
    capabilities: {
      supportsAttachments: true,
      supportsDownloadAttachments: true,
      supportsReactions: true,
    },
    downloadAttachments: async (session, messageId) => {
      if (!(session instanceof DiscordSession)) {
        throw new Error("downloadAttachments only works on Discord sessions");
      }

      const msg = await client.rest.channels.getMessage(session.channelId, messageId);
      const results: { filename: string; data: Buffer }[] = [];
      for (const attachment of msg.attachments.values()) {
        const response = await fetch(attachment.url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = Buffer.from(await response.arrayBuffer());
        results.push({ data, filename: attachment.filename });
      }
      return results;
    },
    fetchHistory: async (session, messageId, direction, limit = 50) => {
      if (!(session instanceof DiscordSession)) {
        throw new Error("fetchHistory only works on Discord sessions");
      }

      const params: {
        limit: number;
        before?: string;
        after?: string;
        around?: string;
      } = {
        limit,
      };

      switch (direction) {
        case "after": {
          params.after = messageId;
          break;
        }
        case "around": {
          params.around = messageId;
          break;
        }
        case "before": {
          params.before = messageId;
          break;
        }
        default: {
          const exhaustive: never = direction;
          throw new Error(`Unknown direction: ${String(exhaustive)}`);
        }
      }

      const messages = await client.rest.channels.getMessages(session.channelId, params);

      const results = await Promise.all(
        messages.map(async (msg) => {
          const formatted = await formatHistoryContext(msg);
          return {
            authorId: msg.author.id,
            authorName: msg.author.username,
            content: msg.content,
            formatted: formatted.content,
            id: msg.id,
            timestamp: msg.createdAt.toISOString(),
          };
        }),
      );

      return direction === "after" ? results : results.toReversed();
    },
    react: async (session, emoji, messageId) => {
      if (!(session instanceof DiscordSession)) {
        throw new Error("Somehow, `session` was not a DiscordSession");
      }

      const targetId = messageId ?? session.lastMessageId;
      if (targetId === undefined) {
        return;
      }

      await client.rest.channels.createReaction(session.channelId, targetId, emoji);
    },
    resolveChannel: async (spec, sessions, ownerUserId) => {
      if (spec === "owner") {
        if (ownerUserId === undefined) {
          return { error: "ownerId not configured" };
        }

        try {
          const dmChannel = await client.rest.users.createDM(ownerUserId);
          const existing = sessions.get(`discord:${dmChannel.id}`);
          if (existing !== undefined) {
            return existing;
          }

          return new DiscordSession({
            channelId: dmChannel.id,
            isNsfw: false,
          });
        } catch {
          return { error: "failed to create DM channel with owner" };
        }
      }

      const match = sessions.get(spec);
      return match ?? { error: `session not found: ${spec}` };
    },
    send: async (session, content, attachments, flags) => {
      if (!(session instanceof DiscordSession)) {
        throw new Error("Somehow, `session` was not a DiscordSession");
      }

      const ds = session;
      const chunks = splitMessage(content);

      const files: { contents: Buffer; name: string }[] | undefined =
        attachments !== undefined && attachments.length > 0
          ? await Promise.all(
              attachments.map(async (sandboxPath) => {
                const realPath = sandboxToReal(sandboxPath, agentSlug);
                const contents = await readFile(realPath);
                return { contents, name: path.basename(realPath) };
              }),
            )
          : undefined;

      for (const [idx, chunk] of chunks.entries()) {
        const isLast = idx === chunks.length - 1;
        await client.rest.channels.createMessage(ds.channelId, {
          content: chunk,
          flags,
          ...(isLast && files !== undefined ? { files } : {}),
        });
      }
    },
  };

  agent.registerChannel("discord", discordHandler);

  // oxlint-disable-next-line typescript/no-misused-promises
  client.on("ready", async () => {
    info("Channel", colors.keyword(`${agentSlug}:discord`), "is now listening");

    const appId = client.application.id;
    const commandsFingerprint = installedCommandsFingerprint(appId);

    const storedHash = readCommandsHash(agentSlug);
    if (storedHash !== commandsFingerprint) {
      try {
        await client.rest.applications.bulkEditGlobalCommands(appId, SLASH_COMMANDS);
        writeCommandsHash(agentSlug, commandsFingerprint);
        info("Registered Discord slash commands");
      } catch (error) {
        warning(
          "Failed to register slash commands:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  });

  client.on("error", (err) => {
    warning("An error occurred on Discord:", err instanceof Error ? err.message : err);
    if (err instanceof Error) {
      warning(err);
    }
  });

  const ctx: HandlerCtx = {
    access,
    agentSlug,
    client,
    directMessages,
    owner,
    ownerId,
  };

  // oxlint-disable-next-line typescript/no-misused-promises
  client.on("messageReactionAdd", async (msg, reactor, reaction) => {
    try {
      await handleMessageReactionAdd(ctx, msg, reactor, reaction);
    } catch (error: unknown) {
      logError("Unhandled error in messageReactionAdd handler:", error);
    }
  });

  // oxlint-disable-next-line typescript/no-misused-promises
  client.on("messageCreate", async (msg) => {
    try {
      await handleMessageCreate(ctx, msg);
    } catch (error: unknown) {
      logError("Unhandled error in messageCreate handler:", error);
    }
  });

  // oxlint-disable-next-line typescript/no-misused-promises
  client.on("messageUpdate", async (msg) => {
    try {
      await handleMessageUpdate(ctx, msg);
    } catch (error: unknown) {
      logError("Unhandled error in messageUpdate handler:", error);
    }
  });

  // oxlint-disable-next-line typescript/no-misused-promises
  client.on("messageDelete", async (msg) => {
    try {
      await handleMessageDelete(ctx, msg);
    } catch (error: unknown) {
      logError("Unhandled error in messageDelete handler:", error);
    }
  });

  // oxlint-disable-next-line typescript/no-misused-promises
  client.on("interactionCreate", async (interaction) => {
    try {
      await handleInteractionCreate(ctx, interaction);
    } catch (error: unknown) {
      logError("Unhandled error in interactionCreate handler:", error);
    }
  });

  await client.connect();

  return client;
}

export { formatUserMessage, startDiscord };
