import { getDb } from "$/db/index.js";
import { sessions } from "$/db/schema.js";
import { updateSessionImages } from "$/db/sessions.js";
import { toWebp } from "$/util/image.js";
import { eq } from "drizzle-orm";
import type { Client as OceanicClient } from "oceanic.js";
import { ChannelTypes } from "oceanic.js";

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

interface RepairResult {
  failed: number;
  skipped: number;
  updated: number;
}

async function fetchSessionDisplayName(
  client: OceanicClient,
  channelId: string,
  guildId?: string,
): Promise<{ channelName: string; guildName: string }> {
  try {
    const channel = await client.rest.channels.get(channelId);

    if (channel.type === ChannelTypes.DM) {
      const dmChannel = channel;
      return {
        channelName: `DM with ${dmChannel.recipient.globalName ?? dmChannel.recipient.username}`,
        guildName: "",
      };
    } else if (channel.type === ChannelTypes.GROUP_DM) {
      const groupChannel = channel;
      const names = [...groupChannel.recipients.values()]
        .map((recipient) => recipient.username)
        .join(", ");
      return { channelName: `Group with ${names}`, guildName: "" };
    }

    let guildName = "";
    if (guildId !== undefined) {
      try {
        const guild = await client.rest.guilds.get(guildId);
        guildName = guild.name;
      } catch {
        guildName = "Unknown Server";
      }
    }

    const channelName = (channel as { name?: string }).name ?? "Unknown Channel";
    return { channelName, guildName };
  } catch {
    return { channelName: channelId, guildName: guildId ?? "" };
  }
}

async function repairSessionImages(
  agentSlug: string,
  sessionId: string,
  client: OceanicClient,
): Promise<RepairResult> {
  const db = getDb(agentSlug);

  const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();

  if (row === undefined) {
    return { failed: 0, skipped: 0, updated: 0 };
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const meta = JSON.parse(row.meta) as { channelId: string; guildId?: string };
  const { channelId } = meta;

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const history = JSON.parse(row.history) as Record<string, unknown>[];

  const result: RepairResult = { failed: 0, skipped: 0, updated: 0 };
  const newImages = new Map<string, Uint8Array>();

  for (const msg of history) {
    if (msg["role"] !== "user" || msg["id"] === undefined) {
      continue;
    }

    const { content, id: msgId } = msg;

    if (typeof msgId !== "string") {
      continue;
    }

    if (!Array.isArray(content)) {
      continue;
    }

    const hasImageRefs = content.some(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        (block as { type: string }).type === "image_ref",
    );

    if (!hasImageRefs) {
      continue;
    }

    try {
      const discordMsg = await client.rest.channels.getMessage(channelId, msgId);

      const imageAttachments = [...discordMsg.attachments.values()]
        .filter((attachment) => {
          const mediaType = attachment.contentType?.split(";")[0]?.trim();
          return mediaType !== undefined && SUPPORTED_IMAGE_TYPES.has(mediaType);
        })
        .toSorted((first, second) => first.id.localeCompare(second.id));

      if (imageAttachments.length === 0) {
        result.skipped++;
        continue;
      }

      const [firstAttachment] = imageAttachments;
      if (firstAttachment === undefined) {
        result.skipped++;
        continue;
      }

      try {
        const response = await fetch(firstAttachment.url);
        if (!response.ok) {
          result.failed++;
          continue;
        }

        const raw = await response.arrayBuffer();
        const data = await toWebp(raw);
        newImages.set(msgId, data);
        result.updated++;
      } catch {
        result.failed++;
      }
    } catch (caughtError) {
      if (caughtError instanceof Error && caughtError.message.includes("Unknown Message")) {
        result.skipped++;
      } else {
        result.failed++;
      }
    }
  }

  if (newImages.size > 0) {
    updateSessionImages(agentSlug, sessionId, newImages);
  }

  return result;
}

export type { RepairResult };
export { fetchSessionDisplayName, repairSessionImages };
