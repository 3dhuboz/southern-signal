/**
 * SyncPanel — operator-configurable cloud upload of audit/media/events.
 *
 * Hard-blocked when globalCulturalSensitivityFlag is on (matches the AI
 * gate). Otherwise the operator pastes endpoint + token, toggles enabled,
 * and either auto-syncs in the background or uses Sync now to flush
 * immediately. Failed rows can be retried in bulk.
 */

import { useCallback, useEffect, useState } from "react";
import { usePreferences } from "../lib/preferences";
import { flushSync } from "../lib/sync/syncWorker";
import { getStats, retryAllFailed, purgeDoneOlderThan, listRecentFailures } from "../lib/sync/queue";
import type { SyncStats, SyncItem, SyncKind } from "../lib/sync/types";
import st from "../views/Setup.module.css";

interface RemoteStatus {
  configured: boolean;
  has_token: boolean;
  has_d1: boolean;
  has_r2: boolean;
  signed_auth_kv: boolean;
  counts?: Record<string, number>;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "in the future";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

type FailureRow = Pick<SyncItem, "id" | "kind" | "ref_id" | "attempts" | "last_error" | "next_attempt_at">;

function kindColor(kind: SyncKind): string {
  if (kind === "audit") return "var(--signal)";
  if (kind === "media_blob") return "var(--danger)";
  return "var(--text-muted)";
}

function truncate(s: string | null | undefined, n: number): string {
  if (!s) return "—";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function SyncPanel() {
  const [prefs, setPrefs] = usePreferences();
  const [stats, setStats] = useState<SyncStats | null>(null);
  const [failures, setFailures] = useState<FailureRow[]>([]);
  const [remote, setRemote] = useState<RemoteStatus | null>(null);
  const [endpointDraft, setEndpointDraft] = useState(prefs.sync.endpoint);
  const [tokenDraft, setTokenDraft] = useState(prefs.sync.token ?? "");
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const refreshStats = useCallback(async () => {
    try {
      const [s, f] = await Promise.all([getStats(), listRecentFailures(5)]);
      setStats(s);
      setFailures(f);
    } catch { /* ignore */ }
  }, []);

  const refreshRemote = useCallback(async () => {
    if (!prefs.sync.enabled || !prefs.sync.endpoint) { setRemote(null); return; }
    try {
      const statusUrl = prefs.sync.endpoint.replace(/\/upload$/, "/status");
      const resp = await fetch(statusUrl, { method: "GET" });
      if (!resp.ok) { setRemote(null); return; }
      setRemote(await resp.json() as RemoteStatus);
    } catch { setRemote(null); }
  }, [prefs.sync.enabled, prefs.sync.endpoint]);

  useEffect(() => { void refreshStats(); }, [refreshStats]);
  useEffect(() => { void refreshRemote(); }, [refreshRemote]);

  // Refresh stats after any flush.
  useEffect(() => {
    const id = window.setInterval(refreshStats, 5000);
    return () => window.clearInterval(id);
  }, [refreshStats]);

  const blocked = prefs.globalCulturalSensitivityFlag;

  const handleSave = useCallback(() => {
    setPrefs({ sync: { ...prefs.sync, endpoint: endpointDraft.trim(), token: tokenDraft.trim() || null } });
    setStatusMsg("Saved.");
    window.setTimeout(() => setStatusMsg(null), 2000);
  }, [endpointDraft, tokenDraft, prefs.sync, setPrefs]);

  const handleToggle = useCallback((enabled: boolean) => {
    setPrefs({ sync: { ...prefs.sync, enabled } });
  }, [prefs.sync, setPrefs]);

  const handleSyncNow = useCallback(async () => {
    setBusy(true); setStatusMsg(null);
    try {
      const result = await flushSync();
      if (result.skippedReason) setStatusMsg(`Skipped: ${result.skippedReason}`);
      else setStatusMsg(`${result.succeeded}/${result.attempted} uploaded${result.failed ? ` · ${result.failed} failed` : ""}`);
      await refreshStats();
      await refreshRemote();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  }, [refreshStats, refreshRemote]);

  const handleRetryFailed = useCallback(async () => {
    const n = await retryAllFailed();
    setStatusMsg(`Re-queued ${n} failed row${n === 1 ? "" : "s"}.`);
    await refreshStats();
  }, [refreshStats]);

  const handleTrim = useCallback(async () => {
    const n = await purgeDoneOlderThan(7);
    setStatusMsg(`Trimmed ${n} done row${n === 1 ? "" : "s"} older than 7 days.`);
    await refreshStats();
  }, [refreshStats]);

  return (
    <section className={st.panel}>
      <header className={st.panelHeader}>
        <h2 className={st.panelTitle}>Cloud sync</h2>
        <span className={st.panelBadge}>
          {blocked ? "BLOCKED · sensitive" : prefs.sync.enabled ? "ENABLED" : "OFF"}
        </span>
      </header>
      <p className={st.panelLede}>
        Background upload of audit chain, evidence events, media rows and media bytes to your operator-configured Cloudflare R2 + D1. Local DB stays the source of truth — sync is mirror-only and idempotent. Disabled automatically while the cultural-sensitivity flag is on.
      </p>

      <label className={st.toggleRow}>
        <span>
          <strong>Enable cloud sync</strong>
          <span className={st.toggleHint}>
            Off by default. When enabled, every audit/event/media row appended on this device is queued for upload to the endpoint below. Failed uploads back off exponentially and retry automatically when network returns.
          </span>
        </span>
        <input
          type="checkbox"
          checked={prefs.sync.enabled}
          disabled={blocked}
          onChange={(e) => handleToggle(e.target.checked)}
        />
      </label>

      <div className={st.field}>
        <label className={st.fieldLabel} htmlFor="sync-endpoint">Upload endpoint</label>
        <input
          id="sync-endpoint"
          className={st.input}
          type="text"
          placeholder="/api/sync/upload"
          value={endpointDraft}
          onChange={(e) => setEndpointDraft(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          disabled={blocked}
        />
      </div>
      <div className={st.field}>
        <label className={st.fieldLabel} htmlFor="sync-token">Bearer token (matches deployment SYNC_TOKEN)</label>
        <input
          id="sync-token"
          className={st.input}
          type="password"
          placeholder="paste your sync token"
          value={tokenDraft}
          onChange={(e) => setTokenDraft(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          disabled={blocked}
        />
      </div>
      <div className={st.actionsRow}>
        <button type="button" className={`btn btn-primary ${st.primarySize}`} onClick={handleSave} disabled={blocked}>Save endpoint</button>
        <button type="button" className={`btn btn-primary ${st.primarySize}`} onClick={handleSyncNow} disabled={blocked || !prefs.sync.enabled || busy}>
          {busy ? "Syncing…" : "Sync now"}
        </button>
      </div>
      {statusMsg && <p className={st.statusLine}>{statusMsg}</p>}

      <dl className={st.statusLine} style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 16px", margin: 0 }}>
        <dt>Pending</dt><dd>{stats?.pending ?? 0}</dd>
        <dt>In flight</dt><dd>{stats?.in_flight ?? 0}</dd>
        <dt>Done</dt><dd>{stats?.done ?? 0}</dd>
        <dt>Failed</dt><dd>{stats?.failed ?? 0}</dd>
        <dt>Oldest pending</dt><dd>{formatRelative(stats?.oldest_pending_at ?? null)}</dd>
        <dt>Last upload</dt><dd>{formatRelative(stats?.last_uploaded_at ?? null)}</dd>
      </dl>

      {failures.length > 0 && (
        <details className={st.statusLine} style={{ margin: 0 }}>
          <summary style={{ cursor: "pointer", fontSize: 12 }}>
            Recent failures ({failures.length})
          </summary>
          <ul
            style={{
              listStyle: "none",
              margin: "6px 0 0",
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: 4,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 11,
              lineHeight: 1.4,
              wordBreak: "break-word",
            }}
          >
            {failures.map((f) => (
              <li key={f.id} style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <span style={{ color: kindColor(f.kind), fontWeight: 600 }}>{f.kind.toUpperCase()}</span>
                <span style={{ color: "var(--text-secondary)" }}>{f.ref_id.slice(0, 8)}…</span>
                <span style={{ color: "var(--text-muted)" }}>{f.attempts}x</span>
                <span style={{ color: "var(--text-secondary)", flex: "1 1 200px" }}>{truncate(f.last_error, 80)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className={st.actionsRow}>
        <button type="button" className={`btn btn-primary ${st.primarySize}`} onClick={handleRetryFailed} disabled={!stats || stats.failed === 0}>
          Retry failed ({stats?.failed ?? 0})
        </button>
        <button type="button" className={`btn btn-primary ${st.primarySize}`} onClick={handleTrim} disabled={!stats || stats.done === 0}>
          Trim done &gt; 7 days
        </button>
      </div>

      {prefs.sync.enabled && remote && (
        <p className={st.privacyNote}>
          Server: {remote.configured ? "configured" : "missing bindings"} · D1 {remote.has_d1 ? "✓" : "✗"} · R2 {remote.has_r2 ? "✓" : "✗"} · Token {remote.has_token ? "✓" : "✗"} · Signature KV {remote.signed_auth_kv ? "✓" : "✗"}
          {remote.counts && (
            <> · server rows: investigations={remote.counts.investigations} events={remote.counts.events} media={remote.counts.media} audit={remote.counts.audit}</>
          )}
        </p>
      )}

      <p className={st.privacyNote}>
        Sync uploads happen over the same TLS Pages domain as the AI proxy. Audit chain hashes go up alongside the rows so the server copy is independently verifiable. Cultural-sensitivity flag in Privacy → above hard-disables this regardless of the toggle.
      </p>
    </section>
  );
}
