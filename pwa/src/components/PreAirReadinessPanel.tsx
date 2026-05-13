/**
 * PreAirReadinessPanel — single-glance status of the methodology gates
 * that have to be green before a TV-grade premiere.
 *
 * Source-of-truth logic lives in `lib/forensic/preAirReadiness.ts` so
 * the UI is a thin render on top of a pure function. Reloads when the
 * panel mounts; the operator manually re-runs via the "Re-check" button
 * after editing reviewer sign-offs or accepting the AoC.
 */

import { useCallback, useEffect, useState } from "react";
import { verifyAuditChain } from "../lib/db/auditLog";
import { listSignoffs } from "../lib/db/repo";
import { usePreferences } from "../lib/preferences";
import { computeReadiness, type ReadinessReport } from "../lib/forensic/preAirReadiness";
import st from "../views/Setup.module.css";
import s from "./PreAirReadinessPanel.module.css";

// Same literal as exportBundle / manifest. Updating one means updating
// all three — see the comment in ReviewerSignoffsPanel.
const APP_VERSION = "0.1.0";

function statusGlyph(status: "pass" | "fail"): string {
  return status === "pass" ? "✓" : "✗";
}

export function PreAirReadinessPanel() {
  const [prefs] = usePreferences();
  const [report, setReport] = useState<ReadinessReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recompute = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [signoffs, chain] = await Promise.all([
        listSignoffs(),
        verifyAuditChain(),
      ]);
      setReport(computeReadiness({
        aocAccepted: prefs.acknowledgementOfCountry.accepted,
        appVersion: APP_VERSION,
        signoffs,
        chain,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [prefs.acknowledgementOfCountry.accepted]);

  useEffect(() => { void recompute(); }, [recompute]);

  return (
    <div className={s.wrap}>
      <p className={st.panelLede}>
        The four hard-block gates the README commits to before any
        TV-grade premiere: Acknowledgement of Country, external Bayesian
        sign-off, external acoustician sign-off, and an intact audit
        chain. Re-check after recording a new sign-off or accepting the
        AoC.
      </p>

      {error && <p className={st.errorLine}>{error}</p>}

      {report && (
        <>
          <div className={s.banner} data-status={report.overall}>
            <span className={s.bannerMark}>
              {report.overall === "ready" ? "✓" : report.overall === "caveats" ? "⚠" : "✗"}
            </span>
            <span className={s.bannerText}>{report.summary}</span>
          </div>

          <ul className={s.list}>
            {report.checks.map((c) => (
              <li key={c.id} className={s.item} data-status={c.status} data-severity={c.severity}>
                <div className={s.itemHead}>
                  <span className={s.itemMark}>{statusGlyph(c.status)}</span>
                  <span className={s.itemLabel}>{c.label}</span>
                  <span className={s.itemSeverity}>{c.severity}</span>
                </div>
                {c.detail && <p className={s.itemDetail}>{c.detail}</p>}
              </li>
            ))}
          </ul>
        </>
      )}

      <button
        type="button"
        className={st.linkBtn ?? ""}
        onClick={() => void recompute()}
        disabled={busy}
      >
        {busy ? "Checking…" : "Re-check readiness"}
      </button>
    </div>
  );
}
