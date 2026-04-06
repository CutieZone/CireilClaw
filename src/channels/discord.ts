import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join } from "node:path";

import * as clearCommand from "$/channels/discord/clear-command.js";
import type { HandlerCtx } from "$/channels/discord/handler-ctx.js";
import * as modelCommand from "$/channels/discord/model-command.js";
import * as repairCommand from "$/channels/discord/repair-command.js";
import { loadChannel, loadEngine } from "$/config/index.js";
import { saveSession } from "$/db/sessions.js";
import type { ImageContent, TextContent, VideoContent } from "$/engine/content.js";
import type { Message } from "$/engine/message.js";
import type { ChannelHandler } from "$/harness/channel-handler.js";
import type { Harness } from "$/harness/index.js";
import { DiscordSession } from "$/harness/session.js";
import colors from "$/output/colors.js";
import { debug, error as logError, info, warning } from "$/output/log.js";
import { formatDate } from "$/util/date.js";
import { getDefaultProviderAndModel } from "$/util/default-provider-and-model.js";
import { toWebp } from "$/util/image.js";
import { root, sandboxToReal } from "$/util/paths.js";
import type {
  AnyInteractionGateway,
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

// Media types supported by OpenAI's vision API.
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

// Video types to fetch when supportsVideo is enabled. Hard cap prevents
// multi-MB payloads from being base64-encoded and sent to the API.
const SUPPORTED_VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const VIDEO_SIZE_CAP = 10 * 1024 * 1024; // 10 MB

// All registered slash commands. Add new command modules here — the hash
// check on startup will detect changes and re-register with Discord's API.
const SLASH_COMMANDS = [clearCommand.definition, repairCommand.definition, modelCommand.definition];

type SlashHandler = (interaction: CommandInteraction, ctx: HandlerCtx) => Promise<void>;
const SLASH_HANDLERS = new Map<string, SlashHandler>([
  ["clear", clearCommand.handle],
  ["repair", repairCommand.handle],
  ["model", modelCommand.handleCommand],
]);

type AutocompleteHandler = (interaction: AutocompleteInteraction, ctx: HandlerCtx) => Promise<void>;
const AUTOCOMPLETE_HANDLERS = new Map<string, AutocompleteHandler>([
  ["model", modelCommand.handleAutocomplete],
]);

// Persisted hash of SLASH_COMMANDS to avoid re-registering on every startup.
const COMMANDS_HASH = createHash("sha256").update(JSON.stringify(SLASH_COMMANDS)).digest("hex");
const COMMANDS_HASH_FILE = join(root(), "discord-commands.hash");

function readCommandsHash(): string | undefined {
  try {
    return readFileSync(COMMANDS_HASH_FILE, "utf8").trim();
  } catch {
    return undefined;
  }
}

function writeCommandsHash(hash: string): void {
  writeFileSync(COMMANDS_HASH_FILE, hash, "utf8");
}

// Wraps an incoming Discord message's content with sender metadata so the
// agent has full context about who sent what and when, without needing to
// parse it out of the message history separately. Includes attachment metadata
// so the model knows what files/images are present.
async function formatUserMessage(msg: DiscordMessage): Promise<TextContent> {
  const { username } = msg.author;
  const authorId = msg.author.id;
  const displayName = msg.member?.nick ?? msg.author.globalName ?? username;
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
    content: `<msg msgId="${msg.id}" from="${username} <${authorId}>" displayName="${displayName}" timestamp="${timestamp}">${innerContent}</msg>`,
    type: "text",
  };
}

// Formats a message as historical context (different from user message - marks it
// as history so the agent understands this is past conversation).
// Includes attachment metadata so the model knows what files/images are present.
async function formatHistoryContext(msg: DiscordMessage): Promise<TextContent> {
  const { username } = msg.author;
  const authorId = msg.author.id;
  const displayName = msg.member?.nick ?? msg.author.globalName ?? username;
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

// Formats a bot's own message as assistant context for history loading.
async function formatAssistantContext(msg: DiscordMessage): Promise<TextContent> {
  const timestamp = await formatDate(msg.createdAt);

  return {
    content: `<assistant-context msgId="${msg.id}" timestamp="${timestamp}">${msg.content}</assistant-context>`,
    type: "text",
  };
}

// Crawls the reply chain from a starting message, collecting all ancestor messages.
// Returns messages in chronological order (oldest first).
async function crawlReplyTree(
  client: OceanicClient,
  startMsg: DiscordMessage,
): Promise<DiscordMessage[]> {
  const messages: DiscordMessage[] = [];
  const seen = new Set<string>();
  // Track the message ID we need to fetch next, not the message object itself
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

  // Reverse to get chronological order (oldest first)
  return messages.toReversed();
}

// Checks if a Discord message ID already exists in session history.
function isMessageInHistory(history: Message[], messageId: string): boolean {
  for (const entry of history) {
    if (entry.id === messageId) {
      return true;
    }
  }
  return false;
}

// Fetches image attachments from a Discord message in parallel, filtering to types
// supported by the vision API and silently dropping any that fail to fetch.
// Results are sorted by attachment ID for consistent ordering.
async function fetchAttachmentImages(msg: DiscordMessage): Promise<ImageContent[]> {
  const fetchPromises = [...msg.attachments.values()].map(
    async (attachment): Promise<(ImageContent & { id: string }) | undefined> => {
      const mediaType = attachment.contentType?.split(";")[0]?.trim();
      if (mediaType === undefined || !SUPPORTED_IMAGE_TYPES.has(mediaType)) {
        return undefined;
      }
      try {
        const response = await fetch(attachment.url);
        const raw = await response.arrayBuffer();
        const data = await toWebp(raw);
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

// Fetches sticker images from a Discord message in parallel, converting to WebP.
// LOTTIE format stickers are skipped (cannot be displayed as raster images).
// Results are sorted by sticker ID for consistent ordering.
async function fetchStickerImages(msg: DiscordMessage): Promise<ImageContent[]> {
  if (!msg.stickerItems || msg.stickerItems.length === 0) {
    return [];
  }

  const fetchPromises = msg.stickerItems.map(
    async (sticker): Promise<(ImageContent & { id: string }) | undefined> => {
      // Skip LOTTIE format - vector format that can't be converted to raster
      if (sticker.format_type === StickerFormatTypes.LOTTIE) {
        return undefined;
      }

      try {
        const url =
          sticker.format_type === StickerFormatTypes.GIF
            ? `https://media.discordapp.net/stickers/${sticker.id}.gif`
            : `https://cdn.discordapp.com/stickers/${sticker.id}.png`;

        const response = await fetch(url);
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

// Fetches both attachments and sticker images in parallel, with attachments
// ordered first (sorted by ID), then stickers (sorted by ID).
async function fetchAllImages(msg: DiscordMessage): Promise<ImageContent[]> {
  const [attachmentImages, stickerImages] = await Promise.all([
    fetchAttachmentImages(msg),
    fetchStickerImages(msg),
  ]);
  return [...attachmentImages, ...stickerImages];
}

// Fetches video attachments from a Discord message. Only called when the
// agent's engine has supportsVideo enabled. Skips attachments that exceed
// VIDEO_SIZE_CAP to avoid sending huge payloads to the API.
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

// Fetches the last N messages from a Discord channel, including images.
// Returns messages in chronological order (oldest first). Messages are
// formatted as reply context since they're historical conversation.
async function fetchMessageHistory(
  client: OceanicClient,
  channelId: string,
  limit = 30,
): Promise<DiscordMessage[]> {
  try {
    const fetched = await client.rest.channels.getMessages(channelId, {
      limit,
    });
    // Discord returns messages newest-first, reverse for chronological order
    return fetched.toReversed();
  } catch {
    // Channel may not be readable, permissions issues, etc.
    return [];
  }
}

// Discord message flag for suppress notifications (silent messages)
const SUPPRESS_NOTIFICATIONS = 4096; // 1 << 12

// Checks if a message has the suppress notifications flag.
function isSuppressNotifications(msg: DiscordMessage): boolean {
  return (msg.flags & SUPPRESS_NOTIFICATIONS) !== 0;
}

// Populates session history with recent Discord messages. Filters out the
// current message (since it's being processed separately), empty messages,
// and messages with SUPPRESS_NOTIFICATIONS flag (unless in reply chain).
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

    // Skip suppressed notification messages (silent messages) - they shouldn't
    // make it to the LLM unless they're in the reply chain (which is handled
    // separately by crawlReplyTree)
    if (isSuppressNotifications(msg)) {
      continue;
    }

    // Check if message has any content we care about
    const hasImages = msg.attachments.some(
      (attachment) =>
        attachment.contentType !== undefined &&
        SUPPORTED_IMAGE_TYPES.has(attachment.contentType.split(";")[0]?.trim() ?? ""),
    );
    const hasText = msg.content.trim().length > 0;

    if (!hasText && !hasImages) {
      continue;
    }

    // Bot's own messages are assistant role, others are user role
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

// Split a response on newline boundaries while respecting CHUNK_LIMIT.
// When a split happens inside a fenced code block, the current chunk is
// closed with ``` and the next chunk reopens with the same fence opener so
// the reader never sees a dangling unclosed block.
function splitMessage(content: string): string[] {
  if (content.length <= CHUNK_LIMIT) {
    return [content];
  }

  const result: string[] = [];
  const lines = content.split("\n");

  let currentLines: string[] = [];
  // Tracks currentLines.join("\n").length without recomputing each iteration.
  let currentLen = 0;
  // The opening fence line we're currently inside (e.g. "```typescript"), or null.
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

    // How much currentLen would grow if we append this line.
    const addedLen = currentLines.length === 0 ? line.length : 1 + line.length;
    // If we're inside an open fence we'll need to close it ("\n```" = 4 chars)
    // before emitting, so account for that headroom.
    const fenceCloseLen = openFence === undefined ? 0 : 4;

    if (currentLen + addedLen + fenceCloseLen > CHUNK_LIMIT && currentLines.length > 0) {
      if (openFence !== undefined) {
        currentLines.push("```");
      }
      emit();
      // Reopen the fence at the top of the new chunk.
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
  // Ignore messages with no text and no image attachments.
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

  // Check access control (allowlist/denylist). Owner always bypasses.
  if (userId !== ownerId) {
    const { mode, users } = access;
    if (mode === "allowlist" && !users.includes(userId)) {
      debug("Ignoring message from", colors.keyword(userId), ": not in allowlist");
      return; // User not in allowlist
    }
    if (mode === "denylist" && users.includes(userId)) {
      debug("Ignoring message from", colors.keyword(userId), ": denylisted");
      return; // User is denylisted
    }
  }

  // Check if this is a DM (no guild ID)
  const isDm = (msg.guildID ?? undefined) === undefined;

  // DMs bypass the mention/reply requirement but are still subject to mode restrictions
  const shouldProcess = isDm;
  if (isDm) {
    const { mode, users } = directMessages;

    // Enforce DM mode
    if (mode === "owner" && userId !== ownerId) {
      return; // Only owner can DM
    }
    if (mode === "allowlist" && userId !== ownerId && !users.includes(userId)) {
      return; // Only owner and allowlisted users can DM
    }
    if (mode === "denylist" && userId !== ownerId && users.includes(userId)) {
      return; // Only owner and non-denylisted users can DM
    }
    // mode === "public" allows anyone to DM
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

  // Process if mentioned, replied to, or allowed via DM mode
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

  const msgChannel = await client.rest.channels.get(msg.channelID);

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

  // Find or create the session for this channel.
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
      selectedModel: defaults.model.name,
      selectedProvider: defaults.provider.name,
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

  // Crawl the full reply tree and add ancestor messages as context.
  // These messages help the agent understand the conversation flow but
  // aren't persisted to avoid polluting long-term history.
  if (directReply !== undefined) {
    // Crawl ancestors (messages older than the direct reply)
    const ancestors = await crawlReplyTree(client, directReply);

    // Add ancestor messages that aren't already in history
    for (const ancestor of ancestors) {
      if (isMessageInHistory(ds.history, ancestor.id)) {
        continue;
      }

      const ancestorContent = await formatHistoryContext(ancestor);
      const ancestorImages = await fetchAllImages(ancestor);
      ds.history.push({
        content: ancestorImages.length > 0 ? [ancestorContent, ...ancestorImages] : ancestorContent,
        id: ancestor.id,
        persist: false,
        role: "user",
        timestamp: Date.now(),
      });
    }

    // Add direct reply only if not already in history
    if (!isMessageInHistory(ds.history, directReply.id)) {
      const replyContent = await formatHistoryContext(directReply);
      const replyImages = await fetchAllImages(directReply);
      ds.history.push({
        content: replyImages.length > 0 ? [replyContent, ...replyImages] : replyContent,
        id: directReply.id,
        persist: true,
        role: "user",
        timestamp: Date.now(),
      });
    }
  }

  // Push user message into history, including any image/video attachments.
  const textContent = await formatUserMessage(msg);
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
  const mediaContents = [...imageContents, ...videoContents];
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
    // Also clear pending tool messages — they reference tool calls from the
    // rolled-back assistant message and must not leak into the next turn.
    session.history.length = historyLengthBeforeTurn;
    session.pendingToolMessages.length = 0;
    warning("Error during agent turn:", error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack !== undefined) {
      warning("Stack trace:", error.stack);
    }
    const reason = error instanceof Error ? error.message : String(error);
    try {
      const newMsg = await msgChannel.createMessage({
        allowedMentions: {
          repliedUser: true,
        },
        content: `⚠️ Engine error: ${reason}\n\n-# agent owner can react with ✨ to delete`,
        messageReference: {
          channelID: msg.channelID,
          guildID: msg.guildID ?? undefined,
          messageID: msg.id,
        },
      });

      await newMsg.createReaction("✨");

      // oxlint-disable-next-line no-shadow
    } catch (error) {
      warning(
        "Failed to send engine error Discord message",
        error instanceof Error ? error.message : String(error),
      );
      // Best-effort.
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
      return; // not us
    }

    if (reactor.id !== ctx.ownerId) {
      return; // not owner
    }

    if (reaction.emoji.name !== "✨") {
      return; // not ✨
    }

    if (
      realMsg.content.startsWith("⚠️ Engine error") ||
      realMsg.content.startsWith(":warning: Engine error")
    ) {
      await realMsg.delete("No longer necessary");
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

  // Bot's own messages are assistant role, others are user role
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
  const engineConfig = await loadEngine(agentSlug);
  const defaults = getDefaultProviderAndModel(engineConfig);

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
  const videos = supportsVideo ? await fetchAttachmentVideos(realMsg) : [];
  const media = [...images, ...videos];

  entry.content = media.length > 0 ? [textContent, ...media] : textContent;

  saveSession(agentSlug, session);
}

async function handleMessageDelete(ctx: HandlerCtx, msg: PossiblyUncachedMessage): Promise<void> {
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

  // If we deleted the last message, update the lastMessageId pointer
  if (session.lastMessageId === msg.id) {
    const lastUserMsg = session.history.findLast((historyMsg) => historyMsg.id !== undefined);
    session.lastMessageId = lastUserMsg?.id;
  }

  // Dummy await to satisfy require-await lint rule
  await Promise.resolve();
  saveSession(agentSlug, session);
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
      await interaction.defer(interaction.data.name === "model" ? MessageFlags.EPHEMERAL : 0);

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
  const { access, directMessages, token, ownerId } = await loadChannel("discord", agentSlug);

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
    rest: {},
  });

  // Store client and ownerId on the agent for channel resolution
  agent.setDiscordClient(client);
  agent.setOwnerId(ownerId);

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
          const _exhaustive: never = direction;
          throw new Error(`Unknown direction: ${String(_exhaustive)}`);
        }
      }

      const messages = await client.rest.channels.getMessages(session.channelId, params);

      // Map to HistoryMessage format with channel-specific formatting
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

      // Discord returns newest-first for before/after, centered for around
      // Always return chronological (oldest first)
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
      // "owner" resolves to DM channel with the bot owner
      if (spec === "owner") {
        if (ownerUserId === undefined) {
          return { error: "ownerId not configured" };
        }

        try {
          const dmChannel = await client.rest.users.createDM(ownerUserId);
          // Check for existing session with this DM channel
          const existing = sessions.get(`discord:${dmChannel.id}`);
          if (existing !== undefined) {
            return existing;
          }

          const engine = await loadEngine(agentSlug);
          const [defaultProvider] = Object.entries(engine)
            .filter((kvp) => kvp[1].isGlobalDefault)
            .map((it) => it[0]);

          if (defaultProvider === undefined) {
            throw new Error("Could not load a default provider from the engine config.");
          }

          const providerConfig = engine[defaultProvider];
          if (providerConfig === undefined) {
            throw new Error(
              "This should not happen. A provider config for a provider we know exists turned out to not exist.",
            );
          }

          const { defaultModel } = providerConfig;

          // Return a new session for this DM channel
          return new DiscordSession({
            channelId: dmChannel.id,
            isNsfw: false,
            selectedModel: defaultModel,
            selectedProvider: defaultProvider,
          });
        } catch {
          return { error: "failed to create DM channel with owner" };
        }
      }

      // Explicit session ID like "discord:123|456" or "discord:123"
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
                return { contents, name: basename(realPath) };
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

    const storedHash = readCommandsHash();
    if (storedHash !== COMMANDS_HASH) {
      try {
        await client.rest.applications.bulkEditGlobalCommands(appId, SLASH_COMMANDS);
        writeCommandsHash(COMMANDS_HASH);
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
    await handleMessageReactionAdd(ctx, msg, reactor, reaction);
  });

  // oxlint-disable-next-line typescript/no-misused-promises
  client.on("messageCreate", async (msg) => {
    await handleMessageCreate(ctx, msg);
  });

  // oxlint-disable-next-line typescript/no-misused-promises
  client.on("messageUpdate", async (msg) => {
    await handleMessageUpdate(ctx, msg);
  });

  // oxlint-disable-next-line typescript/no-misused-promises
  client.on("messageDelete", async (msg) => {
    await handleMessageDelete(ctx, msg);
  });

  // oxlint-disable-next-line typescript/no-misused-promises
  client.on("interactionCreate", async (interaction) => {
    await handleInteractionCreate(ctx, interaction);
  });

  await client.connect();

  return client;
}

export { formatUserMessage, startDiscord };
