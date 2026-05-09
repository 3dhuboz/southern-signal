/**
 * Append-only hash-chained audit log (roadmap Tier 1 #5).
 *
 * Every state-change event in Southern Signal is appended here as a
 * cryptographically-chained entry. Edits to existing data become new
 * `derivation` entries that reference the prior `seq`; the original entry
 * is never updated.
 *
 * Hash function: SHA-256 via SubtleCrypto (no external dep).
 * Entry shape: seq, ts_utc, actor, kind, payload_json, prev_hash, entry_hash.
 */

import { exec, query } from "./db";
import { enqueue } from "../sync/queue";

const GENESIS_HASH = "0".repeat(64);

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
  // Stable stringify with sorted keys.
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

interface PriorEntry {
  seq: number;
  entry_hash: string;
}

async function getLastEntry(): Promise<PriorEntry | null> {
  const rows = await query<PriorEntry>(
    "SELECT seq, entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1",
  );
  return rows[0] ?? null;
}

export interface AuditAppendInput {
  actor: string;
  kind: string;
  payload: Record<string, unknown>;
  ts?: string;
}

export interface AuditAppendResult {
  seq: number;
  ts_utc: string;
  prev_hash: string;
  entry_hash: string;
}

export async function appendAuditEntry({ actor, kind, payload, ts }: AuditAppendInput): Promise<AuditAppendResult> {
  const tsUtc = ts ?? new Date().toISOString();
  const prior = await getLastEntry();
  const prevHash = prior?.entry_hash ?? GENESIS_HASH;
  const seq = (prior?.seq ?? 0) + 1;
  const payloadCanon = canonicalJson(payload);

  // Per-entry hash binds: seq + ts + actor + kind + canonical-payload + prev_hash.
  const message = `${seq}|${tsUtc}|${actor}|${kind}|${payloadCanon}|${prevHash}`;
  const entryHash = await sha256Hex(message);

  await exec(
    "INSERT INTO audit_log (seq, ts_utc, actor, kind, payload_json, prev_hash, entry_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [seq, tsUtc, actor, kind, payloadCanon, prevHash, entryHash],
  );

  // Enqueue for cloud sync. Best-effort — failures here must NOT break the
  // chain itself (sync is downstream of the local source of truth).
  try {
    await enqueue({
      kind: "audit",
      ref_id: String(seq),
      payload: { seq, ts_utc: tsUtc, actor, kind, payload_json: payloadCanon, prev_hash: prevHash, entry_hash: entryHash },
    });
  } catch (err) {
    console.warn("[sync] failed to enqueue audit entry", err);
  }

  return { seq, ts_utc: tsUtc, prev_hash: prevHash, entry_hash: entryHash };
}

/** Walk the entire chain and verify every link. Returns null on success or the seq of the broken entry. */
export async function verifyAuditChain(): Promise<{ ok: true } | { ok: false; brokenAtSeq: number; reason: string }> {
  const rows = await query<{
    seq: number;
    ts_utc: string;
    actor: string;
    kind: string;
    payload_json: string;
    prev_hash: string;
    entry_hash: string;
  }>("SELECT * FROM audit_log ORDER BY seq ASC");

  let expectedPrev = GENESIS_HASH;
  let expectedSeq = 1;
  for (const row of rows) {
    if (row.seq !== expectedSeq) return { ok: false, brokenAtSeq: row.seq, reason: `expected seq ${expectedSeq}` };
    if (row.prev_hash !== expectedPrev) return { ok: false, brokenAtSeq: row.seq, reason: "prev_hash mismatch" };
    const recomputed = await sha256Hex(
      `${row.seq}|${row.ts_utc}|${row.actor}|${row.kind}|${row.payload_json}|${row.prev_hash}`,
    );
    if (recomputed !== row.entry_hash) return { ok: false, brokenAtSeq: row.seq, reason: "entry_hash mismatch" };
    expectedPrev = row.entry_hash;
    expectedSeq += 1;
  }
  return { ok: true };
}
