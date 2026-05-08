/**
 * Per-session forensic manifest. Materialised view over the audit_log,
 * the investigations table, the evidence_events table, and any media
 * assets. Output is a JSON document with a Merkle root over the audit
 * chain — verifiable independently with the merkle.ts primitives.
 *
 * This is the document the report PDF cover page hashes display, and
 * the document the Tier 3 RFC 3161 / COSE layer signs.
 */

import { query } from "../db/db";
import { verifyAuditChain } from "../db/auditLog";
import type { AuditLogEntry, EvidenceEvent, Investigation, MediaAsset } from "../db/schema";
import { leafFromExistingHashHex, merkleRoot } from "./merkle";

export interface ManifestInvestigationView {
  id: string;
  title: string;
  location_name: string | null;
  status: string;
  disposition: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  audit_chain: {
    first_seq: number | null;
    last_seq: number | null;
    leaf_count: number;
    merkle_root: string | null;
  };
  events: { count: number; types: Record<string, number> };
  media: { id: string; media_type: string; file_path: string; sha256: string | null }[];
}

export interface Manifest {
  schema: "southern-signal.manifest.v1";
  app_version: string;
  generated_at: string;
  investigations: ManifestInvestigationView[];
  global_audit_chain: {
    leaf_count: number;
    merkle_root: string | null;
    verification:
      | { ok: true }
      | { ok: false; brokenAtSeq: number; reason: string };
    first_seq: number | null;
    last_seq: number | null;
  };
}

const APP_VERSION = "0.1.0";

async function buildAuditChainSummary(entries: AuditLogEntry[]) {
  if (entries.length === 0) {
    return { first_seq: null, last_seq: null, leaf_count: 0, merkle_root: null };
  }
  const leaves = await Promise.all(entries.map((e) => leafFromExistingHashHex(e.entry_hash)));
  const root = await merkleRoot(leaves);
  return {
    first_seq: entries[0].seq,
    last_seq: entries[entries.length - 1].seq,
    leaf_count: entries.length,
    merkle_root: root,
  };
}

export async function buildManifest(): Promise<Manifest> {
  const investigations = await query<Investigation>(
    "SELECT * FROM investigations ORDER BY created_at ASC",
  );
  const allAudit = await query<AuditLogEntry>(
    "SELECT * FROM audit_log ORDER BY seq ASC",
  );
  const verification = await verifyAuditChain();

  const investigationViews: ManifestInvestigationView[] = [];
  for (const inv of investigations) {
    const invAudit = allAudit.filter((e) => {
      try {
        const payload = JSON.parse(e.payload_json) as Record<string, unknown>;
        return payload.investigation_id === inv.id || payload.id === inv.id;
      } catch { return false; }
    });
    const events = await query<EvidenceEvent>(
      "SELECT * FROM evidence_events WHERE investigation_id = ?",
      [inv.id],
    );
    const eventTypes: Record<string, number> = {};
    for (const e of events) eventTypes[e.event_type] = (eventTypes[e.event_type] ?? 0) + 1;
    const media = await query<MediaAsset>(
      "SELECT * FROM media_assets WHERE investigation_id = ?",
      [inv.id],
    );

    const auditSummary = await buildAuditChainSummary(invAudit);

    investigationViews.push({
      id: inv.id,
      title: inv.title,
      location_name: inv.location_name,
      status: inv.status,
      disposition: inv.disposition,
      created_at: inv.created_at,
      started_at: inv.started_at,
      ended_at: inv.ended_at,
      audit_chain: auditSummary,
      events: { count: events.length, types: eventTypes },
      media: media.map((m) => ({
        id: m.id,
        media_type: m.media_type,
        file_path: m.file_path,
        sha256: m.checksum_sha256,
      })),
    });
  }

  const globalSummary = await buildAuditChainSummary(allAudit);

  return {
    schema: "southern-signal.manifest.v1",
    app_version: APP_VERSION,
    generated_at: new Date().toISOString(),
    investigations: investigationViews,
    global_audit_chain: {
      leaf_count: globalSummary.leaf_count,
      merkle_root: globalSummary.merkle_root,
      first_seq: globalSummary.first_seq,
      last_seq: globalSummary.last_seq,
      verification,
    },
  };
}
