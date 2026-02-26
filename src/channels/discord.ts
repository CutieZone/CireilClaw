import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join } from "node:path";

import * as clearCommand from "$/channels/discord/clear-command.js";
import type { HandlerCtx } from "$/channels/discord/handler-ctx.js";
import { loadChannel } from "$/config/index.js";
import { saveSession } from "$/db/sessions.js";
import type { ImageContent, TextContent } from "$/engine/content.js";
import type { Message } from "$/engine/message.js";
import type { Harness } from "$/harness/index.js";
import { DiscordSession } from "$/harness/session.js";
import colors from "$/output/colors.js";
import { debug, error as logError, info, warning } from "$/output/log.js";
import { toWebp } from "$/util/image.js";
import { root, sandboxToReal } from "$/util/paths.js";
import type {
  AnyInteractionGateway,
  Client as OceanicClient,
  CommandInteraction,
  Message as DiscordMessage,
  PossiblyUncachedMessage,
  TextableChannel,
} from "oceanic.js";
import { InteractionTypes, TextableChannelTypes } from "oceanic.js";

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

// All registered slash commands. Add new command modules here — the hash
// check on startup will detect changes and re-register with Discord's API.
const SLASH_COMMANDS = [clearCommand.definition];

type SlashHandler = (interaction: CommandInteraction, ctx: HandlerCtx) => Promise<void>;
const SLASH_HANDLERS = new Map<string, SlashHandler>([["clear", clearCommand.handle]]);

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
// parse it out of the message history separately.
function formatUserMessage(msg: DiscordMessage): TextContent {
  const { username } = msg.author;
  const authorId = msg.author.id;
  const displayName = msg.member?.nick ?? msg.author.globalName ?? username;
  const timestamp = msg.createdAt.toISOString();

  return {
    content: `<msg msgId="${msg.id}" from="${username} <${authorId}>" displayName="${displayName}" timestamp="${timestamp}">${msg.content}</msg>`,
    type: "text",
  };
}

// Formats a message as a context item (different from user message - marks it as
// reply context so the agent understands this is historical conversation).
function formatReplyContext(msg: DiscordMessage): TextContent {
  const { username } = msg.author;
  const authorId = msg.author.id;
  const displayName = msg.member?.nick ?? msg.author.globalName ?? username;
  const timestamp = msg.createdAt.toISOString();

  return {
    content: `<reply-context msgId="${msg.id}" from="${username} <${authorId}>" displayName="${displayName}" timestamp="${timestamp}">${msg.content}</reply-context>`,
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
    if (entry.role === "user" && entry.id === messageId) {
      return true;
    }
  }
  return false;
}

// Fetches image attachments from a Discord message, filtering to types
// supported by the vision API and silently dropping any that fail to fetch.
async function fetchAttachmentImages(msg: DiscordMessage): Promise<ImageContent[]> {
  const images: ImageContent[] = [];
  for (const attachment of msg.attachments.values()) {
    const mediaType = attachment.contentType?.split(";")[0]?.trim();
    if (mediaType === undefined || !SUPPORTED_IMAGE_TYPES.has(mediaType)) {
      continue;
    }
    try {
      const response = await fetch(attachment.url);
      const raw = await response.arrayBuffer();
      const data = await toWebp(raw);
      images.push({ data, mediaType: "image/webp", type: "image" });
    } catch (error) {
      warning(
        "Failed to fetch attachment:",
        attachment.url,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return images;
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
  { client, owner, ownerId, agentSlug }: HandlerCtx,
  msg: DiscordMessage,
): Promise<void> {
  // Ignore messages with no text and no image attachments.
  const hasImages = msg.attachments.some(
    (attachment) =>
      attachment.contentType !== undefined &&
      SUPPORTED_IMAGE_TYPES.has(attachment.contentType.split(";")[0]?.trim() ?? ""),
  );
  if (msg.content.trim().length === 0 && !hasImages) {
    return;
  }

  const isDirectMessage = (msg.guildID ?? undefined) === undefined && msg.author.id === ownerId;

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

  // Not mentioned anywhere
  if (!(mentionedInReference || memberIdMentioned || userIdMentioned || isDirectMessage)) {
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

  if (session === undefined) {
    const { channelID } = msg;
    const channel = await client.rest.channels.get(channelID);

    if (channel.type in TextableChannelTypes) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const textableChannel = channel as TextableChannel;
      session = new DiscordSession(msg.channelID, msg.guildID ?? undefined, textableChannel.nsfw);
    } else {
      session = new DiscordSession(msg.channelID, msg.guildID ?? undefined);
    }

    agent.sessions.set(sessionId, session);
  } else {
    const { channelID } = msg;
    const channel = await client.rest.channels.get(channelID);

    if (channel.type in TextableChannelTypes) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const textableChannel = channel as TextableChannel;
      session.isNsfw = textableChannel.nsfw;
    }
  }

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

      const ancestorContent = formatReplyContext(ancestor);
      const ancestorImages = await fetchAttachmentImages(ancestor);
      ds.history.push({
        content: ancestorImages.length > 0 ? [ancestorContent, ...ancestorImages] : ancestorContent,
        id: ancestor.id,
        persist: false,
        role: "user",
      });
    }

    // Add direct reply only if not already in history
    if (!isMessageInHistory(ds.history, directReply.id)) {
      const replyContent = formatReplyContext(directReply);
      const replyImages = await fetchAttachmentImages(directReply);
      ds.history.push({
        content: replyImages.length > 0 ? [replyContent, ...replyImages] : replyContent,
        id: directReply.id,
        persist: true,
        role: "user",
      });
    }
  }

  // Push user message into history, including any image attachments.
  const textContent = formatUserMessage(msg);
  const imageContents = await fetchAttachmentImages(msg);
  const historyLengthBeforeTurn = session.history.length;
  session.history.push({
    content: imageContents.length > 0 ? [textContent, ...imageContents] : textContent,
    id: msg.id,
    persist: true,
    role: "user",
  });

  // Start typing indicator — Discord shows "Bot is typing…" for ~5 s, so we
  // refresh it on an interval for the duration of the turn.
  try {
    await msg.channel?.sendTyping();
  } catch {
    // Non-fatal — typing indicators are best-effort.
  }
  ds.typingInterval = setInterval(() => {
    // oxlint-disable-next-line promise/prefer-await-to-then
    msg.channel?.sendTyping().catch(() => {
      // Intentionally ignored
    });
  }, TYPING_INTERVAL_MS);

  try {
    await agent.runTurn(session);
  } catch (error) {
    // Roll back any history entries added during this failed turn so that the
    // next message doesn't see a stranded user message with no response.
    session.history.length = historyLengthBeforeTurn;
    warning("Error during agent turn:", error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack !== undefined) {
      warning("Stack trace:", error.stack);
    }
    const reason = error instanceof Error ? error.message : String(error);
    try {
      await msg.channel?.createMessage({ content: `⚠️ Engine error: ${reason}` });
    } catch {
      // Best-effort.
    }
  } finally {
    saveSession(agent.slug, session);
    clearInterval(ds.typingInterval);
    ds.typingInterval = undefined;
    session.busy = false;
  }
}

async function handleMessageUpdate(_ctx: HandlerCtx, _msg: DiscordMessage): Promise<void> {
  // TODO: unimplemented
}

async function handleMessageDelete(_ctx: HandlerCtx, _msg: PossiblyUncachedMessage): Promise<void> {
  // TODO: unimplemented
}

async function handleInteractionCreate(
  ctx: HandlerCtx,
  interaction: AnyInteractionGateway,
): Promise<void> {
  if (interaction.type !== InteractionTypes.APPLICATION_COMMAND) {
    return;
  }
  // Only respond to the configured owner.
  if (interaction.user.id !== ctx.ownerId) {
    return;
  }

  const handler = SLASH_HANDLERS.get(interaction.data.name);
  if (handler !== undefined) {
    await handler(interaction, ctx);
  }
}

async function startDiscord(owner: Harness, agentSlug: string): Promise<OceanicClient> {
  const { token, ownerId } = await loadChannel("discord", agentSlug);

  const agent = owner.agents.get(agentSlug);
  if (agent === undefined) {
    throw new Error(`Agent ${agentSlug} not found`);
  }

  const client = new Client({
    auth: `Bot ${token}`,
    gateway: {
      intents: Intents.GUILD_MESSAGES | Intents.DIRECT_MESSAGES | Intents.MESSAGE_CONTENT,
    },
    rest: {},
  });

  agent.registerSend(async (session, content, attachments) => {
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
        ...(isLast && files !== undefined ? { files } : {}),
      });
    }
  });

  agent.registerDownloadDiscordAttachments(async (session, messageId) => {
    if (!(session instanceof DiscordSession)) {
      throw new Error("downloadDiscordAttachments only works on Discord sessions");
    }

    const msg = await client.rest.channels.getMessage(session.channelId, messageId);
    const results: { filename: string; data: Buffer }[] = [];
    for (const attachment of msg.attachments.values()) {
      const response = await fetch(attachment.url);
      const data = Buffer.from(await response.arrayBuffer());
      results.push({ data, filename: attachment.filename });
    }
    return results;
  });

  agent.registerReact(async (session, emoji, messageId) => {
    if (!(session instanceof DiscordSession)) {
      throw new Error("Somehow, `session` was not a DiscordSession");
    }

    const targetId = messageId ?? session.lastMessageId;
    if (targetId === undefined) {
      return;
    }

    await client.rest.channels.createReaction(session.channelId, targetId, emoji);
  });

  // oxlint-disable-next-line typescript/no-misused-promises
  client.on("ready", async () => {
    info("Channel", colors.keyword("discord"), "is now listening");

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
    warning("An error occurred on Discord:", err instanceof Error ? err.message : String(err));
    warning(err);
  });

  const ctx: HandlerCtx = {
    agentSlug,
    client,
    owner,
    ownerId,
  };

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
