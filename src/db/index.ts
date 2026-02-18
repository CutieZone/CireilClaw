import { join } from "node:path";

import { root } from "$/util/paths.js";
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import * as schema from "./schema.js";

type Db = ReturnType<typeof drizzle<typeof schema>>;

let _db: Db | undefined = undefined;

function getDb(): Db {
  if (_db === undefined) {
    throw new Error("DB not initialized — call initDb() first");
  }
  return _db;
}

function initDb(): Db {
  const dbPath = join(root(), "sessions.db");
  const sqlite = new BetterSqlite3(dbPath);

  // WAL mode: better concurrent read performance and crash safety.
  sqlite.pragma("journal_mode = WAL");

  _db = drizzle(sqlite, { schema });

  // Runs any pending migrations from the drizzle/ folder at startup.
  migrate(_db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });

  return _db;
}

export type { Db };
export { getDb, initDb };
