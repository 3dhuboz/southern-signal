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
import { createInvestigation, deleteDossier, setCulturallySensitive } from "../lib/db/repo";
import { getProtocol } from "../lib/db/protocolRepo";
import { usePreferences } from "../lib/preferences";
import type { InvestigationProtocol, ResearchDossierRow } from "../lib/db/schema";
import { clearBaseline } from "../lib/posterior/sessionBaseline";
import { buildExportBundle, downloadBlob } from "../lib/forensic/exportBundle";
import { autoName } from "../lib/cases/autoName";
import type { EvidenceEvent, Investigation, MediaAsset } from "../lib/db/schema";
import { EventDebunkPanel } from "./EventDebunkPanel";
import { ProtocolWizard } from "./ProtocolWizard";
import { ProtocolSummaryChip } from "./ProtocolSummaryChip";
import { SensitiveSiteWarning } from "./SensitiveSiteWarning";
import {
  findNearbySites,
  getCurrentLocationSilent,
  type SiteMatch,
} from "../lib/sensors/sensitiveSiteClassifier";
import s from "./CaseManager.module.css";

interface CaseSummary extends Investigation {
  mediaCount: number;
  audioCount: number;
  imageCount: number;
  videoCount: number;
  eventCount: number;
  sessionCount: number;
  /** v4: count of saved AI Investigator dossiers attached to this case
   *  PLUS standalone (recon) dossiers whose venue_name matches title or
   *  location_name — same matching rule the brief uses. Lets the row
   *  show a "🗂 2" badge so the operator sees prior research at a glance. */
  dossierCount: number;
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
  const [prefs] = usePreferences();
  const researchEnabled = prefs.research.enabled;
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [openCaseId, setOpenCaseId] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [openMedia, setOpenMedia] = useState<MediaAsset[]>([]);
  const [openEvents, setOpenEvents] = useState<EvidenceEvent[]>([]);
  const [openDossiers, setOpenDossiers] = useState<ResearchDossierRow[]>([]);
  const [editing, setEditing] = useState<{ title: string; location_name: string; notes: string } | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [dismissedSuggestionFor, setDismissedSuggestionFor] = useState<Set<string>>(() => new Set());
  // New-case form. `newCaseOpen` controls mount/unmount of the form, so the
  // input only exists while the form is showing — when it remounts we get a
  // fresh auto-name from the useState initialiser.
  const [newCaseOpen, setNewCaseOpen] = useState(false);
  const [newCaseTitle, setNewCaseTitle] = useState<string>(() => autoName());

  // Protocol wizard state
  const [wizardCaseId, setWizardCaseId] = useState<string | null>(null);
  const [wizardProtocol, setWizardProtocol] = useState<InvestigationProtocol | null>(null);
  const [wizardLockedHash, setWizardLockedHash] = useState<string | null>(null);

  // Sensitive site classifier: runs silently when new-case form opens.
  const [siteMatches, setSiteMatches] = useState<SiteMatch[]>([]);
  const [siteAcknowledged, setSiteAcknowledged] = useState(false);
  const [showSiteWarning, setShowSiteWarning] = useState(false);

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
        // Dossier count — same id-or-venue-match rule the brief uses.
        // Wrapped in try/catch so pre-v4 installs (no table) skip
        // gracefully instead of erroring out the whole load.
        let dossierCount = 0;
        try {
          const dossierRows = await query<{ total: number }>(
            `SELECT COUNT(*) AS total FROM research_dossiers
             WHERE investigation_id = ?
                OR (investigation_id IS NULL
                    AND (LOWER(venue_name) = LOWER(?) OR LOWER(venue_name) = LOWER(?)))`,
            [i.id, i.title ?? "", i.location_name ?? ""],
          );
          dossierCount = dossierRows[0]?.total ?? 0;
        } catch { /* pre-v4 schema — no dossiers */ }
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
          dossierCount,
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
      // Dossiers attached to this case OR standalone recon matching the
      // case's title / location_name — same rule the brief uses.
      let dossiers: ResearchDossierRow[] = [];
      try {
        const c = cases.find((x) => x.id === openCaseId);
        dossiers = await query<ResearchDossierRow>(
          `SELECT * FROM research_dossiers
           WHERE investigation_id = ?
              OR (investigation_id IS NULL
                  AND (LOWER(venue_name) = LOWER(?) OR LOWER(venue_name) = LOWER(?)))
           ORDER BY created_at DESC
           LIMIT 50`,
          [openCaseId, c?.title ?? "", c?.location_name ?? ""],
        );
      } catch { /* pre-v4 — no dossiers table */ }
      setOpenMedia(media);
      setOpenEvents(events);
      setOpenDossiers(dossiers);
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

  const handleOpenNewCase = () => {
    // Always re-seed the title on each "open" so the timestamp is current —
    // even if the form was previously closed with stale text in state.
    setNewCaseTitle(autoName());
    setSiteAcknowledged(false);
    setSiteMatches([]);
    setNewCaseOpen(true);

    // Silently check for nearby colonial massacre sites (no permission prompt).
    void getCurrentLocationSilent().then((coords) => {
      if (!coords) return;
      const matches = findNearbySites(coords.latitude, coords.longitude);
      if (matches.length > 0) {
        setSiteMatches(matches);
        setShowSiteWarning(true);
      }
    });
  };

  const handleCancelNewCase = () => {
    setNewCaseOpen(false);
    setShowSiteWarning(false);
    setSiteMatches([]);
    setSiteAcknowledged(false);
  };

  const handleOpenWizard = async (caseId: string) => {
    const c = cases.find((x) => x.id === caseId);
    if (!c) return;
    const protocol = await getProtocol(caseId).catch(() => null);
    setWizardProtocol(protocol);
    setWizardLockedHash(c.protocol_hash ?? null);
    setWizardCaseId(caseId);
  };

  const handleCloseWizard = () => {
    setWizardCaseId(null);
    setWizardProtocol(null);
    setWizardLockedHash(null);
  };

  const handleWizardSave = (protocol: InvestigationProtocol) => {
    setWizardProtocol(protocol);
    // Refresh the case list so the chip updates
    refresh();
  };

  const handleWizardLock = (hash: string) => {
    setWizardLockedHash(hash);
    refresh();
  };

  const handleSubmitNewCase = async () => {
    // If nearby massacre sites were found but not acknowledged, surface the
    // warning modal instead of proceeding.
    if (siteMatches.length > 0 && !siteAcknowledged) {
      setShowSiteWarning(true);
      return;
    }

    // If the operator cleared the field, fall back to a fresh auto-name —
    // never let an empty title hit the database.
    const trimmed = newCaseTitle.trim();
    const finalTitle = trimmed || autoName();
    setStatusMsg(null);
    try {
      await createInvestigation({ title: finalTitle });
      setNewCaseOpen(false);
      setSiteMatches([]);
      setSiteAcknowledged(false);
      setStatusMsg(`Created "${finalTitle}".`);
      refresh();
    } catch (err) {
      setStatusMsg(`Create failed: ${(err as Error).message}`);
    }
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

  const handleDeleteDossier = async (dossier: ResearchDossierRow) => {
    if (!confirm(`Delete dossier "${dossier.venue_name}" (${new Date(dossier.created_at).toLocaleString()})?\n\nIt'll be removed from this case's Evidence Brief. An audit entry will record the deletion.`)) return;
    try {
      await deleteDossier(dossier.id);
      setStatusMsg("Dossier deleted.");
      setOpenDossiers((rows) => rows.filter((r) => r.id !== dossier.id));
      refresh();
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
      // Sweep the per-case baseline summary out of localStorage. The DB
      // row is gone, the OPFS bytes are gone — this orphan would just
      // accumulate. clearBaseline is a silent no-op if nothing's there.
      clearBaseline(openCaseId);
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
        {!newCaseOpen && (
          <button type="button" className={`btn btn-ghost ${s.btnSize}`} onClick={handleOpenNewCase}>
            + New case
          </button>
        )}
      </header>

      {newCaseOpen && (
        <div className={s.newCaseBlock}>
          {/* Sensitive site badge — shown after location check resolves */}
          {siteMatches.length > 0 && !siteAcknowledged && (
            <div className={s.siteAlertBadge}>
              <span aria-hidden="true">⚠</span>{" "}
              Sensitive site nearby — acknowledgement required before creating.
              <button
                type="button"
                className={s.siteAlertLink}
                onClick={() => setShowSiteWarning(true)}
              >
                Review
              </button>
            </div>
          )}
          {siteMatches.length > 0 && siteAcknowledged && (
            <div className={s.siteAcknowledgedBadge}>
              <span aria-hidden="true">✓</span>{" "}
              Sensitive site acknowledged
            </div>
          )}
          <label className={s.field}>
            <span className={s.fieldLabel}>Title</span>
            <input
              className={s.input}
              autoFocus
              value={newCaseTitle}
              onChange={(e) => setNewCaseTitle(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              placeholder={autoName()}
            />
          </label>
          <div className={s.actions}>
            <button
              type="button"
              className={`btn btn-primary ${s.btnSize}`}
              onClick={handleSubmitNewCase}
              disabled={siteMatches.length > 0 && !siteAcknowledged}
            >
              Create case
            </button>
            <button type="button" className={`btn btn-ghost ${s.btnSize}`} onClick={handleCancelNewCase}>Cancel</button>
          </div>
        </div>
      )}

      {cases.length === 0 ? (
        <div className={s.emptyBlock}>
          {/* Schematic empty-cases illustration: a case-folder / clipboard
              outline with a soft pulse-line waveform sitting "inside" — the
              container that will hold the user's first investigation. Pure
              currentColor, line-based, ~100px wide. Decorative; the copy
              below carries the meaning. */}
          <svg
            viewBox="0 0 120 90"
            className={s.casesEmptyArt}
            aria-hidden="true"
            xmlns="http://www.w3.org/2000/svg"
          >
            {/* Clipboard / folder body */}
            <rect
              x="14" y="14" width="92" height="68" rx="6"
              fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.85"
            />
            {/* Folder tab + clip at top */}
            <rect
              x="46" y="8" width="28" height="10" rx="2"
              fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.85"
            />
            {/* Two faint ruled lines suggesting "fields waiting to be filled" */}
            <g stroke="currentColor" strokeWidth="0.8" opacity="0.32" strokeLinecap="round">
              <line x1="24" y1="30" x2="64" y2="30" />
              <line x1="24" y1="38" x2="54" y2="38" />
            </g>
            {/* Pulse-line waveform inside the folder — a flat baseline with a
                single subtle blip, signalling "this is where signal lands" */}
            <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
              <path
                d="M 22 62 H 44 L 50 54 L 56 70 L 62 50 L 68 66 L 74 62 H 98"
                strokeWidth="1.6"
                opacity="0.9"
              />
              {/* Faint baseline rule behind it */}
              <path
                d="M 22 62 H 98"
                strokeWidth="0.7"
                strokeDasharray="2 3"
                opacity="0.3"
              />
            </g>
          </svg>
          <p className={s.empty}>No investigations yet. Begin one in <strong>Mission Control</strong>.</p>
        </div>
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
                    {c.dossierCount > 0 && (
                      <>
                        <span>·</span>
                        <span className={s.dossierBadge} title="Saved AI Investigator dossiers for this venue">
                          🗂 {c.dossierCount} dossier{c.dossierCount === 1 ? "" : "s"}
                        </span>
                      </>
                    )}
                    {c.disposition && <><span>·</span><span className={s.disposition}>{c.disposition}</span></>}
                    <span>·</span>
                    <ProtocolSummaryChip
                      protocolJson={c.protocol_json ?? null}
                      protocolHash={c.protocol_hash ?? null}
                    />
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
                    <button type="button" className={`btn btn-primary ${s.btnSize}`} onClick={handleSaveEdits}>Save edits</button>
                    {/* Protocol wizard — shows current lock state, always accessible */}
                    <button
                      type="button"
                      className={`btn btn-ghost ${s.btnSize}`}
                      onClick={() => handleOpenWizard(c.id)}
                      title={c.protocol_hash ? "View locked protocol" : c.protocol_json ? "Edit draft protocol" : "Write pre-registered hypothesis"}
                    >
                      {c.protocol_hash ? "🔒 View protocol" : c.protocol_json ? "📋 Edit protocol" : "📋 Write protocol"}
                    </button>
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
                        {sessions.map((sg, i) => {
                          // Events within this session that need debunking review.
                          const reviewableEvents = sg.events.filter(
                            (ev) => ev.event_type === "marker" || ev.event_type === "anomaly",
                          );
                          return (
                            <li key={i} className={s.sessionRow}>
                              <span className={s.sessionTime}>{new Date(sg.startedAt).toLocaleTimeString()}</span>
                              <span className={s.sessionDur}>{formatDuration(sg.startedAt, sg.endedAt)}</span>
                              <span className={s.sessionEvents}>{sg.events.length} events</span>
                              {reviewableEvents.length > 0 && (
                                <div className={s.eventDebunkList}>
                                  {reviewableEvents.map((ev) => (
                                    <EventDebunkPanel
                                      key={ev.id}
                                      investigationId={openCaseId!}
                                      event={ev}
                                      required={true}
                                    />
                                  ))}
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

                  {/* AI Investigator dossiers attached to this case — same
                      matching rule the brief uses. Each row links to the
                      single-dossier print view; delete fires through the
                      audit chain. */}
                  {researchEnabled && openDossiers.length > 0 && (
                    <div className={s.sessionsBlock}>
                      <span className={s.blockLabel}>Research dossiers ({openDossiers.length})</span>
                      <ul className={s.sessionsList}>
                        {openDossiers.map((d) => {
                          let findingCount = 0;
                          try { findingCount = (JSON.parse(d.result_json) as { findings?: unknown[] }).findings?.length ?? 0; } catch { /* */ }
                          return (
                            <li key={d.id} className={s.dossierRow}>
                              <div className={s.dossierMain}>
                                <span className={s.dossierVenue}>{d.venue_name}</span>
                                <span className={s.dossierMeta}>
                                  {new Date(d.created_at).toLocaleString()}
                                  {" · "}{findingCount} findings
                                  {" · "}{d.region}
                                  {d.investigation_id == null && " · standalone recon"}
                                </span>
                              </div>
                              <div className={s.dossierActions}>
                                <Link to={`/dossier/${d.id}`} className={s.iconBtn} title="Open print view">🖨</Link>
                                <button type="button" className={s.iconBtnDanger} onClick={() => handleDeleteDossier(d)} title="Delete dossier">×</button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

                  <div className={s.mediaBlock}>
                    <div className={s.blockHead}>
                      <span className={s.blockLabel}>Media ({openMedia.length})</span>
                      <button
                        type="button"
                        className={`btn btn-ghost ${s.btnSize}`}
                        onClick={handleExportBundle}
                      >
                        Export bundle (.zip)
                      </button>
                      <button
                        type="button"
                        className={`btn btn-ghost ${s.btnSize}`}
                        onClick={handleDownloadAll}
                        disabled={openMedia.length === 0}
                      >
                        Download media only
                      </button>
                      <Link
                        to={`/brief/${c.id}`}
                        className={`btn btn-ghost ${s.btnSize}`}
                        title="Print a one-page case brief"
                      >
                        Print case brief
                      </Link>
                      {/* AI Investigator deep-link. We URL-encode the
                          venue + location so the Research view prefills
                          even when this case isn't the active session.
                          Hidden when the operator has turned off the
                          AI Investigator in Setup. */}
                      {researchEnabled && (
                        <Link
                          to={`/research?venue=${encodeURIComponent(c.location_name?.trim() || c.title)}${c.location_name && c.title && c.location_name !== c.title ? `&location=${encodeURIComponent(c.title)}` : ""}`}
                          className={`btn btn-ghost ${s.btnSize}`}
                          title="Run the AI Investigator on this venue — opens prefilled"
                        >
                          Research venue
                        </Link>
                      )}
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
                    <button type="button" className={`btn btn-danger ${s.btnSize}`} onClick={handleDeleteCase}>
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

      {/* Protocol wizard modal — rendered at CaseManager root so it
          floats above the case list regardless of which row is open.
          wizardCaseId is set when the operator clicks "Write protocol"
          or "View protocol" on any row. */}
      {wizardCaseId && (
        <ProtocolWizard
          investigationId={wizardCaseId}
          initialProtocol={wizardProtocol}
          lockedHash={wizardLockedHash}
          onSave={handleWizardSave}
          onLock={handleWizardLock}
          onClose={handleCloseWizard}
        />
      )}

      {/* Sensitive site acknowledgement modal — shown when nearby massacre
          sites are found during new-case creation. Rendered above the
          ProtocolWizard so z-order stacking is predictable. */}
      {showSiteWarning && siteMatches.length > 0 && (
        <SensitiveSiteWarning
          matches={siteMatches}
          onAcknowledge={() => {
            setSiteAcknowledged(true);
            setShowSiteWarning(false);
          }}
          onCancel={() => {
            setShowSiteWarning(false);
            setNewCaseOpen(false);
            setSiteMatches([]);
            setSiteAcknowledged(false);
          }}
        />
      )}
    </div>
  );
}

