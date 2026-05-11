/**
 * ResearchSnapshot — compact "we already know X about this venue" card
 * for SimpleMissionView (and anywhere else that has a case context).
 *
 * Self-contained: fetches the latest dossier for the supplied case (or
 * a matching standalone pre-visit recon dossier whose venue_name
 * matches the case title / location), surfaces the top primary-source
 * finding, and links to /research for the full read.
 *
 * Renders null when there's nothing to show — no case, no dossier,
 * no findings. That way the parent can drop it in unconditionally.
 *
 * Caches the lookup against (investigationId + reloadToken). The
 * reloadToken prop lets callers force a refresh after they know a new
 * dossier was saved or one was deleted.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { query } from "../lib/db/db";
import type { ResearchDossierRow } from "../lib/db/schema";
import type { ResearchResult } from "../lib/research/api";
import { ageLabel, pickHeadline } from "./researchSnapshotHelpers";
import s from "./ResearchSnapshot.module.css";

interface ResearchSnapshotProps {
  investigationId: string | null;
  caseTitle: string | null;
  caseLocationName: string | null;
  /** Bumping this forces a refetch even when the investigation id is
   *  stable. Useful when the parent knows a save / delete just happened
   *  and the snapshot should re-resolve. Optional. */
  reloadToken?: number;
}

interface Snapshot {
  dossierId: string;
  venueName: string;
  region: string;
  createdAt: string;
  findingCount: number;
  citationCount: number;
  headline: { tier: string; title: string; sources: number } | null;
}

const TIER_LABEL: Record<string, string> = {
  CULTURAL_SIGNIFICANCE: "Cultural significance",
  HERITAGE: "Heritage",
  DOCUMENTED_INCIDENT: "Documented incident",
  FOLKLORE: "Folklore",
  SYNTHESIS: "Synthesis",
};

const TIER_TONE: Record<string, string> = {
  CULTURAL_SIGNIFICANCE: "warning",
  HERITAGE: "signal",
  DOCUMENTED_INCIDENT: "signal",
  FOLKLORE: "neutral",
  SYNTHESIS: "muted",
};

export function ResearchSnapshot({ investigationId, caseTitle, caseLocationName, reloadToken }: ResearchSnapshotProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Pull dossiers either attached to this case OR standalone with a
        // matching venue name — the same logic the Evidence Brief uses,
        // so the snapshot reflects what the brief will eventually print.
        let rows: ResearchDossierRow[];
        if (investigationId) {
          rows = await query<ResearchDossierRow>(
            `SELECT * FROM research_dossiers
             WHERE investigation_id = ?
                OR (investigation_id IS NULL
                    AND (LOWER(venue_name) = LOWER(?) OR LOWER(venue_name) = LOWER(?)))
             ORDER BY created_at DESC
             LIMIT 5`,
            [investigationId, caseTitle ?? "", caseLocationName ?? ""],
          );
        } else {
          // No active case — fall back to standalone dossiers (recon).
          rows = await query<ResearchDossierRow>(
            `SELECT * FROM research_dossiers WHERE investigation_id IS NULL ORDER BY created_at DESC LIMIT 5`,
          );
        }
        if (cancelled) return;
        if (rows.length === 0) {
          setSnapshot(null);
          setCount(0);
          return;
        }
        const newest = rows[0];
        try {
          const parsed = JSON.parse(newest.result_json) as ResearchResult;
          const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
          const citationCount = findings.reduce((n, f) => n + (Array.isArray(f.sources) ? f.sources.length : 0), 0);
          setSnapshot({
            dossierId: newest.id,
            venueName: newest.venue_name,
            region: newest.region,
            createdAt: newest.created_at,
            findingCount: findings.length,
            citationCount,
            headline: pickHeadline(findings),
          });
          setCount(rows.length);
        } catch {
          // Malformed payload — still surface that something exists so
          // the operator knows to visit /research.
          setSnapshot({
            dossierId: newest.id,
            venueName: newest.venue_name,
            region: newest.region,
            createdAt: newest.created_at,
            findingCount: 0,
            citationCount: 0,
            headline: null,
          });
          setCount(rows.length);
        }
      } catch (err) {
        if (cancelled) return;
        // research_dossiers table missing (pre-v4 install) — render
        // nothing rather than warn the operator.
        console.debug("[research-snapshot] lookup failed (likely pre-v4 schema)", err);
        setSnapshot(null);
        setCount(0);
      }
    })();
    return () => { cancelled = true; };
  }, [investigationId, caseTitle, caseLocationName, reloadToken]);

  if (!snapshot) return null;

  const tone = snapshot.headline ? (TIER_TONE[snapshot.headline.tier] ?? "neutral") : "neutral";

  return (
    <div className={`${s.wrap} ${s[`tone_${tone}`]}`.trim()}>
      <div className={s.head}>
        <span className={s.eyebrow}>SAVED RESEARCH</span>
        <span className={s.meta}>
          {snapshot.findingCount} finding{snapshot.findingCount === 1 ? "" : "s"} · {snapshot.citationCount} citation{snapshot.citationCount === 1 ? "" : "s"} · {ageLabel(snapshot.createdAt)}
          {count > 1 && ` · ${count} total`}
        </span>
      </div>
      <div className={s.body}>
        {snapshot.headline ? (
          <>
            <span className={`${s.tier} ${s[`tier_${tone}`]}`.trim()}>{TIER_LABEL[snapshot.headline.tier] ?? snapshot.headline.tier}</span>
            <span className={s.headline}>{snapshot.headline.title}</span>
          </>
        ) : (
          <span className={s.headline}>No findings recorded — the venue had no archival footprint.</span>
        )}
      </div>
      <Link to="/research" className={s.openLink}>Open full dossier →</Link>
    </div>
  );
}
