/**
 * Custom SQLite worker that opens the database through the **opfs-sahpool**
 * VFS, which (unlike the stock `opfs` VFS) works without COOP/COEP
 * cross-origin isolation. We can't set those headers because they'd block
 * the WHIP video ingest + cross-origin model fetches the app depends on.
 *
 * The bundled `sqlite3-worker1` worker only auto-registers the `opfs` VFS
 * (which silently fails to open on non-isolated pages and lands us in
 * `:memory:` mode — the "NO SAVE" pill). This worker installs the
 * SAH-pool VFS explicitly, then exposes a tiny request/reply protocol
 * compatible with db.ts.
 *
 * Protocol (main thread → worker):
 *   { id, type: "exec", sql, bind?, rowMode?, returnRows? }
 *
 * Worker → main thread:
 *   { id, ok: true, resultRows? }    on success
 *   { id, ok: false, error }         on failure
 *
 * One synthetic "ready" message is posted once init has finished so the
 * main thread knows which persistence mode landed:
 *   { type: "ready", mode: "opfs-sahpool" | "memory" }
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

type ExecMessage = {
  id: number;
  type: "exec";
  sql: string;
  bind?: unknown[];
  rowMode?: "object" | "array";
  returnRows?: boolean;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any | null = null;
let mode: "opfs-sahpool" | "memory" = "memory";

async function init(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sqlite3 = await (sqlite3InitModule as any)({
    print: () => { /* swallow chatty info */ },
    printErr: (msg: string) => console.warn("[sqlite-worker]", msg),
  });

  // Try SAH-pool VFS first. Works without COOP/COEP because the worker
  // can grab FileSystemSyncAccessHandle directly.
  try {
    const poolUtil = await sqlite3.installOpfsSAHPoolVfs({
      name: "southern-signal-sah",
      // Capacity is the *maximum* number of SQLite-managed files the pool
      // can hold concurrently (the DB, its journal, temp files). Eight is
      // plenty for a single-DB app and stays well inside iOS' OPFS quota.
      initialCapacity: 8,
    });
    db = new poolUtil.OpfsSAHPoolDb("/southern_signal.sqlite");
    mode = "opfs-sahpool";
  } catch (err) {
    console.warn("[sqlite-worker] SAH-pool init failed; falling back to :memory:", err);
    db = new sqlite3.oo1.DB(":memory:", "ct");
    mode = "memory";
  }

  (self as DedicatedWorkerGlobalScope).postMessage({ type: "ready", mode });
}

function runExec(msg: ExecMessage): void {
  if (!db) {
    (self as DedicatedWorkerGlobalScope).postMessage({ id: msg.id, ok: false, error: "DB not initialized" });
    return;
  }
  try {
    if (msg.returnRows) {
      const resultRows: unknown[] = [];
      db.exec({
        sql: msg.sql,
        bind: msg.bind,
        rowMode: msg.rowMode ?? "object",
        resultRows,
      });
      (self as DedicatedWorkerGlobalScope).postMessage({ id: msg.id, ok: true, resultRows });
    } else {
      db.exec({ sql: msg.sql, bind: msg.bind });
      (self as DedicatedWorkerGlobalScope).postMessage({ id: msg.id, ok: true });
    }
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Queue messages that arrive before init has finished so the main thread
// can fire-and-forget on bootstrap.
const pending: ExecMessage[] = [];
let initDone = false;

self.addEventListener("message", (event: MessageEvent<ExecMessage>) => {
  if (!initDone) {
    pending.push(event.data);
    return;
  }
  runExec(event.data);
});

void init().then(() => {
  initDone = true;
  while (pending.length > 0) {
    const msg = pending.shift();
    if (msg) runExec(msg);
  }
});
