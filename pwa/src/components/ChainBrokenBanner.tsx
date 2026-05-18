/**
 * ChainBrokenBanner — surfaces a broken audit-chain verifier result at the
 * app shell level so the operator can't miss the failure no matter which
 * route they happen to be on. Without this, BROKEN status was only visible
 * inside the AuditLogInspector panel in Setup — an operator running a hunt
 * could silently capture hours of evidence onto a tainted chain.
 *
 * Behaviour:
 *   - On mount (and every 5 minutes thereafter, defensively), runs
 *     `verifyAuditChain()`.
 *   - When broken, renders a sticky danger banner with the broken seq,
 *     reason, and a button to jump to the AuditLogInspector at Setup.
 *   - Dismissal is per-page-load only (no localStorage) — the banner
 *     reappears on next mount so the operator can't accidentally suppress
 *     a real integrity failure permanently. They have to fix it.
 *
 * Verification is cheap-ish (SHA-256 over the whole chain) so the 5-minute
 * recheck cadence is conservative; in practice the chain doesn't get
 * tampered with between page loads, so the mount check usually suffices.
 */

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { verifyAuditChain } from "../lib/db/auditLog";
import s from "./ChainBrokenBanner.module.css";

interface BrokenStatus { brokenAtSeq: number; reason: string }

const RECHECK_INTERVAL_MS = 5 * 60_000;

export function ChainBrokenBanner() {
  const [broken, setBroken] = useState<BrokenStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const navigate = useNavigate();

  // Snapshot the current bundle to disk immediately. Critical when the chain
  // is broken — the operator wants the forensic record captured before any
  // further evidence appends, so the export reflects the chain state at the
  // moment the failure was first surfaced.
  const exportNow = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      // Lazy-load the bundle builder — it pulls in COSE signing + JSZip,
      // ~60KB gzipped, and the banner is shown app-wide. Keeping it out of
      // the root chunk keeps every page-load lean; only operators who
      // actually hit Export now pay the load cost.
      const { buildExportBundle, downloadBlob } = await import("../lib/forensic/exportBundle");
      const { blob, summary } = await buildExportBundle();
      downloadBlob(blob, summary.filename);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }, [exporting]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const result = await verifyAuditChain();
        if (cancelled) return;
        if (!result.ok) setBroken({ brokenAtSeq: result.brokenAtSeq, reason: result.reason });
        else setBroken(null);
      } catch { /* swallow — degraded DB surfaces elsewhere */ }
    };
    void run();
    const handle = window.setInterval(() => { void run(); }, RECHECK_INTERVAL_MS);
    return () => { cancelled = true; window.clearInterval(handle); };
  }, []);

  if (!broken || dismissed) return null;

  return (
    <div className={s.banner} role="alert">
      <div className={s.body}>
        <strong className={s.title}>Audit chain integrity failure</strong>
        <p className={s.detail}>
          Entry seq <span className={s.seq}>#{broken.brokenAtSeq}</span> failed
          verification: <span className={s.reason}>{broken.reason}</span>. New
          evidence captured while the chain is broken still appends correctly,
          but the existing break needs review before this case can be exported
          as forensic.
        </p>
      </div>
      <div className={s.actions}>
        <button
          type="button"
          className={s.openBtn}
          onClick={() => void exportNow()}
          disabled={exporting}
          title="Captures the bundle (with the current broken chain) to disk for forensic review."
        >
          {exporting ? "Exporting…" : "Export now"}
        </button>
        <button
          type="button"
          className={s.openBtn}
          onClick={() => navigate("/setup")}
        >
          Open audit log
        </button>
        <button
          type="button"
          className={s.dismissBtn}
          onClick={() => setDismissed(true)}
          title="Dismiss for this session"
        >
          Later
        </button>
      </div>
      {exportError && <p className={s.exportError}>{exportError}</p>}
    </div>
  );
}
