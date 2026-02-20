import { join } from "node:path";

import { agentRoot } from "$/util/paths.js";
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import * as schema from "./schema.js";

type Db = ReturnType<typeof drizzle<typeof schema>>;

// Map from agent slug to DB instance — each agent gets its own database.
const _dbs = new Map<string, Db>();

function getDb(agentSlug: string): Db {
  const db = _dbs.get(agentSlug);
  if (db === undefined) {
    throw new Error(`DB not initialized for agent '${agentSlug}' — call initDb(slug) first`);
  }
  return db;
}

function initDb(agentSlug: string): Db {
  const existing = _dbs.get(agentSlug);
  if (existing !== undefined) {
    return existing;
  }

  const dbPath = join(agentRoot(agentSlug), "sessions.db");
  const sqlite = new BetterSqlite3(dbPath);

  // WAL mode: better concurrent read performance and crash safety.
  sqlite.pragma("journal_mode = WAL");

  const db = drizzle(sqlite, { schema });

  // Runs any pending migrations from the drizzle/ folder at startup.
  migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });

  _dbs.set(agentSlug, db);
  return db;
}

export type { Db };
export { getDb, initDb };
