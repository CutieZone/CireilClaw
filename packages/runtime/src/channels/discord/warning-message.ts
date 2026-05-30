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
  const maxBodyLength = DISCORD_WARNING_CONTENT_LIMIT - DISCORD_WARNING_SUFFIX.length;
  const headingPrefix = "⚠️ ";
  const headingSuffix = ": ";
  const maxHeadingLength = Math.max(0, maxBodyLength - headingPrefix.length - headingSuffix.length);
  const visibleHeading =
    heading.length > maxHeadingLength
      ? `${heading.slice(0, Math.max(0, maxHeadingLength - 1))}${maxHeadingLength > 0 ? "…" : ""}`
      : heading;
  const prefix = `${headingPrefix}${visibleHeading}${headingSuffix}`;
  const maxDetailLength = Math.max(0, maxBodyLength - prefix.length);
  const visibleDetail =
    detail.length > maxDetailLength
      ? `${detail.slice(0, Math.max(0, maxDetailLength - 1))}${maxDetailLength > 0 ? "…" : ""}`
      : detail;
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
