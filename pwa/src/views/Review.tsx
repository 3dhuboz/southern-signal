import { useCallback, useEffect, useState } from "react";
import { BaseRatePanel } from "../components/BaseRatePanel";
import { CaseManager } from "../components/CaseManager";
import { query } from "../lib/db/db";
import { verifyAuditChain, appendAuditEntry } from "../lib/db/auditLog";
import { buildManifest } from "../lib/forensic/manifest";
import { buildExportBundle, downloadBlob } from "../lib/forensic/exportBundle";
import s from "./View.module.css";
import r from "./Review.module.css";

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
        <span className={s.eyebrow}>Review · Post-roll</span>
        <h1 className={s.title}>All cases · all data</h1>
        <p className={s.lede}>
          Every investigation, every session, every captured image / audio / video clip, every posterior increment, every audit-chain entry. Edit, export, or download from here. Setup mirrors the case manager so you can manage from either screen.
        </p>
      </div>

      {/* CASE MANAGER — every investigation with media browser, edit, download, delete */}
      <CaseManager />

      {/* Chain status banner */}
      <div className={`${r.chainStatus} ${r[chainStatus]}`.trim()}>
        {chainStatus === "checking" && "Verifying audit chain…"}
        {chainStatus === "ok" && (
          <>
            <strong>CHAIN VERIFIED</strong>
            <span> · {entries.length} entries · SHA-256 hash-chained</span>
            {merkleRoot && (
              <span className={r.merkleLine}>
                {" · Merkle root "}
                <code>{merkleRoot.slice(0, 12)}…{merkleRoot.slice(-8)}</code>
              </span>
            )}
            <button type="button" className={r.downloadButton} onClick={handleExportZip} disabled={exporting}>
              {exporting ? "Building zip…" : "Export full bundle (.zip)"}
            </button>
            <button type="button" className={r.downloadButton} onClick={handleExport}>
              Manifest + chain (.json)
            </button>
          </>
        )}
        {chainStatus === "broken" && (
          <>
            <strong>CHAIN BROKEN</strong>
            <span> · entry seq {chainBrokenSeq} failed verification — evidence cannot be trusted</span>
          </>
        )}
      </div>

      {/* AHT post-roll banner */}
      <div className={r.ahtBanner}>
        <span className={r.ahtBannerLabel}>AHT POST-ROLL</span>
        <span className={r.ahtBannerNote}>AHT eliminates explanations; it does not confirm causes.</span>
      </div>

      {/* Base-rate dashboard — null results count too */}
      <BaseRatePanel />

      {/* H0: AI insufficiency meta-card */}
      <div className={r.h0Card}>
        <div className={r.h0Header}>
          <strong>H₀ — AI insufficiency</strong>
          <span className={r.h0Confidence}>Confidence: 0.18</span>
        </div>
        <p className={r.h0Body}>
          When AI fails to generate plausible mundane explanations, that's a model limitation, not evidence of the paranormal. If H₀ confidence exceeds 0.4 the post-roll renders <em>INCONCLUSIVE — model limitations exceed evidence threshold</em> instead of any verdict.
        </p>
      </div>

      {/* Posterior log */}
      <div className={r.section}>
        <header className={r.sectionHeader}>
          <h2>Posterior increments ({posteriorRows.length})</h2>
        </header>
        {posteriorRows.length === 0 ? (
          <p className={r.empty}>No posterior updates yet. Run a session — every LR is logged here with its channel and reason.</p>
        ) : (
          <ol className={r.incrementList}>
            {posteriorRows.map((row) => (
              <li key={row.seq} className={r.incrementRow}>
                <span className={r.incrementSeq}>#{row.seq}</span>
                <span className={r.incrementChannel}>{row.channel.toUpperCase()}</span>
                <span className={r.incrementMath}>
                  P {row.posterior_before.toFixed(3)} → {row.posterior_after.toFixed(3)}
                </span>
                <span className={r.incrementLr}>
                  {row.log_lr >= 0 ? "+" : ""}{row.log_lr.toFixed(2)} log LR (LR {Math.exp(Math.abs(row.log_lr)).toFixed(1)})
                  {row.capped ? " — CAPPED" : ""}
                </span>
                <span className={r.incrementReason}>{row.reason}</span>
                <span className={r.incrementTs}>{new Date(row.ts_utc).toLocaleTimeString()}</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      {exportStatus && <p className={r.disclaimer}>{exportStatus}</p>}

      <p className={r.disclaimer}>
        The full bundle (.zip) ships the audit chain as JSONL, all media binaries, and a drop-in <code>verify.html</code> any reviewer can open offline. AHT eliminates explanations; it does not confirm causes.
      </p>
    </section>
  );
}
