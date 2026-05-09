/**
 * sqlite-wasm + OPFS connection for the PWA.
 *
 * Uses the official @sqlite.org/sqlite-wasm package (NOT the deprecated
 * Worker1/Promiser1 API). DB lives at /db/southern_signal.sqlite in OPFS.
 *
 * For V1 we run the DB on the main thread for simplicity. If contention with
 * the audio capture worker becomes a problem, move to a worker via
 * sqlite3Worker1Promiser-mode equivalent.
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { CURRENT_SCHEMA_VERSION, SCHEMA_SQL } from "./schema";

let initPromise: Promise<{ sqlite3: Sqlite3Static; db: Database }> | null = null;

export async function getDb(): Promise<Database> {
  if (!initPromise) {
    initPromise = (async () => {
      // sqlite3InitModule's options type varies between versions; cast to any
      // so we can pass debug hooks regardless.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sqlite3 = await (sqlite3InitModule as any)({
        print: () => {},
        printErr: (msg: string) => console.warn("[sqlite]", msg),
      });
      const oo1 = sqlite3.oo1 as unknown as { OpfsDb?: new (path: string) => Database; DB: new (path: string) => Database };
      const hasOpfs = "OpfsDb" in oo1 && oo1.OpfsDb;
      const db = hasOpfs
        ? new oo1.OpfsDb!("/southern_signal.sqlite")
        : new oo1.DB(":memory:");
      if (!hasOpfs) {
        console.warn("[sqlite] OPFS VFS unavailable — running in-memory only. Data will not persist.");
      }
      db.exec(SCHEMA_SQL);
      // v2 -> v3 migration: SQLite has no IF NOT EXISTS for ADD COLUMN, so
      // try/swallow. CREATE TABLE IF NOT EXISTS above already handles fresh DBs.
      try {
        db.exec("ALTER TABLE investigations ADD COLUMN culturally_sensitive INTEGER NOT NULL DEFAULT 0");
      } catch {
        /* column already exists (v3+ DB) — fine */
      }
      // Stamp schema version
      db.exec({
        sql: "INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', ?)",
        bind: [String(CURRENT_SCHEMA_VERSION)],
      });
      // Bump schema_version on already-stamped older DBs.
      db.exec({
        sql: "UPDATE schema_meta SET value = ? WHERE key = 'schema_version' AND CAST(value AS INTEGER) < ?",
        bind: [String(CURRENT_SCHEMA_VERSION), CURRENT_SCHEMA_VERSION],
      });
      return { sqlite3, db };
    })();
  }
  const { db } = await initPromise;
  return db;
}

export async function closeDb(): Promise<void> {
  if (!initPromise) return;
  const { db } = await initPromise;
  try {
    db.close();
  } catch {
    /* ignore */
  }
  initPromise = null;
}

type BindValue = string | number | bigint | null | Uint8Array;

/** Convenience: run a SELECT and return rows as plain objects. */
export async function query<T = Record<string, unknown>>(sql: string, bind: BindValue[] = []): Promise<T[]> {
  const db = await getDb();
  const rows: T[] = [];
  // sqlite-wasm `exec` callback signature is loose; we cast the row to T at the call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).exec({
    sql,
    bind,
    rowMode: "object",
    callback: (row: unknown) => { rows.push(row as T); },
  });
  return rows;
}

/** Convenience: run an INSERT/UPDATE/DELETE. */
export async function exec(sql: string, bind: BindValue[] = []): Promise<void> {
  const db = await getDb();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).exec({ sql, bind });
}
