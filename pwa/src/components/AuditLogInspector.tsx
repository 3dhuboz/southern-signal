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

import { useCallback, useEffect, useMemo, useState } from "react";
import { query } from "../lib/db/db";
import { verifyAuditChain } from "../lib/db/auditLog";
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
  const [filter, setFilter] = useState<string>("");
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
            </>
          )}
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

      <ul className={s.list}>
        {filtered.map((e) => {
          const preflightSummary = preflightSummaries.get(e.seq) ?? null;
          return (
            <li key={e.seq} className={s.row}>
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
