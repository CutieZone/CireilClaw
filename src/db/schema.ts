// oxlint-disable sort-keys
import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// One row per session. History and opened-files are stored as JSON blobs —
// we don't need to query inside them, only load/save whole sessions.
const sessions = sqliteTable("sessions", {
  // e.g. "discord:123456789|987654321"
  id: text("id").primaryKey(),
  agentSlug: text("agent_slug").notNull(),
  // "discord" | "matrix"
  channel: text("channel").notNull(),
  // JSON: channel-specific fields (channelId, guildId, isNsfw, roomId, …)
  meta: text("meta").notNull(),
  // JSON: SerializedMessage[] (ImageContent replaced with image_ref)
  history: text("history").notNull(),
  // JSON: string[]
  openedFiles: text("opened_files").notNull(),
});

// Image files live on disk under agents/{slug}/images/{sha256}.{ext}.
// This table is the index: tracks which sessions reference which images
// so we can prune files when a session is cleared.
// Composite PK allows the same image (same sha256) to be referenced by
// multiple sessions without duplicating the file.
const images = sqliteTable(
  "images",
  {
    // blake3 hex of the raw image bytes — also the filename stem
    agentSlug: text("agent_slug").notNull(),
    id: text("id").notNull(),
    mediaType: text("media_type").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
  },
  (tb) => [primaryKey({ columns: [tb.id, tb.sessionId] })],
);

export { sessions, images };
