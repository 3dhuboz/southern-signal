import { useCallback, useEffect, useState } from "react";
import { query } from "../lib/db/db";
import { verifyAuditChain } from "../lib/db/auditLog";
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

  const handleExport = useCallback(async () => {
    const all = await query<AuditEntry>("SELECT * FROM audit_log ORDER BY seq ASC");
    const verification = await verifyAuditChain();
    const exportPayload = {
      schema: "southern-signal.audit-chain.v1",
      generated_at: new Date().toISOString(),
      app_version: "0.1.0",
      verification,
      entries: all,
    };
    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `southern-signal-audit-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  return (
    <section className={s.view}>
      <div className={s.titleBlock}>
        <span className={s.eyebrow}>Review · Post-roll</span>
        <h1 className={s.title}>Hypothesis log + chain</h1>
        <p className={s.lede}>
          Non-live forensic record. Every posterior increment, prompt, response, sensor frame.
        </p>
      </div>

      {/* Chain status banner */}
      <div className={`${r.chainStatus} ${r[chainStatus]}`.trim()}>
        {chainStatus === "checking" && "Verifying audit chain…"}
        {chainStatus === "ok" && (
          <>
            <strong>CHAIN VERIFIED</strong>
            <span> · {entries.length} entries · SHA-256 hash-chained · download the entire log to reproduce</span>
            <button type="button" className={r.downloadButton} onClick={handleExport}>
              Download chain (JSON)
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

      <p className={r.disclaimer}>
        Hash-chain receipts are downloadable in V1.1 export. AHT eliminates explanations; it does not confirm causes.
      </p>
    </section>
  );
}
