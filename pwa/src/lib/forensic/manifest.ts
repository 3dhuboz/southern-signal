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
import type { AuditLogEntry, EvidenceEvent, Investigation, MediaAsset, ResearchDossierRow, ReviewerSignoffRow } from "../db/schema";
import { leafFromExistingHashHex, merkleRoot } from "./merkle";
import { sha256Hex } from "./canonicalJson";

const GENESIS_HASH = "0".repeat(64);

/**
 * Verify the chain from an already-loaded row set instead of hitting the
 * DB again. Pure function over the snapshot, so callers that need their
 * verification result and their bundled audit_log.jsonl to derive from
 * the exact same bytes can rely on this.
 */
async function verifyAuditChainFromRows(rows: AuditLogEntry[]): Promise<
  { ok: true } | { ok: false; brokenAtSeq: number; reason: string }
> {
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

/**
 * Per-dossier view in the manifest. The full ResearchResult JSON isn't
 * embedded — at 5-30 KB per dossier the manifest would balloon fast.
 * Instead we surface metadata + a SHA-256 of the canonical result_json
 * string. A reviewer with both the manifest and the on-device dossier
 * row can re-hash and prove the dossier hasn't been altered since the
 * `research.dossier.save` audit entry fired.
 */
export interface ManifestDossierView {
  id: string;
  investigation_id: string | null;
  venue_name: string;
  region: string;
  created_at: string;
  model: string;
  finding_count: number;
  citation_count: number;
  result_sha256: string;
}

/**
 * Per-reviewer view in the manifest. Statement bytes aren't repeated here
 * — they're in `reviewers.json` and on the device row — but the SHA-256
 * is included so a reviewer with the bundle can re-hash the on-bundle
 * statement and confirm the manifest anchors the same text the audit
 * chain anchors at `reviewer.signoff.create` / `.update`.
 */
export interface ManifestReviewerView {
  id: string;
  reviewer_name: string;
  discipline: string;
  signed_at: string;
  app_version: string;
  statement_sha256: string;
  affiliation: string | null;
  identifier: string | null;
  source_url: string | null;
}

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
  /** v2: AI Investigator dossiers attached to this case. */
  research_dossiers: ManifestDossierView[];
}

export interface Manifest {
  schema: "southern-signal.manifest.v1" | "southern-signal.manifest.v2" | "southern-signal.manifest.v3";
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
  /** v2: dossiers with NULL investigation_id — pre-visit recon that
   *  hasn't been attached to a case (yet). Forensic artefacts in their
   *  own right; rolled up here so the Merkle anchor isn't a partial view. */
  standalone_research_dossiers: ManifestDossierView[];
  /** v3: external reviewer sign-offs. Methodology-level, not case-scoped
   *  — same list appears regardless of which case the bundle covers. */
  reviewer_signoffs: ManifestReviewerView[];
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

async function toDossierView(row: ResearchDossierRow): Promise<ManifestDossierView> {
  // Hash the exact string stored in the DB — same bytes a reviewer can
  // reproduce off the on-device row without ever re-parsing the JSON.
  // Parsing then re-stringifying would invite whitespace / key-order
  // drift; we want byte-stable.
  const result_sha256 = await sha256Hex(row.result_json);
  let finding_count = 0;
  let citation_count = 0;
  try {
    const parsed = JSON.parse(row.result_json) as { findings?: Array<{ sources?: unknown[] }> };
    if (Array.isArray(parsed.findings)) {
      finding_count = parsed.findings.length;
      for (const f of parsed.findings) {
        if (Array.isArray(f.sources)) citation_count += f.sources.length;
      }
    }
  } catch { /* malformed result_json — keep zero counts but still emit a hash entry so the artefact is anchored. */ }
  return {
    id: row.id,
    investigation_id: row.investigation_id,
    venue_name: row.venue_name,
    region: row.region,
    created_at: row.created_at,
    model: row.model,
    finding_count,
    citation_count,
    result_sha256,
  };
}

/**
 * Build the manifest.
 *
 * Pass `pinned.allAudit` from the caller when you need the manifest's
 * `global_audit_chain.merkle_root` to match a snapshot you've already
 * captured (e.g. the bytes you're about to write to `audit_log.jsonl`
 * in an export bundle). Without pinning, this function re-reads the
 * audit_log table; a concurrent append between the caller's read and
 * this read would silently put the bundled audit log out of sync with
 * the manifest's signed merkle_root. See exportBundle.ts for the
 * call-site that pins to close that TOCTOU window.
 */
export async function buildManifest(opts?: { pinned?: { allAudit: AuditLogEntry[] } }): Promise<Manifest> {
  const investigations = await query<Investigation>(
    "SELECT * FROM investigations ORDER BY created_at ASC",
  );
  const allAudit = opts?.pinned?.allAudit ?? await query<AuditLogEntry>(
    "SELECT * FROM audit_log ORDER BY seq ASC",
  );
  // verifyAuditChain hits the DB independently — a concurrent append
  // between allAudit and verifyAuditChain could disagree. Recompute
  // verification from the pinned snapshot when one was supplied, so
  // the manifest's verification claim, leaf list, and merkle_root all
  // derive from the same byte-for-byte set of rows.
  const verification = opts?.pinned?.allAudit
    ? await verifyAuditChainFromRows(opts.pinned.allAudit)
    : await verifyAuditChain();

  // Bulk-load all dossiers once. The per-case partitioning is cheap and
  // we want a single query because schema_v4 isn't guaranteed on older
  // installs — the try/catch below treats a missing table as "no
  // dossiers" so the manifest stays buildable.
  let allDossiers: ResearchDossierRow[] = [];
  try {
    allDossiers = await query<ResearchDossierRow>(
      "SELECT * FROM research_dossiers ORDER BY created_at ASC",
    );
  } catch {
    // Table doesn't exist on this DB — pre-v4 install. Manifest still
    // builds cleanly; no dossiers to anchor.
  }
  const dossiersByInvestigation = new Map<string, ResearchDossierRow[]>();
  const standaloneDossiers: ResearchDossierRow[] = [];
  for (const d of allDossiers) {
    if (d.investigation_id == null) {
      standaloneDossiers.push(d);
    } else {
      const list = dossiersByInvestigation.get(d.investigation_id) ?? [];
      list.push(d);
      dossiersByInvestigation.set(d.investigation_id, list);
    }
  }

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

    const dossiersForCase = dossiersByInvestigation.get(inv.id) ?? [];
    const dossierViews: ManifestDossierView[] = [];
    for (const d of dossiersForCase) dossierViews.push(await toDossierView(d));

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
      research_dossiers: dossierViews,
    });
  }

  const globalSummary = await buildAuditChainSummary(allAudit);

  const standaloneDossierViews: ManifestDossierView[] = [];
  for (const d of standaloneDossiers) standaloneDossierViews.push(await toDossierView(d));

  // Reviewer sign-offs (v6 schema). Same try/catch shape so the manifest
  // builds on pre-v6 installs.
  let reviewerRows: ReviewerSignoffRow[] = [];
  try {
    reviewerRows = await query<ReviewerSignoffRow>(
      "SELECT * FROM reviewer_signoffs ORDER BY signed_at DESC, created_at DESC",
    );
  } catch {
    /* pre-v6 install — no table yet */
  }
  const reviewerViews: ManifestReviewerView[] = [];
  for (const r of reviewerRows) {
    reviewerViews.push({
      id: r.id,
      reviewer_name: r.reviewer_name,
      discipline: r.discipline,
      signed_at: r.signed_at,
      app_version: r.app_version,
      statement_sha256: await sha256Hex(r.statement),
      affiliation: r.affiliation,
      identifier: r.identifier,
      source_url: r.source_url,
    });
  }

  return {
    schema: "southern-signal.manifest.v3",
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
    standalone_research_dossiers: standaloneDossierViews,
    reviewer_signoffs: reviewerViews,
  };
}
