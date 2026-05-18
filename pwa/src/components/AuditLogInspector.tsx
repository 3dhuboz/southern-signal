/**
 * AuditLogInspector — Setup-page panel for chain inspection.
 *
 *   • Runs verifyAuditChain() so the operator can see chain status at
 *     a glance (matches what the Evidence Brief reports).
 *   • Lists the most recent N audit entries (default 50) with kind,
 *     actor, timestamp, and a truncated payload preview.
 *   • Optional kind-filter so the operator can narrow to e.g. just
 *     research.* or media.* entries.
 *
 * The chain is the forensic backbone — every meaningful state change
 * appends here. Making it inspectable in the app (rather than just
 * via export) helps the operator catch problems sooner.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { query } from "../lib/db/db";
import { verifyAuditChain } from "../lib/db/auditLog";
import { sha256Hex } from "../lib/forensic/canonicalJson";
import { compareAgainstSnapshot, loadLastExportSnapshot, type ChainComparison, type LastExportSnapshot } from "../lib/forensic/lastExportSnapshot";
import s from "./AuditLogInspector.module.css";

interface AuditRow {
  seq: number;
  ts_utc: string;
  actor: string;
  kind: string;
  payload_json: string;
  entry_hash: string;
}

interface ChainStatus { ok: true }
interface ChainStatusBad { ok: false; brokenAtSeq: number; reason: string }
type ChainResult = ChainStatus | ChainStatusBad;

const LIMIT_DEFAULT = 50;

/** localStorage key for the persisted quick-filter selection. The user's
 *  last filter survives reloads so a reviewer who left the panel filtered
 *  to "session_" doesn't have to re-pick on every visit. */
const FILTER_STORAGE_KEY = "ss-audit-filter-v1";

/**
 * Quick-filter presets — saved hand-shortcuts for the kinds of audit rows the
 * operator most often wants to scan. Each `match` is plugged straight into the
 * filter string so the existing case-insensitive substring filter handles the
 * rest. The first preset blanks the filter back out (acts as a "clear").
 */
const QUICK_FILTERS: { id: string; label: string; match: string; hint: string }[] = [
  { id: "all",       label: "All",        match: "",                  hint: "Clear filter" },
  { id: "session",   label: "Session",    match: "session_",          hint: "Session start/stop with preflight snapshot" },
  { id: "markers",   label: "Markers",    match: "marker",            hint: "Operator-dropped moment markers" },
  { id: "evidence",  label: "Evidence",   match: "event.posterior",   hint: "Posterior increments & emissions" },
  { id: "ai",        label: "AI",         match: "ai_",               hint: "AI assistant + research runs" },
  { id: "media",     label: "Media",      match: "media.",            hint: "Recording, broadcast, dossier saves" },
];

export function AuditLogInspector() {
  const [chain, setChain] = useState<ChainResult | null>(null);
  const [entries, setEntries] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<string>(() => {
    try { return localStorage.getItem(FILTER_STORAGE_KEY) ?? ""; } catch { return ""; }
  });
  // Track the row that the chain verifier flagged as broken so the "Jump to
  // broken row" button can scroll it into view. We brief-flash a highlight
  // class so the operator's eye lands on the failed entry instead of having
  // to scan the list.
  const listRef = useRef<HTMLUListElement | null>(null);
  const [flashSeq, setFlashSeq] = useState<number | null>(null);
  // Diagnostic report for the broken row — populated by the Diagnose button.
  // Reads the row + its predecessor, recomputes the expected entry_hash, and
  // tells the operator which step of the chain check actually failed. We
  // never auto-repair: rewriting a hash chain would defeat the chain's
  // purpose. The report is for forensic triage, not modification.
  interface ChainDiagnosis {
    seq: number;
    storedEntryHash: string;
    recomputedEntryHash: string;
    storedPrevHash: string;
    expectedPrevHash: string;
    issue:
      | "missing_predecessor"
      | "prev_hash_mismatch"
      | "entry_hash_mismatch"
      | "no_issue_found";
  }
  const [diagnosis, setDiagnosis] = useState<ChainDiagnosis | null>(null);
  // Last-export comparison — populated lazily via the "Compare to last export"
  // button. The snapshot itself is persisted in localStorage by buildExportBundle
  // and contains seq→entry_hash; we walk the current chain against it.
  const [exportComparison, setExportComparison] = useState<
    | { snapshot: LastExportSnapshot; comparison: ChainComparison; ranAt: string }
    | { snapshot: null }
    | null
  >(null);
  // Persist the operator's filter across reloads. Empty string clears storage
  // so we don't keep a stale value pinned forever.
  useEffect(() => {
    try {
      if (filter) localStorage.setItem(FILTER_STORAGE_KEY, filter);
      else localStorage.removeItem(FILTER_STORAGE_KEY);
    } catch { /* swallow — localStorage unavailable */ }
  }, [filter]);

  // Clear the broken-row flash after 2s so it doesn't strobe forever.
  useEffect(() => {
    if (flashSeq == null) return;
    const h = window.setTimeout(() => setFlashSeq(null), 2000);
    return () => window.clearTimeout(h);
  }, [flashSeq]);

  // Deep-link via URL hash — `/setup#audit-seq-42` jumps to that row and
  // flashes it. Lets a reviewer paste a link in a thread and the recipient
  // lands directly on the entry under discussion. We watch the hash for
  // changes too so a re-click on a different link without a reload still
  // triggers the jump. The target seq is held in a separate state so the
  // jump runs once entries have actually loaded — without this, the
  // querySelector on mount fires before the async reload completes and
  // misses the row.
  const [pendingJumpSeq, setPendingJumpSeq] = useState<number | null>(null);
  useEffect(() => {
    const handleHash = () => {
      const match = window.location.hash.match(/^#audit-seq-(\d+)$/);
      if (!match) return;
      const seq = Number(match[1]);
      if (Number.isFinite(seq)) setPendingJumpSeq(seq);
    };
    handleHash();
    window.addEventListener("hashchange", handleHash);
    return () => window.removeEventListener("hashchange", handleHash);
  }, []);
  // Execute the pending jump once rows are present (and again whenever the
  // entries list updates so a Refresh re-anchors the operator).
  useEffect(() => {
    if (pendingJumpSeq == null || entries.length === 0) return;
    setFilter("");
    setFlashSeq(pendingJumpSeq);
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector<HTMLLIElement>(`[data-seq="${pendingJumpSeq}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    setPendingJumpSeq(null);
  }, [pendingJumpSeq, entries]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const totalRows = await query<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log");
      const status = await verifyAuditChain();
      const rows = await query<AuditRow>(
        "SELECT seq, ts_utc, actor, kind, payload_json, entry_hash FROM audit_log ORDER BY seq DESC LIMIT ?",
        [LIMIT_DEFAULT],
      );
      setChain(status);
      setEntries(rows);
      setTotal(totalRows[0]?.n ?? 0);
    } catch (err) {
      setError(`Couldn't load audit log: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  // Diagnose a broken chain row — recomputes the expected entry_hash from
  // the row's own payload and the previous row's hash, surfaces which check
  // failed. Pure read-only inspection; the chain itself is untouched.
  const diagnose = useCallback(async (brokenAtSeq: number) => {
    const GENESIS_HASH = "0".repeat(64);
    const broken = (await query<AuditRow & { prev_hash: string }>(
      "SELECT seq, ts_utc, actor, kind, payload_json, prev_hash, entry_hash FROM audit_log WHERE seq = ?",
      [brokenAtSeq],
    ))[0];
    if (!broken) return;
    // Expected prev_hash = previous row's entry_hash, or GENESIS for seq=1
    let expectedPrev = GENESIS_HASH;
    if (brokenAtSeq > 1) {
      const prev = (await query<{ entry_hash: string }>(
        "SELECT entry_hash FROM audit_log WHERE seq = ?",
        [brokenAtSeq - 1],
      ))[0];
      if (!prev) {
        setDiagnosis({
          seq: brokenAtSeq,
          storedEntryHash: broken.entry_hash,
          recomputedEntryHash: "",
          storedPrevHash: broken.prev_hash,
          expectedPrevHash: "(missing — predecessor row absent)",
          issue: "missing_predecessor",
        });
        return;
      }
      expectedPrev = prev.entry_hash;
    }
    const recomputed = await sha256Hex(
      `${broken.seq}|${broken.ts_utc}|${broken.actor}|${broken.kind}|${broken.payload_json}|${broken.prev_hash}`,
    );
    let issue: ChainDiagnosis["issue"] = "no_issue_found";
    if (broken.prev_hash !== expectedPrev) issue = "prev_hash_mismatch";
    else if (recomputed !== broken.entry_hash) issue = "entry_hash_mismatch";
    setDiagnosis({
      seq: brokenAtSeq,
      storedEntryHash: broken.entry_hash,
      recomputedEntryHash: recomputed,
      storedPrevHash: broken.prev_hash,
      expectedPrevHash: expectedPrev,
      issue,
    });
  }, []);

  // Compare the live chain against the snapshot saved at the last export.
  // Surfaces append-since-export (the normal case) AND first-divergence-seq
  // (the forensic case — "an entry we exported now hashes differently").
  // Storage cost is bounded by chain length × 64 chars; ~10KB for 100 entries.
  const compareToLastExport = useCallback(async () => {
    const snapshot = loadLastExportSnapshot();
    if (!snapshot) {
      setExportComparison({ snapshot: null });
      return;
    }
    const rows = await query<{ seq: number; entry_hash: string }>(
      "SELECT seq, entry_hash FROM audit_log",
    );
    const current = new Map<number, string>();
    for (const r of rows) current.set(r.seq, r.entry_hash);
    const comparison = compareAgainstSnapshot(snapshot, current);
    setExportComparison({ snapshot, comparison, ranAt: new Date().toISOString() });
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) =>
      e.kind.toLowerCase().includes(q)
      || e.actor.toLowerCase().includes(q)
      || e.payload_json.toLowerCase().includes(q),
    );
  }, [filter, entries]);

  const uniqueKinds = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) set.add(e.kind);
    return Array.from(set).sort();
  }, [entries]);

  // Precompute the preflight summary string once per entries snapshot so the
  // JSON.parse cost doesn't repeat on every render (especially when the user
  // is typing into the filter input, which rebuilds `filtered` but not `entries`).
  // Keyed by seq because that's the stable identity inside the audit chain.
  const preflightSummaries = useMemo(() => {
    const out = new Map<number, string | null>();
    for (const e of entries) out.set(e.seq, summarisePreflight(e));
    return out;
  }, [entries]);

  return (
    <div className={s.wrap}>
      <p className={s.lede}>
        Hash-chained event log. Every meaningful state change — investigations created, sensor
        markers, AI runs, dossier saves — is appended here and linked to the prior entry's
        hash. Tampering with any past row invalidates every subsequent hash.
      </p>

      {/* Chain status */}
      {chain && (
        <div className={`${s.status} ${chain.ok ? s.statusOk : s.statusBad}`.trim()}>
          <span className={s.statusDot} />
          {chain.ok ? (
            <>
              <span className={s.statusLabel}>VERIFIED</span>
              <span className={s.statusDetail}>{total} entries, chain intact.</span>
              <button
                type="button"
                className={s.statusJumpBtn}
                onClick={() => { void compareToLastExport(); }}
                title="Compare the current chain against the snapshot saved at the most recent export — surfaces append-since-export and any after-the-fact tampering."
              >
                Compare to last export
              </button>
            </>
          ) : (
            <>
              <span className={s.statusLabel}>BROKEN</span>
              <span className={s.statusDetail}>Entry seq {chain.brokenAtSeq} failed: {chain.reason}</span>
              <button
                type="button"
                className={s.statusJumpBtn}
                onClick={() => {
                  // Clear filter so the broken row is guaranteed to be visible
                  // even if the operator had narrowed the view to a quick-filter.
                  // The persisted-filter effect will mirror "" into localStorage,
                  // which is the intent here — chain-repair mode supersedes a
                  // saved filter selection.
                  setFilter("");
                  setFlashSeq(chain.brokenAtSeq);
                  // requestAnimationFrame so the DOM has rerendered with the
                  // cleared filter before we look up the row.
                  requestAnimationFrame(() => {
                    const el = listRef.current?.querySelector<HTMLLIElement>(`[data-seq="${chain.brokenAtSeq}"]`);
                    el?.scrollIntoView({ behavior: "smooth", block: "center" });
                  });
                }}
              >
                Jump to row
              </button>
              <button
                type="button"
                className={s.statusJumpBtn}
                onClick={() => { void diagnose(chain.brokenAtSeq); }}
              >
                Diagnose
              </button>
              <button
                type="button"
                className={s.statusJumpBtn}
                onClick={() => { void compareToLastExport(); }}
                title="Compare the current chain against the snapshot saved at the most recent export."
              >
                Compare to last export
              </button>
            </>
          )}
        </div>
      )}

      {/* Last-export comparison readout — only when the operator has clicked
           the button. Forensic-aid: when the snapshot exists, surfaces both
           the normal case (entries appended since export) and the alarming
           one (a seq we ALREADY exported now hashes differently). */}
      {exportComparison && (
        <div className={s.diagnosis} role="region" aria-label="Export comparison">
          <div className={s.diagnosisHead}>
            <span className={s.diagnosisTitle}>Compare · last export</span>
            <button
              type="button"
              className={s.diagnosisClose}
              onClick={() => setExportComparison(null)}
              aria-label="Dismiss comparison"
            >×</button>
          </div>
          {exportComparison.snapshot === null ? (
            <p className={s.diagnosisIssue} data-issue="no_issue_found">
              No export snapshot stored on this device. Build a case bundle (Review → Export full bundle) first; the next chain compare will work.
            </p>
          ) : (
            <>
              <p
                className={s.diagnosisIssue}
                data-issue={
                  exportComparison.comparison.firstDivergenceSeq !== null
                    ? "entry_hash_mismatch"
                    : exportComparison.comparison.missingFromCurrent > 0
                      ? "missing_predecessor"
                      : "no_issue_found"
                }
              >
                {exportComparison.comparison.firstDivergenceSeq !== null
                  ? `Hash divergence at seq #${exportComparison.comparison.firstDivergenceSeq} — entry was modified after the export went out.`
                  : exportComparison.comparison.missingFromCurrent > 0
                    ? `${exportComparison.comparison.missingFromCurrent} entry(s) present in the export are missing from the current chain — possible deletion.`
                    : exportComparison.comparison.appendedSinceExport > 0
                      ? `Chain is consistent with the last export plus ${exportComparison.comparison.appendedSinceExport} new entry(s) appended since.`
                      : "Chain is identical to the last export — nothing has been appended since."}
              </p>
              <dl className={s.diagnosisGrid}>
                <dt>Exported at</dt>
                <dd>{new Date(exportComparison.snapshot.exportedAt).toLocaleString()}</dd>
                <dt>Bundle</dt>
                <dd><code>{exportComparison.snapshot.bundleLabel}</code></dd>
                <dt>Chain length at export</dt>
                <dd>{exportComparison.snapshot.chainLength}</dd>
                <dt>Merkle root</dt>
                <dd><code>{exportComparison.snapshot.merkleRoot ? `${exportComparison.snapshot.merkleRoot.slice(0, 24)}…` : "—"}</code></dd>
                <dt>Compared entries</dt>
                <dd>{exportComparison.comparison.comparedCount}</dd>
                <dt>Appended since</dt>
                <dd>{exportComparison.comparison.appendedSinceExport}</dd>
              </dl>
              <p className={s.diagnosisFoot}>
                Forensic-aid only — the snapshot lives in localStorage and reflects the most recent export from THIS device. A reviewer who has the bundle can still re-verify independently via the included verifier.
              </p>
            </>
          )}
        </div>
      )}

      {/* Diagnostic readout — only when the operator tapped Diagnose. Pure
           inspection; never auto-repairs the chain (that would defeat its
           purpose). The recomputed hash + expected predecessor tell the
           operator exactly which step of the verification failed so a
           tampered row can be distinguished from a missing predecessor or
           a swapped pointer. */}
      {diagnosis && (
        <div className={s.diagnosis} role="region" aria-label={`Chain diagnosis for entry ${diagnosis.seq}`}>
          <div className={s.diagnosisHead}>
            <span className={s.diagnosisTitle}>Diagnosis · seq {diagnosis.seq}</span>
            <button
              type="button"
              className={s.diagnosisClose}
              onClick={() => setDiagnosis(null)}
              aria-label="Dismiss diagnosis"
            >×</button>
          </div>
          <p className={s.diagnosisIssue} data-issue={diagnosis.issue}>
            {diagnosis.issue === "missing_predecessor" && "Predecessor row is missing — chain integrity cannot be confirmed past this break."}
            {diagnosis.issue === "prev_hash_mismatch" && "prev_hash doesn't match the previous row's entry_hash — the chain pointer was rewritten or the predecessor was altered."}
            {diagnosis.issue === "entry_hash_mismatch" && "Stored entry_hash doesn't match the recomputed hash of this row's payload — the row's data was modified after appending."}
            {diagnosis.issue === "no_issue_found" && "Recomputed hash matches stored hash. The verifier may have flagged this seq due to an earlier break — check the predecessor."}
          </p>
          <dl className={s.diagnosisGrid}>
            <dt>Stored entry hash</dt><dd><code>{diagnosis.storedEntryHash.slice(0, 24)}…</code></dd>
            <dt>Recomputed entry hash</dt><dd><code>{diagnosis.recomputedEntryHash ? `${diagnosis.recomputedEntryHash.slice(0, 24)}…` : "—"}</code></dd>
            <dt>Stored prev_hash</dt><dd><code>{diagnosis.storedPrevHash.slice(0, 24)}…</code></dd>
            <dt>Expected prev_hash</dt><dd><code>{diagnosis.expectedPrevHash.startsWith("(") ? diagnosis.expectedPrevHash : `${diagnosis.expectedPrevHash.slice(0, 24)}…`}</code></dd>
          </dl>
          <p className={s.diagnosisFoot}>
            Read-only inspection. Export the full bundle for offline forensic review — don't edit the chain in place.
          </p>
        </div>
      )}

      {/* Controls */}
      <div className={s.controls}>
        <input
          type="text"
          className={s.filterInput}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by kind, actor, or payload text…"
          spellCheck={false}
        />
        <button
          type="button"
          className={s.refreshBtn}
          onClick={() => void reload()}
          disabled={loading}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && <p className={s.error}>{error}</p>}

      <div className={s.kindRow}>
        <span className={s.kindRowLabel}>Quick filter:</span>
        {QUICK_FILTERS.map((qf) => {
          const active = filter === qf.match;
          return (
            <button
              key={qf.id}
              type="button"
              className={`${s.kindChip} ${active ? s.kindChipActive : ""}`.trim()}
              onClick={() => setFilter(qf.match)}
              title={qf.hint}
              aria-pressed={active}
            >
              {qf.label}
            </button>
          );
        })}
      </div>

      {uniqueKinds.length > 0 && (
        <div className={s.kindRow}>
          <span className={s.kindRowLabel}>Visible kinds:</span>
          {uniqueKinds.map((k) => (
            <button
              key={k}
              type="button"
              className={s.kindChip}
              onClick={() => setFilter(filter === k ? "" : k)}
              title={`Filter to ${k}`}
            >
              {k}
            </button>
          ))}
        </div>
      )}

      <ul className={s.list} ref={listRef}>
        {filtered.map((e) => {
          const preflightSummary = preflightSummaries.get(e.seq) ?? null;
          const flashed = flashSeq === e.seq;
          return (
            <li
              key={e.seq}
              data-seq={e.seq}
              className={`${s.row} ${flashed ? s.rowFlash : ""}`.trim()}
            >
              <div className={s.rowHead}>
                <span className={s.rowSeq}>#{e.seq}</span>
                <span className={s.rowKind}>{e.kind}</span>
                <span className={s.rowActor}>{e.actor}</span>
                <span className={s.rowTs}>{new Date(e.ts_utc).toLocaleString()}</span>
                <button
                  type="button"
                  className={s.rowLinkBtn}
                  title="Copy deep-link to this entry"
                  aria-label={`Copy deep-link to seq ${e.seq}`}
                  onClick={() => {
                    // Write the URL with the seq anchor to the clipboard so
                    // the reviewer can paste it elsewhere. We update the
                    // location.hash too — chains the browser's back button
                    // to the deep-link AND makes "view source" obvious.
                    const url = `${window.location.origin}${window.location.pathname}#audit-seq-${e.seq}`;
                    window.history.replaceState(null, "", `#audit-seq-${e.seq}`);
                    void navigator.clipboard?.writeText(url);
                  }}
                >🔗</button>
              </div>
              {preflightSummary && (
                <p className={s.rowSummary} aria-label="Pre-flight snapshot">
                  {preflightSummary}
                </p>
              )}
              <details className={s.rowPayload}>
                <summary>Payload</summary>
                <pre>{prettyPayload(e.payload_json)}</pre>
              </details>
              <code className={s.rowHash}>{e.entry_hash.slice(0, 16)}…</code>
            </li>
          );
        })}
      </ul>

      {entries.length === LIMIT_DEFAULT && (
        <p className={s.foot}>
          Showing the most recent {LIMIT_DEFAULT} of {total} entries. Export the case
          bundle for the full chain.
        </p>
      )}
      {entries.length === 0 && !loading && (
        <p className={s.empty}>No audit entries yet. Start an investigation in Mission Control.</p>
      )}
    </div>
  );
}

function prettyPayload(raw: string): string {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}

/**
 * Surface the preflight snapshot from a session_start row inline so the
 * operator doesn't have to expand the payload JSON to see what the device
 * looked like at the moment of capture. Returns null for any other kind —
 * the row renders without the summary line. We deliberately don't try to
 * be exhaustive; a one-liner with the most actionable numbers (battery %,
 * free storage MB, permission states) is enough to triage at a glance.
 */
interface PreflightCheckPayload {
  id: string;
  level: string;
  data?: {
    storageFreeBytes?: number;
    storageQuotaBytes?: number;
    batteryLevel?: number;
    batteryCharging?: boolean;
    permission?: string;
  };
}
function summarisePreflight(row: AuditRow): string | null {
  if (!row.kind.includes("session_start")) return null;
  let parsed: { metadata?: { preflight?: { checks?: PreflightCheckPayload[] } } };
  try { parsed = JSON.parse(row.payload_json); } catch { return null; }
  const checks = parsed.metadata?.preflight?.checks;
  if (!checks || checks.length === 0) return null;
  const parts: string[] = [];
  for (const c of checks) {
    if (c.id === "battery" && c.data?.batteryLevel != null) {
      const pct = Math.round(c.data.batteryLevel * 100);
      parts.push(`Battery ${pct}%${c.data.batteryCharging ? " ⚡" : ""}`);
    } else if (c.id === "storage" && c.data?.storageFreeBytes != null) {
      const mb = Math.round(c.data.storageFreeBytes / (1024 * 1024));
      parts.push(`${mb}MB free`);
    } else if ((c.id === "camera" || c.id === "mic") && c.data?.permission) {
      parts.push(`${c.id}: ${c.data.permission}`);
    }
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
