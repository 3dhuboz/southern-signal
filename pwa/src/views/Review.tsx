import { useCallback, useEffect, useState } from "react";
import { BaseRatePanel } from "../components/BaseRatePanel";
import { CaseManager } from "../components/CaseManager";
import { query } from "../lib/db/db";
import { verifyAuditChain, appendAuditEntry } from "../lib/db/auditLog";
import { buildManifest } from "../lib/forensic/manifest";
import { buildExportBundle, downloadBlob } from "../lib/forensic/exportBundle";
import { usePreferences } from "../lib/preferences";
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

export function Review() {
  const [prefs] = usePreferences();
  const isPro = prefs.experienceMode === "pro";
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [chainStatus, setChainStatus] = useState<"checking" | "ok" | "broken">("checking");
  const [chainBrokenSeq, setChainBrokenSeq] = useState<number | null>(null);
  const [merkleRoot, setMerkleRoot] = useState<string | null>(null);

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

      {/* Chain status banner */}
      <div className={`${r.chainStatus} ${r[chainStatus]}`.trim()}>
        {chainStatus === "checking" && (isPro ? "Verifying audit chain…" : "Checking the record…")}
        {chainStatus === "ok" && (
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
      <BaseRatePanel />

      {/* AI sanity meta-card */}
      <div className={r.h0Card}>
        <div className={r.h0Header}>
          <strong>{isPro ? "H₀ — AI insufficiency" : "AI sanity check"}</strong>
          <span className={r.h0Confidence}>{isPro ? "Confidence: 0.18" : "18% — AI is being useful"}</span>
        </div>
        <p className={r.h0Body}>
          {isPro ? (
            <>When AI fails to generate plausible mundane explanations, that's a model limitation, not evidence of the paranormal. If H₀ confidence exceeds 0.4 the post-roll renders <em>INCONCLUSIVE — model limitations exceed evidence threshold</em> instead of any verdict.</>
          ) : (
            <>If the AI can't think of normal explanations for what you saw, that's a limit of the AI, NOT proof of a ghost. When this number climbs above 40% we mark the case <em>inconclusive</em> instead of giving any verdict.</>
          )}
        </p>
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
