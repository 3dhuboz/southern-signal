/**
 * Sync queue persistence — append-only enqueue, FIFO drain by next_attempt_at.
 *
 * Every write to a synced table calls `enqueue()` with the row payload. The
 * sync worker reads `listDueForUpload()` in batches and calls `markInFlight`
 * → `markDone` / `markFailed`. Failed rows get exponential backoff via
 * `next_attempt_at`.
 */

import { exec, query } from "../db/db";
import type { SyncItem, SyncKind, SyncStats } from "./types";

const MAX_ATTEMPTS = 8;

interface EnqueueInput {
  kind: SyncKind;
  ref_id: string;
  payload: Record<string, unknown>;
  file_path?: string | null;
}

export async function enqueue(input: EnqueueInput): Promise<void> {
  const ts = new Date().toISOString();
  await exec(
    `INSERT INTO sync_queue (kind, ref_id, payload_json, file_path, status, attempts, enqueued_at, next_attempt_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
    [input.kind, input.ref_id, JSON.stringify(input.payload), input.file_path ?? null, ts, ts],
  );
}

export async function listDueForUpload(limit = 16): Promise<SyncItem[]> {
  const ts = new Date().toISOString();
  return query<SyncItem>(
    `SELECT * FROM sync_queue
     WHERE status = 'pending' AND next_attempt_at <= ?
     ORDER BY id ASC
     LIMIT ?`,
    [ts, limit],
  );
}

export async function markInFlight(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  await exec(`UPDATE sync_queue SET status = 'in_flight' WHERE id IN (${placeholders})`, ids);
}

export async function markDone(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const ts = new Date().toISOString();
  const placeholders = ids.map(() => "?").join(",");
  await exec(
    `UPDATE sync_queue SET status = 'done', uploaded_at = ?, last_error = NULL WHERE id IN (${placeholders})`,
    [ts, ...ids],
  );
}

export async function markFailed(id: number, error: string, attempts: number): Promise<void> {
  const final = attempts >= MAX_ATTEMPTS;
  // Exponential backoff: 2^attempts seconds, capped at 5 minutes.
  const delaySec = Math.min(300, Math.pow(2, attempts));
  const next = new Date(Date.now() + delaySec * 1000).toISOString();
  await exec(
    `UPDATE sync_queue
     SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ?
     WHERE id = ?`,
    [final ? "failed" : "pending", attempts, error.slice(0, 400), next, id],
  );
}

export async function getStats(): Promise<SyncStats> {
  const counts = await query<{ status: string; n: number }>(
    "SELECT status, COUNT(*) AS n FROM sync_queue GROUP BY status",
  );
  const map = Object.fromEntries(counts.map((c) => [c.status, c.n] as const));
  const oldest = await query<{ ts: string | null }>(
    "SELECT MIN(enqueued_at) AS ts FROM sync_queue WHERE status = 'pending'",
  );
  const newest = await query<{ ts: string | null }>(
    "SELECT MAX(uploaded_at) AS ts FROM sync_queue WHERE status = 'done'",
  );
  return {
    pending: map.pending ?? 0,
    in_flight: map.in_flight ?? 0,
    done: map.done ?? 0,
    failed: map.failed ?? 0,
    oldest_pending_at: oldest[0]?.ts ?? null,
    last_uploaded_at: newest[0]?.ts ?? null,
  };
}

/** Reset rows stuck in_flight (e.g. tab closed mid-upload). Call on bootstrap. */
export async function recoverInFlight(): Promise<void> {
  const ts = new Date().toISOString();
  await exec(
    `UPDATE sync_queue
     SET status = 'pending', next_attempt_at = ?
     WHERE status = 'in_flight'`,
    [ts],
  );
}

/** Manual retry of permanently-failed rows (Setup UI). */
export async function retryAllFailed(): Promise<number> {
  const ts = new Date().toISOString();
  const before = await query<{ n: number }>("SELECT COUNT(*) AS n FROM sync_queue WHERE status = 'failed'");
  await exec(
    `UPDATE sync_queue
     SET status = 'pending', attempts = 0, last_error = NULL, next_attempt_at = ?
     WHERE status = 'failed'`,
    [ts],
  );
  return before[0]?.n ?? 0;
}

/** Trim 'done' rows older than N days to keep the queue table small. */
export async function purgeDoneOlderThan(days: number): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const before = await query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sync_queue WHERE status = 'done' AND uploaded_at < ?",
    [cutoff],
  );
  await exec("DELETE FROM sync_queue WHERE status = 'done' AND uploaded_at < ?", [cutoff]);
  return before[0]?.n ?? 0;
}
