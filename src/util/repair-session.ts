import { getDb } from "$/db/index.js";
import { sessions } from "$/db/schema.js";
import { updateSessionImages } from "$/db/sessions.js";
import { DiscordMetaSchema, SerializedHistorySchema } from "$/db/validation.js";
import { isImageRef } from "$/engine/content.js";
import { toWebp } from "$/util/image.js";
import { eq } from "drizzle-orm";
import type { Client as OceanicClient } from "oceanic.js";
import { ChannelTypes } from "oceanic.js";
import * as vb from "valibot";

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

  const meta = vb.parse(DiscordMetaSchema, JSON.parse(row.meta));
  const { channelId } = meta;

  const history = vb.parse(SerializedHistorySchema, JSON.parse(row.history));

  const toFetch: { msgId: string; url: string }[] = [];
  let skipped = 0;

  for (const msg of history) {
    if (msg.role !== "user" || msg.id === undefined) {
      continue;
    }

    const msgId = msg.id;
    const { content } = msg;

    // TODO: check single imageRef (aka, msg with no other content than an image)

    if (!Array.isArray(content)) {
      continue;
    }

    const hasImageRefs = content.some((block) => isImageRef(block));

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

      const [firstAttachment] = imageAttachments;
      if (firstAttachment === undefined) {
        skipped++;
      } else {
        toFetch.push({ msgId, url: firstAttachment.url });
      }
    } catch (caughtError) {
      if (caughtError instanceof Error && caughtError.message.includes("Unknown Message")) {
        skipped++;
      }
      // else: failed, will be counted after parallel fetch
    }
  }

  const fetchResults = await Promise.all(
    toFetch.map(async ({ msgId, url }) => {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          return { status: "failed" as const };
        }

        const raw = await response.arrayBuffer();
        const data = await toWebp(raw);
        return { data, msgId, status: "updated" as const };
      } catch {
        return { status: "failed" as const };
      }
    }),
  );

  const newImages = new Map<string, Uint8Array>();
  let failed = 0;
  let updated = 0;

  for (const res of fetchResults) {
    if (res.status === "updated") {
      newImages.set(res.msgId, res.data);
      updated++;
    } else {
      failed++;
    }
  }

  const result: RepairResult = { failed, skipped, updated };

  if (newImages.size > 0) {
    updateSessionImages(agentSlug, sessionId, newImages);
  }

  return result;
}

export type { RepairResult };
export { fetchSessionDisplayName, repairSessionImages };
