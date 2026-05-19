/**
 * SessionSummaryCard — closes every session with a one-glance digest of
 * what just happened. Operator gets:
 *
 *   • Duration · peak posterior · final posterior
 *   • Top 5 moments by |log LR| (channel · time · plain reason)
 *   • Contamination tags applied
 *   • Disposition the operator just selected
 *   • Merkle-root anchor for the chain so the digest matches the export
 *   • Quick links to Review and the Evidence Brief
 *
 * Why: previously a session ended → DispositionPicker → silent return
 * to standby. Operators (especially streamers / amateurs) had no closure
 * artefact and no signal whether the session was worth reviewing. This
 * card is the closure.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { query } from "../lib/db/db";
import { buildManifest } from "../lib/forensic/manifest";
import { describeChannel, describeSector, plainEnglishReason } from "../lib/posterior/plainEnglish";
import { classifyPosterior } from "../lib/posterior/posterior";
import {
  computeAhtVerdict,
  computeH0Confidence,
  type AhtVerdictResult,
} from "../lib/posterior/ahtVerdict";
import s from "./SessionSummaryCard.module.css";

interface SessionSummaryCardProps {
  investigationId: string;
  sessionStartIso: string;
  sessionEndIso: string;
  peakPosterior: number;
  finalPosterior: number;
  onClose: () => void;
}

interface TopMoment {
  ts: string;
  channel: string;
  logLr: number;
  reason: string;
  sector: string | null;
  capped: boolean;
}

interface SessionStats {
  topMoments: TopMoment[];
  totalIncrements: number;
  contaminations: number;
  dispositionLabel: string | null;
  merkleRoot: string | null;
  ahtVerdict: AhtVerdictResult;
  h0Confidence: number;
  h0FromData: boolean;
  h0SampleCount: number;
}

const DISPOSITION_LABEL: Record<string, string> = {
  null: "Null · nothing happened",
  inconclusive: "Inconclusive · something, not enough",
  flagged: "Flagged · worth reviewing",
  confirmed_mundane: "Mundane · explained at the time",
};

function formatDuration(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = t % 60;
  if (hh > 0) return `${hh}h ${mm}m ${ss}s`;
  return `${mm}m ${ss}s`;
}

function formatTimeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function SessionSummaryCard(props: SessionSummaryCardProps) {
  const { investigationId, sessionStartIso, sessionEndIso, peakPosterior, finalPosterior, onClose } = props;
  const [stats, setStats] = useState<SessionStats | null>(null);

  useEffect(() => {
    void (async () => {
      // Pull all posterior increments inside the session window.
      const rows = await query<{ ts_utc: string; payload_json: string }>(
        `SELECT ts_utc, payload_json FROM audit_log
         WHERE actor = 'posterior' AND kind LIKE 'evidence.%'
           AND ts_utc >= ? AND ts_utc <= ?
         ORDER BY seq ASC`,
        [sessionStartIso, sessionEndIso],
      );

      const increments = rows.map((row) => {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        const metadata = (payload.metadata as Record<string, unknown> | undefined) ?? {};
        return {
          ts: row.ts_utc,
          channel: String(payload.channel ?? "unknown"),
          logLr: Number(payload.log_lr ?? 0),
          reason: String(payload.reason ?? ""),
          sector: typeof metadata.sector === "string" ? metadata.sector : null,
          capped: Boolean(payload.capped ?? false),
        } as TopMoment;
      });

      const topMoments = [...increments]
        .sort((a, b) => Math.abs(b.logLr) - Math.abs(a.logLr))
        .slice(0, 5);

      // Contamination markers logged inside the window.
      const contam = await query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM evidence_events
         WHERE investigation_id = ? AND event_type = 'contamination'
           AND timestamp >= ? AND timestamp <= ?`,
        [investigationId, sessionStartIso, sessionEndIso],
      );

      // Disposition lives on the investigations row, set by DispositionPicker.
      const inv = await query<{ disposition: string | null }>(
        "SELECT disposition FROM investigations WHERE id = ?",
        [investigationId],
      );
      const disposition = inv[0]?.disposition ?? null;

      // Best-effort Merkle root — UI is fine without it.
      let merkleRoot: string | null = null;
      try {
        const manifest = await buildManifest();
        merkleRoot = manifest.global_audit_chain.merkle_root;
      } catch { /* ignore */ }

      // H₀ — device-wide, from the most-recent 30 ai.debunk.proposed
      // entries that carry max_plausibility. Drives the AHT post-roll
      // verdict for THIS session (peak posterior is local; H₀ is the
      // operator's recent debunker reliability).
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

      setStats({
        topMoments,
        totalIncrements: increments.length,
        contaminations: contam[0]?.n ?? 0,
        dispositionLabel: disposition ? (DISPOSITION_LABEL[disposition] ?? disposition) : null,
        merkleRoot,
        ahtVerdict,
        h0Confidence: h0.value,
        h0FromData: h0.fromData,
        h0SampleCount: h0.n,
      });
    })();
  }, [investigationId, sessionStartIso, sessionEndIso, peakPosterior]);

  const durationSec = (new Date(sessionEndIso).getTime() - new Date(sessionStartIso).getTime()) / 1000;
  const peakBand = classifyPosterior(peakPosterior);
  const finalBand = classifyPosterior(finalPosterior);

  return (
    // role="region" — this is a digest card embedded in the page flow,
    // not a modal dialog. The previous role="dialog" misled screen readers
    // into announcing it as a focus-trapped overlay; it's actually just
    // a labelled section. aria-live="polite" stays so a new session digest
    // announces itself when it appears after stop.
    <div className={s.wrap} role="region" aria-label="Session summary" aria-live="polite">
      <header className={s.head}>
        <span className={s.eyebrow}>SESSION DIGEST</span>
        <h2 className={s.title}>How that session went</h2>
        {stats?.dispositionLabel && (
          <div className={s.dispositionPill}>{stats.dispositionLabel}</div>
        )}
      </header>

      <div className={s.metrics}>
        <div className={s.metric}>
          <span className={s.metricLabel}>Duration</span>
          <span className={s.metricValue}>{formatDuration(durationSec)}</span>
        </div>
        <div className={s.metric}>
          <span className={s.metricLabel}>Peak score</span>
          <span className={`${s.metricValue} ${s[`band_${peakBand}`]}`.trim()}>
            {(peakPosterior * 100).toFixed(0)}%
          </span>
        </div>
        <div className={s.metric}>
          <span className={s.metricLabel}>At session end</span>
          <span className={`${s.metricValue} ${s[`band_${finalBand}`]}`.trim()}>
            {(finalPosterior * 100).toFixed(0)}%
          </span>
        </div>
      </div>

      {/* AHT POST-ROLL VERDICT — the conclusion, computed from H₀ + peak. */}
      {stats && (
        <div className={`${s.verdict} ${s[`verdict_${stats.ahtVerdict.verdict}`]}`.trim()}>
          <div className={s.verdictHead}>
            <span className={s.verdictEyebrow}>POST-ROLL VERDICT</span>
            <span className={s.verdictLabel}>{stats.ahtVerdict.label}</span>
          </div>
          <p className={s.verdictDetail}>{stats.ahtVerdict.detail}</p>
          <p className={s.verdictMeta}>
            H₀ {stats.h0Confidence.toFixed(2)}
            {stats.h0FromData ? ` (n=${stats.h0SampleCount})` : " (default)"}
            {" · "}peak {(peakPosterior * 100).toFixed(0)}%
          </p>
        </div>
      )}

      <div className={s.section}>
        <header className={s.sectionHead}>
          <span className={s.sectionEyebrow}>TOP MOMENTS</span>
          <span className={s.sectionNote}>
            {stats == null
              ? "Loading…"
              : `${stats.totalIncrements} evidence increment${stats.totalIncrements === 1 ? "" : "s"} · ${stats.contaminations} interference tag${stats.contaminations === 1 ? "" : "s"}`}
          </span>
        </header>
        {stats == null ? (
          <p className={s.empty}>Loading the audit chain…</p>
        ) : stats.topMoments.length === 0 ? (
          <p className={s.empty}>No anomalies above noise this session — quiet room is honest data too.</p>
        ) : (
          <ol className={s.list}>
            {stats.topMoments.map((m, i) => {
              const ch = describeChannel(m.channel);
              const sectorPart = describeSector(m.sector);
              return (
                <li key={`${m.ts}-${i}`} className={s.row}>
                  <span className={s.rowEmoji}>{ch.emoji}</span>
                  <div className={s.rowBody}>
                    <span className={s.rowKind}>
                      {ch.label}
                      {sectorPart ? ` · ${sectorPart}` : ""}
                    </span>
                    <span className={s.rowReason}>{plainEnglishReason(m.reason)}</span>
                  </div>
                  <span className={s.rowMeta}>
                    <span className={`${s.rowLr} ${m.logLr >= 0 ? s.rowLrPos : s.rowLrNeg}`.trim()}>
                      {m.logLr >= 0 ? "+" : ""}{m.logLr.toFixed(2)}
                      {m.capped ? "*" : ""}
                    </span>
                    <span className={s.rowTs}>{formatTimeOfDay(m.ts)}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {stats?.merkleRoot && (
        <p className={s.chain}>
          <strong>Chain anchored.</strong>{" "}
          Merkle root <code>{stats.merkleRoot.slice(0, 12)}…{stats.merkleRoot.slice(-8)}</code> — the export bundle will hash to this.
        </p>
      )}

      <div className={s.actions}>
        <Link to="/review" className={s.actionPrimary}>Open Review →</Link>
        <button type="button" className={s.actionSecondary} onClick={onClose}>Done</button>
      </div>
    </div>
  );
}
