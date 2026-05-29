import { warning } from "#output/log.js";

const DISCORD_WARNING_SUFFIX = "\n\n-# agent owner can react with ✨ to delete";
const DISCORD_WARNING_CONTENT_LIMIT = 1800;

interface DiscordWarningClient {
  rest: {
    channels: {
      createMessage: (
        channelID: string,
        options: {
          allowedMentions: { repliedUser: true };
          content: string;
          messageReference: {
            channelID: string;
            guildID: string | undefined;
            messageID: string;
          };
        },
      ) => Promise<{ createReaction: (emoji: string) => Promise<unknown> }>;
    };
  };
}

interface ReferencedMessage {
  channelID: string;
  guildID: string | null | undefined;
  id: string;
}

function buildDiscordWarningContent(heading: string, detail: string): string {
  const prefix = `⚠️ ${heading}: `;
  const maxDetailLength =
    DISCORD_WARNING_CONTENT_LIMIT - prefix.length - DISCORD_WARNING_SUFFIX.length;
  const visibleDetail =
    detail.length > maxDetailLength ? `${detail.slice(0, maxDetailLength - 1)}…` : detail;
  return `${prefix}${visibleDetail}${DISCORD_WARNING_SUFFIX}`;
}

async function sendDiscordWarningMessage(
  client: DiscordWarningClient,
  msg: ReferencedMessage,
  heading: string,
  detail: string,
): Promise<void> {
  try {
    const newMsg = await client.rest.channels.createMessage(msg.channelID, {
      allowedMentions: {
        repliedUser: true,
      },
      content: buildDiscordWarningContent(heading, detail),
      messageReference: {
        channelID: msg.channelID,
        guildID: msg.guildID ?? undefined,
        messageID: msg.id,
      },
    });

    await newMsg.createReaction("✨");
  } catch (error: unknown) {
    warning(
      "Failed to send Discord warning message",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export { buildDiscordWarningContent, sendDiscordWarningMessage };
