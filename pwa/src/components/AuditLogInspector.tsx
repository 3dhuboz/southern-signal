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
