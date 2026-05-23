/**
 * Sync queue persistence — append-only enqueue, FIFO drain by next_attempt_at.
 *
 * Every write to a synced table calls `enqueue()` with the row payload. The
 * sync worker reads `listDueForUpload()` in batches and calls `markInFlight`
 * → `markDone` / `markFailed`. Failed rows get exponential backoff via
 * `next_attempt_at`.
 */

import { exec, query } from "../db/db";
import { getPreferences } from "../preferences";
import type { SyncItem, SyncKind, SyncStats } from "./types";

const MAX_ATTEMPTS = 8;

interface EnqueueInput {
  kind: SyncKind;
  ref_id: string;
  payload: Record<string, unknown>;
  file_path?: string | null;
}

// ---------------------------------------------------------------------------
// Per-case cultural-sensitivity gate (v3).
//
// When an investigation is flagged sensitive, NONE of its rows, media bytes,
// or audit metadata should leave the device. We check at enqueue() time so
// the row never even lands in the queue. The local audit chain still records
// the event; the queue mirror for that audit row is what gets suppressed.
//
// We cache investigation_id -> sensitive boolean for at most 30s so a burst
// of enqueues during recording doesn't hammer the DB.
// ---------------------------------------------------------------------------

const SENSITIVITY_TTL_MS = 30_000;
interface SensitivityCacheEntry { value: boolean; cachedAt: number; }
const sensitivityCache = new Map<string, SensitivityCacheEntry>();

async function isSensitive(investigationId: string): Promise<boolean> {
  const now = Date.now();
  const hit = sensitivityCache.get(investigationId);
  if (hit && now - hit.cachedAt < SENSITIVITY_TTL_MS) return hit.value;
  try {
    const rows = await query<{ culturally_sensitive: number | bigint }>(
      "SELECT culturally_sensitive FROM investigations WHERE id = ?",
      [investigationId],
    );
    const raw = rows[0]?.culturally_sensitive ?? 0;
    const value = Number(raw) === 1;
    sensitivityCache.set(investigationId, { value, cachedAt: now });
    return value;
  } catch {
    // Fail open here is safer than fail closed for sync, but this query is
    // simple and shouldn't fail. If it does, leave cached value alone.
    return hit?.value ?? false;
  }
}

/** Public helper so callers (e.g. tests) can clear the cache. */
export function clearSensitivityCache(): void {
  sensitivityCache.clear();
}

/**
 * Pull the investigation_id out of an enqueue payload. For investigation
 * rows themselves, the row's own `id` IS the investigation_id.
 */
function extractInvestigationId(input: EnqueueInput): string | null {
  if (input.kind === "investigation") {
    const id = input.payload.id;
    return typeof id === "string" ? id : null;
  }
  if (input.kind === "audit") {
    return extractInvestigationIdFromAuditPayload(input.payload);
  }
  const ref = input.payload.investigation_id;
  return typeof ref === "string" ? ref : null;
}

function extractInvestigationIdFromAuditPayload(payload: Record<string, unknown>): string | null {
  const payloadJson = payload.payload_json;
  if (typeof payloadJson !== "string") return null;
  try {
    const auditPayload = JSON.parse(payloadJson) as Record<string, unknown>;
    if (typeof auditPayload.investigation_id === "string") return auditPayload.investigation_id;

    const auditKind = payload.kind;
    if (typeof auditKind === "string" && auditKind.startsWith("investigation.")) {
      return typeof auditPayload.id === "string" ? auditPayload.id : null;
    }
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Audit-logger injection.
//
// queue.ts and auditLog.ts form a cycle (auditLog.ts statically imports
// `enqueue` here; this module needs to append audit entries when it skips a
// row for cultural-sensitivity reasons). To keep the cycle from forcing a
// dynamic import (which the bundler then flags as INEFFECTIVE_DYNAMIC_IMPORT
// because auditLog is already in the eager index chunk), we accept an
// `appendAuditEntry` function via setter-injection. auditLog.ts wires itself
// in at module-init time via the `setAuditLogger` call at the bottom of that
// file. Until injection happens (e.g. in unit tests that import queue.ts
// without auditLog.ts), logSkip becomes a no-op + console.warn.
// ---------------------------------------------------------------------------

type AuditLogger = (input: {
  actor: string;
  kind: string;
  payload: Record<string, unknown>;
}) => Promise<unknown>;

let auditLogger: AuditLogger | null = null;

export function setAuditLogger(fn: AuditLogger | null): void {
  auditLogger = fn;
}

async function logSkip(
  input: EnqueueInput,
  investigationId: string,
  auditKind: "sync.skip_sensitive" | "sync.skip_global_sensitive" = "sync.skip_sensitive",
): Promise<void> {
  // Append a hash-chained audit entry recording the sync skip. The audit
  // module re-enters enqueue() for its own kind="audit" row. Audit sync rows
  // are now gated too, so enqueue() deliberately avoids calling logSkip for
  // audit rows to prevent recursive skip-of-skip entries.
  if (!auditLogger) {
    console.warn(`[sync] audit logger not registered; cannot record ${auditKind}`);
    return;
  }
  try {
    await auditLogger({
      actor: "system",
      kind: auditKind,
      payload: {
        kind: input.kind,
        ref_id: input.ref_id,
        investigation_id: investigationId,
      },
    });
  } catch (err) {
    console.warn(`[sync] failed to audit ${auditKind}`, err);
  }
}

export async function enqueue(input: EnqueueInput): Promise<void> {
  // Global cultural-sensitivity flag: hard-block ALL enqueues, including
  // audit sync mirrors, so metadata captured while the flag is on cannot
  // leave later when sync is re-enabled.
  if (getPreferences().globalCulturalSensitivityFlag) {
    const investigationId = extractInvestigationId(input) ?? "global_flag";
    if (input.kind !== "audit") {
      await logSkip(input, investigationId, "sync.skip_global_sensitive");
    }
    return;
  }

  const investigationId = extractInvestigationId(input);
  if (investigationId) {
    const sensitive = await isSensitive(investigationId);
    if (sensitive) {
      if (input.kind !== "audit") {
        await logSkip(input, investigationId);
      }
      return;
    }
  }

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

/**
 * Most-recent permanently-failed rows for the operator UI. Read-only display
 * helper — does not mutate retry state. Newest-first by id.
 */
export async function listRecentFailures(
  limit = 5,
): Promise<Pick<SyncItem, "id" | "kind" | "ref_id" | "attempts" | "last_error" | "next_attempt_at">[]> {
  return query<Pick<SyncItem, "id" | "kind" | "ref_id" | "attempts" | "last_error" | "next_attempt_at">>(
    `SELECT id, kind, ref_id, attempts, last_error, next_attempt_at
     FROM sync_queue
     WHERE status = 'failed'
     ORDER BY id DESC
     LIMIT ?`,
    [limit],
  );
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
