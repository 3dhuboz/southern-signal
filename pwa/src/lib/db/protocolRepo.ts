/**
 * Protocol repository — pre-registered hypothesis CRUD (Tier 2 #4).
 *
 * Three operations:
 *  - saveProtocol   — write or update the draft protocol before session start.
 *  - lockProtocol   — compute SHA-256 at session start; hash is immutable after.
 *  - getProtocol    — read back the parsed protocol (null if not yet written).
 *
 * Locking is intentionally separate from saving so investigators can revise
 * their hypothesis right up until the moment they press "Start session". Once
 * locked, the protocol_hash proves the hypothesis existed before any sensor
 * data was gathered.
 */

import { exec, query } from "./db";
import { appendAuditEntry } from "./auditLog";
import { canonicalJson, sha256Hex } from "../forensic/canonicalJson";
import type { InvestigationProtocol } from "./schema";

// ── helpers ──────────────────────────────────────────────────────────────────

interface ProtocolRow {
  protocol_json: string | null;
  protocol_hash: string | null;
}

async function fetchProtocolRow(investigationId: string): Promise<ProtocolRow | null> {
  const rows = await query<ProtocolRow>(
    "SELECT protocol_json, protocol_hash FROM investigations WHERE id = ?",
    [investigationId],
  );
  return rows[0] ?? null;
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Save or update the draft protocol for an investigation.
 *
 * Safe to call multiple times before session start. Overwrites the previous
 * draft. Throws if the protocol is already locked (protocol_hash is set) —
 * locked protocols are immutable.
 */
export async function saveProtocol(
  investigationId: string,
  protocol: InvestigationProtocol,
): Promise<void> {
  const row = await fetchProtocolRow(investigationId);
  if (!row) throw new Error(`Investigation ${investigationId} not found.`);
  if (row.protocol_hash) {
    throw new Error(
      "Protocol is already locked. Create a new investigation to write a fresh hypothesis.",
    );
  }

  const protocolJson = JSON.stringify(protocol);
  await exec(
    "UPDATE investigations SET protocol_json = ? WHERE id = ?",
    [protocolJson, investigationId],
  );
  await appendAuditEntry({
    actor: "user",
    kind: "protocol.save",
    payload: {
      investigation_id: investigationId,
      authored_at: protocol.authored_at,
      hypothesis_length: protocol.hypothesis.length,
      signal_count: protocol.predicted_signals.length,
      zone_count: protocol.zones.length,
      window_count: protocol.windows.length,
    },
  });
}

/**
 * Lock the protocol at session start.
 *
 * Reads the current protocol_json, computes SHA-256 of its canonical form,
 * writes protocol_hash, and appends an audit entry with kind 'protocol.locked'.
 * The hash is the return value and is displayed to the investigator.
 *
 * Throws if:
 *  - The investigation does not exist.
 *  - protocol_json is null (no draft written yet).
 *  - protocol_hash is already set (already locked — idempotent callers should
 *    check this condition before calling).
 */
export async function lockProtocol(investigationId: string): Promise<string> {
  const row = await fetchProtocolRow(investigationId);
  if (!row) throw new Error(`Investigation ${investigationId} not found.`);
  if (!row.protocol_json) {
    throw new Error("No protocol written for this investigation. Write one before locking.");
  }
  if (row.protocol_hash) {
    // Already locked — return the existing hash so callers can treat this
    // as idempotent (e.g. a retry after a network hiccup).
    return row.protocol_hash;
  }

  let protocol: InvestigationProtocol;
  try {
    protocol = JSON.parse(row.protocol_json) as InvestigationProtocol;
  } catch {
    throw new Error("Stored protocol_json is corrupt and cannot be parsed.");
  }

  // Canonical JSON → SHA-256 so key ordering in the stored string is
  // irrelevant — the hash is always over a deterministic byte sequence.
  const hash = await sha256Hex(canonicalJson(protocol as unknown as Record<string, unknown>));

  await exec(
    "UPDATE investigations SET protocol_hash = ? WHERE id = ?",
    [hash, investigationId],
  );

  await appendAuditEntry({
    actor: "user",
    kind: "protocol.locked",
    payload: {
      investigation_id: investigationId,
      protocol_hash: hash,
      authored_at: protocol.authored_at,
    },
  });

  return hash;
}

/**
 * Load the protocol for an investigation.
 *
 * Returns null if protocol_json has not been written yet. Throws on JSON
 * parse failure so callers know the DB row is corrupt rather than silently
 * returning garbage.
 */
export async function getProtocol(
  investigationId: string,
): Promise<InvestigationProtocol | null> {
  const row = await fetchProtocolRow(investigationId);
  if (!row || !row.protocol_json) return null;
  try {
    return JSON.parse(row.protocol_json) as InvestigationProtocol;
  } catch {
    throw new Error(`protocol_json for investigation ${investigationId} is not valid JSON.`);
  }
}
