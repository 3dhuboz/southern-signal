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
        {filtered.map((e) => (
          <li key={e.seq} className={s.row}>
            <div className={s.rowHead}>
              <span className={s.rowSeq}>#{e.seq}</span>
              <span className={s.rowKind}>{e.kind}</span>
              <span className={s.rowActor}>{e.actor}</span>
              <span className={s.rowTs}>{new Date(e.ts_utc).toLocaleString()}</span>
            </div>
            <details className={s.rowPayload}>
              <summary>Payload</summary>
              <pre>{prettyPayload(e.payload_json)}</pre>
            </details>
            <code className={s.rowHash}>{e.entry_hash.slice(0, 16)}…</code>
          </li>
        ))}
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
