// oxlint-disable sort-keys
import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// One row per session. History and opened-files are stored as JSON blobs —
// we don't need to query inside them, only load/save whole sessions.
// Note: Each agent has its own database, so no agent_slug column needed.
const sessions = sqliteTable("sessions", {
  // e.g. "discord:123456789|987654321"
  id: text("id").primaryKey(),
  // "discord" | "matrix"
  channel: text("channel").notNull(),
  // JSON: channel-specific fields (channelId, guildId, isNsfw, roomId, …)
  meta: text("meta").notNull(),
  // JSON: SerializedMessage[] (ImageContent replaced with image_ref)
  history: text("history").notNull(),
  // JSON: string[]
  openedFiles: text("opened_files").notNull(),
  // ISO-8601 timestamp
  lastActivity: text("last_activity"),
  // Index into history: first message sent to the LLM on this turn.
  historyCursor: integer("history_cursor").notNull().default(0),
  // JSON: {path: [section_ids]} — active section filters for pinned files.
  activeFileSections: text("active_file_sections").notNull().default("{}"),
});

// Image files live on disk under agents/{slug}/images/{sha256}.{ext}.
// This table is the index: tracks which sessions reference which images
// so we can prune files when a session is cleared.
// Composite PK allows the same image (same sha256) to be referenced by
// multiple sessions without duplicating the file.
// Note: Each agent has its own database, so no agent_slug column needed.
const images = sqliteTable(
  "images",
  {
    // blake3 hex of the raw image bytes — also the filename stem
    id: text("id").notNull(),
    mediaType: text("media_type").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
  },
  (tb) => [primaryKey({ columns: [tb.id, tb.sessionId] })],
);

// Stores topic compaction summaries. Each row replaces a range of messages
// in the LLM prompt with a summary, while the full history stays in SQLite.
const summaries = sqliteTable(
  "summaries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    startMessageId: text("start_message_id").notNull(),
    endMessageId: text("end_message_id").notNull(),
    preserve: text("preserve").notNull().default("[]"),
    summary: text("summary").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (tb) => [uniqueIndex("summaries_session_slug_idx").on(tb.sessionId, tb.slug)],
);

// Tracks cron jobs: both config-file recurring jobs (for last-run timestamps)
// and runtime one-shot jobs created via the schedule tool.
// Note: Each agent has its own database, so job_id is unique within agent.
const cronJobs = sqliteTable("cron_jobs", {
  jobId: text("job_id").primaryKey(),
  // "one-shot" | "recurring"
  type: text("type").notNull(),
  // JSON blob for runtime one-shot jobs (schedule, prompt, delivery, target, etc.)
  config: text("config"),
  lastRun: text("last_run"),
  nextRun: text("next_run"),
  status: text("status").notNull().default("pending"),
  retryCount: integer("retry_count").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

export { sessions, images, summaries, cronJobs };
