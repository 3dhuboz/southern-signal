/**
 * sqlite-wasm + OPFS connection for the PWA, mediated through a dedicated
 * Web Worker.
 *
 * Why the Worker: `FileSystemFileHandle.createSyncAccessHandle()` — the API
 * sqlite-wasm needs for OPFS persistence — is **not available on the main
 * thread** in any current browser. The standard OpfsDb VFS uses Atomics +
 * SharedArrayBuffer to bridge to a worker, which requires COOP/COEP cross-
 * origin isolation. Setting those headers would break our WHIP cross-origin
 * video ingest, so we instead run the entire SQLite engine inside a
 * dedicated worker via `sqlite3Worker1Promiser`. The worker has direct
 * access to FileSystemSyncAccessHandle and full OPFS persistence — no
 * COOP/COEP required.
 *
 * Public API stays the same as before: `query()`, `exec()`,
 * `getPersistenceMode()`. Callers don't need to know the engine moved.
 *
 * Persistence ladder (first that opens wins):
 *
 *   1. opfs-worker  — Worker promiser opens with `vfs=opfs`. Persists.
 *      The expected path on every modern desktop + Android browser, and
 *      iOS Safari 17+.
 *
 *   2. memory       — :memory: fallback when even the worker can't reach
 *      OPFS (private browsing, restrictive iOS configs, locked storage).
 *      `getPersistenceMode()` returns "memory" so the UI can warn the
 *      operator that data won't survive a refresh.
 */

import { useEffect, useState } from "react";
import { sqlite3Worker1Promiser } from "@sqlite.org/sqlite-wasm";
import { CURRENT_SCHEMA_VERSION, SCHEMA_SQL } from "./schema";

export type PersistenceMode = "opfs-worker" | "memory";

// The promiser's call-site shape is loose; we type just what we use.
type Promiser = (
  type: "open" | "exec" | "close" | "config-get",
  args?: Record<string, unknown>,
) => Promise<{ result?: { resultRows?: unknown[]; [k: string]: unknown }; [k: string]: unknown }>;

interface InitResult {
  promiser: Promiser;
  mode: PersistenceMode;
}

let initPromise: Promise<InitResult> | null = null;
let lastKnownMode: PersistenceMode = "memory";
const modeSubscribers = new Set<(m: PersistenceMode) => void>();

function setMode(next: PersistenceMode): void {
  if (next === lastKnownMode) return;
  lastKnownMode = next;
  for (const fn of modeSubscribers) fn(next);
}

async function init(): Promise<InitResult> {
  // The promiser launches its own Worker internally, loads the wasm, and
  // resolves once it's ready to accept messages.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const promiser = (await (sqlite3Worker1Promiser as any)({
    // Quiet the package's default error handler — we surface failures
    // through the open() try/catch below.
    onerror: () => { /* swallow */ },
  })) as Promiser;

  let mode: PersistenceMode = "memory";

  // Strategy 1 — open with the OPFS VFS. The worker has the synchronous
  // FileSystemAccessHandle APIs available natively; persistence works.
  try {
    await promiser("open", {
      filename: "file:southern_signal.sqlite?vfs=opfs",
    });
    mode = "opfs-worker";
  } catch (err) {
    // Strategy 2 — fall back to :memory:. Browsers that block OPFS
    // (private mode, restrictive iOS configs) land here. UI warns.
    console.warn("[sqlite] worker OPFS open failed; falling back to :memory:", err);
    await promiser("open", { filename: ":memory:" });
    mode = "memory";
    console.warn(
      "[sqlite] running in-memory only — data will NOT persist across page refresh.",
    );
  }

  setMode(mode);

  // Schema setup — same SQL the previous main-thread path ran.
  await promiser("exec", { sql: SCHEMA_SQL });

  // v2 -> v3 migration: SQLite has no IF NOT EXISTS for ADD COLUMN, so
  // try/swallow. CREATE TABLE IF NOT EXISTS in SCHEMA_SQL handles fresh DBs.
  try {
    await promiser("exec", {
      sql: "ALTER TABLE investigations ADD COLUMN culturally_sensitive INTEGER NOT NULL DEFAULT 0",
    });
  } catch {
    /* column already exists (v3+ DB) — fine */
  }

  // Stamp schema version on fresh DBs.
  await promiser("exec", {
    sql: "INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', ?)",
    bind: [String(CURRENT_SCHEMA_VERSION)],
  });
  // Bump on already-stamped older DBs.
  await promiser("exec", {
    sql: "UPDATE schema_meta SET value = ? WHERE key = 'schema_version' AND CAST(value AS INTEGER) < ?",
    bind: [String(CURRENT_SCHEMA_VERSION), CURRENT_SCHEMA_VERSION],
  });

  return { promiser, mode };
}

async function getPromiser(): Promise<Promiser> {
  if (!initPromise) initPromise = init();
  return (await initPromise).promiser;
}

/**
 * Returns the currently-active persistence strategy. "memory" means data
 * will NOT survive a page refresh — the UI should warn the operator.
 *
 * Synchronous; returns the last known mode. On the very first call before
 * init completes, returns "memory" (fail-closed). Use
 * `getPersistenceModeAsync()` if you need a guaranteed-fresh answer.
 */
export function getPersistenceMode(): PersistenceMode {
  return lastKnownMode;
}

/** Async variant — awaits init and returns the actual mode. */
export async function getPersistenceModeAsync(): Promise<PersistenceMode> {
  if (!initPromise) initPromise = init();
  await initPromise;
  return lastKnownMode;
}

/**
 * React hook — reactively returns the current persistence mode. Kicks off
 * init on first mount so the subscriber sees a real answer once the worker
 * has tried OPFS. Useful for AppHeader-style "memory-only" warnings.
 */
export function usePersistenceMode(): PersistenceMode {
  const [mode, setLocal] = useState<PersistenceMode>(lastKnownMode);
  useEffect(() => {
    let cancelled = false;
    modeSubscribers.add(setLocal);
    void getPersistenceModeAsync().then((m) => {
      if (!cancelled) setLocal(m);
    });
    return () => {
      cancelled = true;
      modeSubscribers.delete(setLocal);
    };
  }, []);
  return mode;
}

/** Convenience for tests / cleanup. Closes the underlying database connection. */
export async function closeDb(): Promise<void> {
  if (!initPromise) return;
  try {
    const { promiser } = await initPromise;
    await promiser("close", {});
  } catch {
    /* ignore */
  }
  initPromise = null;
  lastKnownMode = "memory";
}

type BindValue = string | number | bigint | null | Uint8Array;

/**
 * Run a SELECT and return rows as plain objects. Mirrors the prior main-
 * thread API exactly so all existing callers and tests keep working.
 */
export async function query<T = Record<string, unknown>>(
  sql: string,
  bind: BindValue[] = [],
): Promise<T[]> {
  const promiser = await getPromiser();
  const response = await promiser("exec", {
    sql,
    bind,
    rowMode: "object",
    returnRows: true,
  });
  const rows = response?.result?.resultRows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/** Run an INSERT/UPDATE/DELETE/DDL statement. */
export async function exec(sql: string, bind: BindValue[] = []): Promise<void> {
  const promiser = await getPromiser();
  await promiser("exec", { sql, bind });
}
