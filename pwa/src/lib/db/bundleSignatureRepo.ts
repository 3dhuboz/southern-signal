/**
 * Repository for the bundle_signatures table (v12 / Tier 3 #2).
 *
 * Follows the same exec/query pattern as repo.ts — import from db.ts,
 * no raw IndexedDB here.
 */

import { appendAuditEntry } from "./auditLog";
import { exec, query } from "./db";
import type { BundleSignatureRow, TsaStatus } from "./schema";

/**
 * Insert a new bundle signature row.
 * Called at export time, before or after the TSA attempt.
 */
export async function saveBundleSignature(row: BundleSignatureRow): Promise<void> {
  await exec(
    `INSERT INTO bundle_signatures
       (bundle_id, investigation_id, built_at, merkle_root,
        cose_signature_b64, ed25519_pubkey_hex,
        tsa_status, tsa_token_b64, tsa_requested_at, tsa_anchored_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.bundle_id,
      row.investigation_id,
      row.built_at,
      row.merkle_root,
      row.cose_signature_b64,
      row.ed25519_pubkey_hex,
      row.tsa_status,
      row.tsa_token_b64,
      row.tsa_requested_at,
      row.tsa_anchored_at,
    ],
  );
  await appendAuditEntry({
    actor: "user",
    kind: "bundle_signature.save",
    payload: {
      bundle_id: row.bundle_id,
      investigation_id: row.investigation_id,
      tsa_status: row.tsa_status,
    },
  });
}

/**
 * Update TSA fields after a deferred anchoring attempt.
 * Called by the background reconnect handler.
 */
export async function updateTsaResult(
  bundleId: string,
  tsa_status: TsaStatus,
  tsa_token_b64: string | null,
  tsa_anchored_at: string | null,
): Promise<void> {
  await exec(
    `UPDATE bundle_signatures
       SET tsa_status = ?, tsa_token_b64 = ?, tsa_anchored_at = ?
     WHERE bundle_id = ?`,
    [tsa_status, tsa_token_b64, tsa_anchored_at, bundleId],
  );
  await appendAuditEntry({
    actor: "user",
    kind: "bundle_signature.tsa_update",
    payload: { bundle_id: bundleId, tsa_status },
  });
}

/**
 * List all bundles whose TSA anchor is still pending.
 * Called on network reconnect to drain the queue.
 */
export async function listPendingTsaRequests(): Promise<BundleSignatureRow[]> {
  try {
    return await query<BundleSignatureRow>(
      "SELECT * FROM bundle_signatures WHERE tsa_status = 'pending'",
    );
  } catch {
    // Pre-v12 schema — table doesn't exist yet.
    return [];
  }
}

/**
 * Retrieve a single bundle signature row by bundle_id.
 * Returns null if not found or if the table doesn't exist yet.
 */
export async function getBundleSignature(bundleId: string): Promise<BundleSignatureRow | null> {
  try {
    const rows = await query<BundleSignatureRow>(
      "SELECT * FROM bundle_signatures WHERE bundle_id = ?",
      [bundleId],
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}
