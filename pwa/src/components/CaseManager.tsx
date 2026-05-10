/**
 * CaseManager — list every investigation on this device, drill into any
 * one to edit metadata + browse all media (images, audio, video) +
 * export individual assets, and (with confirmation) delete the case.
 *
 * One night = one investigation = potentially many sessions. The
 * sessions are tracked as `evidence_events` with `event_type` of
 * `session_start` / `session_stop` so we don't need a separate table —
 * we just group them in the UI.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { exec, query } from "../lib/db/db";
import { readFile, deletePath } from "../lib/opfs";
import { appendAuditEntry } from "../lib/db/auditLog";
import { setCulturallySensitive } from "../lib/db/repo";
import { buildExportBundle, downloadBlob } from "../lib/forensic/exportBundle";
import type { EvidenceEvent, Investigation, MediaAsset } from "../lib/db/schema";
import s from "./CaseManager.module.css";

interface CaseSummary extends Investigation {
  mediaCount: number;
  audioCount: number;
  imageCount: number;
  videoCount: number;
  eventCount: number;
  sessionCount: number;
}

interface SessionGroup {
  startedAt: string;
  endedAt: string | null;
  events: EvidenceEvent[];
}

function groupSessions(events: EvidenceEvent[]): SessionGroup[] {
  // Walk events in chronological order, opening a new session on session_start
  // and closing on session_stop.
  const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const out: SessionGroup[] = [];
  let current: SessionGroup | null = null;
  for (const ev of sorted) {
    if (ev.event_type === "session_start") {
      if (current) out.push(current);
      current = { startedAt: ev.timestamp, endedAt: null, events: [ev] };
      continue;
    }
    if (!current) {
      current = { startedAt: ev.timestamp, endedAt: null, events: [] };
    }
    current.events.push(ev);
    if (ev.event_type === "session_stop") {
      current.endedAt = ev.timestamp;
      out.push(current);
      current = null;
    }
  }
  if (current) out.push(current);
  return out;
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms <= 0) return "—";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

export function CaseManager() {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [openCaseId, setOpenCaseId] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [openMedia, setOpenMedia] = useState<MediaAsset[]>([]);
  const [openEvents, setOpenEvents] = useState<EvidenceEvent[]>([]);
  const [editing, setEditing] = useState<{ title: string; location_name: string; notes: string } | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [dismissedSuggestionFor, setDismissedSuggestionFor] = useState<Set<string>>(() => new Set());

  const refresh = useCallback(() => setReloadTick((t) => t + 1), []);

  useEffect(() => {
    void (async () => {
      const inv = await query<Investigation>("SELECT * FROM investigations ORDER BY created_at DESC");
      const summaries: CaseSummary[] = [];
      for (const i of inv) {
        const [mediaRows] = await Promise.all([
          query<{ media_type: string; total: number }>(
            "SELECT media_type, COUNT(*) AS total FROM media_assets WHERE investigation_id = ? GROUP BY media_type",
            [i.id],
          ),
        ]);
        const events = await query<{ total: number }>(
          "SELECT COUNT(*) AS total FROM evidence_events WHERE investigation_id = ?",
          [i.id],
        );
        const sessions = await query<{ total: number }>(
          "SELECT COUNT(*) AS total FROM evidence_events WHERE investigation_id = ? AND event_type = 'session_start'",
          [i.id],
        );
        const audioCount = mediaRows.find((r) => r.media_type === "audio")?.total ?? 0;
        const imageCount = mediaRows.find((r) => r.media_type === "image")?.total ?? 0;
        const videoCount = mediaRows.find((r) => r.media_type === "video")?.total ?? 0;
        summaries.push({
          ...i,
          mediaCount: audioCount + imageCount + videoCount,
          audioCount,
          imageCount,
          videoCount,
          eventCount: events[0]?.total ?? 0,
          sessionCount: sessions[0]?.total ?? 0,
        });
      }
      setCases(summaries);
    })();
  }, [reloadTick]);

  useEffect(() => {
    if (!openCaseId) return;
    void (async () => {
      const media = await query<MediaAsset>(
        "SELECT * FROM media_assets WHERE investigation_id = ? ORDER BY timestamp_start DESC",
        [openCaseId],
      );
      const events = await query<EvidenceEvent>(
        "SELECT * FROM evidence_events WHERE investigation_id = ? ORDER BY timestamp ASC",
        [openCaseId],
      );
      setOpenMedia(media);
      setOpenEvents(events);
      const c = cases.find((x) => x.id === openCaseId);
      if (c) {
        setEditing({
          title: c.title,
          location_name: c.location_name ?? "",
          notes: c.notes ?? "",
        });
      }
    })();
  }, [openCaseId, cases]);

  const sessions = useMemo(() => groupSessions(openEvents), [openEvents]);

  // Derive a "null result" suggestion when the case has at least one ENDED
  // session, no current disposition, and no logged posterior_after ever
  // exceeded 0.4. We look at evidence_events whose metadata_json carries a
  // `posterior_after` field (the same payload key the audit-log evidence.*
  // entries use; see siteSession.applyAndAudit + Review.tsx parsing).
  const openCase = openCaseId ? cases.find((c) => c.id === openCaseId) ?? null : null;
  const suggestNullResult = useMemo(() => {
    if (!openCase) return false;
    if (openCase.disposition) return false;
    const hasEndedSession = sessions.some((sg) => sg.endedAt !== null);
    if (!hasEndedSession) return false;
    let sawPosteriorEvent = false;
    let anyAboveThreshold = false;
    for (const ev of openEvents) {
      if (!ev.metadata_json) continue;
      let meta: Record<string, unknown>;
      try { meta = JSON.parse(ev.metadata_json) as Record<string, unknown>; } catch { continue; }
      if (typeof meta.posterior_after !== "number") continue;
      sawPosteriorEvent = true;
      if (meta.posterior_after > 0.4) {
        anyAboveThreshold = true;
        break;
      }
    }
    if (!sawPosteriorEvent) return false; // no signal — can't advise
    return !anyAboveThreshold;
  }, [openCase, sessions, openEvents]);

  const showSuggestion = suggestNullResult && openCaseId !== null && !dismissedSuggestionFor.has(openCaseId);

  const handleDismissSuggestion = async () => {
    if (!openCaseId) return;
    setDismissedSuggestionFor((prev) => {
      const next = new Set(prev);
      next.add(openCaseId);
      return next;
    });
    try {
      await appendAuditEntry({
        actor: "user",
        kind: "disposition.suggestion_dismiss",
        payload: { investigation_id: openCaseId, suggested: "null", reason: "no posterior_after > 0.4" },
      });
    } catch { /* audit failures must not break UX */ }
  };

  const handleSaveEdits = async () => {
    if (!openCaseId || !editing) return;
    setStatusMsg(null);
    try {
      await exec(
        "UPDATE investigations SET title = ?, location_name = ?, notes = ? WHERE id = ?",
        [editing.title.trim() || "Unnamed case", editing.location_name.trim() || null, editing.notes.trim() || null, openCaseId],
      );
      await appendAuditEntry({
        actor: "user",
        kind: "investigation.edit",
        payload: { id: openCaseId, title: editing.title.trim(), location_name: editing.location_name.trim() || null },
      });
      setStatusMsg("Saved.");
      refresh();
    } catch (err) {
      setStatusMsg(`Save failed: ${(err as Error).message}`);
    }
  };

  const handleToggleCulturallySensitive = async (next: boolean) => {
    if (!openCaseId) return;
    setStatusMsg(null);
    try {
      await setCulturallySensitive(openCaseId, next);
      setStatusMsg(next ? "Marked culturally sensitive — cloud AI and sync blocked for this case." : "Cultural-sensitivity flag cleared.");
      refresh();
    } catch (err) {
      setStatusMsg(`Failed: ${(err as Error).message}`);
    }
  };

  const handleSetDisposition = async (disposition: "null" | "inconclusive" | "flagged" | "confirmed_mundane") => {
    if (!openCaseId) return;
    try {
      await exec("UPDATE investigations SET disposition = ? WHERE id = ?", [disposition, openCaseId]);
      await appendAuditEntry({
        actor: "user",
        kind: "investigation.disposition",
        payload: { id: openCaseId, disposition },
      });
      setStatusMsg(`Disposition set: ${disposition}`);
      refresh();
    } catch (err) {
      setStatusMsg(`Failed: ${(err as Error).message}`);
    }
  };

  const handleDownloadMedia = async (asset: MediaAsset) => {
    try {
      const file = await readFile(asset.file_path);
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url;
      a.download = asset.file_path.split("/").pop() ?? "media";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setStatusMsg(`Download failed: ${(err as Error).message}`);
    }
  };

  const handleDownloadAll = async () => {
    if (openMedia.length === 0) return;
    setStatusMsg(`Downloading ${openMedia.length} files…`);
    for (const asset of openMedia) {
      // Browsers throttle rapid auto-downloads; small delay keeps things sane.
      await new Promise((r) => setTimeout(r, 250));
      await handleDownloadMedia(asset);
    }
    setStatusMsg(`Triggered ${openMedia.length} downloads.`);
  };

  const handleExportBundle = async () => {
    if (!openCaseId) return;
    setStatusMsg("Building bundle…");
    try {
      const { blob, summary } = await buildExportBundle(openCaseId);
      downloadBlob(blob, summary.filename);
      const sizeMb = (summary.byteLength / 1024 / 1024).toFixed(1);
      setStatusMsg(`Bundle exported · ${sizeMb} MB · ${summary.mediaIncluded} media files${summary.mediaMissing ? ` (${summary.mediaMissing} missing)` : ""}`);
      await appendAuditEntry({
        actor: "user",
        kind: "case.export",
        payload: { investigation_id: openCaseId, bytes: summary.byteLength, media_included: summary.mediaIncluded, media_missing: summary.mediaMissing },
      }).catch(() => { /* ignore */ });
    } catch (err) {
      setStatusMsg(`Bundle failed: ${(err as Error).message}`);
    }
  };

  const handleDeleteMedia = async (asset: MediaAsset) => {
    if (!confirm(`Delete media file ${asset.file_path}? The audit-chain entry remains.`)) return;
    try {
      await deletePath(asset.file_path).catch(() => { /* file may already be gone */ });
      await exec("DELETE FROM media_assets WHERE id = ?", [asset.id]);
      await appendAuditEntry({
        actor: "user",
        kind: "media.delete",
        payload: { id: asset.id, file_path: asset.file_path, investigation_id: asset.investigation_id },
      });
      setStatusMsg("Media deleted.");
      refresh();
      const media = await query<MediaAsset>(
        "SELECT * FROM media_assets WHERE investigation_id = ? ORDER BY timestamp_start DESC",
        [asset.investigation_id],
      );
      setOpenMedia(media);
    } catch (err) {
      setStatusMsg(`Delete failed: ${(err as Error).message}`);
    }
  };

  const handleDeleteCase = async () => {
    if (!openCaseId) return;
    const c = cases.find((x) => x.id === openCaseId);
    if (!c) return;
    if (!confirm(`Delete case "${c.title}" and all linked media? This cannot be undone. The audit chain entry remains.`)) return;
    try {
      // Best-effort delete of all OPFS media for this case.
      for (const asset of openMedia) {
        await deletePath(asset.file_path).catch(() => { /* ignore */ });
      }
      await exec("DELETE FROM investigations WHERE id = ?", [openCaseId]);
      await appendAuditEntry({
        actor: "user",
        kind: "investigation.delete",
        payload: { id: openCaseId, title: c.title, media_purged: openMedia.length },
      });
      setOpenCaseId(null);
      setOpenMedia([]);
      setOpenEvents([]);
      setEditing(null);
      setStatusMsg("Case deleted.");
      refresh();
    } catch (err) {
      setStatusMsg(`Delete failed: ${(err as Error).message}`);
    }
  };

  return (
    <div className={s.wrap}>
      <header className={s.head}>
        <h2 className={s.title}>Cases</h2>
        <span className={s.count}>{cases.length} investigation{cases.length === 1 ? "" : "s"} on this device</span>
      </header>

      {cases.length === 0 ? (
        <p className={s.empty}>No investigations yet. Begin one in <strong>Mission Control</strong>.</p>
      ) : (
        <ul className={s.list}>
          {cases.map((c) => (
            <li key={c.id} className={s.row}>
              <button
                type="button"
                className={`${s.rowBtn} ${openCaseId === c.id ? s.rowBtnActive : ""}`.trim()}
                onClick={() => setOpenCaseId(openCaseId === c.id ? null : c.id)}
              >
                <div className={s.rowMain}>
                  <span className={s.rowTitle}>{c.title}</span>
                  <span className={s.rowMeta}>
                    {c.location_name ? `${c.location_name} · ` : ""}
                    {new Date(c.created_at).toLocaleString()}
                  </span>
                  <span className={s.rowStats}>
                    <span>{c.sessionCount} session{c.sessionCount === 1 ? "" : "s"}</span>
                    <span>·</span>
                    <span>{c.audioCount} audio</span>
                    <span>·</span>
                    <span>{c.imageCount} image</span>
                    <span>·</span>
                    <span>{c.videoCount} video</span>
                    <span>·</span>
                    <span>{c.eventCount} events</span>
                    {c.disposition && <><span>·</span><span className={s.disposition}>{c.disposition}</span></>}
                  </span>
                </div>
                <span className={s.rowChevron}>{openCaseId === c.id ? "▾" : "▸"}</span>
              </button>

              {openCaseId === c.id && editing && (
                <div className={s.detail}>
                  <div className={s.editRow}>
                    <label className={s.field}>
                      <span className={s.fieldLabel}>Title</span>
                      <input
                        className={s.input}
                        value={editing.title}
                        onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                      />
                    </label>
                    <label className={s.field}>
                      <span className={s.fieldLabel}>Location</span>
                      <input
                        className={s.input}
                        value={editing.location_name}
                        onChange={(e) => setEditing({ ...editing, location_name: e.target.value })}
                      />
                    </label>
                  </div>
                  <label className={s.field}>
                    <span className={s.fieldLabel}>Notes</span>
                    <textarea
                      className={s.textarea}
                      rows={3}
                      value={editing.notes}
                      onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                    />
                  </label>

                  <label className={s.sensitiveRow}>
                    <span className={s.sensitiveText}>
                      <strong>Culturally sensitive site</strong>
                      <span className={s.sensitiveHint}>
                        Blocks cloud AI and cloud sync for this case. Audit chain still records locally.
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={Number(c.culturally_sensitive ?? 0) === 1}
                      onChange={(e) => handleToggleCulturallySensitive(e.target.checked)}
                    />
                  </label>

                  {showSuggestion && (
                    <div className={s.suggestion}>
                      <span className={s.suggestionText}>
                        <strong>Suggested disposition: NULL RESULT</strong> — no posterior increment exceeded 0.4 in any session.
                      </span>
                      <button type="button" className={s.dispo} onClick={() => handleSetDisposition("null")}>Confirm null result</button>
                      <button type="button" className={s.dispo} onClick={() => handleSetDisposition("inconclusive")}>Set inconclusive</button>
                      <button type="button" className={s.dispo} onClick={handleDismissSuggestion}>Dismiss</button>
                    </div>
                  )}

                  <div className={s.actions}>
                    <button type="button" className={s.primary} onClick={handleSaveEdits}>Save edits</button>
                    <div className={s.dispoGroup}>
                      <span className={s.fieldLabel}>Disposition</span>
                      <button type="button" className={s.dispo} onClick={() => handleSetDisposition("null")}>Null result</button>
                      <button type="button" className={s.dispo} onClick={() => handleSetDisposition("inconclusive")}>Inconclusive</button>
                      <button type="button" className={s.dispo} onClick={() => handleSetDisposition("flagged")}>Flagged</button>
                      <button type="button" className={s.dispo} onClick={() => handleSetDisposition("confirmed_mundane")}>Mundane</button>
                    </div>
                  </div>

                  {sessions.length > 0 && (
                    <div className={s.sessionsBlock}>
                      <span className={s.blockLabel}>Sessions ({sessions.length})</span>
                      <ul className={s.sessionsList}>
                        {sessions.map((sg, i) => (
                          <li key={i} className={s.sessionRow}>
                            <span className={s.sessionTime}>{new Date(sg.startedAt).toLocaleTimeString()}</span>
                            <span className={s.sessionDur}>{formatDuration(sg.startedAt, sg.endedAt)}</span>
                            <span className={s.sessionEvents}>{sg.events.length} events</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className={s.mediaBlock}>
                    <div className={s.blockHead}>
                      <span className={s.blockLabel}>Media ({openMedia.length})</span>
                      <button
                        type="button"
                        className={s.secondary}
                        onClick={handleExportBundle}
                      >
                        Export bundle (.zip)
                      </button>
                      <button
                        type="button"
                        className={s.secondary}
                        onClick={handleDownloadAll}
                        disabled={openMedia.length === 0}
                      >
                        Download media only
                      </button>
                      <Link
                        to={`/brief/${c.id}`}
                        className={s.secondary}
                        title="Print a one-page case brief"
                      >
                        Print case brief
                      </Link>
                    </div>
                    {openMedia.length === 0 ? (
                      <p className={s.emptySmall}>No media captured yet.</p>
                    ) : (
                      <ul className={s.mediaList}>
                        {openMedia.map((m) => {
                          let meta: { duration_s?: number; bytes?: number } = {};
                          try { meta = m.metadata_json ? JSON.parse(m.metadata_json) : {}; } catch { /* ignore */ }
                          return (
                            <li key={m.id} className={s.mediaRow}>
                              <span className={`${s.mediaBadge} ${s[`badge_${m.media_type}`]}`.trim()}>
                                {m.media_type}
                              </span>
                              <div className={s.mediaMain}>
                                <span className={s.mediaName}>{m.file_path.split("/").pop()}</span>
                                <span className={s.mediaMeta}>
                                  {new Date(m.timestamp_start).toLocaleTimeString()} ·
                                  {" "}
                                  {meta.duration_s ? `${meta.duration_s.toFixed(1)}s` : "—"} ·
                                  {" "}
                                  {meta.bytes ? `${(meta.bytes / 1024).toFixed(0)} KB` : "—"}
                                  {m.checksum_sha256 && <> · <code>{m.checksum_sha256.slice(0, 10)}…</code></>}
                                </span>
                              </div>
                              <div className={s.mediaActions}>
                                <button type="button" className={s.iconBtn} onClick={() => handleDownloadMedia(m)} title="Download">⬇</button>
                                <button type="button" className={s.iconBtnDanger} onClick={() => handleDeleteMedia(m)} title="Delete">×</button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>

                  <div className={s.dangerBlock}>
                    <button type="button" className={s.danger} onClick={handleDeleteCase}>
                      Delete case + media
                    </button>
                  </div>

                  {statusMsg && <p className={s.status}>{statusMsg}</p>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

