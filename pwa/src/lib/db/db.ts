/**
 * sqlite-wasm connection for the PWA, mediated through a dedicated Web
 * Worker that uses the **opfs-sahpool** VFS for persistence.
 *
 * Why a custom worker (not sqlite3Worker1Promiser): the stock worker1
 * promiser only auto-registers the `opfs` VFS, which silently fails to
 * open without COOP/COEP cross-origin isolation. We can't set those
 * headers because they break WHIP cross-origin video ingest and
 * cross-origin model fetches. The SAH-pool VFS works without isolation
 * because it grabs FileSystemSyncAccessHandle directly inside the worker
 * (no Atomics+SAB bridge).
 *
 * The worker is in `./sahPoolWorker.ts`. It installs SAH-pool, opens
 * `/southern_signal.sqlite`, and answers a small request/reply protocol.
 *
 * Persistence ladder:
 *
 *   1. opfs-sahpool — SAH-pool installs, DB opens against OPFS. Survives
 *      page refresh. The expected path on Chromium / WebKit when the
 *      origin isn't in private mode and OPFS hasn't been disabled.
 *
 *   2. memory — :memory: fallback when even SAH-pool can't initialize
 *      (private browsing, locked OPFS quota, missing SyncAccessHandle).
 *      `getPersistenceMode()` returns "memory" so the AppHeader badge
 *      warns the operator that data won't survive a refresh.
 */

import { useEffect, useState } from "react";
import { CURRENT_SCHEMA_VERSION, SCHEMA_SQL } from "./schema";

export type PersistenceMode = "opfs-sahpool" | "memory";

// ---------------------------------------------------------------------------
// Worker promiser — request/reply over postMessage with monotonic ids.
// ---------------------------------------------------------------------------

interface ExecReply {
  id: number;
  ok: boolean;
  resultRows?: unknown[];
  error?: string;
}

interface ReadyMessage {
  type: "ready";
  mode: PersistenceMode;
}

type WorkerMessage = ExecReply | ReadyMessage;

interface InitResult {
  exec: (sql: string, bind: BindValue[], wantRows: boolean) => Promise<unknown[]>;
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
  const worker = new Worker(new URL("./sahPoolWorker.ts", import.meta.url), {
    type: "module",
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (err: Error) => void }>();
  let readyResolve!: (mode: PersistenceMode) => void;
  const ready = new Promise<PersistenceMode>((resolve) => { readyResolve = resolve; });

  worker.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
    const data = event.data;
    if ("type" in data && data.type === "ready") {
      readyResolve(data.mode);
      return;
    }
    if ("id" in data) {
      const waiter = pending.get(data.id);
      if (!waiter) return;
      pending.delete(data.id);
      if (data.ok) waiter.resolve(data.resultRows ?? []);
      else waiter.reject(new Error(data.error ?? "sqlite worker error"));
    }
  });
  worker.addEventListener("error", (event) => {
    console.error("[sqlite] worker error", event.message);
  });

  const exec = (sql: string, bind: BindValue[], wantRows: boolean): Promise<unknown[]> => {
    const id = nextId++;
    return new Promise<unknown[]>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({
        id,
        type: "exec",
        sql,
        bind,
        rowMode: "object",
        returnRows: wantRows,
      });
    });
  };

  const mode = await ready;
  setMode(mode);

  // v15 — enforce declared FOREIGN KEY constraints on this connection.
  //
  // SQLite parses FK declarations regardless, but they're INERT until
  // `PRAGMA foreign_keys = ON` is set on each new connection. We've been
  // shipping the declarations since v3; they only start to MEAN anything
  // once this PRAGMA fires. It MUST run before any other DML — including
  // the legacy ALTER statements below — because turning it on mid-flight
  // is rejected inside a transaction, and toggling it changes whether
  // subsequent writes raise FOREIGN KEY constraint failed.
  //
  // Why per-connection: the SAH-pool worker holds one persistent DB
  // handle for the lifetime of the page. If we ever respawn the worker
  // (closeDb() → next init()), `init` runs again and re-applies the
  // PRAGMA against the fresh handle. No code path opens a second
  // connection.
  await exec("PRAGMA foreign_keys = ON;", [], false);

  // Schema setup — same SQL the previous path ran. Idempotent.
  await exec(SCHEMA_SQL, [], false);

  // v2 -> v3 migration: SQLite has no IF NOT EXISTS for ADD COLUMN, so
  // try/swallow. CREATE TABLE IF NOT EXISTS in SCHEMA_SQL handles fresh DBs.
  try {
    await exec(
      "ALTER TABLE investigations ADD COLUMN culturally_sensitive INTEGER NOT NULL DEFAULT 0",
      [],
      false,
    );
  } catch {
    /* column already exists (v3+ DB) — fine */
  }

  // v9: pre-registered protocol columns on investigations.
  for (const col of ["protocol_json TEXT", "protocol_hash TEXT"]) {
    try {
      await exec(`ALTER TABLE investigations ADD COLUMN ${col}`, [], false);
    } catch {
      /* column already exists on v9+ DBs */
    }
  }

  // v10: sham/control session columns on investigations.
  for (const col of [
    "session_type TEXT NOT NULL DEFAULT 'active'",
    "paired_investigation_id TEXT",
  ]) {
    try {
      await exec(`ALTER TABLE investigations ADD COLUMN ${col}`, [], false);
    } catch {
      /* column already exists on v10+ DBs */
    }
  }

  // v11 + v12 tables land via CREATE TABLE IF NOT EXISTS in SCHEMA_SQL.

  // v13: rename misnamed column ed25519_pubkey_b64 → ed25519_pubkey_hex on bundle_signatures.
  try {
    await exec(
      "ALTER TABLE bundle_signatures RENAME COLUMN ed25519_pubkey_b64 TO ed25519_pubkey_hex",
      [],
      false,
    );
  } catch {
    /* column already renamed (v13+) or table was just created with new name */
  }

  // v14: ICIP restriction levels on media_assets and evidence_events;
  // TO consent path + commercial-use flag on investigations. Default
  // 'open' so all existing evidence rows are treated as unrestricted.
  for (const stmt of [
    "ALTER TABLE media_assets    ADD COLUMN restriction       TEXT    NOT NULL DEFAULT 'open'",
    "ALTER TABLE evidence_events ADD COLUMN restriction       TEXT    NOT NULL DEFAULT 'open'",
    "ALTER TABLE investigations  ADD COLUMN to_consent_path  TEXT",
    "ALTER TABLE investigations  ADD COLUMN commercial_use_approved INTEGER NOT NULL DEFAULT 0",
  ]) {
    try {
      await exec(stmt, [], false);
    } catch {
      /* column exists on v14+ DBs or new DB created with SCHEMA_SQL */
    }
  }

  // v15: one-shot orphan-row cleanup. FK constraints were not enforced
  // before this version, so a legacy DB can hold rows whose parent has
  // been deleted (e.g. an investigation row was removed without ON
  // DELETE cascading because the cascade was inert). With foreign_keys
  // now ON, subsequent writes to those tables would fail on the FIRST
  // child insert if SQLite ever runs an integrity check (e.g. during
  // VACUUM). We pre-clean here so existing chains stay verifiable.
  //
  // Idempotent: a fresh DB has no orphans, and re-running on a clean DB
  // is a no-op. Audit log is intentionally left untouched (no FK).
  for (const stmt of [
    // CASCADE-equivalent cleanups for tables whose parent FK is to investigations.
    "DELETE FROM sensor_samples       WHERE investigation_id NOT IN (SELECT id FROM investigations)",
    "DELETE FROM evidence_events      WHERE investigation_id NOT IN (SELECT id FROM investigations)",
    "DELETE FROM media_assets         WHERE investigation_id NOT IN (SELECT id FROM investigations)",
    "DELETE FROM transcripts          WHERE investigation_id NOT IN (SELECT id FROM investigations)",
    "DELETE FROM transcripts          WHERE media_id         NOT IN (SELECT id FROM media_assets)",
    "DELETE FROM debunk_checklist     WHERE investigation_id NOT IN (SELECT id FROM investigations)",
    "DELETE FROM debunk_checklist     WHERE event_id         NOT IN (SELECT id FROM evidence_events)",
    "DELETE FROM interviews           WHERE investigation_id NOT IN (SELECT id FROM investigations)",
    "DELETE FROM trigger_objects      WHERE investigation_id NOT IN (SELECT id FROM investigations)",
    "DELETE FROM trigger_object_checks WHERE trigger_object_id NOT IN (SELECT id FROM trigger_objects)",
    "DELETE FROM trigger_object_checks WHERE investigation_id  NOT IN (SELECT id FROM investigations)",
    "DELETE FROM research_finding_notes WHERE dossier_id NOT IN (SELECT id FROM research_dossiers)",
    // SET NULL-equivalent cleanups for nullable FKs.
    "UPDATE research_dossiers SET investigation_id = NULL WHERE investigation_id IS NOT NULL AND investigation_id NOT IN (SELECT id FROM investigations)",
    "UPDATE bundle_signatures SET investigation_id = NULL WHERE investigation_id IS NOT NULL AND investigation_id NOT IN (SELECT id FROM investigations)",
  ]) {
    try {
      await exec(stmt, [], false);
    } catch (err) {
      // A missing table (pre-the-table-was-added) raises here. That's
      // fine — there's nothing to clean. Anything else, surface so we
      // notice in the console; we still continue.
      console.warn("[db] v15 orphan cleanup skipped:", (err as Error).message);
    }
  }

  // Stamp schema version on fresh DBs.
  await exec(
    "INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', ?)",
    [String(CURRENT_SCHEMA_VERSION)],
    false,
  );
  // Bump on already-stamped older DBs.
  await exec(
    "UPDATE schema_meta SET value = ? WHERE key = 'schema_version' AND CAST(value AS INTEGER) < ?",
    [String(CURRENT_SCHEMA_VERSION), CURRENT_SCHEMA_VERSION],
    false,
  );

  return { exec, mode };
}

async function getExec(): Promise<InitResult["exec"]> {
  if (!initPromise) initPromise = init();
  return (await initPromise).exec;
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

/** Convenience for tests / cleanup. Resets the in-process init handle. */
export async function closeDb(): Promise<void> {
  // The worker is owned by the page; we just drop the cached promise so a
  // subsequent call respawns the worker. The browser garbage-collects the
  // dead worker when its message channel is unreferenced.
  initPromise = null;
  lastKnownMode = "memory";
}

type BindValue = string | number | bigint | null | Uint8Array;

/**
 * Run a SELECT and return rows as plain objects. Mirrors the prior API
 * exactly so all existing callers and tests keep working.
 */
export async function query<T = Record<string, unknown>>(
  sql: string,
  bind: BindValue[] = [],
): Promise<T[]> {
  const exec = await getExec();
  const rows = await exec(sql, bind, true);
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/** Run an INSERT/UPDATE/DELETE/DDL statement. */
export async function exec(sql: string, bind: BindValue[] = []): Promise<void> {
  const fn = await getExec();
  await fn(sql, bind, false);
}

// ---------------------------------------------------------------------------
// Transactions (v15).
//
// sqlite-wasm runs every exec() on the same DB handle inside one worker, so
// nesting BEGIN/COMMIT around a sequence of writes gives us atomic semantics
// (the FS sync after COMMIT either succeeds for the whole group or rolls
// back). We do NOT support nesting in SQLite — if a transaction is already
// open we run the body inline and rely on the OUTER caller's COMMIT/ROLLBACK
// to bracket us. SQLite-wasm doesn't expose SAVEPOINT cleanly over the
// promiser, and treating nesting as a no-op matches the only callers we
// have today (appendAuditEntry inside an outer repo.ts transaction).
//
// Failure semantics: if the body throws, we ROLLBACK and rethrow. If the
// COMMIT itself throws, we let the caller see the failure.
// ---------------------------------------------------------------------------

let inTransaction = false;
let transactionTail: Promise<void> = Promise.resolve();

/**
 * Run `body` inside a SQLite transaction. Use for any function that does
 * more than one INSERT/UPDATE/DELETE and needs all-or-nothing semantics —
 * e.g. "create row + append audit entry + enqueue for sync".
 */
export async function withTransaction<T>(body: () => Promise<T>): Promise<T> {
  if (inTransaction) {
    // Already inside a tx — just run inline, the outer caller commits.
    return body();
  }
  const previous = transactionTail;
  let release!: () => void;
  transactionTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;

  let fn: InitResult["exec"] | null = null;
  try {
    fn = await getExec();
    await fn("BEGIN", [], false);
    inTransaction = true;
    const result = await body();
    await fn("COMMIT", [], false);
    inTransaction = false;
    return result;
  } catch (err) {
    inTransaction = false;
    if (fn) {
      try { await fn("ROLLBACK", [], false); } catch { /* best effort */ }
    }
    throw err;
  } finally {
    release();
  }
}
