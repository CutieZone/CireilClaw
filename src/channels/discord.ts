import type { ImageContent, TextContent } from "$/engine/content.js";
import type { Harness } from "$/harness/index.js";
import type {
  AnyInteractionGateway,
  Client as OceanicClient,
  CommandInteraction,
  Message as DiscordMessage,
  PossiblyUncachedMessage,
  TextableChannel,
} from "oceanic.js";

import * as clearCommand from "$/channels/discord/clear-command.js";
import { loadChannel } from "$/config/index.js";
import { saveSession } from "$/db/sessions.js";
import { DiscordSession, MatrixSession } from "$/harness/session.js";
import colors from "$/output/colors.js";
import { debug, info, warning } from "$/output/log.js";
import { toWebp } from "$/util/image.js";
import { root } from "$/util/paths.js";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
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

type SlashHandler = (interaction: CommandInteraction, owner: Harness) => Promise<void>;
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
  const { id } = msg.author;
  const displayName = msg.member?.nick ?? msg.author.globalName ?? username;
  const timestamp = msg.createdAt.toISOString();

  return {
    content: `<msg from="${username} <${id}>" displayName="${displayName}" timestamp="${timestamp}">${msg.content}</msg>`,
    type: "text",
  };
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
      if (openFence !== null) {
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

async function startDiscord(owner: Harness): Promise<OceanicClient> {
  const { token, ownerId } = await loadChannel("discord");

  const client = new Client({
    auth: `Bot ${token}`,
    gateway: {
      intents: Intents.GUILD_MESSAGES | Intents.DIRECT_MESSAGES | Intents.MESSAGE_CONTENT,
    },
    rest: {},
  });

  owner.registerSend("discord", async (session, content) => {
    if (!(session instanceof DiscordSession)) {
      throw new Error("Somehow, `session` was not a DiscordSession");
    }

    const ds = session;
    const chunks = splitMessage(content);
    for (const chunk of chunks) {
      await client.rest.channels.createMessage(ds.channelId, { content: chunk });
    }
  });

  // oxlint-disable-next-line typescript/no-misused-promises
  client.on("ready", async () => {
    info("Channel", colors.keyword("discord"), "is now listening");

    const appId = client.application?.id;
    if (appId === undefined) {
      warning("Discord application ID unavailable — skipping slash command registration");
      return;
    }

    const storedHash = readCommandsHash();
    if (storedHash !== COMMANDS_HASH) {
      try {
        // oxlint-disable-next-line typescript/no-unsafe-call
        await client.rest.applications.bulkEditGlobalApplicationCommands(appId, SLASH_COMMANDS);
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

  // oxlint-disable-next-line typescript/no-misused-promises
  client.on("messageCreate", async (msg) => {
    await handleMessageCreate(client, owner, ownerId, msg);
  });

  // oxlint-disable-next-line typescript/no-misused-promises
  client.on("messageUpdate", async (msg) => {
    await handleMessageUpdate(client, owner, ownerId, msg);
  });

  // oxlint-disable-next-line typescript/no-misused-promises
  client.on("messageDelete", async (msg) => {
    await handleMessageDelete(client, owner, ownerId, msg);
  });

  // oxlint-disable-next-line typescript/no-misused-promises
  client.on("interactionCreate", async (interaction) => {
    await handleInteractionCreate(owner, ownerId, interaction);
  });

  await client.connect();

  return client;
}

async function handleMessageCreate(
  client: OceanicClient,
  owner: Harness,
  ownerId: string,
  msg: DiscordMessage,
): Promise<void> {
  // Only respond to the configured owner.
  if (msg.author.id !== ownerId) {
    return;
  }
  // Ignore bot messages.
  if (msg.author.bot) {
    return;
  }
  // Ignore messages with no text and no image attachments.
  const hasImages = msg.attachments.some(
    (attachment) =>
      attachment.contentType !== undefined &&
      SUPPORTED_IMAGE_TYPES.has(attachment.contentType.split(";")[0]?.trim() ?? ""),
  );
  if (msg.content.trim().length === 0 && !hasImages) {
    return;
  }

  // Find an agent to handle this message. For now, use the first available agent.
  const agents = [...owner.agents.values()];
  if (agents.length === 0) {
    warning("Received message but no agents are loaded");
    return;
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const agent = agents[0]!;

  // Find or create the session for this channel.
  const sessionId =
    msg.guildID === undefined
      ? `discord:${msg.channelID}`
      : `discord:${msg.channelID}|${msg.guildID}`;

  let session = agent.sessions.get(sessionId);
  if (session instanceof MatrixSession) {
    throw new TypeError("invalid session type: expected discord, got matrix");
  }

  if (session === undefined) {
    const { DiscordSession } = await import("$/harness/session.js");

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

  // Prevent concurrent turns on the same session.
  if (ds.typingInterval !== undefined) {
    debug("Ignoring message — turn already in progress for", colors.keyword(sessionId));
    return;
  }

  // Push user message into history, including any image attachments.
  const textContent = formatUserMessage(msg);
  const imageContents = await fetchAttachmentImages(msg);
  const historyLengthBeforeTurn = session.history.length;
  session.history.push({
    content: imageContents.length > 0 ? [textContent, ...imageContents] : textContent,
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
    msg.channel?.sendTyping().catch(() => undefined);
  }, TYPING_INTERVAL_MS);

  try {
    await agent.engine.runTurn(session, agent.slug);
  } catch (error) {
    // Roll back any history entries added during this failed turn so that the
    // next message doesn't see a stranded user message with no response.
    session.history.length = historyLengthBeforeTurn;
    warning("Error during agent turn:", error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack !== undefined) {
      warning("Stack trace:", error.stack);
    }
    try {
      await msg.channel?.createMessage({ content: "An internal error occurred." });
    } catch {
      // Best-effort.
    }
  } finally {
    saveSession(agent.slug, session);
    clearInterval(ds.typingInterval);
    ds.typingInterval = undefined;
  }
}

async function handleMessageUpdate(
  _client: OceanicClient,
  _owner: Harness,
  _ownerId: string,
  _msg: DiscordMessage,
): Promise<void> {
  // TODO: unimplemented
}

async function handleMessageDelete(
  _client: OceanicClient,
  _owner: Harness,
  _ownerId: string,
  _msg: PossiblyUncachedMessage,
): Promise<void> {
  // TODO: unimplemented
}

async function handleInteractionCreate(
  owner: Harness,
  ownerId: string,
  interaction: AnyInteractionGateway,
): Promise<void> {
  if (interaction.type !== InteractionTypes.APPLICATION_COMMAND) {
    return;
  }
  // Only respond to the configured owner.
  if (interaction.user.id !== ownerId) {
    return;
  }

  const handler = SLASH_HANDLERS.get(interaction.data.name);
  if (handler !== undefined) {
    await handler(interaction, owner);
  }
}

export { formatUserMessage, startDiscord };
