import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AHT_H0_SUSPEND_THRESHOLD, computeH0Confidence } from "../lib/posterior/ahtVerdict";
import { buildEvidenceBrief, findMostRecentInvestigationId, type EvidenceBrief } from "../lib/forensic/evidenceBrief";
import { NullRateDashboard } from "../components/NullRateDashboard";
import { CaseManager } from "../components/CaseManager";
import { InterviewsList } from "../components/InterviewsList";
import { query } from "../lib/db/db";
import { verifyAuditChain, appendAuditEntry } from "../lib/db/auditLog";
import { loadMarkerOverrides } from "../lib/db/markerOverrides";
import { buildManifest } from "../lib/forensic/manifest";
import { buildExportBundle, downloadBlob } from "../lib/forensic/exportBundle";
import { usePreferences } from "../lib/preferences";
import { formatTimeToEmpty, projectTimeToEmpty, projectTimeToZero } from "../lib/system/batteryProjection";
import { getScene } from "../lib/overlays/scenes";
import s from "./View.module.css";
import r from "./Review.module.css";

function plainEnglishChannel(channel: string): string {
  switch (channel.toLowerCase()) {
    case "acoustic": return "Sound";
    case "magnetometer": return "Magnetic field";
    case "motion": return "Movement";
    case "light": return "Light";
    case "temperature": return "Temperature";
    case "contamination": return "Possible interference";
    case "evp": return "Voice recording";
    case "spirit_box": return "Spirit box";
    default: return channel.replace(/_/g, " ");
  }
}

function plainEnglishMove(before: number, after: number): { label: string; tone: "up" | "down" | "flat" } {
  const delta = after - before;
  const absDelta = Math.abs(delta);
  if (absDelta < 0.005) return { label: "no real change", tone: "flat" };
  const dir = delta > 0 ? "up" : "down";
  if (absDelta < 0.05) return { label: `score ticked ${dir} a touch`, tone: dir };
  if (absDelta < 0.20) return { label: `score moved ${dir} noticeably`, tone: dir };
  return { label: `score jumped ${dir} sharply`, tone: dir };
}

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

interface MarkerRow {
  id: string;
  timestamp: string;
  investigation_id: string;
  title: string | null;
  description: string | null;
  metadata_json: string | null;
}

type MarkerCategory = "sound" | "movement" | "felt" | null;
/** Filter state for the Review marker list. Categories match MarkerCategory
 *  plus an "untagged" sentinel that maps to category === null at filter time
 *  — modelled as its own union member so type-narrowing handles both paths
 *  without unsafe casts. `null` = show all. */
type MarkerFilter = MarkerCategory | "untagged";

interface MarkerView {
  id: string;
  timestamp: string;
  title: string;
  elapsedLabel: string | null;
  sceneId: string | null;
  category: MarkerCategory;
  note: string | null;
  /** Small JPEG dataUrl captured at marker-drop time. Null when the marker
   *  was dropped without an active camera (audio-only scene, source not yet
   *  decodable, or the marker pre-dates the thumbnail capture feature). */
  thumbnailDataUrl: string | null;
}

const MARKER_CATEGORIES: { id: Exclude<MarkerCategory, null>; label: string }[] = [
  { id: "sound",    label: "Sound" },
  { id: "movement", label: "Movement" },
  { id: "felt",     label: "Felt" },
];

/** Single predicate shared by header count + list render so the "untagged"
 *  sentinel can't desync them. `null` filter = show all. */
function matchesMarkerFilter(m: { category: MarkerCategory }, filter: MarkerFilter): boolean {
  if (filter === null) return true;
  if (filter === "untagged") return m.category === null;
  return m.category === filter;
}

/** localStorage key prefix for marker-edit drafts. One entry per marker so
 *  an operator editing multiple markers in quick succession doesn't lose
 *  one when opening another. Versioned to allow schema migration. */
const MARKER_DRAFT_KEY_PREFIX = "ss-marker-draft-v1:";

interface MarkerDraft { note: string; category: MarkerCategory }

function saveMarkerDraft(markerId: string, note: string, category: MarkerCategory): void {
  try {
    // Don't pin empty drafts — they're indistinguishable from "no draft" at
    // restore time, and clutter localStorage with stale keys. The clear
    // helper handles success-save cleanup; this just keeps junk out.
    if (!note.trim() && category === null) {
      localStorage.removeItem(`${MARKER_DRAFT_KEY_PREFIX}${markerId}`);
      return;
    }
    localStorage.setItem(`${MARKER_DRAFT_KEY_PREFIX}${markerId}`, JSON.stringify({ note, category }));
  } catch { /* swallow — localStorage unavailable */ }
}

function loadMarkerDraft(markerId: string): MarkerDraft | null {
  try {
    const raw = localStorage.getItem(`${MARKER_DRAFT_KEY_PREFIX}${markerId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { note?: unknown; category?: unknown };
    if (typeof parsed.note !== "string") return null;
    let category: MarkerCategory = null;
    if (parsed.category === "sound" || parsed.category === "movement" || parsed.category === "felt") {
      category = parsed.category;
    }
    return { note: parsed.note, category };
  } catch { return null; }
}

function clearMarkerDraft(markerId: string): void {
  try { localStorage.removeItem(`${MARKER_DRAFT_KEY_PREFIX}${markerId}`); }
  catch { /* swallow */ }
}


interface DeviceSampleRow {
  timestamp: string;
  sensor_type: string;
  value: number | null;
  metadata_json: string | null;
}

interface DeviceTimeline {
  /** Each entry pairs a numeric value with its ISO timestamp so marker
   *  positions can be derived against the same time axis the sparkline
   *  uses — otherwise battery samples and markers would drift apart.
   *  Battery samples additionally carry the charging flag from the
   *  watchdog so the spark can refuse to project a time-to-empty during
   *  plugged-in stretches. */
  battery: { value: number; ts: string; charging?: boolean }[];
  storageMb: { value: number; ts: string }[];
  /** Earliest sample timestamp, for the rangelabel. */
  startTs: string | null;
  endTs: string | null;
}

function formatMarkerElapsed(meta: string | null): string | null {
  if (!meta) return null;
  try {
    const parsed = JSON.parse(meta) as { sessionElapsedSec?: unknown };
    const sec = parsed.sessionElapsedSec;
    if (typeof sec !== "number" || !Number.isFinite(sec)) return null;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec) % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  } catch { return null; }
}

export function Review() {
  const [prefs] = usePreferences();
  const isPro = prefs.experienceMode === "pro";
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [chainStatus, setChainStatus] = useState<"checking" | "ok" | "broken">("checking");
  const [chainBrokenSeq, setChainBrokenSeq] = useState<number | null>(null);
  const [merkleRoot, setMerkleRoot] = useState<string | null>(null);
  const [latestBrief, setLatestBrief] = useState<EvidenceBrief | null>(null);
  const [markers, setMarkers] = useState<MarkerView[]>([]);
  // Active category filter for the markers list — null = show all.
  // Selecting a chip restricts the visible markers; chip stays sticky
  // through reload? No — case-by-case workflow, in-session state is fine.
  const [markerCategoryFilter, setMarkerCategoryFilter] = useState<MarkerFilter>(null);
  // Marker editing — one editor open at a time. Persisting an edit appends a
  // marker.annotated audit entry (note + category override) and updates the
  // local state optimistically. Dismissal appends marker.dismissed and drops
  // the row. Original evidence_events row is never mutated either way.
  const [editingMarkerId, setEditingMarkerId] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState("");
  const [draftCategory, setDraftCategory] = useState<MarkerCategory>(null);
  // Flash a marker row when the operator jumps to it from a spark tick or
  // keyboard nav. Auto-clears so the highlight doesn't strobe forever.
  const [flashMarkerId, setFlashMarkerId] = useState<string | null>(null);
  const markerListRef = useRef<HTMLOListElement | null>(null);
  useEffect(() => {
    if (flashMarkerId == null) return;
    const h = window.setTimeout(() => setFlashMarkerId(null), 1600);
    return () => window.clearTimeout(h);
  }, [flashMarkerId]);
  // Focused marker for keyboard shortcuts — j/k navigates, e opens the
  // editor, d dismisses, Esc closes. Distinct from `flashMarkerId` (which
  // is a one-shot pulse) because the focus persists between key presses.
  const [focusedMarkerId, setFocusedMarkerId] = useState<string | null>(null);
  // Bulk selection mode — when on, each marker row shows a checkbox and a
  // toolbar surfaces "Set category" + "Dismiss" actions over the selection.
  // Shift-click extends the range from the last clicked checkbox.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedMarkerIds, setSelectedMarkerIds] = useState<Set<string>>(() => new Set());
  const [lastClickedMarkerId, setLastClickedMarkerId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<DeviceTimeline | null>(null);
  // EVP captures for the most-recent investigation. Looked up once at load
  // alongside markers so the summary card has a denominator that matches
  // what's actually on disk for this case, not the global event count.
  const [evpCaptureCount, setEvpCaptureCount] = useState(0);

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
      try {
        const manifest = await buildManifest();
        setMerkleRoot(manifest.global_audit_chain.merkle_root);
      } catch { /* manifest is best-effort in the banner */ }
      // Build the brief for the most-recent investigation so we can show its
      // AHT verdict inline — saves the operator a trip to the print view.
      try {
        const recentId = await findMostRecentInvestigationId();
        if (recentId) setLatestBrief(await buildEvidenceBrief(recentId));
        // Load moment markers for the most-recent investigation. Markers
        // ride in the evidence_events table (event_type='marker'); the
        // audit log carries the hash chain but not the metadata we need
        // to render elapsed-time + scene id at review time.
        if (recentId) {
          // Watchdog-sourced battery + storage samples — written every minute
          // while running. Pull both series in one query, then split client-
          // side so the chart renders the device-state decay alongside the
          // markers without two round-trips.
          const deviceRows = await query<DeviceSampleRow>(
            "SELECT timestamp, sensor_type, value, metadata_json FROM sensor_samples WHERE investigation_id = ? AND sensor_type IN ('battery', 'storage_free') ORDER BY timestamp ASC",
            [recentId],
          );
          if (deviceRows.length > 0) {
            const battery: { value: number; ts: string; charging?: boolean }[] = [];
            const storageMb: { value: number; ts: string }[] = [];
            for (const r of deviceRows) {
              if (r.value == null) continue;
              if (r.sensor_type === "battery") {
                // metadata_json carries { charging: boolean } from the
                // watchdog — surfaced so the spark's projectTimeToEmpty
                // returns null for plugged-in stretches.
                let charging: boolean | undefined;
                if (r.metadata_json) {
                  try {
                    const meta = JSON.parse(r.metadata_json) as { charging?: unknown };
                    if (typeof meta.charging === "boolean") charging = meta.charging;
                  } catch { /* ignore */ }
                }
                battery.push({ value: r.value, ts: r.timestamp, charging });
              } else if (r.sensor_type === "storage_free") {
                storageMb.push({ value: r.value / (1024 * 1024), ts: r.timestamp });
              }
            }
            setTimeline({
              battery,
              storageMb,
              startTs: deviceRows[0]?.timestamp ?? null,
              endTs: deviceRows[deviceRows.length - 1]?.timestamp ?? null,
            });
          }
          const rows = await query<MarkerRow>(
            "SELECT id, timestamp, investigation_id, title, description, metadata_json FROM evidence_events WHERE investigation_id = ? AND event_type = 'marker' ORDER BY timestamp DESC LIMIT 200",
            [recentId],
          );
          // Marker edits/dismissals are append-only audit entries — the
          // original evidence_events row is never mutated, so we can prove
          // the original capture happened. The shared loader hits audit_log
          // once and folds latest-wins; dismissals are absorbing.
          const overrides = await loadMarkerOverrides();
          // EVP capture count for the same case. One round-trip; the result
          // feeds the Session summary card. Failure is non-fatal — the
          // card just renders "0 captured" if the query errors.
          try {
            const evpRows = await query<{ n: number }>(
              "SELECT COUNT(*) as n FROM evidence_events WHERE investigation_id = ? AND event_type = 'audio.evp_capture'",
              [recentId],
            );
            setEvpCaptureCount(Number(evpRows[0]?.n ?? 0));
          } catch { /* leave at 0 */ }
          setMarkers(rows
            .filter((row) => !overrides.dismissed.has(row.id))
            .map((row) => {
              let sceneId: string | null = null;
              let category: MarkerCategory = null;
              let thumbnailDataUrl: string | null = null;
              if (row.metadata_json) {
                try {
                  const parsed = JSON.parse(row.metadata_json) as { sceneId?: unknown; category?: unknown; thumbnailDataUrl?: unknown };
                  if (typeof parsed.sceneId === "string") sceneId = parsed.sceneId;
                  if (parsed.category === "sound" || parsed.category === "movement" || parsed.category === "felt") {
                    category = parsed.category;
                  }
                  if (typeof parsed.thumbnailDataUrl === "string" && parsed.thumbnailDataUrl.startsWith("data:image/")) {
                    thumbnailDataUrl = parsed.thumbnailDataUrl;
                  }
                } catch { /* ignore */ }
              }
              const ann = overrides.annotations.get(row.id);
              return {
                id: row.id,
                timestamp: row.timestamp,
                title: row.title ?? "Moment marked",
                elapsedLabel: formatMarkerElapsed(row.metadata_json),
                sceneId,
                category: ann?.category !== undefined ? ann.category : category,
                note: ann?.note ?? null,
                thumbnailDataUrl,
              };
            }));
        }
      } catch { /* verdict card just won't render */ }
    })();
  }, []);

  // At-a-glance session summary — counts by category, EVP captures, audit
  // entries, and session duration derived from the device-state timeline.
  // Computed inline because all the inputs are already in state; a memoised
  // intermediate would be over-engineered for ~5 small reductions.
  const sessionSummary = (() => {
    const total = markers.length;
    const byCategory: Record<"sound" | "movement" | "felt" | "untagged", number> = {
      sound: 0, movement: 0, felt: 0, untagged: 0,
    };
    for (const m of markers) {
      if (m.category === "sound") byCategory.sound += 1;
      else if (m.category === "movement") byCategory.movement += 1;
      else if (m.category === "felt") byCategory.felt += 1;
      else byCategory.untagged += 1;
    }
    // Duration from the watchdog timeline — first and last device-state
    // samples bracket the session. Empty / single-sample sessions show no
    // duration (the chip simply omits). Audio-only sessions still have the
    // EVP count and marker count even when the timeline is empty.
    let durationLabel: string | null = null;
    if (timeline?.startTs && timeline?.endTs && timeline.startTs !== timeline.endTs) {
      try {
        const ms = new Date(timeline.endTs).getTime() - new Date(timeline.startTs).getTime();
        if (Number.isFinite(ms) && ms > 0) {
          const totalSec = Math.round(ms / 1000);
          const h = Math.floor(totalSec / 3600);
          const m = Math.floor((totalSec % 3600) / 60);
          durationLabel = h > 0 ? `${h}h ${m}m` : `${m}m`;
        }
      } catch { /* leave null */ }
    }
    return { total, byCategory, durationLabel };
  })();

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

  // H₀ — AI insufficiency. Computed from the 30 most-recent
  // `ai.debunk.proposed` audit entries carrying max_plausibility, via the
  // shared helper. When H₀ ≥ the suspend threshold the AHT post-roll engine
  // SUSPENDS — every case renders INCONCLUSIVE instead of a positive verdict.
  const debunkAttempts = entries
    .filter((e) => e.kind === "ai.debunk.proposed")
    .map((e) => {
      try {
        const p = JSON.parse(e.payload_json) as Record<string, unknown>;
        return typeof p.max_plausibility === "number" ? p.max_plausibility : null;
      } catch { return null; }
    })
    .filter((p): p is number => p !== null && Number.isFinite(p))
    .slice(0, 30); // entries are ordered DESC so this is the 30 most recent
  const h0 = computeH0Confidence(debunkAttempts);
  const h0Confidence = h0.value;
  const h0Pct = Math.round(h0Confidence * 100);
  const h0Computed = h0.fromData;
  const h0Useful = h0Confidence < AHT_H0_SUSPEND_THRESHOLD;
  const postRollSuspended = h0Confidence >= AHT_H0_SUSPEND_THRESHOLD;

  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const handleExport = useCallback(async () => {
    const all = await query<AuditEntry>("SELECT * FROM audit_log ORDER BY seq ASC");
    const manifest = await buildManifest();
    const exportPayload = {
      schema: "southern-signal.export.v1",
      generated_at: new Date().toISOString(),
      app_version: "0.1.0",
      manifest,
      entries: all,
    };
    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `southern-signal-bundle-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  // Scroll the matching marker row into view + flash it. Wired to the
  // spark marker ticks so the operator can dive from "I see a tick at
  // 14:32" to the row's editor in one tap. Also used by the j/k keyboard
  // nav to keep the focused row visible as it moves through the list.
  const jumpToMarker = useCallback((id: string) => {
    setFlashMarkerId(id);
    setFocusedMarkerId(id);
    requestAnimationFrame(() => {
      const el = markerListRef.current?.querySelector<HTMLLIElement>(`[data-marker-id="${id}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, []);

  // Open the inline editor for a marker — pre-seed the draft from the
  // marker's current values so an operator who just wants to fix the
  // category doesn't have to re-type the note (and vice versa).
  //
  // Restores any in-flight draft from localStorage first — if the operator
  // closed the editor mid-edit (or accidentally navigated away), the next
  // open re-hydrates so the half-typed note isn't lost.
  const openMarkerEditor = useCallback((m: MarkerView) => {
    setEditingMarkerId(m.id);
    const draft = loadMarkerDraft(m.id);
    if (draft) {
      setDraftNote(draft.note);
      setDraftCategory(draft.category);
    } else {
      setDraftNote(m.note ?? "");
      setDraftCategory(m.category);
    }
  }, []);

  // Closing the editor without saving keeps the draft in localStorage so
  // the next open re-hydrates. Use clearMarkerDraft to drop it explicitly
  // (success-save / dismiss paths).
  const closeMarkerEditor = useCallback(() => {
    setEditingMarkerId(null);
    setDraftNote("");
    setDraftCategory(null);
  }, []);

  const saveMarkerEdit = useCallback(async (markerId: string) => {
    const trimmed = draftNote.trim();
    try {
      await appendAuditEntry({
        actor: "user",
        kind: "marker.annotated",
        payload: { marker_id: markerId, note: trimmed || null, category: draftCategory },
      });
      setMarkers((cur) => cur.map((m) =>
        m.id === markerId ? { ...m, note: trimmed || null, category: draftCategory } : m,
      ));
      clearMarkerDraft(markerId);
      closeMarkerEditor();
    } catch { /* swallow — audit append failures are surfaced via the chain banner */ }
  }, [draftNote, draftCategory, closeMarkerEditor]);

  const dismissMarker = useCallback(async (markerId: string) => {
    try {
      await appendAuditEntry({
        actor: "user",
        kind: "marker.dismissed",
        payload: { marker_id: markerId },
      });
      setMarkers((cur) => cur.filter((m) => m.id !== markerId));
      clearMarkerDraft(markerId);
      if (editingMarkerId === markerId) closeMarkerEditor();
    } catch { /* swallow */ }
  }, [editingMarkerId, closeMarkerEditor]);

  // Persist the draft note + category to localStorage whenever they change
  // while an editor is open. Debounce-free — typing latency on a small
  // payload (note + category) is negligible. Keeps the editor recoverable
  // across page reloads as well as nav.
  useEffect(() => {
    if (!editingMarkerId) return;
    saveMarkerDraft(editingMarkerId, draftNote, draftCategory);
  }, [editingMarkerId, draftNote, draftCategory]);

  // Toggle a marker's selection. Shift-click extends the selection range
  // from the last-clicked marker to the current one across the visible
  // (filtered) list — matches the convention every file picker uses.
  const toggleMarkerSelection = useCallback((markerId: string, shiftKey: boolean) => {
    setSelectedMarkerIds((prev) => {
      const next = new Set(prev);
      const visible = markers.filter((m) => matchesMarkerFilter(m, markerCategoryFilter));
      if (shiftKey && lastClickedMarkerId) {
        const a = visible.findIndex((m) => m.id === lastClickedMarkerId);
        const b = visible.findIndex((m) => m.id === markerId);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i += 1) next.add(visible[i].id);
          return next;
        }
      }
      if (next.has(markerId)) next.delete(markerId);
      else next.add(markerId);
      return next;
    });
    setLastClickedMarkerId(markerId);
  }, [markers, markerCategoryFilter, lastClickedMarkerId]);

  // Apply a category to every selected marker — one audit entry per marker
  // so the chain captures each change individually. Optimistic local state
  // update; failures are best-effort surfaced via the chain banner.
  const bulkSetCategory = useCallback(async (category: MarkerCategory) => {
    if (selectedMarkerIds.size === 0) return;
    const ids = Array.from(selectedMarkerIds);
    for (const id of ids) {
      try {
        await appendAuditEntry({
          actor: "user",
          kind: "marker.annotated",
          payload: { marker_id: id, note: null, category },
        });
      } catch { /* continue — chain banner surfaces failures */ }
    }
    setMarkers((cur) => cur.map((m) => (selectedMarkerIds.has(m.id) ? { ...m, category } : m)));
    setSelectedMarkerIds(new Set());
    setSelectMode(false);
  }, [selectedMarkerIds]);

  // Dismiss every selected marker — same pattern, one audit entry each.
  const bulkDismiss = useCallback(async () => {
    if (selectedMarkerIds.size === 0) return;
    const ids = Array.from(selectedMarkerIds);
    for (const id of ids) {
      try {
        await appendAuditEntry({
          actor: "user",
          kind: "marker.dismissed",
          payload: { marker_id: id },
        });
        clearMarkerDraft(id);
      } catch { /* continue */ }
    }
    setMarkers((cur) => cur.filter((m) => !selectedMarkerIds.has(m.id)));
    setSelectedMarkerIds(new Set());
    setSelectMode(false);
  }, [selectedMarkerIds]);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedMarkerIds(new Set());
    setLastClickedMarkerId(null);
  }, []);

  // Keyboard shortcuts for power-use review. j/ArrowDown + k/ArrowUp navigate
  // through the filtered markers list; e opens the editor on the focused
  // row; d dismisses; Esc closes the editor. Skip when an input is focused
  // so typing in the note textarea doesn't trigger 'e' for edit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) {
        // Esc inside the editor still closes — gives the operator a quick
        // way out without reaching for the Cancel button.
        if (e.key === "Escape" && editingMarkerId) {
          setEditingMarkerId(null);
          setDraftNote("");
          setDraftCategory(null);
        }
        return;
      }
      if (markers.length === 0) return;
      const visible = markers.filter((m) => matchesMarkerFilter(m, markerCategoryFilter));
      if (visible.length === 0) return;
      const currentIdx = focusedMarkerId ? visible.findIndex((m) => m.id === focusedMarkerId) : -1;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = visible[Math.min(visible.length - 1, currentIdx < 0 ? 0 : currentIdx + 1)];
        if (next) jumpToMarker(next.id);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        const prev = visible[Math.max(0, currentIdx < 0 ? 0 : currentIdx - 1)];
        if (prev) jumpToMarker(prev.id);
      } else if (e.key === "e" && focusedMarkerId) {
        e.preventDefault();
        const m = visible.find((x) => x.id === focusedMarkerId);
        if (m) {
          setEditingMarkerId(m.id);
          setDraftNote(m.note ?? "");
          setDraftCategory(m.category);
        }
      } else if (e.key === "d" && focusedMarkerId) {
        e.preventDefault();
        // No confirm — the dismissal is reversible via the audit chain.
        // Aggressive shortcut + reversible action = no need for a modal.
        void dismissMarker(focusedMarkerId);
      } else if (e.key === "Escape" && editingMarkerId) {
        setEditingMarkerId(null);
        setDraftNote("");
        setDraftCategory(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  // dismissMarker is stable; markers/editingMarkerId/focusedMarkerId/filter
  // are read at fire time, so the effect doesn't need to re-bind on each
  // keystroke — that'd be a re-bind storm. Closures capture the latest.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markers, markerCategoryFilter, focusedMarkerId, editingMarkerId, jumpToMarker, dismissMarker]);

  const handleExportZip = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    setExportStatus("Building bundle…");
    try {
      const { blob, summary } = await buildExportBundle();
      downloadBlob(blob, summary.filename);
      const sizeMb = (summary.byteLength / 1024 / 1024).toFixed(1);
      setExportStatus(`Bundle exported · ${sizeMb} MB · ${summary.investigationIds.length} cases · ${summary.mediaIncluded} media${summary.mediaMissing ? ` (${summary.mediaMissing} missing)` : ""}`);
      await appendAuditEntry({
        actor: "user",
        kind: "bundle.export",
        payload: { scope: "all", bytes: summary.byteLength, cases: summary.investigationIds.length, media_included: summary.mediaIncluded, media_missing: summary.mediaMissing },
      }).catch(() => { /* ignore */ });
    } catch (err) {
      setExportStatus(`Bundle failed: ${(err as Error).message}`);
    } finally {
      setExporting(false);
    }
  }, [exporting]);

  return (
    <section className={s.view}>
      <div className={s.titleBlock}>
        <span className={s.eyebrow}>{isPro ? "Review · Post-roll" : "Review"}</span>
        <h1 className={s.title}>{isPro ? "All cases · all data" : "Your cases"}</h1>
        <p className={s.lede}>
          {isPro
            ? "Every investigation, every session, every captured image / audio / video clip, every posterior increment, every audit-chain entry. Edit, export, or download from here. Setup mirrors the case manager so you can manage from either screen."
            : "Look back over your investigations. Browse the recordings, change a case's verdict, or download a tamper-proof bundle to share with a reviewer. Switch to Pro mode in Setup if you want the math behind the scores."}
        </p>
      </div>

      {/* CASE MANAGER — every investigation with media browser, edit, download, delete */}
      <CaseManager />

      {/* Chain status banner. Fresh device (0 entries) gets honest copy
          rather than "✓ verified" — there's nothing to verify yet, and
          claiming verification on an empty chain is a small lie. */}
      <div className={`${r.chainStatus} ${r[chainStatus]}`.trim()}>
        {chainStatus === "checking" && (isPro ? "Verifying audit chain…" : "Checking the record…")}
        {chainStatus === "ok" && entries.length === 0 && (
          <>
            {/* Schematic empty-chain illustration: a short Merkle / hash-chain
                fragment of three rounded blocks linked by solid connectors,
                trailing off into dotted segments that fade — reads as "no
                links recorded yet" without any literal text. Pure currentColor,
                same line-based idiom as the OnboardingTour cue glyphs and the
                logo-mark. Decorative; the banner copy carries the meaning. */}
            <svg
              viewBox="0 0 160 56"
              className={r.emptyArt}
              aria-hidden="true"
              xmlns="http://www.w3.org/2000/svg"
            >
              {/* Three present "hash blocks" — rounded rects */}
              <g fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.85">
                <rect x="8"  y="18" width="22" height="20" rx="3" />
                <rect x="42" y="18" width="22" height="20" rx="3" />
                <rect x="76" y="18" width="22" height="20" rx="3" />
              </g>
              {/* Inner hash-prefix tick inside each block, suggestive of a SHA digest */}
              <g stroke="currentColor" strokeWidth="0.9" opacity="0.55" strokeLinecap="round">
                <line x1="12" y1="28" x2="26" y2="28" />
                <line x1="46" y1="28" x2="60" y2="28" />
                <line x1="80" y1="28" x2="94" y2="28" />
              </g>
              {/* Solid connectors between the present blocks */}
              <g stroke="currentColor" strokeWidth="1.2" opacity="0.7" strokeLinecap="round">
                <line x1="30" y1="28" x2="42" y2="28" />
                <line x1="64" y1="28" x2="76" y2="28" />
              </g>
              {/* Outbound dotted chain trailing into nothing — the absence */}
              <g stroke="currentColor" strokeWidth="1.1" fill="none" strokeLinecap="round" strokeDasharray="2 4">
                <line x1="98"  y1="28" x2="116" y2="28" opacity="0.45" />
                <line x1="120" y1="28" x2="136" y2="28" opacity="0.28" />
                <line x1="140" y1="28" x2="152" y2="28" opacity="0.15" />
              </g>
              {/* Faint ghost outline of the next block that would have been here */}
              <rect
                x="110" y="18" width="22" height="20" rx="3"
                fill="none" stroke="currentColor" strokeWidth="1"
                strokeDasharray="2 3" opacity="0.22"
              />
            </svg>
            <strong>{isPro ? "CHAIN EMPTY" : "Nothing recorded yet"}</strong>
            <span>
              {isPro
                ? " · No audit entries on this device. Start a hunt from the Camera tab to start the chain."
                : " — no investigations have been recorded on this device. "}
            </span>
            {!isPro && <Link to="/">Open Camera →</Link>}
          </>
        )}
        {chainStatus === "ok" && entries.length > 0 && (
          <>
            {isPro ? (
              <>
                <strong>CHAIN VERIFIED</strong>
                <span> · {entries.length} entries · SHA-256 hash-chained</span>
                {merkleRoot && (
                  <span className={r.merkleLine}>
                    {" · Merkle root "}
                    <code>{merkleRoot.slice(0, 12)}…{merkleRoot.slice(-8)}</code>
                  </span>
                )}
              </>
            ) : (
              <>
                <strong>✓ Tamper-proof record verified</strong>
                <span> · {entries.length} log entries, none altered since capture</span>
              </>
            )}
            <button type="button" className={r.downloadButton} onClick={handleExportZip} disabled={exporting}>
              {exporting ? "Building zip…" : isPro ? "Export full bundle (.zip)" : "Download case bundle (.zip)"}
            </button>
            {isPro && (
              <button type="button" className={r.downloadButton} onClick={handleExport}>
                Manifest + chain (.json)
              </button>
            )}
            <Link to="/brief" className={r.downloadButton}>
              Print case brief
            </Link>
          </>
        )}
        {chainStatus === "broken" && (
          <>
            {isPro ? (
              <>
                <strong>CHAIN BROKEN</strong>
                <span> · entry seq {chainBrokenSeq} failed verification — evidence cannot be trusted</span>
              </>
            ) : (
              <>
                <strong>⚠ Record looks tampered</strong>
                <span> · the {chainBrokenSeq}{nth(chainBrokenSeq)} log entry doesn't match its signature. Treat results from this device with caution.</span>
              </>
            )}
          </>
        )}
      </div>

      {/* Method banner */}
      <div className={r.ahtBanner}>
        {isPro ? (
          <>
            <span className={r.ahtBannerLabel}>AHT POST-ROLL</span>
            <span className={r.ahtBannerNote}>AHT eliminates explanations; it does not confirm causes.</span>
          </>
        ) : (
          <>
            <span className={r.ahtBannerLabel}>HOW THIS WORKS</span>
            <span className={r.ahtBannerNote}>We try to disprove the paranormal first. Anything left over is "still unexplained" — never "confirmed."</span>
          </>
        )}
      </div>

      {/* Base-rate dashboard — null results count too */}
      <NullRateDashboard />

      {/* AI sanity meta-card */}
      <div className={`${r.h0Card} ${postRollSuspended ? r.h0CardSuspended : ""}`.trim()}>
        <div className={r.h0Header}>
          <strong>{isPro ? "H₀ — AI insufficiency" : "AI sanity check"}</strong>
          <span className={r.h0Confidence}>
            {isPro
              ? `Confidence: ${h0Confidence.toFixed(2)}${h0Computed ? ` (n=${debunkAttempts.length})` : " (no data yet)"}`
              : h0Computed
                ? `${h0Pct}% — ${h0Useful ? "AI is being useful" : "AI is struggling"}`
                : "no data yet"}
          </span>
        </div>
        <div className={`${r.h0EngineRow} ${postRollSuspended ? r.h0EngineSuspended : r.h0EngineActive}`.trim()}>
          <span className={r.h0EngineDot} aria-hidden="true" />
          {postRollSuspended ? (
            isPro
              ? <>POST-ROLL <strong>SUSPENDED</strong> — every case renders INCONCLUSIVE while H₀ ≥ {AHT_H0_SUSPEND_THRESHOLD.toFixed(2)}. Run more debunk requests with reliable mundane explanations to bring it back.</>
              : <>Verdicts <strong>paused</strong> — the AI hasn't been reliable enough lately, so every case shows "inconclusive" until that improves.</>
          ) : (
            isPro
              ? <>POST-ROLL <strong>ACTIVE</strong> — verdicts computed normally. Suspend threshold is H₀ ≥ {AHT_H0_SUSPEND_THRESHOLD.toFixed(2)}.</>
              : <>Verdicts <strong>active</strong> — the AI is doing its job, so cases get a real verdict.</>
          )}
        </div>
        <p className={r.h0Body}>
          {isPro ? (
            <>When AI fails to generate plausible mundane explanations, that's a model limitation, not evidence of the paranormal. If H₀ confidence exceeds {AHT_H0_SUSPEND_THRESHOLD.toFixed(1)} the post-roll renders <em>INCONCLUSIVE — model limitations exceed evidence threshold</em> instead of any verdict. Computed as mean(1 − max-plausibility) across recent debunk requests; the per-case verdict appears on the Evidence Brief.</>
          ) : (
            <>If the AI can't think of normal explanations for what you saw, that's a limit of the AI, NOT proof of a ghost. When this number climbs above 40% we mark the case <em>inconclusive</em> instead of giving any verdict. Print a case brief for the full verdict.</>
          )}
        </p>
      </div>

      {/* Latest-case AHT verdict — surfaces the per-case verdict without
          requiring the operator to open the print view. */}
      {latestBrief && (
        <div className={`${r.verdictCard} ${r[`verdict_${latestBrief.ahtVerdict.verdict}`]}`.trim()}>
          <div className={r.verdictCardHead}>
            <span className={r.verdictCardEyebrow}>
              {isPro ? "AHT VERDICT · LATEST CASE" : "Latest case · verdict"}
            </span>
            <span className={r.verdictCardLabel}>{latestBrief.ahtVerdict.label}</span>
          </div>
          <p className={r.verdictCardTitle}>{latestBrief.investigation.title}</p>
          <p className={r.verdictCardDetail}>{latestBrief.ahtVerdict.detail}</p>
          <div className={r.verdictCardFoot}>
            <span>peak {(latestBrief.peakPosterior * 100).toFixed(0)}%</span>
            <span>·</span>
            <span>H₀ {latestBrief.h0Confidence.toFixed(2)}</span>
            {latestBrief.investigation.disposition && (
              <>
                <span>·</span>
                <span>operator: {latestBrief.investigation.disposition.replace(/_/g, " ")}</span>
              </>
            )}
            <Link to={`/brief/${latestBrief.investigation.id}`} className={r.verdictCardLink}>
              Full brief →
            </Link>
          </div>
        </div>
      )}

      {/* Witness interviews — Section 2 of the report. Scoped to the
          most-recent investigation so the operator can add/edit interviews
          during or after a session without leaving the Review screen.
          Evidence event linking is available on the EvidenceBrief print
          view where events are fully loaded. */}
      {latestBrief && (
        <div className={r.section}>
          <InterviewsList
            investigationId={latestBrief.investigation.id}
          />
        </div>
      )}

      {/* Device-state timeline — battery + free-storage decay sampled by the
          mid-session watchdog every 60s. Tiny SVG sparklines so the reviewer
          can eyeball "did the device run low partway through?" without
          opening a chart library. */}
      {timeline && (timeline.battery.length > 1 || timeline.storageMb.length > 1) && (
        <div className={r.section}>
          <header className={r.sectionHeader}>
            <h2>Device state — battery + storage</h2>
          </header>
          <div className={r.deviceSparkRow}>
            {timeline.battery.length > 1 && (
              <DeviceSpark
                label="Battery"
                samples={timeline.battery}
                markers={markers.map((m) => ({ id: m.id, ts: m.timestamp }))}
                onMarkerJump={jumpToMarker}
                domain={{ min: 0, max: 1 }}
                format={(v) => `${Math.round(v * 100)}%`}
                tone="battery"
              />
            )}
            {timeline.storageMb.length > 1 && (
              <DeviceSpark
                label="Storage free"
                samples={timeline.storageMb}
                markers={markers.map((m) => ({ id: m.id, ts: m.timestamp }))}
                onMarkerJump={jumpToMarker}
                format={(v) => `${Math.round(v)} MB`}
                tone="storage"
              />
            )}
          </div>
        </div>
      )}

      {/* Session summary card — a compact at-a-glance read on the most
          recent investigation. Only renders when there's *something* to
          summarise (markers, EVPs, or a measurable duration) so a brand-new
          install doesn't see a stack of zeroes. */}
      {(sessionSummary.total > 0 || evpCaptureCount > 0 || sessionSummary.durationLabel) && (
        <div className={r.sessionSummary} aria-label="Most recent session summary">
          <div className={r.sessionSummaryRow}>
            <div className={r.sessionSummaryTile}>
              <span className={r.sessionSummaryValue}>{sessionSummary.total}</span>
              <span className={r.sessionSummaryLabel}>markers</span>
            </div>
            <div className={r.sessionSummaryTile}>
              <span className={r.sessionSummaryValue}>{evpCaptureCount}</span>
              <span className={r.sessionSummaryLabel}>EVP{evpCaptureCount === 1 ? "" : "s"}</span>
            </div>
            {sessionSummary.durationLabel && (
              <div className={r.sessionSummaryTile}>
                <span className={r.sessionSummaryValue}>{sessionSummary.durationLabel}</span>
                <span className={r.sessionSummaryLabel}>duration</span>
              </div>
            )}
            <div className={r.sessionSummaryTile}>
              <span className={r.sessionSummaryValue}>{entries.length}</span>
              <span className={r.sessionSummaryLabel}>chain entr{entries.length === 1 ? "y" : "ies"}</span>
            </div>
          </div>
          {sessionSummary.total > 0 && (
            <div className={r.sessionSummaryBreakdown}>
              {(["sound", "movement", "felt", "untagged"] as const)
                .filter((cat) => sessionSummary.byCategory[cat] > 0)
                .map((cat) => (
                  <span key={cat} className={r.sessionSummaryChip} data-category={cat}>
                    {sessionSummary.byCategory[cat]} {cat}
                  </span>
                ))}
            </div>
          )}
        </div>
      )}

      {/* Moment markers — double-taps the operator dropped during capture.
          Latest case only; oldest cases are still searchable through the
          audit log if needed. Filter chips narrow by category — the
          category is recorded at drop-time via the camera-surface picker.

          filteredMarkers single-sources both the header count and the list
          render so the "Untagged" sentinel can't desync the two paths. */}
      <div className={r.section}>
        <header className={r.sectionHeader}>
          {(() => {
            const filteredMarkers = markers.filter((m) => matchesMarkerFilter(m, markerCategoryFilter));
            return (
              <h2>
                Moment markers ({filteredMarkers.length}{markerCategoryFilter ? ` / ${markers.length}` : ""})
                {markers.length > 0 && (
                  <span className={r.kbdHint} title="Keyboard: j/k navigate · e edit focused · d dismiss focused · Esc close editor">
                    {" "}· <kbd>j</kbd>/<kbd>k</kbd> · <kbd>e</kbd> · <kbd>d</kbd>
                  </span>
                )}
                {markers.length > 1 && (
                  <button
                    type="button"
                    className={r.selectModeBtn}
                    onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
                    title={selectMode ? "Exit select mode" : "Pick multiple markers to recategorise or dismiss in one go"}
                  >
                    {selectMode ? "Done" : "Select"}
                  </button>
                )}
              </h2>
            );
          })()}
        </header>
        {selectMode && (
          <div className={r.bulkToolbar} role="toolbar" aria-label="Bulk marker actions">
            <span className={r.bulkCount}>
              {selectedMarkerIds.size === 0
                ? "No markers selected"
                : `${selectedMarkerIds.size} selected`}
            </span>
            <div className={r.bulkActions}>
              <span className={r.bulkActionsLabel}>Set category:</span>
              {MARKER_CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={r.bulkChip}
                  onClick={() => void bulkSetCategory(c.id)}
                  disabled={selectedMarkerIds.size === 0}
                >
                  {c.label}
                </button>
              ))}
              <button
                type="button"
                className={r.bulkChip}
                onClick={() => void bulkSetCategory(null)}
                disabled={selectedMarkerIds.size === 0}
              >
                Untagged
              </button>
              <button
                type="button"
                className={r.bulkDismiss}
                onClick={() => void bulkDismiss()}
                disabled={selectedMarkerIds.size === 0}
              >
                Dismiss ×{selectedMarkerIds.size}
              </button>
            </div>
          </div>
        )}
        {markers.length > 0 && (
          <div className={r.markerChipRow}>
            <button
              type="button"
              className={`${r.markerChip} ${markerCategoryFilter === null ? r.markerChipActive : ""}`.trim()}
              onClick={() => setMarkerCategoryFilter(null)}
            >
              All
            </button>
            {MARKER_CATEGORIES.map((cat) => {
              const count = markers.filter((m) => m.category === cat.id).length;
              return (
                <button
                  key={cat.id}
                  type="button"
                  className={`${r.markerChip} ${markerCategoryFilter === cat.id ? r.markerChipActive : ""}`.trim()}
                  onClick={() => setMarkerCategoryFilter(cat.id)}
                  disabled={count === 0}
                >
                  {cat.label} ({count})
                </button>
              );
            })}
            {markers.some((m) => m.category === null) && (
              <button
                type="button"
                className={`${r.markerChip} ${markerCategoryFilter === "untagged" ? r.markerChipActive : ""}`.trim()}
                onClick={() => setMarkerCategoryFilter("untagged")}
              >
                Untagged ({markers.filter((m) => m.category === null).length})
              </button>
            )}
          </div>
        )}
        {markers.length === 0 ? (
          <p className={r.empty}>
            No markers yet. Double-tap the camera viewport during a session to drop a moment marker — it lands here with the elapsed time + active scene for one-tap review later.
          </p>
        ) : (
          <ol className={r.incrementList} ref={markerListRef}>
            {markers
              .filter((m) => matchesMarkerFilter(m, markerCategoryFilter))
              .map((m) => {
                const isEditing = editingMarkerId === m.id;
                const isFlashed = flashMarkerId === m.id;
                const isFocused = focusedMarkerId === m.id;
                const isSelected = selectedMarkerIds.has(m.id);
                return (
                  <li
                    key={m.id}
                    data-marker-id={m.id}
                    className={`${r.markerRow} ${isFlashed ? r.markerRowFlash : ""} ${isFocused ? r.markerRowFocused : ""} ${isSelected ? r.markerRowSelected : ""}`.trim()}
                  >
                    <div className={r.incrementRow}>
                      {selectMode ? (
                        <input
                          type="checkbox"
                          className={r.markerRowCheckbox}
                          checked={isSelected}
                          onChange={(e) => toggleMarkerSelection(m.id, (e.nativeEvent as MouseEvent).shiftKey)}
                          onClick={(e) => {
                            // shift-click on the actual checkbox reaches us via
                            // change/click; we also support the row label below.
                            if (e.shiftKey) toggleMarkerSelection(m.id, true);
                          }}
                          aria-label={`Select marker ${m.elapsedLabel ?? ""}`}
                        />
                      ) : (
                        <span className={r.incrementSeq}>●</span>
                      )}
                      <span className={r.incrementChannel}>{m.elapsedLabel ?? "—"}</span>
                      <span className={r.incrementMath}>{m.title}</span>
                      {m.category && (
                        <span className={r.markerCategoryTag} data-category={m.category}>{m.category}</span>
                      )}
                      {m.sceneId && (
                        <span className={r.incrementReason}>
                          {/* Pretty-print scene id → display name (e.g.
                              "walkthrough" → "Walkthrough"). Falls back to the
                              raw id if the scene was deleted/renamed between
                              capture and review. */}
                          scene: {getScene(m.sceneId as never)?.name ?? m.sceneId}
                        </span>
                      )}
                      <span className={r.incrementTs}>{new Date(m.timestamp).toLocaleTimeString()}</span>
                      <button
                        type="button"
                        className={r.markerEditBtn}
                        onClick={() => (isEditing ? closeMarkerEditor() : openMarkerEditor(m))}
                        aria-expanded={isEditing}
                        aria-controls={isEditing ? `marker-edit-${m.id}` : undefined}
                      >
                        {isEditing ? "Cancel" : "Edit"}
                      </button>
                    </div>
                    {m.thumbnailDataUrl && !isEditing && (
                      <img
                        className={r.markerThumb}
                        src={m.thumbnailDataUrl}
                        alt={`Camera view at ${m.elapsedLabel ?? "marker drop"}`}
                        loading="lazy"
                      />
                    )}
                    {m.note && !isEditing && (
                      <p className={r.markerNote}>{m.note}</p>
                    )}
                    {isEditing && (
                      <div className={r.markerEditor} id={`marker-edit-${m.id}`}>
                        <label className={r.markerEditField}>
                          <span>Category</span>
                          <select
                            value={draftCategory ?? ""}
                            onChange={(e) => {
                              const v = e.target.value;
                              setDraftCategory(v === "sound" || v === "movement" || v === "felt" ? v : null);
                            }}
                          >
                            <option value="">Untagged</option>
                            {MARKER_CATEGORIES.map((c) => (
                              <option key={c.id} value={c.id}>{c.label}</option>
                            ))}
                          </select>
                        </label>
                        <label className={r.markerEditField}>
                          <span>Note</span>
                          <textarea
                            value={draftNote}
                            onChange={(e) => setDraftNote(e.target.value)}
                            placeholder="e.g. doorbell rang at this moment — explains the audio spike"
                            rows={2}
                          />
                        </label>
                        <div className={r.markerEditActions}>
                          <button type="button" className={r.markerEditSave} onClick={() => void saveMarkerEdit(m.id)}>
                            Save
                          </button>
                          <button type="button" className={r.markerEditDismiss} onClick={() => void dismissMarker(m.id)}>
                            Delete marker
                          </button>
                        </div>
                        <p className={r.markerEditFoot}>
                          Edits append a new audit entry. The original capture stays intact in the chain — this is a forensic record, not an in-place mutation.
                        </p>
                      </div>
                    )}
                  </li>
                );
              })}
          </ol>
        )}
      </div>

      {/* Evidence updates / posterior log */}
      <div className={r.section}>
        <header className={r.sectionHeader}>
          <h2>{isPro ? `Posterior increments (${posteriorRows.length})` : `Evidence updates (${posteriorRows.length})`}</h2>
        </header>
        {posteriorRows.length === 0 ? (
          <p className={r.empty}>
            {isPro
              ? "No posterior updates yet. Run a session — every LR is logged here with its channel and reason."
              : "No evidence yet. Start a hunt from the Camera tab — anything notable will show up here."}
          </p>
        ) : (
          <ol className={r.incrementList}>
            {posteriorRows.map((row) => {
              const move = plainEnglishMove(row.posterior_before, row.posterior_after);
              return (
                <li key={row.seq} className={r.incrementRow}>
                  <span className={r.incrementSeq}>#{row.seq}</span>
                  <span className={r.incrementChannel}>
                    {isPro ? row.channel.toUpperCase() : plainEnglishChannel(row.channel)}
                  </span>
                  {isPro ? (
                    <>
                      <span className={r.incrementMath}>
                        P {row.posterior_before.toFixed(3)} → {row.posterior_after.toFixed(3)}
                      </span>
                      <span className={r.incrementLr}>
                        {row.log_lr >= 0 ? "+" : ""}{row.log_lr.toFixed(2)} log LR (LR {Math.exp(Math.abs(row.log_lr)).toFixed(1)})
                        {row.capped ? " — CAPPED" : ""}
                      </span>
                    </>
                  ) : (
                    <span className={r.incrementMath}>
                      {move.label} ({(row.posterior_before * 100).toFixed(0)}% → {(row.posterior_after * 100).toFixed(0)}%)
                    </span>
                  )}
                  <span className={r.incrementReason}>{row.reason}</span>
                  <span className={r.incrementTs}>{new Date(row.ts_utc).toLocaleTimeString()}</span>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {exportStatus && <p className={r.disclaimer}>{exportStatus}</p>}

      <p className={r.disclaimer}>
        {isPro
          ? <>The full bundle (.zip) ships the audit chain as JSONL, all media binaries, and a drop-in <code>verify.html</code> any reviewer can open offline. AHT eliminates explanations; it does not confirm causes.</>
          : <>The downloadable bundle is a single .zip with all your recordings, a printable cover sheet, and a small <code>verify.html</code> file anyone can open in a browser to confirm nothing's been edited. We try to disprove the paranormal first; the app never confirms one.</>}
      </p>
    </section>
  );
}

/**
 * Tiny inline sparkline — no chart-library dependency, just an SVG polyline
 * sized to a fixed 120×28 viewbox so it scales cleanly inside the section.
 *
 * `domain` lets battery clamp to 0..1 (so the curve doesn't auto-stretch when
 * the device never went under 80%). Storage doesn't pass a domain because the
 * meaningful range varies per device; we autoscale from min..max of the
 * series.
 */
function DeviceSpark({
  label, samples, format, domain, tone, markerTimestamps, markers, onMarkerJump,
}: {
  label: string;
  samples: readonly { value: number; ts: string; charging?: boolean }[];
  format: (v: number) => string;
  domain?: { min: number; max: number };
  tone: "battery" | "storage";
  /** ISO timestamps of moment markers — rendered as faint vertical ticks so
   *  the reviewer sees where the operator flagged moments against the
   *  device-state curve. Markers outside [first..last] sample range clip.
   *  Kept for callers that don't need click-to-jump; pass `markers` instead
   *  if you want the spark ticks to act as deep links. */
  markerTimestamps?: readonly string[];
  /** Same series as markerTimestamps but with stable ids so a click can
   *  scroll/flash the matching row. Supersedes markerTimestamps when both
   *  are provided. */
  markers?: readonly { id: string; ts: string }[];
  /** Click handler fired when the operator taps a marker tick. Only wired
   *  when `markers` is provided. */
  onMarkerJump?: (id: string) => void;
}) {
  // Hover/tap readout — index of the sample nearest the pointer's x in the
  // viewBox. Null = no hover, render the "latest sample" headline value.
  // `locked` keeps the readout visible after pointerleave on mobile, where a
  // touch+drag off the SVG would otherwise dismiss the reading mid-read. Tap
  // again to unlock; outside-click also dismisses via a document listener.
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [locked, setLocked] = useState(false);
  // Expand-to-modal — a larger render of the same data so a reviewer can
  // read individual samples on a desktop screen without resorting to dev
  // tools. The expanded view shares the same hover/lock readout pattern;
  // the unexpanded card stays for the at-a-glance use case.
  const [expanded, setExpanded] = useState(false);
  // Escape closes the expanded modal — standard browser-modal expectation.
  // The expanded SVG remains mounted while collapsed so the hover/lock
  // listener attached above already handles outside-click for both views.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setExpanded(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded]);
  useEffect(() => {
    if (!locked) return;
    const onDocPointer = (e: PointerEvent) => {
      if (svgRef.current && !svgRef.current.contains(e.target as Node)) {
        setLocked(false);
        setHoverIdx(null);
      }
    };
    document.addEventListener("pointerdown", onDocPointer);
    return () => document.removeEventListener("pointerdown", onDocPointer);
  }, [locked]);

  if (samples.length < 2) return null;
  const W = 120;
  const H = 28;
  const values = samples.map((s) => s.value);
  const min = domain?.min ?? Math.min(...values);
  const max = domain?.max ?? Math.max(...values);
  const span = Math.max(0.0001, max - min);
  const stepX = W / (samples.length - 1);
  const points = samples.map((s, i) => {
    const x = i * stepX;
    const y = H - ((s.value - min) / span) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const last = samples[samples.length - 1];
  const first = samples[0];

  // Map a clientX inside the SVG bounding box to the nearest sample index.
  // We use bounding-box → viewBox math instead of relying on the SVG's CTM
  // (getScreenCTM) because the SVG scales with the container; bbox math is
  // simpler + survives the CSS scale-to-fit treatment.
  const pointerToIdx = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return null;
    const xInViewBox = ((clientX - rect.left) / rect.width) * W;
    const idx = Math.round(xInViewBox / stepX);
    if (idx < 0 || idx >= samples.length) return null;
    return idx;
  };

  const hovered = hoverIdx != null ? samples[hoverIdx] : null;
  const hoveredX = hoverIdx != null ? hoverIdx * stepX : null;
  // Display the hovered sample in the headline value when active; otherwise
  // the latest sample. Footer toggles to show the hovered timestamp.
  const displayValue = hovered ?? last;
  // Map markers to x-positions on the spark's time axis. Clip anything that
  // falls outside the sample range (e.g. markers from before the watchdog
  // started writing samples).
  const startMs = Date.parse(first.ts);
  const endMs = Date.parse(last.ts);
  const rangeMs = Math.max(1, endMs - startMs);
  // Keep id+timestamp+x together. When `markers` is provided, id powers
  // the click-to-jump handler; otherwise we fall back to markerTimestamps
  // (kept for the cover.html consumer that doesn't need ids).
  const markerSource = markers
    ? markers.map((m) => ({ id: m.id as string | null, iso: m.ts, ms: Date.parse(m.ts) }))
    : (markerTimestamps ?? []).map((iso) => ({ id: null as string | null, iso, ms: Date.parse(iso) }));
  const markerPoints = markerSource
    .filter(({ ms }) => Number.isFinite(ms) && ms >= startMs && ms <= endMs)
    .map(({ id, iso, ms }) => ({ id, iso, x: ((ms - startMs) / rangeMs) * W }));
  // Time-to-zero projection on the spark headline. Battery projects to
  // 0% (empty); storage projects free-MB to 0 (disk full). Both refuse on
  // flat/rising series so the chip never appears in a steady state. The
  // battery path additionally refuses while charging.
  const batteryEta = tone === "battery"
    ? projectTimeToEmpty(samples as readonly { value: number; ts: string; charging?: boolean }[])
    : null;
  const storageEta = tone === "storage" ? projectTimeToZero(samples) : null;
  const etaMinutes = batteryEta?.minutesToEmpty ?? storageEta?.minutesToZero ?? null;
  const etaWindow = batteryEta?.windowMinutes ?? storageEta?.windowMinutes ?? null;
  const etaSuffix = tone === "battery" ? "until empty" : "until full";

  return (
    <div className={r.deviceSpark} data-tone={tone}>
      <div className={r.deviceSparkHead}>
        <span className={r.deviceSparkLabel}>{label}</span>
        <span className={r.deviceSparkValue}>{format(displayValue.value)}</span>
        {etaMinutes != null && etaMinutes < 24 * 60 && (
          <span className={r.deviceSparkEta} title={`Projected from the last ${etaWindow?.toFixed(0)} min of samples — ${etaSuffix}. Informational, not a guarantee.`}>
            ~{formatTimeToEmpty(etaMinutes)}
          </span>
        )}
        <button
          type="button"
          className={r.deviceSparkExpand}
          onClick={() => setExpanded(true)}
          aria-label={`Expand ${label} chart`}
          title="Expand to read individual samples"
        >⛶</button>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className={r.deviceSparkSvg}
        role="img"
        aria-label={`${label} timeline${markerPoints.length ? ` with ${markerPoints.length} markers` : ""}`}
        onPointerMove={(e) => { if (!locked) setHoverIdx(pointerToIdx(e.clientX)); }}
        onPointerLeave={() => { if (!locked) setHoverIdx(null); }}
        onPointerDown={(e) => {
          // Tapping the spark sets the readout AND locks it for sticky
          // inspection on touch devices. Tapping again on a locked spark
          // unlocks + clears so a single tap toggles read → dismiss.
          const idx = pointerToIdx(e.clientX);
          if (locked && idx === hoverIdx) {
            setLocked(false);
            setHoverIdx(null);
          } else {
            setHoverIdx(idx);
            setLocked(true);
          }
        }}
      >
        {/* Markers behind the polyline so the curve reads over the ticks.
            Each tick gets an invisible wider hit-target rect so taps land
            reliably on a 120-pixel-wide spark; clicking jumps to the row. */}
        {markerPoints.map((m) => (
          <g key={m.iso}>
            <line
              x1={m.x} x2={m.x} y1={0} y2={H}
              stroke="var(--text-dim)" strokeWidth={0.6} strokeDasharray="1.5 1.5" opacity={0.55}
              pointerEvents="none"
            />
            {m.id && onMarkerJump && (
              <rect
                x={m.x - 3} y={0} width={6} height={H}
                fill="transparent"
                style={{ cursor: "pointer" }}
                onPointerDown={(e) => {
                  // stopPropagation: keep the spark's tap-to-lock from
                  // firing when the operator's intent was "jump to row".
                  e.stopPropagation();
                  onMarkerJump(m.id!);
                }}
              />
            )}
          </g>
        ))}
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        {/* Hover guide — vertical line + dot at the hovered sample so the
            reviewer's eye lands on the exact reading. Rendered last so it
            stays on top of both the markers and the data curve. */}
        {hoveredX != null && hovered && (
          <>
            <line x1={hoveredX} x2={hoveredX} y1={0} y2={H} stroke="currentColor" strokeWidth={0.5} opacity={0.4} />
            <circle
              cx={hoveredX}
              cy={H - ((hovered.value - min) / span) * H}
              r={2}
              fill="currentColor"
            />
          </>
        )}
      </svg>
      <div className={r.deviceSparkFoot}>
        <span className={r.deviceSparkMeta}>
          {hovered
            ? new Date(hovered.ts).toLocaleTimeString()
            : `start ${format(first.value)}`}
        </span>
        <span className={r.deviceSparkMeta}>
          {samples.length} samples
          {markerPoints.length > 0 ? ` · ${markerPoints.length} marker${markerPoints.length === 1 ? "" : "s"}` : ""}
        </span>
      </div>
      {expanded && (
        <SparkExpandedModal
          label={label}
          samples={samples}
          format={format}
          domain={domain}
          tone={tone}
          markerTimestamps={markerTimestamps}
          onClose={() => setExpanded(false)}
        />
      )}
    </div>
  );
}

/**
 * Larger readable version of DeviceSpark rendered as a viewport-anchored
 * modal. Same data, bigger viewBox (480×160), the same hover/lock readout
 * pattern, plus min/max labels so a reviewer reading on desktop can pin
 * specific samples without squinting. Closes via X button, Escape key, or
 * backdrop click.
 *
 * Kept as a sibling component instead of a flag inside DeviceSpark because
 * the modal owns its own hover/lock state — bleeding the trigger card's
 * hover state into the modal would make the dismiss-on-outside-click logic
 * tangled (both SVGs would be valid "inside" targets for each other).
 */
function SparkExpandedModal({
  label, samples, format, domain, tone, markerTimestamps, onClose,
}: {
  label: string;
  samples: readonly { value: number; ts: string; charging?: boolean }[];
  format: (v: number) => string;
  domain?: { min: number; max: number };
  tone: "battery" | "storage";
  markerTimestamps?: readonly string[];
  onClose: () => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  // Drag-to-zoom — the user drags across the SVG to select a time range,
  // and the modal re-renders showing only that slice. Tracked as [startIdx,
  // endIdx] into the original samples array. `dragging` holds the in-flight
  // selection while the operator's pointer is down. A min-width threshold
  // (≥5 sample-stops) prevents a stray tap from collapsing the view.
  const [zoomRange, setZoomRange] = useState<[number, number] | null>(null);
  const [dragging, setDragging] = useState<{ fromIdx: number; toIdx: number } | null>(null);
  // Compute the visible slice (zoom-aware), then derive the polyline math
  // from the slice. Hover/markers/min-max all re-derive against the slice
  // so the modal reads as a coherent zoomed view, not a half-zoomed mess.
  const visibleStart = zoomRange?.[0] ?? 0;
  const visibleEnd = zoomRange?.[1] ?? samples.length - 1;
  const visibleSamples = samples.slice(visibleStart, visibleEnd + 1);
  const W = 480;
  const H = 160;
  const values = visibleSamples.map((s) => s.value);
  const min = domain?.min ?? Math.min(...values);
  const max = domain?.max ?? Math.max(...values);
  const span = Math.max(0.0001, max - min);
  const stepX = W / Math.max(1, visibleSamples.length - 1);
  const points = visibleSamples.map((s, i) => {
    const x = i * stepX;
    const y = H - ((s.value - min) / span) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const first = visibleSamples[0];
  const last = visibleSamples[visibleSamples.length - 1];
  const startMs = Date.parse(first.ts);
  const endMs = Date.parse(last.ts);
  const rangeMs = Math.max(1, endMs - startMs);
  const markerPoints = (markerTimestamps ?? [])
    .map((iso) => ({ iso, ms: Date.parse(iso) }))
    .filter(({ ms }) => Number.isFinite(ms) && ms >= startMs && ms <= endMs)
    .map(({ iso, ms }) => ({ iso, x: ((ms - startMs) / rangeMs) * W }));
  const pointerToIdx = (clientX: number): number | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return null;
    const xInViewBox = ((clientX - rect.left) / rect.width) * W;
    const localIdx = Math.round(xInViewBox / stepX);
    if (localIdx < 0 || localIdx >= visibleSamples.length) return null;
    // Translate slice-local idx back to the original samples array so the
    // caller works in a single index namespace whether zoomed or not.
    return visibleStart + localIdx;
  };
  const hovered = hoverIdx != null ? samples[hoverIdx] : null;
  const hoveredX = hoverIdx != null && hoverIdx >= visibleStart && hoverIdx <= visibleEnd
    ? (hoverIdx - visibleStart) * stepX
    : null;
  // Translate an in-flight drag (original-idx) to viewBox X for the marquee.
  // Clamp the upper bound at the visible window so a drag past the edge
  // doesn't draw outside the SVG.
  const dragXs = dragging
    ? (() => {
        const a = Math.max(visibleStart, Math.min(visibleEnd, dragging.fromIdx));
        const b = Math.max(visibleStart, Math.min(visibleEnd, dragging.toIdx));
        const [lo, hi] = a < b ? [a, b] : [b, a];
        return { x1: (lo - visibleStart) * stepX, x2: (hi - visibleStart) * stepX };
      })()
    : null;
  return (
    <div className={r.sparkModalBackdrop} role="dialog" aria-modal="true" aria-label={`${label} expanded chart`} onPointerDown={onClose}>
      <div className={r.sparkModalCard} data-tone={tone} onPointerDown={(e) => e.stopPropagation()}>
        <div className={r.sparkModalHead}>
          <span className={r.deviceSparkLabel}>{label}</span>
          <span className={r.deviceSparkValue}>{format(hovered?.value ?? last.value)}</span>
          {zoomRange && (
            <button type="button" className={r.sparkModalResetZoom} onClick={() => setZoomRange(null)} title="Show the full range again">
              Reset zoom
            </button>
          )}
          <button type="button" className={r.sparkModalClose} onClick={onClose} aria-label="Close expanded chart">×</button>
        </div>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className={r.sparkModalSvg}
          role="img"
          aria-label={`${label} expanded timeline${markerPoints.length ? ` with ${markerPoints.length} markers` : ""}`}
          onPointerMove={(e) => {
            const idx = pointerToIdx(e.clientX);
            setHoverIdx(idx);
            if (dragging && idx != null) setDragging({ fromIdx: dragging.fromIdx, toIdx: idx });
          }}
          onPointerLeave={() => {
            setHoverIdx(null);
            // Don't cancel a drag on leave — the operator might be sweeping
            // off the SVG to reach the edge. Pointer-up still commits.
          }}
          onPointerDown={(e) => {
            const idx = pointerToIdx(e.clientX);
            if (idx == null) return;
            (e.target as Element).setPointerCapture?.(e.pointerId);
            setDragging({ fromIdx: idx, toIdx: idx });
          }}
          onPointerUp={(e) => {
            if (!dragging) return;
            const idx = pointerToIdx(e.clientX) ?? dragging.toIdx;
            const lo = Math.min(dragging.fromIdx, idx);
            const hi = Math.max(dragging.fromIdx, idx);
            setDragging(null);
            // Minimum drag width — a stray tap collapses to lo===hi, which
            // we don't want to interpret as a zoom-to-single-point.
            if (hi - lo >= 4) setZoomRange([lo, hi]);
          }}
        >
          {markerPoints.map((m) => (
            <line key={m.iso} x1={m.x} x2={m.x} y1={0} y2={H} stroke="var(--text-dim)" strokeWidth={1} strokeDasharray="3 3" opacity={0.6} />
          ))}
          <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          {hoveredX != null && hovered && (
            <>
              <line x1={hoveredX} x2={hoveredX} y1={0} y2={H} stroke="currentColor" strokeWidth={1} opacity={0.4} />
              <circle cx={hoveredX} cy={H - ((hovered.value - min) / span) * H} r={4} fill="currentColor" />
            </>
          )}
          {dragXs && (
            <rect
              x={dragXs.x1}
              y={0}
              width={Math.max(0, dragXs.x2 - dragXs.x1)}
              height={H}
              fill="currentColor"
              opacity={0.15}
            />
          )}
        </svg>
        <div className={r.sparkModalAxis}>
          <span>{format(min)}</span>
          <span className={r.sparkModalAxisRight}>{format(max)}</span>
        </div>
        <div className={r.sparkModalFoot}>
          <span>
            {hovered
              ? `${new Date(hovered.ts).toLocaleString()} · ${format(hovered.value)}`
              : `${new Date(first.ts).toLocaleString()} → ${new Date(last.ts).toLocaleString()}`}
          </span>
          <span>
            {visibleSamples.length}
            {zoomRange ? ` / ${samples.length}` : ""}
            {" samples · "}
            {markerPoints.length} marker{markerPoints.length === 1 ? "" : "s"}
            {!zoomRange && samples.length > 8 && (
              <span className={r.sparkModalHint}> · drag to zoom</span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

function nth(n: number | null): string {
  if (n == null) return "";
  const v = n % 100;
  if (v >= 11 && v <= 13) return "th";
  switch (n % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}
