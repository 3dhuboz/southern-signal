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
import type { Investigation } from "../db/schema";
import { classifyPosterior, type PosteriorBand } from "../posterior/posterior";

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
  };
}

export async function findMostRecentInvestigationId(): Promise<string | null> {
  const rows = await query<{ id: string }>(
    "SELECT id FROM investigations ORDER BY started_at DESC, created_at DESC LIMIT 1",
  );
  return rows[0]?.id ?? null;
}
