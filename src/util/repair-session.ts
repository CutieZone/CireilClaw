import { getDb } from "$/db/index.js";
import { sessions } from "$/db/schema.js";
import { updateSessionImages, updateSessionVideoRefs } from "$/db/sessions.js";
import { DiscordMetaSchema, SerializedHistorySchema } from "$/db/validation.js";
import { isImageRef, isVideoRef } from "$/engine/content.js";
import { toWebp } from "$/util/image.js";
import { eq } from "drizzle-orm";
import type { Client as OceanicClient } from "oceanic.js";
import { ChannelTypes } from "oceanic.js";
import * as vb from "valibot";

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const SUPPORTED_VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);

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

async function repairSession(
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

  const imagesToFetch: { msgId: string; url: string }[] = [];
  const videoRefsToFetch: { msgId: string; attachmentId: string }[] = [];
  let skipped = 0;

  for (const msg of history) {
    if (msg.role !== "user" || msg.id === undefined) {
      continue;
    }

    const msgId = msg.id;
    const { content } = msg;

    if (!Array.isArray(content)) {
      continue;
    }

    const hasImageRefs = content.some((block) => isImageRef(block));
    const videoRefs = content.filter((block) => isVideoRef(block));

    if (!hasImageRefs && videoRefs.length === 0) {
      continue;
    }

    try {
      const discordMsg = await client.rest.channels.getMessage(channelId, msgId);

      if (hasImageRefs) {
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
          imagesToFetch.push({ msgId, url: firstAttachment.url });
        }
      }

      if (videoRefs.length > 0) {
        const videoAttachments = new Map(
          [...discordMsg.attachments.values()]
            .filter((attachment) => {
              const mediaType = attachment.contentType?.split(";")[0]?.trim();
              return mediaType !== undefined && SUPPORTED_VIDEO_TYPES.has(mediaType);
            })
            .map((attachment) => [attachment.id, attachment]),
        );

        for (const ref of videoRefs) {
          if (videoAttachments.has(ref.attachmentId)) {
            videoRefsToFetch.push({ attachmentId: ref.attachmentId, msgId });
          } else {
            skipped++;
          }
        }
      }
    } catch (caughtError) {
      if (caughtError instanceof Error && caughtError.message.includes("Unknown Message")) {
        skipped++;
      }
      // else: failed, will be counted after parallel fetch
    }
  }

  // Re-fetch images and convert to WebP.
  const imageResults = await Promise.all(
    imagesToFetch.map(async ({ msgId, url }) => {
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

  // Re-fetch Discord messages to get fresh video CDN URLs.
  const videoResults = await Promise.all(
    videoRefsToFetch.map(async ({ msgId, attachmentId }) => {
      try {
        const discordMsg = await client.rest.channels.getMessage(channelId, msgId);
        const attachment = discordMsg.attachments.get(attachmentId);
        if (attachment === undefined) {
          return { status: "failed" as const };
        }
        return { attachmentId, status: "updated" as const, url: attachment.url };
      } catch {
        return { status: "failed" as const };
      }
    }),
  );

  const newImages = new Map<string, Uint8Array>();
  const newVideoUrls = new Map<string, string>(); // attachmentId -> fresh URL
  let failed = 0;
  let updated = 0;

  for (const res of imageResults) {
    if (res.status === "updated") {
      newImages.set(res.msgId, res.data);
      updated++;
    } else {
      failed++;
    }
  }

  for (const res of videoResults) {
    if (res.status === "updated") {
      newVideoUrls.set(res.attachmentId, res.url);
      updated++;
    } else {
      failed++;
    }
  }

  if (newImages.size > 0) {
    updateSessionImages(agentSlug, sessionId, newImages);
  }

  if (newVideoUrls.size > 0) {
    updateSessionVideoRefs(agentSlug, sessionId, newVideoUrls);
  }

  return { failed, skipped, updated };
}

export type { RepairResult };
export { fetchSessionDisplayName, repairSession };
