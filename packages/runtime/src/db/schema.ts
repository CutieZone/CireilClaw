// oxlint-disable sort-keys
import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// One row per session. History and opened-files are stored as JSON blobs —
// we don't need to query inside them, only load/save whole sessions.
// Note: Each agent has its own database, so no agent_slug column needed.
const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  channel: text("channel").notNull(),
  meta: text("meta").notNull(),
  history: text("history").notNull(),
  openedFiles: text("opened_files").notNull(),
  lastActivity: text("last_activity"),
  historyCursor: integer("history_cursor").notNull().default(0),
  activeFileSections: text("active_file_sections").notNull().default("{}"),
});

// This table is the index: tracks which sessions reference which images
// so we can prune files when a session is cleared.
// Composite PK allows the same image (same sha256) to be referenced by
// multiple sessions without duplicating the file.
// Note: Each agent has its own database, so no agent_slug column needed.
const images = sqliteTable(
  "images",
  {
    id: text("id").notNull(),
    mediaType: text("media_type").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
  },
  (tb) => [primaryKey({ columns: [tb.id, tb.sessionId] })],
);

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

// Note: Each agent has its own database, so job_id is unique within agent.
const cronJobs = sqliteTable("cron_jobs", {
  jobId: text("job_id").primaryKey(),
  type: text("type").notNull(),
  config: text("config"),
  lastRun: text("last_run"),
  nextRun: text("next_run"),
  status: text("status").notNull().default("pending"),
  retryCount: integer("retry_count").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

export { sessions, images, summaries, cronJobs };
