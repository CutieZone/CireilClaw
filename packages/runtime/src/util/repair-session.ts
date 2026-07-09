import { eq } from "drizzle-orm";
import type { Client as OceanicClient } from "oceanic.js";
import { ChannelTypes } from "oceanic.js";
import * as vb from "valibot";

import { getDb } from "#db/index.js";
import { sessions } from "#db/schema.js";
import { DiscordMetaSchema, updateSessionImages, updateSessionVideoRefs } from "#db/sessions.js";
import type { SerializedMessage } from "#db/validation.js";
import { SerializedHistorySchema } from "#db/validation.js";
import { isImageRef, isVideoRef } from "#engine/content.js";
import { warning } from "#output/log.js";
import { SUPPORTED_IMAGE_TYPES, SUPPORTED_VIDEO_TYPES } from "#supports.js";
import { toWebp } from "#util/image.js";

interface RepairResult {
  failed: number;
  skipped: number;
  updated: number;
  reordered: number;
}

interface HistorySegment {
  type: "entry" | "loop";
  entries: SerializedMessage[];
  sortId: string | undefined;
}

/**
 * Sort serialized history entries into chronological order while keeping
 * agentic-loop regions (`[assistant, toolResponse*, assistant, toolResponse*, ...]`)
 * as atomic units. Loops are never split; individual user/assistant entries
 * are sorted by their Discord snowflake ID.
 *
 * Returns a new sorted array (or the same array if already in order).
 */
function sortHistoryEntries(history: SerializedMessage[]): SerializedMessage[] {
  if (history.length < 2) {
    return history;
  }

  // Phase 1: split into segments — agentic loops and individual entries.
  const segments: HistorySegment[] = [];
  let idx = 0;
  while (idx < history.length) {
    const msg = history[idx];
    if (msg === undefined) {
      idx++;
      continue;
    }

    if (msg.role === "assistant") {
      // Check for an agentic loop: continuous [assistant, toolResponse*, assistant, toolResponse*, ...]
      const loopStart = idx;
      let loopEnd = idx + 1;
      while (
        loopEnd < history.length &&
        (history[loopEnd]?.role === "toolResponse" || history[loopEnd]?.role === "assistant")
      ) {
        loopEnd++;
      }

      if (loopEnd > loopStart + 1) {
        // Has at least one follower — real loop.
        segments.push({
          entries: history.slice(loopStart, loopEnd),
          sortId: msg.id,
          type: "loop",
        });
        idx = loopEnd;
        continue;
      }
    }

    segments.push({
      entries: [msg],
      sortId: msg.id,
      type: "entry",
    });
    idx++;
  }

  // Phase 2: sort segments by snowflake ID. Entries without IDs keep
  // their relative order and sort before everything with IDs.
  const sorted = segments.toSorted((first, second) => {
    const firstId = first.sortId;
    const secondId = second.sortId;
    if (firstId === undefined && secondId === undefined) {
      return 0;
    }
    if (firstId === undefined) {
      return -1;
    }
    if (secondId === undefined) {
      return 1;
    }
    if (firstId < secondId) {
      return -1;
    }
    if (firstId > secondId) {
      return 1;
    }
    return 0;
  });

  // Phase 3: flatten back to a message array.
  return sorted.flatMap((seg) => seg.entries);
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
    return { failed: 0, reordered: 0, skipped: 0, updated: 0 };
  }

  const meta = vb.parse(DiscordMetaSchema, JSON.parse(row.meta));
  const { channelId } = meta;

  let history = vb.parse(SerializedHistorySchema, JSON.parse(row.history));

  // Sort history entries chronologically by snowflake ID while keeping
  // agentic-loop regions intact, then write back so the image/video repair
  // functions below see the sorted data.
  const sorted = sortHistoryEntries(history);
  let reordered = 0;
  if (sorted !== history) {
    reordered = sorted.length;
    const updatedHistory = JSON.stringify(sorted);
    db.update(sessions).set({ history: updatedHistory }).where(eq(sessions.id, sessionId)).run();
    // Use the sorted copy for the rest of the repair.
    history = sorted;
  }

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
          if (!isVideoRef(ref)) {
            warning("Should be unreachable.");
            continue;
          }

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
    }
  }

  const imageResults = await Promise.all(
    imagesToFetch.map(async ({ msgId, url }) => {
      try {
        const response = await fetch(url, { cache: "no-store" });
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
  const newVideoUrls = new Map<string, string>();
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

  return { failed, reordered, skipped, updated };
}

export type { RepairResult };
export { fetchSessionDisplayName, repairSession };
