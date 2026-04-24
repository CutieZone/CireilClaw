import { join } from "node:path";

import { eq } from "drizzle-orm";
import * as vb from "valibot";

import type { ConfigMigration } from "#config/migrations/index.js";
import { initDb } from "#db/index.js";
import { sessions } from "#db/schema.js";
import { isMessage } from "#engine/message.js";

// oxlint-disable sort-keys
const migration: ConfigMigration = {
  description:
    "Migrate assistant messages in session history to include IDs from their content tags",
  id: "20260322000000_assistant_message_ids",
  targets: [], // No TOML targets

  async migrateAgent(agentSlug, agentPath, context) {
    const dbPath = join(agentPath, "sessions.db");
    await context.backupFile(dbPath);

    // Initialize DB for this agent (runs Drizzle migrations if needed)
    const db = initDb(agentSlug);

    const allSessions = db.select().from(sessions).all();

    for (const row of allSessions) {
      const rawHistory = vb.parse(vb.array(vb.unknown()), JSON.parse(row.history));
      const history = rawHistory.filter((it) => isMessage(it));
      let modified = false;

      for (const msg of history) {
        // 1. Add ID to assistant messages from their <assistant-context> tag
        if (msg.role === "assistant" && msg.id === undefined) {
          const content = Array.isArray(msg.content) ? msg.content : [msg.content];
          for (const block of content) {
            if (block.type === "text") {
              const match = /<assistant-context msgId="([^"]+)"/.exec(block.content);
              if (match !== null) {
                const [, msgId] = match;
                if (msgId !== undefined) {
                  msg.id = msgId;
                  modified = true;
                  break;
                }
              }
            }
          }
        }

        // 2. Add ID to user messages from their <history-context> or <msg> tag if missing
        if (msg.role === "user" && msg.id === undefined) {
          const content = Array.isArray(msg.content) ? msg.content : [msg.content];
          for (const block of content) {
            if (block.type === "text") {
              const match = /<(?:history-context|msg) msgId="([^"]+)"/.exec(block.content);
              if (match !== null) {
                const [, msgId] = match;
                if (msgId !== undefined) {
                  msg.id = msgId;
                  modified = true;
                  break;
                }
              }
            }
          }
        }

        // 3. Ensure persist is set correctly
        if (msg.role === "assistant" && msg.persist === undefined) {
          msg.persist = true;
          modified = true;
        } else if (msg.role === "user" && msg.persist === undefined) {
          // If it was already in DB, it was persisted.
          msg.persist = true;
          modified = true;
        }
      }

      if (modified) {
        db.update(sessions)
          .set({ history: JSON.stringify(history) })
          .where(eq(sessions.id, row.id))
          .run();
      }
    }
  },

  transform(data) {
    return data;
  },
};

export { migration };
