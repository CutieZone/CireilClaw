import { join } from "node:path";

import colors from "$/output/colors.js";
import { warning } from "$/output/log.js";
import { agentRoot } from "$/util/paths.js";
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import * as schema from "./schema.js";

type Database = Awaited<ReturnType<typeof drizzle<typeof schema>>>;

// Map from agent slug to DB instance — each agent gets its own database.
const _dbs = new Map<string, Database>();

function getDb(agentSlug: string): Database {
  const db = _dbs.get(agentSlug);
  if (db === undefined) {
    throw new Error(`DB not initialized for agent '${agentSlug}' — call initDb(slug) first`);
  }
  return db;
}

function initDb(agentSlug: string): Database {
  const existing = _dbs.get(agentSlug);
  if (existing !== undefined) {
    return existing;
  }

  const dbPath = join(agentRoot(agentSlug), "sessions.db");
  const sqlite = new BetterSqlite3(dbPath);

  // WAL mode: better concurrent read performance and crash safety.
  sqlite.pragma("journal_mode = WAL");

  const db = drizzle({ client: sqlite, schema });

  try {
    // Runs any pending migrations from the drizzle/ folder at startup.
    migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
  } catch (error: unknown) {
    if (error instanceof Error) {
      warning(
        "Failed to migrate agent",
        colors.keyword(agentSlug),
        "and their database:",
        error.message,
      );
    } else {
      warning("Failed to migrate agent", colors.keyword(agentSlug), "and their database:", error);
    }
  }

  _dbs.set(agentSlug, db);
  return db;
}

export type { Database };
export { getDb, initDb };
