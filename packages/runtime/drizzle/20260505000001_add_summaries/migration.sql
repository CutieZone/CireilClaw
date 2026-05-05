CREATE TABLE "summaries" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "session_id" text NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "slug" text NOT NULL,
  "display_name" text NOT NULL,
  "start_message_id" text NOT NULL,
  "end_message_id" text NOT NULL,
  "preserve" text DEFAULT '[]' NOT NULL,
  "summary" text NOT NULL,
  "created_at" integer NOT NULL
);
CREATE UNIQUE INDEX "summaries_session_slug_idx" ON "summaries" ("session_id", "slug");
