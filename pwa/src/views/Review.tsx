import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AHT_H0_SUSPEND_THRESHOLD, computeH0Confidence } from "../lib/posterior/ahtVerdict";
import { buildEvidenceBrief, findMostRecentInvestigationId, type EvidenceBrief } from "../lib/forensic/evidenceBrief";
import { NullRateDashboard } from "../components/NullRateDashboard";
import { CaseManager } from "../components/CaseManager";
import { InterviewsList } from "../components/InterviewsList";
import { query } from "../lib/db/db";
import { verifyAuditChain, appendAuditEntry } from "../lib/db/auditLog";
import { buildManifest } from "../lib/forensic/manifest";
import { buildExportBundle, downloadBlob } from "../lib/forensic/exportBundle";
import { usePreferences } from "../lib/preferences";
import { getScene } from "../lib/overlays/scenes";
import s from "./View.module.css";
import r from "./Review.module.css";

function plainEnglishChannel(channel: string): string {
  switch (channel.toLowerCase()) {
    case "acoustic": return "Sound";
    case "magnetometer": return "Magnetic field";
    case "motion": return "Movement";
    case "light": return "Light";
    case "temperature": return "Temperature";
    case "contamination": return "Possible interference";
    case "evp": return "Voice recording";
    case "spirit_box": return "Spirit box";
    default: return channel.replace(/_/g, " ");
  }
}

function plainEnglishMove(before: number, after: number): { label: string; tone: "up" | "down" | "flat" } {
  const delta = after - before;
  const absDelta = Math.abs(delta);
  if (absDelta < 0.005) return { label: "no real change", tone: "flat" };
  const dir = delta > 0 ? "up" : "down";
  if (absDelta < 0.05) return { label: `score ticked ${dir} a touch`, tone: dir };
  if (absDelta < 0.20) return { label: `score moved ${dir} noticeably`, tone: dir };
  return { label: `score jumped ${dir} sharply`, tone: dir };
}

interface AuditEntry {
  seq: number;
  ts_utc: string;
  actor: string;
  kind: string;
  payload_json: string;
  prev_hash: string;
  entry_hash: string;
}

interface PosteriorRow {
  seq: number;
  ts_utc: string;
  channel: string;
  log_lr: number;
  posterior_before: number;
  posterior_after: number;
  reason: string;
  capped: boolean;
}

interface MarkerRow {
  id: string;
  timestamp: string;
  investigation_id: string;
  title: string | null;
  description: string | null;
  metadata_json: string | null;
}

interface MarkerView {
  id: string;
  timestamp: string;
  title: string;
  elapsedLabel: string | null;
  sceneId: string | null;
}

interface DeviceSampleRow {
  timestamp: string;
  sensor_type: string;
  value: number | null;
}

interface DeviceTimeline {
  /** Each entry pairs a numeric value with its ISO timestamp so marker
   *  positions can be derived against the same time axis the sparkline
   *  uses — otherwise battery samples and markers would drift apart. */
  battery: { value: number; ts: string }[];
  storageMb: { value: number; ts: string }[];
  /** Earliest sample timestamp, for the rangelabel. */
  startTs: string | null;
  endTs: string | null;
}

function formatMarkerElapsed(meta: string | null): string | null {
  if (!meta) return null;
  try {
    const parsed = JSON.parse(meta) as { sessionElapsedSec?: unknown };
    const sec = parsed.sessionElapsedSec;
    if (typeof sec !== "number" || !Number.isFinite(sec)) return null;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec) % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  } catch { return null; }
}

export function Review() {
  const [prefs] = usePreferences();
  const isPro = prefs.experienceMode === "pro";
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [chainStatus, setChainStatus] = useState<"checking" | "ok" | "broken">("checking");
  const [chainBrokenSeq, setChainBrokenSeq] = useState<number | null>(null);
  const [merkleRoot, setMerkleRoot] = useState<string | null>(null);
  const [latestBrief, setLatestBrief] = useState<EvidenceBrief | null>(null);
  const [markers, setMarkers] = useState<MarkerView[]>([]);
  const [timeline, setTimeline] = useState<DeviceTimeline | null>(null);

  useEffect(() => {
    void (async () => {
      const rows = await query<AuditEntry>("SELECT * FROM audit_log ORDER BY seq DESC LIMIT 200");
      setEntries(rows);
      const verification = await verifyAuditChain();
      if (verification.ok) {
        setChainStatus("ok");
      } else {
        setChainStatus("broken");
        setChainBrokenSeq(verification.brokenAtSeq);
      }
      try {
        const manifest = await buildManifest();
        setMerkleRoot(manifest.global_audit_chain.merkle_root);
      } catch { /* manifest is best-effort in the banner */ }
      // Build the brief for the most-recent investigation so we can show its
      // AHT verdict inline — saves the operator a trip to the print view.
      try {
        const recentId = await findMostRecentInvestigationId();
        if (recentId) setLatestBrief(await buildEvidenceBrief(recentId));
        // Load moment markers for the most-recent investigation. Markers
        // ride in the evidence_events table (event_type='marker'); the
        // audit log carries the hash chain but not the metadata we need
        // to render elapsed-time + scene id at review time.
        if (recentId) {
          // Watchdog-sourced battery + storage samples — written every minute
          // while running. Pull both series in one query, then split client-
          // side so the chart renders the device-state decay alongside the
          // markers without two round-trips.
          const deviceRows = await query<DeviceSampleRow>(
            "SELECT timestamp, sensor_type, value FROM sensor_samples WHERE investigation_id = ? AND sensor_type IN ('battery', 'storage_free') ORDER BY timestamp ASC",
            [recentId],
          );
          if (deviceRows.length > 0) {
            const battery: { value: number; ts: string }[] = [];
            const storageMb: { value: number; ts: string }[] = [];
            for (const r of deviceRows) {
              if (r.value == null) continue;
              if (r.sensor_type === "battery") battery.push({ value: r.value, ts: r.timestamp });
              else if (r.sensor_type === "storage_free") storageMb.push({ value: r.value / (1024 * 1024), ts: r.timestamp });
            }
            setTimeline({
              battery,
              storageMb,
              startTs: deviceRows[0]?.timestamp ?? null,
              endTs: deviceRows[deviceRows.length - 1]?.timestamp ?? null,
            });
          }
          const rows = await query<MarkerRow>(
            "SELECT id, timestamp, investigation_id, title, description, metadata_json FROM evidence_events WHERE investigation_id = ? AND event_type = 'marker' ORDER BY timestamp DESC LIMIT 200",
            [recentId],
          );
          setMarkers(rows.map((row) => {
            let sceneId: string | null = null;
            if (row.metadata_json) {
              try {
                const parsed = JSON.parse(row.metadata_json) as { sceneId?: unknown };
                if (typeof parsed.sceneId === "string") sceneId = parsed.sceneId;
              } catch { /* ignore */ }
            }
            return {
              id: row.id,
              timestamp: row.timestamp,
              title: row.title ?? "Moment marked",
              elapsedLabel: formatMarkerElapsed(row.metadata_json),
              sceneId,
            };
          }));
        }
      } catch { /* verdict card just won't render */ }
    })();
  }, []);

  const posteriorRows: PosteriorRow[] = entries
    .filter((e) => e.kind.startsWith("evidence."))
    .map((e) => {
      const payload = JSON.parse(e.payload_json) as Record<string, unknown>;
      return {
        seq: e.seq,
        ts_utc: e.ts_utc,
        channel: String(payload.channel ?? ""),
        log_lr: Number(payload.log_lr ?? 0),
        posterior_before: Number(payload.posterior_before ?? 0),
        posterior_after: Number(payload.posterior_after ?? 0),
        reason: String(payload.reason ?? ""),
        capped: Boolean(payload.capped ?? false),
      };
    });

  // H₀ — AI insufficiency. Computed from the 30 most-recent
  // `ai.debunk.proposed` audit entries carrying max_plausibility, via the
  // shared helper. When H₀ ≥ the suspend threshold the AHT post-roll engine
  // SUSPENDS — every case renders INCONCLUSIVE instead of a positive verdict.
  const debunkAttempts = entries
    .filter((e) => e.kind === "ai.debunk.proposed")
    .map((e) => {
      try {
        const p = JSON.parse(e.payload_json) as Record<string, unknown>;
        return typeof p.max_plausibility === "number" ? p.max_plausibility : null;
      } catch { return null; }
    })
    .filter((p): p is number => p !== null && Number.isFinite(p))
    .slice(0, 30); // entries are ordered DESC so this is the 30 most recent
  const h0 = computeH0Confidence(debunkAttempts);
  const h0Confidence = h0.value;
  const h0Pct = Math.round(h0Confidence * 100);
  const h0Computed = h0.fromData;
  const h0Useful = h0Confidence < AHT_H0_SUSPEND_THRESHOLD;
  const postRollSuspended = h0Confidence >= AHT_H0_SUSPEND_THRESHOLD;

  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const handleExport = useCallback(async () => {
    const all = await query<AuditEntry>("SELECT * FROM audit_log ORDER BY seq ASC");
    const manifest = await buildManifest();
    const exportPayload = {
      schema: "southern-signal.export.v1",
      generated_at: new Date().toISOString(),
      app_version: "0.1.0",
      manifest,
      entries: all,
    };
    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `southern-signal-bundle-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const handleExportZip = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    setExportStatus("Building bundle…");
    try {
      const { blob, summary } = await buildExportBundle();
      downloadBlob(blob, summary.filename);
      const sizeMb = (summary.byteLength / 1024 / 1024).toFixed(1);
      setExportStatus(`Bundle exported · ${sizeMb} MB · ${summary.investigationIds.length} cases · ${summary.mediaIncluded} media${summary.mediaMissing ? ` (${summary.mediaMissing} missing)` : ""}`);
      await appendAuditEntry({
        actor: "user",
        kind: "bundle.export",
        payload: { scope: "all", bytes: summary.byteLength, cases: summary.investigationIds.length, media_included: summary.mediaIncluded, media_missing: summary.mediaMissing },
      }).catch(() => { /* ignore */ });
    } catch (err) {
      setExportStatus(`Bundle failed: ${(err as Error).message}`);
    } finally {
      setExporting(false);
    }
  }, [exporting]);

  return (
    <section className={s.view}>
      <div className={s.titleBlock}>
        <span className={s.eyebrow}>{isPro ? "Review · Post-roll" : "Review"}</span>
        <h1 className={s.title}>{isPro ? "All cases · all data" : "Your cases"}</h1>
        <p className={s.lede}>
          {isPro
            ? "Every investigation, every session, every captured image / audio / video clip, every posterior increment, every audit-chain entry. Edit, export, or download from here. Setup mirrors the case manager so you can manage from either screen."
            : "Look back over your investigations. Browse the recordings, change a case's verdict, or download a tamper-proof bundle to share with a reviewer. Switch to Pro mode in Setup if you want the math behind the scores."}
        </p>
      </div>

      {/* CASE MANAGER — every investigation with media browser, edit, download, delete */}
      <CaseManager />

      {/* Chain status banner. Fresh device (0 entries) gets honest copy
          rather than "✓ verified" — there's nothing to verify yet, and
          claiming verification on an empty chain is a small lie. */}
      <div className={`${r.chainStatus} ${r[chainStatus]}`.trim()}>
        {chainStatus === "checking" && (isPro ? "Verifying audit chain…" : "Checking the record…")}
        {chainStatus === "ok" && entries.length === 0 && (
          <>
            {/* Schematic empty-chain illustration: a short Merkle / hash-chain
                fragment of three rounded blocks linked by solid connectors,
                trailing off into dotted segments that fade — reads as "no
                links recorded yet" without any literal text. Pure currentColor,
                same line-based idiom as the OnboardingTour cue glyphs and the
                logo-mark. Decorative; the banner copy carries the meaning. */}
            <svg
              viewBox="0 0 160 56"
              className={r.emptyArt}
              aria-hidden="true"
              xmlns="http://www.w3.org/2000/svg"
            >
              {/* Three present "hash blocks" — rounded rects */}
              <g fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.85">
                <rect x="8"  y="18" width="22" height="20" rx="3" />
                <rect x="42" y="18" width="22" height="20" rx="3" />
                <rect x="76" y="18" width="22" height="20" rx="3" />
              </g>
              {/* Inner hash-prefix tick inside each block, suggestive of a SHA digest */}
              <g stroke="currentColor" strokeWidth="0.9" opacity="0.55" strokeLinecap="round">
                <line x1="12" y1="28" x2="26" y2="28" />
                <line x1="46" y1="28" x2="60" y2="28" />
                <line x1="80" y1="28" x2="94" y2="28" />
              </g>
              {/* Solid connectors between the present blocks */}
              <g stroke="currentColor" strokeWidth="1.2" opacity="0.7" strokeLinecap="round">
                <line x1="30" y1="28" x2="42" y2="28" />
                <line x1="64" y1="28" x2="76" y2="28" />
              </g>
              {/* Outbound dotted chain trailing into nothing — the absence */}
              <g stroke="currentColor" strokeWidth="1.1" fill="none" strokeLinecap="round" strokeDasharray="2 4">
                <line x1="98"  y1="28" x2="116" y2="28" opacity="0.45" />
                <line x1="120" y1="28" x2="136" y2="28" opacity="0.28" />
                <line x1="140" y1="28" x2="152" y2="28" opacity="0.15" />
              </g>
              {/* Faint ghost outline of the next block that would have been here */}
              <rect
                x="110" y="18" width="22" height="20" rx="3"
                fill="none" stroke="currentColor" strokeWidth="1"
                strokeDasharray="2 3" opacity="0.22"
              />
            </svg>
            <strong>{isPro ? "CHAIN EMPTY" : "Nothing recorded yet"}</strong>
            <span>
              {isPro
                ? " · No audit entries on this device. Begin a session in Mission Control to start the chain."
                : " — no investigations have been recorded on this device. "}
            </span>
            {!isPro && <Link to="/">Open Mission Control →</Link>}
          </>
        )}
        {chainStatus === "ok" && entries.length > 0 && (
          <>
            {isPro ? (
              <>
                <strong>CHAIN VERIFIED</strong>
                <span> · {entries.length} entries · SHA-256 hash-chained</span>
                {merkleRoot && (
                  <span className={r.merkleLine}>
                    {" · Merkle root "}
                    <code>{merkleRoot.slice(0, 12)}…{merkleRoot.slice(-8)}</code>
                  </span>
                )}
              </>
            ) : (
              <>
                <strong>✓ Tamper-proof record verified</strong>
                <span> · {entries.length} log entries, none altered since capture</span>
              </>
            )}
            <button type="button" className={r.downloadButton} onClick={handleExportZip} disabled={exporting}>
              {exporting ? "Building zip…" : isPro ? "Export full bundle (.zip)" : "Download case bundle (.zip)"}
            </button>
            {isPro && (
              <button type="button" className={r.downloadButton} onClick={handleExport}>
                Manifest + chain (.json)
              </button>
            )}
            <Link to="/brief" className={r.downloadButton}>
              Print case brief
            </Link>
          </>
        )}
        {chainStatus === "broken" && (
          <>
            {isPro ? (
              <>
                <strong>CHAIN BROKEN</strong>
                <span> · entry seq {chainBrokenSeq} failed verification — evidence cannot be trusted</span>
              </>
            ) : (
              <>
                <strong>⚠ Record looks tampered</strong>
                <span> · the {chainBrokenSeq}{nth(chainBrokenSeq)} log entry doesn't match its signature. Treat results from this device with caution.</span>
              </>
            )}
          </>
        )}
      </div>

      {/* Method banner */}
      <div className={r.ahtBanner}>
        {isPro ? (
          <>
            <span className={r.ahtBannerLabel}>AHT POST-ROLL</span>
            <span className={r.ahtBannerNote}>AHT eliminates explanations; it does not confirm causes.</span>
          </>
        ) : (
          <>
            <span className={r.ahtBannerLabel}>HOW THIS WORKS</span>
            <span className={r.ahtBannerNote}>We try to disprove the paranormal first. Anything left over is "still unexplained" — never "confirmed."</span>
          </>
        )}
      </div>

      {/* Base-rate dashboard — null results count too */}
      <NullRateDashboard />

      {/* AI sanity meta-card */}
      <div className={`${r.h0Card} ${postRollSuspended ? r.h0CardSuspended : ""}`.trim()}>
        <div className={r.h0Header}>
          <strong>{isPro ? "H₀ — AI insufficiency" : "AI sanity check"}</strong>
          <span className={r.h0Confidence}>
            {isPro
              ? `Confidence: ${h0Confidence.toFixed(2)}${h0Computed ? ` (n=${debunkAttempts.length})` : " (no data yet)"}`
              : h0Computed
                ? `${h0Pct}% — ${h0Useful ? "AI is being useful" : "AI is struggling"}`
                : "no data yet"}
          </span>
        </div>
        <div className={`${r.h0EngineRow} ${postRollSuspended ? r.h0EngineSuspended : r.h0EngineActive}`.trim()}>
          <span className={r.h0EngineDot} aria-hidden="true" />
          {postRollSuspended ? (
            isPro
              ? <>POST-ROLL <strong>SUSPENDED</strong> — every case renders INCONCLUSIVE while H₀ ≥ {AHT_H0_SUSPEND_THRESHOLD.toFixed(2)}. Run more debunk requests with reliable mundane explanations to bring it back.</>
              : <>Verdicts <strong>paused</strong> — the AI hasn't been reliable enough lately, so every case shows "inconclusive" until that improves.</>
          ) : (
            isPro
              ? <>POST-ROLL <strong>ACTIVE</strong> — verdicts computed normally. Suspend threshold is H₀ ≥ {AHT_H0_SUSPEND_THRESHOLD.toFixed(2)}.</>
              : <>Verdicts <strong>active</strong> — the AI is doing its job, so cases get a real verdict.</>
          )}
        </div>
        <p className={r.h0Body}>
          {isPro ? (
            <>When AI fails to generate plausible mundane explanations, that's a model limitation, not evidence of the paranormal. If H₀ confidence exceeds {AHT_H0_SUSPEND_THRESHOLD.toFixed(1)} the post-roll renders <em>INCONCLUSIVE — model limitations exceed evidence threshold</em> instead of any verdict. Computed as mean(1 − max-plausibility) across recent debunk requests; the per-case verdict appears on the Evidence Brief.</>
          ) : (
            <>If the AI can't think of normal explanations for what you saw, that's a limit of the AI, NOT proof of a ghost. When this number climbs above 40% we mark the case <em>inconclusive</em> instead of giving any verdict. Print a case brief for the full verdict.</>
          )}
        </p>
      </div>

      {/* Latest-case AHT verdict — surfaces the per-case verdict without
          requiring the operator to open the print view. */}
      {latestBrief && (
        <div className={`${r.verdictCard} ${r[`verdict_${latestBrief.ahtVerdict.verdict}`]}`.trim()}>
          <div className={r.verdictCardHead}>
            <span className={r.verdictCardEyebrow}>
              {isPro ? "AHT VERDICT · LATEST CASE" : "Latest case · verdict"}
            </span>
            <span className={r.verdictCardLabel}>{latestBrief.ahtVerdict.label}</span>
          </div>
          <p className={r.verdictCardTitle}>{latestBrief.investigation.title}</p>
          <p className={r.verdictCardDetail}>{latestBrief.ahtVerdict.detail}</p>
          <div className={r.verdictCardFoot}>
            <span>peak {(latestBrief.peakPosterior * 100).toFixed(0)}%</span>
            <span>·</span>
            <span>H₀ {latestBrief.h0Confidence.toFixed(2)}</span>
            {latestBrief.investigation.disposition && (
              <>
                <span>·</span>
                <span>operator: {latestBrief.investigation.disposition.replace(/_/g, " ")}</span>
              </>
            )}
            <Link to={`/brief/${latestBrief.investigation.id}`} className={r.verdictCardLink}>
              Full brief →
            </Link>
          </div>
        </div>
      )}

      {/* Witness interviews — Section 2 of the report. Scoped to the
          most-recent investigation so the operator can add/edit interviews
          during or after a session without leaving the Review screen.
          Evidence event linking is available on the EvidenceBrief print
          view where events are fully loaded. */}
      {latestBrief && (
        <div className={r.section}>
          <InterviewsList
            investigationId={latestBrief.investigation.id}
          />
        </div>
      )}

      {/* Device-state timeline — battery + free-storage decay sampled by the
          mid-session watchdog every 60s. Tiny SVG sparklines so the reviewer
          can eyeball "did the device run low partway through?" without
          opening a chart library. */}
      {timeline && (timeline.battery.length > 1 || timeline.storageMb.length > 1) && (
        <div className={r.section}>
          <header className={r.sectionHeader}>
            <h2>Device state — battery + storage</h2>
          </header>
          <div className={r.deviceSparkRow}>
            {timeline.battery.length > 1 && (
              <DeviceSpark
                label="Battery"
                samples={timeline.battery}
                markerTimestamps={markers.map((m) => m.timestamp)}
                domain={{ min: 0, max: 1 }}
                format={(v) => `${Math.round(v * 100)}%`}
                tone="battery"
              />
            )}
            {timeline.storageMb.length > 1 && (
              <DeviceSpark
                label="Storage free"
                samples={timeline.storageMb}
                markerTimestamps={markers.map((m) => m.timestamp)}
                format={(v) => `${Math.round(v)} MB`}
                tone="storage"
              />
            )}
          </div>
        </div>
      )}

      {/* Moment markers — double-taps the operator dropped during capture.
          Latest case only; oldest cases are still searchable through the
          audit log if needed. */}
      <div className={r.section}>
        <header className={r.sectionHeader}>
          <h2>Moment markers ({markers.length})</h2>
        </header>
        {markers.length === 0 ? (
          <p className={r.empty}>
            No markers yet. Double-tap the camera viewport during a session to drop a moment marker — it lands here with the elapsed time + active scene for one-tap review later.
          </p>
        ) : (
          <ol className={r.incrementList}>
            {markers.map((m) => (
              <li key={m.id} className={r.incrementRow}>
                <span className={r.incrementSeq}>●</span>
                <span className={r.incrementChannel}>{m.elapsedLabel ?? "—"}</span>
                <span className={r.incrementMath}>{m.title}</span>
                {m.sceneId && (
                  <span className={r.incrementReason}>
                    {/* Pretty-print scene id → display name (e.g.
                        "walkthrough" → "Walkthrough"). Falls back to the
                        raw id if the scene was deleted/renamed between
                        capture and review. */}
                    scene: {getScene(m.sceneId as never)?.name ?? m.sceneId}
                  </span>
                )}
                <span className={r.incrementTs}>{new Date(m.timestamp).toLocaleTimeString()}</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* Evidence updates / posterior log */}
      <div className={r.section}>
        <header className={r.sectionHeader}>
          <h2>{isPro ? `Posterior increments (${posteriorRows.length})` : `Evidence updates (${posteriorRows.length})`}</h2>
        </header>
        {posteriorRows.length === 0 ? (
          <p className={r.empty}>
            {isPro
              ? "No posterior updates yet. Run a session — every LR is logged here with its channel and reason."
              : "No evidence yet. Run a session in Mission Control — anything notable will show up here."}
          </p>
        ) : (
          <ol className={r.incrementList}>
            {posteriorRows.map((row) => {
              const move = plainEnglishMove(row.posterior_before, row.posterior_after);
              return (
                <li key={row.seq} className={r.incrementRow}>
                  <span className={r.incrementSeq}>#{row.seq}</span>
                  <span className={r.incrementChannel}>
                    {isPro ? row.channel.toUpperCase() : plainEnglishChannel(row.channel)}
                  </span>
                  {isPro ? (
                    <>
                      <span className={r.incrementMath}>
                        P {row.posterior_before.toFixed(3)} → {row.posterior_after.toFixed(3)}
                      </span>
                      <span className={r.incrementLr}>
                        {row.log_lr >= 0 ? "+" : ""}{row.log_lr.toFixed(2)} log LR (LR {Math.exp(Math.abs(row.log_lr)).toFixed(1)})
                        {row.capped ? " — CAPPED" : ""}
                      </span>
                    </>
                  ) : (
                    <span className={r.incrementMath}>
                      {move.label} ({(row.posterior_before * 100).toFixed(0)}% → {(row.posterior_after * 100).toFixed(0)}%)
                    </span>
                  )}
                  <span className={r.incrementReason}>{row.reason}</span>
                  <span className={r.incrementTs}>{new Date(row.ts_utc).toLocaleTimeString()}</span>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {exportStatus && <p className={r.disclaimer}>{exportStatus}</p>}

      <p className={r.disclaimer}>
        {isPro
          ? <>The full bundle (.zip) ships the audit chain as JSONL, all media binaries, and a drop-in <code>verify.html</code> any reviewer can open offline. AHT eliminates explanations; it does not confirm causes.</>
          : <>The downloadable bundle is a single .zip with all your recordings, a printable cover sheet, and a small <code>verify.html</code> file anyone can open in a browser to confirm nothing's been edited. We try to disprove the paranormal first; the app never confirms one.</>}
      </p>
    </section>
  );
}

/**
 * Tiny inline sparkline — no chart-library dependency, just an SVG polyline
 * sized to a fixed 120×28 viewbox so it scales cleanly inside the section.
 *
 * `domain` lets battery clamp to 0..1 (so the curve doesn't auto-stretch when
 * the device never went under 80%). Storage doesn't pass a domain because the
 * meaningful range varies per device; we autoscale from min..max of the
 * series.
 */
function DeviceSpark({
  label, samples, format, domain, tone, markerTimestamps,
}: {
  label: string;
  samples: readonly { value: number; ts: string }[];
  format: (v: number) => string;
  domain?: { min: number; max: number };
  tone: "battery" | "storage";
  /** ISO timestamps of moment markers — rendered as faint vertical ticks so
   *  the reviewer sees where the operator flagged moments against the
   *  device-state curve. Markers outside [first..last] sample range clip. */
  markerTimestamps?: readonly string[];
}) {
  // Hover/tap readout — index of the sample nearest the pointer's x in the
  // viewBox. Null = no hover, render the "latest sample" headline value.
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (samples.length < 2) return null;
  const W = 120;
  const H = 28;
  const values = samples.map((s) => s.value);
  const min = domain?.min ?? Math.min(...values);
  const max = domain?.max ?? Math.max(...values);
  const span = Math.max(0.0001, max - min);
  const stepX = W / (samples.length - 1);
  const points = samples.map((s, i) => {
    const x = i * stepX;
    const y = H - ((s.value - min) / span) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const last = samples[samples.length - 1];
  const first = samples[0];

  // Map a clientX inside the SVG bounding box to the nearest sample index.
  // We use bounding-box → viewBox math instead of relying on the SVG's CTM
  // (getScreenCTM) because the SVG scales with the container; bbox math is
  // simpler + survives the CSS scale-to-fit treatment.
  const pointerToIdx = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return null;
    const xInViewBox = ((clientX - rect.left) / rect.width) * W;
    const idx = Math.round(xInViewBox / stepX);
    if (idx < 0 || idx >= samples.length) return null;
    return idx;
  };

  const hovered = hoverIdx != null ? samples[hoverIdx] : null;
  const hoveredX = hoverIdx != null ? hoverIdx * stepX : null;
  // Display the hovered sample in the headline value when active; otherwise
  // the latest sample. Footer toggles to show the hovered timestamp.
  const displayValue = hovered ?? last;
  // Map markers to x-positions on the spark's time axis. Clip anything that
  // falls outside the sample range (e.g. markers from before the watchdog
  // started writing samples).
  const startMs = Date.parse(first.ts);
  const endMs = Date.parse(last.ts);
  const rangeMs = Math.max(1, endMs - startMs);
  // Keep timestamp + x together so we can key the rendered <line> by the
  // stable timestamp instead of array index — append-only markers shouldn't
  // shift keys, but ts-keyed is the defensive choice.
  const markerPoints = (markerTimestamps ?? [])
    .map((iso) => ({ iso, ms: Date.parse(iso) }))
    .filter(({ ms }) => Number.isFinite(ms) && ms >= startMs && ms <= endMs)
    .map(({ iso, ms }) => ({ iso, x: ((ms - startMs) / rangeMs) * W }));
  return (
    <div className={r.deviceSpark} data-tone={tone}>
      <div className={r.deviceSparkHead}>
        <span className={r.deviceSparkLabel}>{label}</span>
        <span className={r.deviceSparkValue}>{format(displayValue.value)}</span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className={r.deviceSparkSvg}
        role="img"
        aria-label={`${label} timeline${markerPoints.length ? ` with ${markerPoints.length} markers` : ""}`}
        onPointerMove={(e) => setHoverIdx(pointerToIdx(e.clientX))}
        onPointerLeave={() => setHoverIdx(null)}
        onPointerDown={(e) => setHoverIdx(pointerToIdx(e.clientX))}
      >
        {/* Markers behind the polyline so the curve reads over the ticks. */}
        {markerPoints.map((m) => (
          <line
            key={m.iso}
            x1={m.x} x2={m.x} y1={0} y2={H}
            stroke="var(--text-dim)" strokeWidth={0.6} strokeDasharray="1.5 1.5" opacity={0.55}
          />
        ))}
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        {/* Hover guide — vertical line + dot at the hovered sample so the
            reviewer's eye lands on the exact reading. Rendered last so it
            stays on top of both the markers and the data curve. */}
        {hoveredX != null && hovered && (
          <>
            <line x1={hoveredX} x2={hoveredX} y1={0} y2={H} stroke="currentColor" strokeWidth={0.5} opacity={0.4} />
            <circle
              cx={hoveredX}
              cy={H - ((hovered.value - min) / span) * H}
              r={2}
              fill="currentColor"
            />
          </>
        )}
      </svg>
      <div className={r.deviceSparkFoot}>
        <span className={r.deviceSparkMeta}>
          {hovered
            ? new Date(hovered.ts).toLocaleTimeString()
            : `start ${format(first.value)}`}
        </span>
        <span className={r.deviceSparkMeta}>
          {samples.length} samples
          {markerPoints.length > 0 ? ` · ${markerPoints.length} marker${markerPoints.length === 1 ? "" : "s"}` : ""}
        </span>
      </div>
    </div>
  );
}

function nth(n: number | null): string {
  if (n == null) return "";
  const v = n % 100;
  if (v >= 11 && v <= 13) return "th";
  switch (n % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}
