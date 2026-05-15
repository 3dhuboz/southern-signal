/**
 * Evidence Brief — assembles the data backing a printable one-page case
 * summary. Pure data layer; the view (EvidenceBrief.tsx) handles render.
 *
 * Sources:
 *   • investigations row (title, location, dates, disposition, sensitivity)
 *   • audit_log evidence.* entries scoped to this investigation
 *     (posterior increments — top 5 by |log_lr|, peak posterior across run)
 *   • evidence_events for marker/contamination/observation counts
 *   • media_assets for asset counts by type
 *   • verifyAuditChain() for chain status
 *   • buildManifest() for Merkle root anchor
 *   • preferences.acknowledgementOfCountry for the brief's footer
 */

import { query } from "../db/db";
import { verifyAuditChain } from "../db/auditLog";
import { getPreferences } from "../preferences";
import { buildManifest } from "./manifest";
import type { Investigation, InterviewRow, ResearchDossierRow, ResearchFindingNoteRow } from "../db/schema";
import { classifyPosterior, type PosteriorBand } from "../posterior/posterior";
import { computeAhtVerdict, computeH0Confidence, type AhtVerdictResult } from "../posterior/ahtVerdict";
import { findingKeyFor } from "../db/repo";
import type { ResearchFinding, ResearchResult, ResearchTier } from "../research/api";

export interface BriefMoment {
  ts: string;
  channel: string;
  logLr: number;
  reason: string;
  sector: string | null;
  capped: boolean;
  posteriorBefore: number;
  posteriorAfter: number;
}

/**
 * A single research dossier as it appears in the brief — already
 * tier-grouped so the renderer doesn't have to think about ordering.
 * The full ResearchResult is preserved on `raw` for callers that want
 * the suggestions / warnings / search-terms metadata.
 */
/**
 * A finding as it appears in the brief — extends the raw model output
 * with the reviewer's note (if any). `findingKey` is the SHA-256 prefix
 * the note is anchored to, exposed so a reviewer-side verifier can
 * confirm the note attached to *this* finding text and not some
 * neighbour.
 */
export interface BriefResearchFinding extends ResearchFinding {
  findingKey: string;
  reviewerNote: { text: string; updatedAt: string } | null;
}

export interface BriefResearchDossier {
  id: string;
  venueName: string;
  locationHint: string | null;
  region: string;
  createdAt: string;
  model: string;
  findingsByTier: { tier: ResearchTier; findings: BriefResearchFinding[] }[];
  /** Total findings across all tiers — convenient for tally rendering. */
  findingCount: number;
  /** Total distinct source citations across the dossier. */
  citationCount: number;
  /** Total reviewer notes attached across all findings. */
  reviewerNoteCount: number;
  /** True iff at least one finding sits in a tier with primary-source
   *  weight (HERITAGE or DOCUMENTED_INCIDENT). Drives the "cited
   *  primary-source corroboration" header on the brief. */
  hasPrimarySources: boolean;
  raw: ResearchResult;
}

/** A witness interview as it appears in the brief — linked event titles are
 *  resolved from the evidence_events table for readability. */
export interface BriefInterview {
  id: string;
  witnessName: string;
  relationship: string | null;
  statement: string;
  notableClaims: string | null;
  occurredAt: string | null;
  linkedEventIds: string[];
}

export interface EvidenceBrief {
  generatedAt: string;
  investigation: Investigation;
  durationSeconds: number | null;
  topMoments: BriefMoment[];
  totalIncrements: number;
  peakPosterior: number;
  peakPosteriorBand: PosteriorBand;
  finalPosterior: number;
  contaminationCount: number;
  markerCount: number;
  observationCount: number;
  mediaByType: { audio: number; image: number; video: number };
  chainStatus: { ok: true } | { ok: false; brokenAtSeq: number; reason: string };
  merkleRoot: string | null;
  acknowledgementStatement: string | null;
  acknowledgementAcceptedAt: string | null;
  culturallySensitive: boolean;
  /** H₀ "AI insufficiency" confidence (device-wide, from recent debunk requests). */
  h0Confidence: number;
  /** True when h0Confidence came from real debunk data; false = the 0.18 fallback. */
  h0FromData: boolean;
  /** Number of debunk requests that contributed to h0Confidence. */
  h0SampleCount: number;
  /** The AHT post-roll verdict, derived from h0Confidence + peakPosterior. */
  ahtVerdict: AhtVerdictResult;
  /** Saved AI-Investigator dossiers scoped to this case (newest first).
   *  Empty when the operator hasn't run the deep-dive for this venue. */
  researchDossiers: BriefResearchDossier[];
  /** Section 2: witness interviews (v8). Empty on pre-v8 schema. */
  interviews: BriefInterview[];
}

const TIER_DISPLAY_ORDER: ResearchTier[] = [
  "CULTURAL_SIGNIFICANCE",
  "HERITAGE",
  "DOCUMENTED_INCIDENT",
  "FOLKLORE",
  "SYNTHESIS",
];

/** Parse a stored ResearchResult JSON safely, returning null on malformed
 *  payloads. Defends against schema drift between dossier versions. */
function parseDossierResult(json: string): ResearchResult | null {
  try {
    const parsed = JSON.parse(json) as ResearchResult;
    if (!Array.isArray(parsed.findings)) return null;
    return parsed;
  } catch { return null; }
}

function groupFindingsByTier(findings: BriefResearchFinding[]): { tier: ResearchTier; findings: BriefResearchFinding[] }[] {
  const buckets = new Map<ResearchTier, BriefResearchFinding[]>();
  for (const f of findings) {
    const list = buckets.get(f.tier) ?? [];
    list.push(f);
    buckets.set(f.tier, list);
  }
  const out: { tier: ResearchTier; findings: BriefResearchFinding[] }[] = [];
  for (const tier of TIER_DISPLAY_ORDER) {
    const list = buckets.get(tier);
    if (list && list.length > 0) out.push({ tier, findings: list });
  }
  return out;
}

async function toBriefDossier(row: ResearchDossierRow, notes: ResearchFindingNoteRow[]): Promise<BriefResearchDossier | null> {
  const parsed = parseDossierResult(row.result_json);
  if (!parsed) return null;
  const noteByKey = new Map<string, ResearchFindingNoteRow>();
  for (const n of notes) noteByKey.set(n.finding_key, n);

  // Compute the finding_key for each finding so we can look up notes.
  // Same hash the UI uses on save — content-anchored, not index-anchored.
  const annotatedFindings: BriefResearchFinding[] = [];
  for (const f of parsed.findings) {
    const findingKey = await findingKeyFor(f);
    const note = noteByKey.get(findingKey);
    annotatedFindings.push({
      ...f,
      findingKey,
      reviewerNote: note ? { text: note.text, updatedAt: note.updated_at } : null,
    });
  }

  const findingsByTier = groupFindingsByTier(annotatedFindings);
  const hasPrimarySources = findingsByTier.some((g) => g.tier === "HERITAGE" || g.tier === "DOCUMENTED_INCIDENT");
  const citationCount = parsed.findings.reduce((n, f) => n + (Array.isArray(f.sources) ? f.sources.length : 0), 0);
  const reviewerNoteCount = annotatedFindings.reduce((n, f) => n + (f.reviewerNote ? 1 : 0), 0);
  return {
    id: row.id,
    venueName: row.venue_name,
    locationHint: row.location_hint,
    region: row.region,
    createdAt: row.created_at,
    model: row.model,
    findingsByTier,
    findingCount: parsed.findings.length,
    citationCount,
    reviewerNoteCount,
    hasPrimarySources,
    raw: parsed,
  };
}

export async function buildEvidenceBrief(investigationId: string): Promise<EvidenceBrief | null> {
  const invRows = await query<Investigation>(
    "SELECT * FROM investigations WHERE id = ? LIMIT 1",
    [investigationId],
  );
  const investigation = invRows[0];
  if (!investigation) return null;

  const startIso = investigation.started_at ?? investigation.created_at;
  const endIso = investigation.ended_at ?? new Date().toISOString();
  const durationSeconds = investigation.started_at && investigation.ended_at
    ? (new Date(investigation.ended_at).getTime() - new Date(investigation.started_at).getTime()) / 1000
    : null;

  // Posterior increments scoped to this investigation. We anchor to the
  // session window, but if started_at/ended_at aren't set yet (rare —
  // mostly during first-run race conditions), fall back to all evidence.*
  // entries since the investigation row was created.
  const incrementRows = await query<{ ts_utc: string; payload_json: string }>(
    `SELECT ts_utc, payload_json FROM audit_log
     WHERE actor = 'posterior' AND kind LIKE 'evidence.%'
       AND ts_utc >= ? AND ts_utc <= ?
     ORDER BY seq ASC`,
    [startIso, endIso],
  );

  const moments: BriefMoment[] = incrementRows.map((row) => {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const metadata = (payload.metadata as Record<string, unknown> | undefined) ?? {};
    return {
      ts: row.ts_utc,
      channel: String(payload.channel ?? "unknown"),
      logLr: Number(payload.log_lr ?? 0),
      reason: String(payload.reason ?? ""),
      sector: typeof metadata.sector === "string" ? metadata.sector : null,
      capped: Boolean(payload.capped ?? false),
      posteriorBefore: Number(payload.posterior_before ?? 0),
      posteriorAfter: Number(payload.posterior_after ?? 0),
    };
  });

  const peakPosterior = moments.reduce((peak, m) => Math.max(peak, m.posteriorAfter), 0);
  const finalPosterior = moments.length > 0 ? moments[moments.length - 1].posteriorAfter : 0;

  const topMoments = [...moments]
    .sort((a, b) => Math.abs(b.logLr) - Math.abs(a.logLr))
    .slice(0, 5);

  // Event tallies.
  const eventRows = await query<{ event_type: string; n: number }>(
    `SELECT event_type, COUNT(*) AS n FROM evidence_events
     WHERE investigation_id = ?
     GROUP BY event_type`,
    [investigationId],
  );
  const evMap = Object.fromEntries(eventRows.map((r) => [r.event_type, r.n] as const));
  const contaminationCount = evMap["contamination"] ?? 0;
  const markerCount = evMap["marker"] ?? 0;
  const observationCount = evMap["observation"] ?? 0;

  // Media tallies.
  const mediaRows = await query<{ media_type: string; n: number }>(
    `SELECT media_type, COUNT(*) AS n FROM media_assets
     WHERE investigation_id = ?
     GROUP BY media_type`,
    [investigationId],
  );
  const mediaMap = Object.fromEntries(mediaRows.map((r) => [r.media_type, r.n] as const));
  const mediaByType = {
    audio: mediaMap["audio"] ?? 0,
    image: mediaMap["image"] ?? 0,
    video: mediaMap["video"] ?? 0,
  };

  // H₀ — device-wide, from the most-recent 30 debunk requests that carry
  // a max_plausibility. Drives the AHT post-roll verdict below.
  const debunkRows = await query<{ payload_json: string }>(
    `SELECT payload_json FROM audit_log
     WHERE kind = 'ai.debunk.proposed'
     ORDER BY seq DESC
     LIMIT 30`,
  );
  const maxPlausibilities = debunkRows
    .map((r) => {
      try {
        const p = JSON.parse(r.payload_json) as Record<string, unknown>;
        return typeof p.max_plausibility === "number" ? p.max_plausibility : null;
      } catch { return null; }
    })
    .filter((p): p is number => p !== null);
  const h0 = computeH0Confidence(maxPlausibilities);
  const ahtVerdict = computeAhtVerdict({ h0Confidence: h0.value, peakPosterior });

  // v4: research dossiers saved against this investigation, newest first.
  // We also include standalone dossiers (investigation_id NULL) whose
  // venue_name matches the case's title or location_name — those were
  // typically pre-visit recon for this very case.
  const dossierRows = await query<ResearchDossierRow>(
    `SELECT * FROM research_dossiers
     WHERE investigation_id = ?
        OR (investigation_id IS NULL
            AND (LOWER(venue_name) = LOWER(?) OR LOWER(venue_name) = LOWER(?)))
     ORDER BY created_at DESC
     LIMIT 10`,
    [investigationId, investigation.title ?? "", investigation.location_name ?? ""],
  );
  // Bulk-load notes for all dossiers we're about to render. Wrapped
  // in try/catch — pre-v5 schemas don't have the table.
  const dossierIds = dossierRows.map((d) => d.id);
  let noteRows: ResearchFindingNoteRow[] = [];
  if (dossierIds.length > 0) {
    try {
      const placeholders = dossierIds.map(() => "?").join(",");
      noteRows = await query<ResearchFindingNoteRow>(
        `SELECT * FROM research_finding_notes WHERE dossier_id IN (${placeholders})`,
        dossierIds,
      );
    } catch { /* pre-v5 schema — no notes */ }
  }
  const notesByDossierId = new Map<string, ResearchFindingNoteRow[]>();
  for (const n of noteRows) {
    const list = notesByDossierId.get(n.dossier_id) ?? [];
    list.push(n);
    notesByDossierId.set(n.dossier_id, list);
  }

  const researchDossiers: BriefResearchDossier[] = [];
  for (const row of dossierRows) {
    const d = await toBriefDossier(row, notesByDossierId.get(row.id) ?? []);
    if (d) researchDossiers.push(d);
  }

  // v8: witness interviews — Section 2 of the brief.
  let interviews: BriefInterview[] = [];
  try {
    const interviewRows = await query<InterviewRow>(
      "SELECT * FROM interviews WHERE investigation_id = ? ORDER BY occurred_at ASC, created_at ASC",
      [investigationId],
    );
    interviews = interviewRows.map((r) => {
      let linkedEventIds: string[] = [];
      if (r.linked_event_ids) {
        try { linkedEventIds = JSON.parse(r.linked_event_ids); } catch { /* ignore */ }
      }
      return {
        id: r.id,
        witnessName: r.witness_name,
        relationship: r.relationship,
        statement: r.statement,
        notableClaims: r.notable_claims,
        occurredAt: r.occurred_at,
        linkedEventIds,
      };
    });
  } catch { /* pre-v8 schema — no interviews table yet */ }

  // Chain + manifest are best-effort.
  const chainStatus = await verifyAuditChain();
  let merkleRoot: string | null = null;
  try {
    const manifest = await buildManifest();
    merkleRoot = manifest.global_audit_chain.merkle_root;
  } catch { /* ignore */ }

  const prefs = getPreferences();

  return {
    generatedAt: new Date().toISOString(),
    investigation,
    durationSeconds,
    topMoments,
    totalIncrements: moments.length,
    peakPosterior,
    peakPosteriorBand: classifyPosterior(peakPosterior),
    finalPosterior,
    contaminationCount,
    markerCount,
    observationCount,
    mediaByType,
    chainStatus,
    merkleRoot,
    acknowledgementStatement: prefs.acknowledgementOfCountry.statement,
    acknowledgementAcceptedAt: prefs.acknowledgementOfCountry.acceptedAt,
    culturallySensitive: investigation.culturally_sensitive === 1,
    h0Confidence: h0.value,
    h0FromData: h0.fromData,
    h0SampleCount: h0.n,
    ahtVerdict,
    researchDossiers,
    interviews,
  };
}

export async function findMostRecentInvestigationId(): Promise<string | null> {
  const rows = await query<{ id: string }>(
    "SELECT id FROM investigations ORDER BY started_at DESC, created_at DESC LIMIT 1",
  );
  return rows[0]?.id ?? null;
}
