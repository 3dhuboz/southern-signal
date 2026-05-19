/**
 * CameraScreen — the camera-first primary route (Snapchat / iPhone-camera grade).
 *
 * The camera fills ~96% of the viewport. The only persistent on-screen
 * controls are:
 *   - top-left floating pill — REC / LIVE indicator + elapsed time
 *   - top-right floating pill — active scene name (tap → SceneSheet)
 *   - bottom-center BIG SHUTTER — 88×88 single primary action (Begin / End)
 *   - slim semi-transparent secondary dock — Scenes / Settings / Clip Rec
 *
 * Removed from the dock: ScreenRecord (top-of-app feature), Flip (now a
 * double-tap on the camera wrap), Torch (deferred to a long-press in a
 * later commit), Spirit Box / Ovilus (scene-managed via tools.spiritBox
 * / tools.ovilus autoStart — commit d133dae wired these). The 14-toggle
 * channel grid was already excised; this commit removes the residual chip
 * row that lingered around it.
 *
 * All sensor / posterior management that MissionControl does is reproduced
 * here in a leaner form: same hooks, same Bayesian engine, minimal UI.
 * Pro / Lab users get the full MissionControl review surface at /lab
 * (gated behind prefs.proMode); the legacy /investigate path remains as
 * a back-compat alias.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { LiveStreamView } from "../components/LiveStreamView";
import { ScreenRecordButton } from "../components/ScreenRecordButton";
import { SceneSheet } from "../components/SceneSheet";
import { EvpRecorderControl } from "../components/EvpRecorderControl";
import { DispositionPicker } from "../components/DispositionPicker";
import { BroadcastBug } from "../components/broadcast/BroadcastBug";
import { BroadcastAudioMeter } from "../components/broadcast/BroadcastAudioMeter";
import { BroadcastTimestamp } from "../components/broadcast/BroadcastTimestamp";
import { BroadcastSensorHud } from "../components/broadcast/BroadcastSensorHud";
import { BroadcastSceneSelector } from "../components/broadcast/BroadcastSceneSelector";
import { BroadcastLowerThird } from "../components/broadcast/BroadcastLowerThird";
import { useLiveBroadcastState } from "../lib/system/liveBroadcast";
import { usePushToTalk } from "../lib/audio/usePushToTalk";
import { startVad, type VadHandle } from "../lib/audio/vad";
import { useLongPress, useDoubleTap, useHorizontalSwipe, composeHandlers } from "../lib/gestures";
import { CAMERA_WELCOME_KEY } from "../lib/version";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { resolvePreflightOverrides, runPreflight, type PreflightCheck, type PreflightLevel, type PreflightReport } from "../lib/system/preflight";
import { formatTimeToEmpty, projectTimeToEmpty, projectTimeToZero, type BatterySample } from "../lib/system/batteryProjection";
import { verifyAuditChain, appendAuditEntry } from "../lib/db/auditLog";
import { usePwaInstall } from "../lib/system/usePwaInstall";
import { useLiveNarrator } from "../lib/posterior/liveNarrator";
import { LiveAnalyzer } from "../lib/audio/liveAnalyzer";
import { type SectorReading } from "../lib/audio/sectorIndicator";
import { ensureTodayInvestigation } from "../lib/bootstrap";
import { requestPersistentStorage } from "../lib/opfs";
import { recordEvent, recordSensorSample, startInvestigation, stopInvestigation } from "../lib/db/repo";
import { lockProtocol } from "../lib/db/protocolRepo";
import {
  emitAcousticTransient,
  emitMagnetometerAnomaly,
  emitTemporalCoupling,
} from "../lib/posterior/likelihoods";
import { getPosterior } from "../lib/posterior/posterior";
import { applyAndAudit, createSiteSession, type SiteSession } from "../lib/posterior/siteSession";
import { type BaselineSummary, loadBaseline } from "../lib/posterior/sessionBaseline";
import { requestSensorPermissionsForUserGesture } from "../lib/sensors/permissions";
import { useSensors } from "../lib/sensors/useSensors";
import { setCurrent, setPermissionsGranted, useSession } from "../lib/session";
import { usePreferences } from "../lib/preferences";
import { useWakeLock } from "../lib/system/wakeLock";
import type { OverlayChannels } from "../lib/media/canvasCompositor";
import { resolveOverlaysFromScene } from "../lib/overlays/registry";
import {
  BUILT_IN_SCENES,
  hasPickedSceneEver, loadActiveSceneId, saveActiveSceneId, getScene, loadSceneOverrides,
  type SceneId,
} from "../lib/overlays/scenes";
import { useSpiritBox } from "../lib/itc/useSpiritBox";
import { useOvilus } from "../lib/itc/useOvilus";
import { Navigate, useNavigate } from "react-router-dom";
import s from "./CameraScreen.module.css";

/** localStorage key for the watchdog snooze deadline (ms epoch). Versioned
 *  so a future schema change can skip the legacy value cleanly. */
const SNOOZE_STORAGE_KEY = "ss-watchdog-snooze-until-v1";

// Pre-canned quick-tag chips for the marker picker. Each lands a marker with
// category + note in one tap. Module-scoped so the array isn't reallocated
// per render — the picker is part of a long-lived HUD.
type MarkerCat = "sound" | "movement" | "felt";
const QUICK_TAGS: ReadonlyArray<{ label: string; category: MarkerCat }> = [
  { label: "Cold spot",    category: "felt" },
  { label: "Footstep",     category: "sound" },
  { label: "Voice",        category: "sound" },
  { label: "Object moved", category: "movement" },
  { label: "Touched",      category: "felt" },
];
// Long-form category picker chips — same set as MARKER_CATEGORIES upstream
// but module-scoped here so the picker JSX can map without re-declaring.
const PICKER_CATEGORIES: ReadonlyArray<{ id: MarkerCat; label: string }> = [
  { id: "sound",    label: "Sound" },
  { id: "movement", label: "Movement" },
  { id: "felt",     label: "Felt" },
];
// Marker breakdown rows for the HUD popover. Order matches reading priority:
// the loudest signal types first, untagged last.
const MARKER_BREAKDOWN: ReadonlyArray<{ id: "sound" | "movement" | "felt" | "untagged"; label: string }> = [
  { id: "sound",    label: "sound" },
  { id: "movement", label: "movement" },
  { id: "felt",     label: "felt" },
  { id: "untagged", label: "untagged" },
];

// ── Dock button icons ──────────────────────────────────────────────────────
// Slim dock holds: Scenes (text), Settings, ScreenRec, Clip Rec, Flip, Torch.
// Viewport gestures:
//   • long-press anywhere   → push-to-talk (ducks ITC mixer -18dB)
//   • double-tap anywhere   → drop a moment marker into the audit chain
//   • horizontal swipe      → cycle scene (prev / next from BUILT_IN_SCENES)

function IconRecord() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <circle cx="12" cy="12" r="7" fill="currentColor" />
    </svg>
  );
}
function IconSettings() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
function IconFlip() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <rect x="2" y="7" width="20" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="14" r="4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M9 4.5 Q12 2 15 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <polyline points="13.5,3 15,4.5 13.5,6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconTorch() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path d="M9 2 H15 L20 21 H4 Z" fill="currentColor" opacity="0.2" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <rect x="8.5" y="0.5" width="7" height="3.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="2.25" r="1" fill="currentColor" />
    </svg>
  );
}

// Top-left status state — passed through to the BroadcastBug component
// which owns label + visual treatment. Kept here so the priority ladder
// (rec > live > ready > idle) stays in CameraScreen where the broadcast /
// session timers already live.
type TopPillState = "rec" | "live" | "ready" | "idle";

/**
 * Format the failing preflight checks for the watchdog toast. Prefers the
 * numeric `data` snapshot (e.g. "Battery 18%", "212 MB free") over the prose
 * `message` field — a glance-readable number sells the warning's urgency
 * better than a sentence the operator has to parse mid-hunt.
 */
function formatWatchdogChecks(checks: readonly PreflightCheck[]): string {
  const parts: string[] = [];
  for (const c of checks) {
    if (c.level === "ok") continue;
    if (c.id === "battery" && c.data?.batteryLevel != null) {
      const pct = Math.round(c.data.batteryLevel * 100);
      parts.push(`Battery ${pct}%${c.data.batteryCharging ? " ⚡" : ""}`);
    } else if (c.id === "storage" && c.data?.storageFreeBytes != null) {
      const mb = Math.round(c.data.storageFreeBytes / (1024 * 1024));
      parts.push(`${mb} MB free`);
    } else if (c.id === "camera" || c.id === "mic") {
      parts.push(`${c.id} ${c.data?.permission ?? "issue"}`);
    } else {
      parts.push(c.message);
    }
  }
  return parts.join(" · ");
}

/** True when any failing check is the storage one — drives the install CTA. */
function watchdogStorageWarn(report: PreflightReport): boolean {
  return report.checks.some((c) => c.id === "storage" && c.level !== "ok");
}

/**
 * Filter suppressed-by-pref checks out of a watchdog report and recompute
 * the overall severity from what remains. Pre-start preflight never goes
 * through this — the operator's "stop nagging me" pref intentionally only
 * applies mid-session so they can't accidentally hide a battery failure at
 * the moment of starting a session.
 */
function applyWatchdogSuppression(
  report: PreflightReport,
  suppress: { battery: boolean; storage: boolean },
): PreflightReport {
  if (!suppress.battery && !suppress.storage) return report;
  const checks = report.checks.filter((c) =>
    !((suppress.battery && c.id === "battery") || (suppress.storage && c.id === "storage")),
  );
  const overall: PreflightLevel = checks.some((c) => c.level === "block")
    ? "block"
    : checks.some((c) => c.level === "warn") ? "warn" : "ok";
  return { overall, checks };
}

/** Ordinal formatter for the "Nth warning" counter — short forms that read
 *  cleanly inline. Used by the watchdog toast superscript chip. */
function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const mod10 = n % 10;
  return `${n}${mod10 === 1 ? "st" : mod10 === 2 ? "nd" : mod10 === 3 ? "rd" : "th"}`;
}

// `mergeWatchdogReports` USED to keep the worst-severity check per id across
// reports — but each preflight is already a full snapshot, so the new report
// always contains current state for every active check. Merging just stalled
// recovered checks at their stale warn level. Use the new report directly.


// ── Component ────────────────────────────────────────────────────────────────

export function CameraScreen() {
  const session = useSession();
  const sensors = useSensors(session.permissionsGranted);
  const [prefs] = usePreferences();
  const proMode = prefs.proMode;
  // PWA install status — surfaced from the watchdog toast as a fallback CTA
  // when storage is the failing check. Standalone PWAs get OPFS persistence
  // guarantees, which is exactly what a "running out of room" warning is
  // really about. usePwaInstall is cheap (a single useEffect with two
  // listeners) so we always call it even on non-storage paths.
  const installStatus = usePwaInstall();

  // Session lifecycle
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);

  // Bayesian posterior
  const [siteSession, setSiteSession] = useState<SiteSession>(() => createSiteSession());
  const [posterior, setPosterior] = useState<number>(siteSession.state.prior);

  // Broadcast state — recording / live status from LiveStreamView
  const broadcastState = useLiveBroadcastState();
  const recordToggleRef = useRef<(() => void) | null>(null);
  const liveToggleRef   = useRef<(() => void) | null>(null);
  const flipCameraRef   = useRef<(() => void) | null>(null);
  const torchToggleRef  = useRef<(() => void) | null>(null);
  const refocusRef      = useRef<(() => void) | null>(null);
  const startCameraRef  = useRef<(() => Promise<void>) | null>(null);
  // Snap a small JPEG thumbnail of the active camera frame on marker drop.
  // LiveStreamView fills this in once the source <video> is decodable;
  // commitMarker reads it synchronously so the dataUrl can flow into the
  // audit chain via the marker's metadata payload.
  const snapThumbnailRef = useRef<(() => string | null) | null>(null);
  const [cameraState, setCameraState] = useState({
    streamOn: false, whipConfigured: false,
    torchSupported: false, torchOn: false,
    facingMode: "environment" as "environment" | "user",
  });
  const handleCameraState = useCallback((next: {
    streamOn: boolean; whipConfigured: boolean;
    torchSupported: boolean; torchOn: boolean;
    facingMode: "environment" | "user";
  }) => {
    setCameraState((prev) =>
      prev.streamOn === next.streamOn && prev.whipConfigured === next.whipConfigured &&
      prev.torchSupported === next.torchSupported && prev.torchOn === next.torchOn &&
      prev.facingMode === next.facingMode
        ? prev : next,
    );
  }, []);

  // ITC quick-dock tools — phoneme cycle (spirit box) and word-gen (ovilus).
  // Both publish to the module-scope ITC channel store which the compositor
  // reads each frame; the `itc` overlay channel must be enabled to show them.
  // The active scene's tools config kicks the cycle on automatically when the
  // session begins (e.g. Spirit Box Session scene), so the operator gets a
  // one-tap setup. Manual toggle remains the override.
  // Quantise to 2dp so sensor jitter doesn't thrash the entropy ref-write
  // effect inside useSpiritBox / useOvilus every frame.
  const rawEntropy = sensors.snapshot.magnetometer?.magnitude ?? sensors.snapshot.motion?.accelMagnitude ?? 0;
  const itcEntropy = Math.round(rawEntropy * 100) / 100;

  // Session timer — elapsed seconds since Begin
  const [sessionSecs, setSessionSecs] = useState(0);
  const sessionStartRef = useRef<number | null>(null);
  useEffect(() => {
    if (running) {
      sessionStartRef.current = Date.now();
      setSessionSecs(0);
      const h = window.setInterval(() => {
        setSessionSecs(Math.floor((Date.now() - (sessionStartRef.current ?? Date.now())) / 1000));
      }, 1000);
      return () => window.clearInterval(h);
    }
    sessionStartRef.current = null;
    setSessionSecs(0);
  }, [running]);

  // Audio analyzer → sector / coherence / rms
  const analyzerRef = useRef<LiveAnalyzer | null>(null);
  const [sectorReading, setSectorReading] = useState<SectorReading | null>(null);
  // audioRms updates at 94 Hz (48 kHz / 512 samples). Avoid a React render
  // every frame: keep the always-current level in a ref, and surface a
  // coarse ~5 Hz copy through state for consumers (BroadcastAudioMeter,
  // LiveStreamView's overlay-state effect). The new broadcast meter
  // handles its own peak-hold ballistics off the 5 Hz state copy — no
  // direct DOM writes needed.
  const audioRmsRef = useRef<number>(0.05);
  const [audioRmsCoarse, setAudioRmsCoarse] = useState<number>(0.05);
  const lastRmsCoarseEmitRef = useRef<number>(0);

  // Debounce refs for likelihood emission
  const lastAcousticEmitTsRef = useRef<number>(0);
  const lastMagnetometerEmitTsRef = useRef<number>(0);
  const lastEmissionTsRef = useRef<{ acoustic: number | null; magnetometer: number | null }>({ acoustic: null, magnetometer: null });

  // Baseline for emission quality gates
  const baselineRef = useRef<BaselineSummary | null>(null);
  useEffect(() => {
    const id = session.current?.id;
    if (id) baselineRef.current = loadBaseline(id);
    else baselineRef.current = null;
  // session is a useRef — the ref object is stable, .current mutates without
  // needing to retrigger. session.current?.id is the read-out scalar; adding
  // the ref itself as a dep would either no-op or churn.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.current?.id]);

  // Live narrator caption
  const narratorCaption = useLiveNarrator(siteSession.recentIncrements, {
    speak: false,
    captionMs: 7000,
  });

  // ── Scene-driven overlay channels ──────────────────────────────────────────
  // The active scene (chosen in HuntSetup) is the source of truth for which
  // overlays burn into the broadcast frame. We resolve the scene's sparse
  // overlay map against the registry once at mount — operator can still
  // toggle individual channels for the session, but the next session reload
  // will re-resolve from whichever scene is active in localStorage.
  const [activeSceneId, setActiveSceneId] = useState<SceneId>(() => loadActiveSceneId());
  // Mirror the active scene id into a ref so watchdog ticks read the current
  // value at fire time without re-binding the effect every scene swap. The
  // effect itself only depends on `running`.
  const activeSceneIdRef = useRef<SceneId>(activeSceneId);
  useEffect(() => { activeSceneIdRef.current = activeSceneId; }, [activeSceneId]);
  // Same pattern for the operator-level preflight pref: a Setup edit during
  // a running session needs to be visible to the next watchdog tick without
  // re-binding the 60s interval.
  const preflightPrefRef = useRef(prefs.preflight);
  useEffect(() => { preflightPrefRef.current = prefs.preflight; }, [prefs.preflight]);
  const activeScene = getScene(activeSceneId);
  const [channels, setChannels] = useState<OverlayChannels>(() =>
    resolveOverlaysFromScene({ ...(activeScene?.overlays ?? {}), ...loadSceneOverrides(activeSceneId) }, { proMode }),
  );
  // Whenever the active scene changes (operator picked a different one from
  // the dock chip or HuntSetup) OR Pro mode flips, re-resolve channels.
  // Pro-mode gating matters: turning Pro off mid-session should strip the
  // posterior/activity/edge-glow overlays even from the pro_lab scene.
  // Dep on `activeSceneId` (the scalar) — `activeScene` is derived from it
  // and `getScene` returns a stable reference, but pinning to the id keeps
  // the effect from re-firing if registry internals ever reshape the lookup.
  useEffect(() => {
    const scene = getScene(activeSceneId);
    setChannels(resolveOverlaysFromScene({ ...(scene?.overlays ?? {}), ...loadSceneOverrides(activeSceneId) }, { proMode }));
  }, [activeSceneId, proMode]);
  const handleChannelChange = useCallback((key: keyof OverlayChannels, value: boolean) => {
    setChannels((prev) => prev[key] === value ? prev : { ...prev, [key]: value });
  }, []);

  // ── Scene sheet (bottom-of-screen scene picker) ──────────────────────────
  // The top-right pill opens this — replaces the navigate("/hunt-setup") jump
  // for in-session scene swaps so the operator never leaves the camera.
  const [sceneSheetOpen, setSceneSheetOpen] = useState(false);

  // ── Gesture handlers ─────────────────────────────────────────────────────
  // Long-press anywhere on the camera primes Push-To-Talk — ducks the ITC
  // mixer -18dB so the operator's narration lands cleanly on the recording.
  // Double-tap drops a moment marker into the audit chain (a transient toast
  // confirms). Horizontal swipe cycles to the previous/next scene.
  const [pttActive, setPttActive] = useState(false);
  // usePushToTalk is called once further down with `pttActive || vadActive`
  // so manual PTT and hands-free VAD share a single ducking pipeline.
  const longPressProps = useLongPress(setPttActive);

  // Marker drop — fires a recordEvent into the current investigation +
  // surfaces a 1.5s confirmation toast at top-center. The audit log already
  // captures `event.marker` per recordEvent's instrumentation.
  //
  // Throttle: rapid-fire taps (operator excited, hands shaky, accidental
  // double-double-tap) within 600ms of the last marker get swallowed. The
  // toast still extends so the operator sees their second tap "succeeded"
  // visually — no marker dupes in the audit chain, no UI mystery.
  const MARKER_THROTTLE_MS = 600;
  const [markerToastUntil, setMarkerToastUntil] = useState<number>(0);
  const lastMarkerTsRef = useRef<number>(0);
  // Marker categories — three operator-affordable types for reviewers to
  // filter by later in Review. The picker auto-commits as `null` (untagged)
  // after MARKER_PICKER_MS so a fire-and-forget double-tap still lands a
  // marker — categorisation is opt-in. NB: changing this set has no schema
  // impact since metadata is opaque, but Review's filter chips lock to these.
  type MarkerCategory = "sound" | "movement" | "felt" | null;
  const MARKER_PICKER_MS = 2200;
  const [markerPicker, setMarkerPicker] = useState<{ until: number; committed: boolean } | null>(null);
  const markerCommittedRef = useRef(false);
  // Session-scoped marker tally — surfaced as a small pill on the camera HUD
  // so the operator knows their tag count without leaving the scene. Resets
  // on session start; bumps on every successful commitMarker call so an
  // auto-untag (after the picker timeout) counts the same as a category tap.
  // Per-category breakdown for the HUD pill + popover. Total count is
  // derived from these (sound + movement + felt + untagged) so we don't
  // carry two pieces of state that can desync. Reset on session start.
  const [sessionMarkerByCat, setSessionMarkerByCat] = useState<{ sound: number; movement: number; felt: number; untagged: number }>(
    { sound: 0, movement: 0, felt: 0, untagged: 0 },
  );
  const sessionMarkerCount = sessionMarkerByCat.sound + sessionMarkerByCat.movement + sessionMarkerByCat.felt + sessionMarkerByCat.untagged;
  // Pill popover open-state. Click pill → open; second click or outside
  // pointer → close. Navigation to Review moves to an explicit "Open
  // Review →" link inside the popover so an accidental swipe-on-pill
  // doesn't yank the operator off the camera mid-session.
  const [markerPillOpen, setMarkerPillOpen] = useState(false);
  const markerPillWrapRef = useRef<HTMLDivElement | null>(null);
  // a11y: trap focus in the popover dialog while it's open. Escape closes,
  // restore-focus returns the operator to the pill button on dismiss.
  const markerPillTrapRef = useFocusTrap<HTMLDivElement>(markerPillOpen, {
    onEscape: () => setMarkerPillOpen(false),
  });
  // After a session stops on the Camera surface, hold the investigation id
  // here so the DispositionPicker can prompt the operator to classify it.
  // Without this, the base-rate dashboard silently miscounts (Pro/Lab
  // sessions get classified via MissionControl's picker but default Camera
  // sessions slipped through). Mandatory-classify contract from
  // DispositionPicker.tsx:9-13 enforced for both flows now.
  const [pendingDispositionFor, setPendingDispositionFor] = useState<string | null>(null);
  // Outside-pointer close — once the popover is open, any pointerdown that
  // doesn't land inside the wrap dismisses it. Listener is short-lived
  // (only attached while open) so it doesn't add a global handler for the
  // 99% case where the popover is closed.
  useEffect(() => {
    if (!markerPillOpen) return;
    const onPointer = (e: PointerEvent) => {
      const wrap = markerPillWrapRef.current;
      if (wrap && e.target instanceof Node && !wrap.contains(e.target)) {
        setMarkerPillOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [markerPillOpen]);

  // First-run helper card. Shows once on a fresh install (or after the
  // version bump) and dismisses to localStorage. Hidden while a session is
  // running so the operator's eye lands on the live feed, not onboarding
  // copy — the dismissal still persists so it doesn't pop back when they
  // end the session.
  const [welcomeVisible, setWelcomeVisible] = useState<boolean>(() => {
    try { return localStorage.getItem(CAMERA_WELCOME_KEY) == null; }
    catch { return false; }
  });
  const dismissWelcome = useCallback(() => {
    try { localStorage.setItem(CAMERA_WELCOME_KEY, String(Date.now())); }
    catch { /* private mode — in-memory dismiss still works for the session */ }
    setWelcomeVisible(false);
  }, []);
  // a11y: trap focus while the welcome card is on screen so an external-
  // keyboard user can't tab into the camera chrome behind. Escape dismisses.
  const welcomeTrapRef = useFocusTrap<HTMLDivElement>(welcomeVisible && !running, {
    onEscape: dismissWelcome,
  });

  const commitMarker = useCallback((category: MarkerCategory, note?: string) => {
    if (markerCommittedRef.current) return;
    const inv = session.current;
    if (!inv) return;
    // Flip the ref AFTER the session-guard — otherwise an end-of-session
    // race could leave the ref stuck true and suppress the next session's
    // marker commits until dropMarker reset it.
    markerCommittedRef.current = true;
    setSessionMarkerByCat((prev) => {
      const key = category ?? "untagged";
      return { ...prev, [key]: prev[key] + 1 };
    });
    const nowMs = Date.now();
    const elapsed = sessionStartRef.current ? Math.floor((nowMs - sessionStartRef.current) / 1000) : 0;
    // Snap a 160px JPEG of the live frame. Null when the camera is closed
    // (audio-only scene, source not ready) — marker still lands. The dataUrl
    // sits in evidence_events.metadata_json (+ rides the sync queue); the
    // audit chain entry itself only carries {id, source, event_type}, so the
    // thumbnail is replayable but not directly in the hash chain.
    const thumb = snapThumbnailRef.current?.() ?? null;
    const trimmedNote = note?.trim();
    void (async () => {
      const event = await recordEvent({
        investigation_id: inv.id,
        source: "user",
        event_type: "marker",
        title: category ? `Moment marked · ${category}` : "Moment marked",
        metadata: { sessionElapsedSec: elapsed, sceneId: activeSceneId, category, thumbnailDataUrl: thumb },
      });
      // Quick-tag note → append-only marker.annotated, same path the Review
      // editor uses. Preserves "marker created, then noted" in the chain
      // rather than back-editing the capture row.
      //
      // investigation_id MUST be in the payload — the per-case Merkle root
      // computation in src/lib/forensic/manifest.ts filters audit rows by
      // `payload.investigation_id === inv.id`. Without it, marker
      // annotations silently fall out of the per-case bundle, and a
      // verifier comparing two manifests over time will flag the drift.
      if (trimmedNote) {
        try {
          await appendAuditEntry({
            actor: "user",
            kind: "marker.annotated",
            payload: { investigation_id: inv.id, marker_id: event.id, note: trimmedNote, category },
          });
        } catch { /* surfaced via the chain banner */ }
      }
    })();
  }, [session, activeSceneId]);

  const dropMarker = useCallback(() => {
    const inv = session.current;
    if (!inv) return;
    const nowMs = Date.now();
    setMarkerToastUntil(nowMs + 1500);
    if (nowMs - lastMarkerTsRef.current < MARKER_THROTTLE_MS) return;
    lastMarkerTsRef.current = nowMs;
    markerCommittedRef.current = false;
    setMarkerPicker({ until: nowMs + MARKER_PICKER_MS, committed: false });
    // Auto-commit as untagged after the picker timeout — fire-and-forget
    // double-taps still land in the chain. A category tap before then races
    // the timer; markerCommittedRef guards against double-commits.
    window.setTimeout(() => {
      if (!markerCommittedRef.current) commitMarker(null);
      setMarkerPicker(null);
    }, MARKER_PICKER_MS);
  }, [session, commitMarker]);
  const doubleTapProps = useDoubleTap(dropMarker);

  const pickMarkerCategory = useCallback((cat: Exclude<MarkerCategory, null>) => {
    commitMarker(cat);
    setMarkerPicker(null);
  }, [commitMarker]);

  // Quick-tag chip handler. The chip set itself is module-scoped (QUICK_TAGS).
  const pickMarkerQuickTag = useCallback((label: string, cat: Exclude<MarkerCategory, null>) => {
    commitMarker(cat, label);
    setMarkerPicker(null);
  }, [commitMarker]);

  // Horizontal swipe → cycle scene. Index modulo wraps both directions so the
  // operator can keep swiping past either end. saveActiveSceneId persists the
  // pick so the next session reload starts on the chosen scene.
  const cycleScene = useCallback((dir: "left" | "right") => {
    const idx = BUILT_IN_SCENES.findIndex((sc) => sc.id === activeSceneId);
    if (idx < 0) return;
    const len = BUILT_IN_SCENES.length;
    const next = dir === "right"
      ? BUILT_IN_SCENES[(idx + 1) % len]
      : BUILT_IN_SCENES[(idx - 1 + len) % len];
    saveActiveSceneId(next.id);
    setActiveSceneId(next.id);
  }, [activeSceneId]);
  const swipeProps = useHorizontalSwipe(cycleScene);

  // Marker toast — visible flag flips off via a setTimeout. Keeping the
  // expiry in state (vs imperative timer) lets the toast survive React
  // re-renders without flashing.
  const markerToastVisible = markerToastUntil > Date.now();
  useEffect(() => {
    if (!markerToastVisible) return;
    const handle = window.setTimeout(() => setMarkerToastUntil(0), Math.max(0, markerToastUntil - Date.now()));
    return () => window.clearTimeout(handle);
  }, [markerToastVisible, markerToastUntil]);

  // ── Tap-to-focus — single click on the viewport re-triggers autofocus
  //    and pulses a small ring at the tap point as visual confirmation.
  //    The handler is `onClick` (not pointerdown) so it doesn't race with
  //    the long-press / double-tap / swipe pipeline above — onClick fires
  //    AFTER those have resolved, and is idempotent so a double-tap just
  //    refocuses twice (cheap).
  const [focusPulse, setFocusPulse] = useState<{ x: number; y: number; key: number } | null>(null);
  const handleFocusTap = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!cameraState.streamOn) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setFocusPulse({ x: e.clientX - rect.left, y: e.clientY - rect.top, key: Date.now() });
    void refocusRef.current?.();
  }, [cameraState.streamOn]);
  useEffect(() => {
    if (!focusPulse) return;
    const handle = window.setTimeout(() => setFocusPulse(null), 700);
    return () => window.clearTimeout(handle);
  }, [focusPulse]);

  // ── VAD auto-duck — when prefs.vadAutoDuck is ON, watch the mic stream
  //    and feed its voice-activity boolean into usePushToTalk so the ITC
  //    mixer ducks hands-free. Long-press PTT remains as a manual override
  //    that wins (state OR).
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [vadActive, setVadActive] = useState(false);
  useEffect(() => {
    if (!prefs.vadAutoDuck || !micStream) { setVadActive(false); return; }
    let handle: VadHandle | null = null;
    try {
      handle = startVad(micStream, setVadActive, {
        activationDb: prefs.vadConfig.sensitivityDb,
        // Deactivation sits half the activation gap below — keeps the
        // hysteresis ratio consistent as the operator tunes sensitivity.
        deactivationDb: Math.max(2, prefs.vadConfig.sensitivityDb / 2),
        attackMs: prefs.vadConfig.attackMs,
        releaseMs: prefs.vadConfig.releaseMs,
        // Seed the adaptive floor from a saved Sound-Check baseline so the
        // trigger threshold is correct from the first audio frame instead of
        // adapting upward through the warmup window.
        initialNoiseFloorDb: prefs.vadConfig.noiseFloorDb ?? undefined,
      });
    } catch { setVadActive(false); }
    return () => { handle?.stop(); setVadActive(false); };
  // noiseFloorDb is intentionally a SEED at VAD startup — the adaptive floor
  // takes over from there. Re-triggering on noiseFloorDb changes would tear
  // down and re-seed mid-session, which is the opposite of what we want.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.vadAutoDuck, micStream, prefs.vadConfig.sensitivityDb, prefs.vadConfig.attackMs, prefs.vadConfig.releaseMs]);
  usePushToTalk(pttActive || vadActive);

  // ── Pre-flight blocker — runs at mount + on every Begin tap. If anything
  //    critical fails (camera/mic/storage), surface a blocker dialog with
  //    actionable hints instead of letting getUserMedia bury the error
  //    10 minutes into a hunt.
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);
  const [preflightDismissed, setPreflightDismissed] = useState(false);
  // ── Mid-session watchdog — re-runs preflight every 60s while running.
  //    Surfaces a non-blocking toast only when the overall level WORSENS vs
  //    what was seen at Begin. Storage and battery degrade slowly during a
  //    long hunt; the watchdog gives the operator a chance to swap a battery
  //    or free space before the recording silently drops chunks.
  //
  //    Anti-pester: we only fire the toast once per degradation event by
  //    tracking the last-fired overall in a ref; staying degraded doesn't
  //    re-emit. Returning to OK doesn't fire either — it just resets the ref
  //    so the next degradation event can fire.
  const WATCHDOG_INTERVAL_MS = 60_000;
  const WATCHDOG_TOAST_MS = 7000;
  const [watchdog, setWatchdog] = useState<PreflightReport | null>(null);
  const lastWatchdogLevelRef = useRef<"ok" | "warn" | "block">("ok");
  // Track the set of failing check ids we've already toasted about so a new
  // failing check (e.g. storage drops while battery is already warn) refires
  // the toast even though `overall` stayed at warn. Without this, a same-level
  // re-degradation goes unsurfaced.
  const lastWatchdogFailIdsRef = useRef<string>("");
  // Count of toasts fired in the current session — surfaced as "Nth warning"
  // in the toast so the operator notices a degrading trend rather than
  // treating each notification as an isolated event. Resets when running
  // flips off (alongside the level/failIds refs).
  const [watchdogCount, setWatchdogCount] = useState(0);
  // Rolling buffer of battery readings the watchdog observed during this
  // session — fed into projectTimeToEmpty for the toast's "swap in N min"
  // hint. Keeps the most recent 20 samples (~20 minutes at the 60s tick)
  // so the regression is a recent-trend estimate, not a session-average.
  const batterySamplesRef = useRef<BatterySample[]>([]);
  const BATTERY_SAMPLE_BUFFER = 20;
  const [batteryProjectionMinutes, setBatteryProjectionMinutes] = useState<number | null>(null);
  // Sibling buffer for storage_free MB samples — same projection helper as
  // the battery path, just looking for "when does free hit 0 MB" instead.
  // Useful on long video sessions where the operator's already lost track
  // of how fast the disk's filling.
  const storageSamplesRef = useRef<{ value: number; ts: string }[]>([]);
  const STORAGE_SAMPLE_BUFFER = 20;
  const [storageProjectionMinutes, setStorageProjectionMinutes] = useState<number | null>(null);
  // Latest battery/storage readings the watchdog observed — drives the
  // always-on device-state HUD chip. Stored as integers/booleans so React
  // doesn't re-render on micro-float jitter; only meaningful changes propagate.
  const [hudBatteryPct, setHudBatteryPct] = useState<number | null>(null);
  const [hudBatteryCharging, setHudBatteryCharging] = useState(false);
  const [hudStorageMb, setHudStorageMb] = useState<number | null>(null);
  const [hudBatteryWarn, setHudBatteryWarn] = useState(false);
  const [hudStorageWarn, setHudStorageWarn] = useState(false);
  // Watchdog snooze — when set in the future, tick() skips the toast-fire
  // path entirely until the timestamp has passed. Lighter-touch than the
  // Setup-level suppression toggle: suppress is "stop nagging me about
  // this check forever", snooze is "give me ten minutes of quiet". The
  // operator gets a Snooze button on the toast itself; cleared when the
  // session stops or the operator dismisses the toast manually.
  //
  // State holds the deadline so the HUD chip ("Snoozed for 8m") can render;
  // the parallel ref is what the watchdog tick reads at fire time without
  // re-binding the 60s interval on every state update. The deadline is also
  // mirrored to localStorage so a navigation away (Setup, Review) and back
  // doesn't reset the snooze — operators rely on it persisting through the
  // 10-minute window they asked for.
  const [watchdogSnoozeUntil, setWatchdogSnoozeUntil] = useState<number | null>(() => {
    try {
      const stored = localStorage.getItem(SNOOZE_STORAGE_KEY);
      if (!stored) return null;
      const parsed = Number(stored);
      if (!Number.isFinite(parsed)) return null;
      // A stored deadline in the past is stale — treat as no snooze and
      // tidy the storage so the chip doesn't briefly flicker on mount.
      if (parsed <= Date.now()) {
        localStorage.removeItem(SNOOZE_STORAGE_KEY);
        return null;
      }
      return parsed;
    } catch { return null; }
  });
  const watchdogSnoozeUntilRef = useRef<number | null>(null);
  useEffect(() => { watchdogSnoozeUntilRef.current = watchdogSnoozeUntil; }, [watchdogSnoozeUntil]);
  // Auto-clear when the snooze deadline passes so the chip vanishes without
  // a click. One setTimeout per snooze — cleaner than polling every tick.
  useEffect(() => {
    if (watchdogSnoozeUntil == null) {
      try { localStorage.removeItem(SNOOZE_STORAGE_KEY); } catch { /* swallow */ }
      return;
    }
    try { localStorage.setItem(SNOOZE_STORAGE_KEY, String(watchdogSnoozeUntil)); } catch { /* swallow */ }
    const remaining = watchdogSnoozeUntil - Date.now();
    if (remaining <= 0) { setWatchdogSnoozeUntil(null); return; }
    const h = window.setTimeout(() => setWatchdogSnoozeUntil(null), remaining);
    return () => window.clearTimeout(h);
  }, [watchdogSnoozeUntil]);
  // Re-tick the chip every 30s so the "Snoozed for Nm" countdown stays
  // roughly current. State doesn't actually change — we just force a render
  // via a dummy ticker. Skipped when no snooze is active.
  const [snoozeTick, setSnoozeTick] = useState(0);
  useEffect(() => {
    if (watchdogSnoozeUntil == null) return;
    const h = window.setInterval(() => setSnoozeTick((n) => n + 1), 30_000);
    return () => window.clearInterval(h);
  }, [watchdogSnoozeUntil]);
  void snoozeTick; // referenced only to satisfy lint; the value drives renders
  const WATCHDOG_SNOOZE_MS = 10 * 60_000;
  // Suppresses watchdog ticks while the browser install prompt is on screen.
  // Without it, a 60s tick can fire mid-prompt and stack a fresh toast behind
  // the native dialog — confusing the operator when they dismiss the prompt
  // and find a second warning waiting.
  const installPromptOpenRef = useRef(false);

  // ITC hooks read the scene's tools config — Spirit Box Session auto-starts
  // the spirit box; Pro/Lab leaves Ovilus to manual. Output is consumed via
  // the live overlay compositor, so we call the hooks for their side effects
  // (publishing to the ITC channel store) and ignore their returned API.
  useSpiritBox(itcEntropy, running, activeScene?.tools.spiritBox === true);
  useOvilus(itcEntropy, running, activeScene?.tools.ovilus === true);

  // Watchdog effect: ticks every WATCHDOG_INTERVAL_MS while running. The
  // baseline level (from the Begin preflight) is captured into the ref by
  // handleBegin; this effect only ESCALATES the ref upward, so going from
  // ok → warn → block surfaces toasts but warn → ok doesn't. We fire an
  // immediate tick at activation so a device that degrades inside the first
  // minute still gets surfaced, then settle into the periodic cadence.
  useEffect(() => {
    if (!running) {
      // Reset the baseline so the next session's watchdog starts clean —
      // otherwise a session that hit `block` would silently leave the next
      // session unable to fire warn-tier toasts. handleBegin re-seeds this
      // from the Begin preflight, but the explicit reset here is defensive.
      lastWatchdogLevelRef.current = "ok";
      lastWatchdogFailIdsRef.current = "";
      setWatchdogCount(0);
      batterySamplesRef.current = [];
      setBatteryProjectionMinutes(null);
      storageSamplesRef.current = [];
      setStorageProjectionMinutes(null);
      watchdogSnoozeUntilRef.current = null;
      setWatchdogSnoozeUntil(null);
      setSessionMarkerByCat({ sound: 0, movement: 0, felt: 0, untagged: 0 });
      setMarkerPillOpen(false);
      setHudBatteryPct(null);
      setHudBatteryCharging(false);
      setHudStorageMb(null);
      setHudBatteryWarn(false);
      setHudStorageWarn(false);
      return;
    }
    const tick = async () => {
      // Skip while the install prompt is open — preflight still passes, but
      // a fresh toast stacking behind the browser's native dialog would be
      // confusing UX. The next tick after the prompt closes picks up state.
      if (installPromptOpenRef.current) return;
      // Snooze guard — short-circuit before runPreflight() since the whole
      // point of snoozing is to stop nagging. We still want sampling to
      // happen, so flow through after the toast-fire gate instead.
      try {
        // Re-read activeScene each tick so a mid-session swap to a plugged-in
        // scene immediately stops firing battery toasts. Operator-level prefs
        // sit BELOW scene overrides: a scene-specific tightening wins, but
        // otherwise an operator's global pref applies on top of the module
        // defaults.
        const raw = await runPreflight(resolvePreflightOverrides(preflightPrefRef.current, getScene(activeSceneIdRef.current)?.preflightOverrides));
        // Apply operator suppression last — Setup → Preflight thresholds lets
        // the operator silence battery/storage warnings here. Pre-start
        // preflight intentionally doesn't honour this; suppression only
        // affects the mid-session re-check cadence, not initial gating.
        const report = applyWatchdogSuppression(raw, preflightPrefRef.current.watchdogSuppress);
        const severity = { ok: 0, warn: 1, block: 2 } as const;
        // Fire the toast when (a) the overall severity escalated OR
        // (b) a new check id started failing while severity stayed the same
        // (e.g. battery already warn, storage drops to warn — operator
        // wouldn't see it without this branch).
        const failIds = report.checks
          .filter((c) => c.level !== "ok")
          .map((c) => `${c.id}:${c.level}`)
          .sort()
          .join("|");
        const severityEscalated = severity[report.overall] > severity[lastWatchdogLevelRef.current];
        const newFail = failIds !== "" && failIds !== lastWatchdogFailIdsRef.current;
        const snoozedUntil = watchdogSnoozeUntilRef.current;
        const snoozeActive = snoozedUntil !== null && Date.now() < snoozedUntil;
        if ((severityEscalated || newFail) && !snoozeActive) {
          lastWatchdogLevelRef.current = report.overall;
          lastWatchdogFailIdsRef.current = failIds;
          setWatchdog(report);
          setWatchdogCount((n) => n + 1);
        } else if (severityEscalated || newFail) {
          // Snooze swallowed a fire — still update the refs so we don't
          // re-fire the SAME degradation the moment snooze expires; a new
          // degradation (different failIds or higher severity) will fire.
          lastWatchdogLevelRef.current = report.overall;
          lastWatchdogFailIdsRef.current = failIds;
        }
        // Sample battery + storage into the case file each tick — gives the
        // export bundle a per-minute timeline of device-state degradation
        // alongside the audio/sensor evidence stream. Cheap (one INSERT each)
        // and the sample queue throttles cloud sync to one row per minute
        // per (investigation_id, sensor_type) anyway.
        //
        // Sample from `raw` (not the suppression-filtered `report`) so the
        // review-time spark still has data even when the operator silenced
        // toasts. Suppression is "stop nagging me", not "stop collecting".
        const inv = session.current;
        const battery = raw.checks.find((c) => c.id === "battery");
        // Update the in-memory projection buffer first — even when there's no
        // active investigation we still want the toast to show an ETA, and
        // the buffer is what feeds projectTimeToEmpty.
        if (battery?.data?.batteryLevel != null) {
          const sample: BatterySample = {
            value: battery.data.batteryLevel,
            ts: new Date().toISOString(),
            charging: battery.data.batteryCharging === true,
          };
          const buf = batterySamplesRef.current;
          buf.push(sample);
          if (buf.length > BATTERY_SAMPLE_BUFFER) buf.splice(0, buf.length - BATTERY_SAMPLE_BUFFER);
          const projection = projectTimeToEmpty(buf);
          // Only surface the ETA below a soft threshold (35 min) — a curve
          // that projects 8 hours doesn't warrant operator attention and
          // would clutter the toast. The buffer keeps populating regardless.
          if (projection && projection.minutesToEmpty < 35 * 60) {
            setBatteryProjectionMinutes(projection.minutesToEmpty);
          } else {
            setBatteryProjectionMinutes(null);
          }
        }
        // Always update the HUD chip from the raw report — even when the
        // operator has suppressed toasts for a check, they still want to see
        // the live readings. Comparing-before-setting keeps React from re-
        // rendering on float jitter (battery levels arrive as 0.83000004 etc).
        if (battery?.data?.batteryLevel != null) {
          const pct = Math.round(battery.data.batteryLevel * 100);
          const charging = battery.data.batteryCharging === true;
          setHudBatteryPct((prev) => (prev === pct ? prev : pct));
          setHudBatteryCharging((prev) => (prev === charging ? prev : charging));
        }
        setHudBatteryWarn((prev) => {
          const next = report.checks.some((c) => c.id === "battery" && c.level !== "ok");
          return prev === next ? prev : next;
        });
        // Update the storage projection buffer regardless of investigation
        // state — same rationale as battery; the toast wants an ETA even on
        // a not-yet-started session. Storage projects in MB rather than
        // bytes to stay readable in the buffer + drainPerMinute.
        const storageCheck = raw.checks.find((c) => c.id === "storage");
        if (storageCheck?.data?.storageFreeBytes != null) {
          const mb = Math.round(storageCheck.data.storageFreeBytes / (1024 * 1024));
          setHudStorageMb((prev) => (prev === mb ? prev : mb));
        }
        setHudStorageWarn((prev) => {
          const next = report.checks.some((c) => c.id === "storage" && c.level !== "ok");
          return prev === next ? prev : next;
        });
        if (storageCheck?.data?.storageFreeBytes != null) {
          const sample = {
            value: storageCheck.data.storageFreeBytes / (1024 * 1024),
            ts: new Date().toISOString(),
          };
          const buf = storageSamplesRef.current;
          buf.push(sample);
          if (buf.length > STORAGE_SAMPLE_BUFFER) buf.splice(0, buf.length - STORAGE_SAMPLE_BUFFER);
          const projection = projectTimeToZero(buf);
          // Same soft-threshold treatment as battery — if the disk has 8 h
          // before filling, we don't need to dramatise it on the toast.
          if (projection && projection.minutesToZero < 35 * 60) {
            setStorageProjectionMinutes(projection.minutesToZero);
          } else {
            setStorageProjectionMinutes(null);
          }
        }
        if (inv) {
          if (battery?.data?.batteryLevel != null) {
            void recordSensorSample({
              investigation_id: inv.id,
              sensor_type: "battery",
              value: battery.data.batteryLevel,
              unit: "fraction",
              metadata: { charging: battery.data.batteryCharging === true },
            });
          }
          if (storageCheck?.data?.storageFreeBytes != null) {
            void recordSensorSample({
              investigation_id: inv.id,
              sensor_type: "storage_free",
              value: storageCheck.data.storageFreeBytes,
              unit: "bytes",
            });
          }
        }
      } catch { /* swallow — best-effort watchdog, never breaks the hunt */ }
    };
    void tick();
    const handle = window.setInterval(() => { void tick(); }, WATCHDOG_INTERVAL_MS);
    return () => window.clearInterval(handle);
  // session is a useRef — tick() reads session.current at fire time so we
  // intentionally don't re-bind the 60s interval when the ref mutates.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // Auto-dismiss the toast after WATCHDOG_TOAST_MS. The operator can also
  // tap it; staying surfaced indefinitely would compete with the camera view.
  useEffect(() => {
    if (!watchdog) return;
    const h = window.setTimeout(() => setWatchdog(null), WATCHDOG_TOAST_MS);
    return () => window.clearTimeout(h);
  }, [watchdog]);

  // First-run redirect flag — evaluated up front, applied as a conditional
  // return AFTER every hook has been declared. We can't `return <Navigate />`
  // at this point because all the hooks below (useWakeLock, the sensor
  // emitters, the posterior tick, etc.) must be called in the same order on
  // every render to satisfy React's rules-of-hooks. On first-run the
  // component still mounts the hooks, but their bodies all gate on `running`
  // (false at startup), so the side-effect cost of the wasted render is
  // effectively zero — the Navigate fires before any timers, listeners, or
  // wake locks attach. BottomNav still provides the escape hatch (Review /
  // Setup / EVP tabs) for a user who back-buttons mid-flow.
  const navigate = useNavigate();
  const needsScenePickRedirect = !hasPickedSceneEver();

  // Keep screen awake during recording
  useWakeLock(running);

  // ── Posterior engine ────────────────────────────────────────────────────────

  // Mirror siteSession into a ref so that emitEvidence can be stable ([] deps)
  // while always reading the current session. This is critical for the acoustic
  // analyzer: it captures emitEvidence once at handleBegin time and never
  // updates. Without the ref, rapid evidence events would read stale state.
  const siteSessionRef = useRef(siteSession);
  useEffect(() => { siteSessionRef.current = siteSession; }, [siteSession]);

  const emitEvidence = useCallback(async (input: Parameters<typeof applyAndAudit>[1]) => {
    const result = await applyAndAudit(siteSessionRef.current, input);
    setSiteSession(result.session);
    setPosterior(getPosterior(result.session.state, Date.now()));
  }, []); // stable — safe for acoustic analyzer closure capture

  // Posterior decay tick via ref so the interval never restarts on evidence.
  useEffect(() => {
    if (!running) return;
    const h = window.setInterval(() => {
      setPosterior(getPosterior(siteSessionRef.current.state, Date.now()));
    }, 1000);
    return () => window.clearInterval(h);
  }, [running]); // stable — siteSessionRef.current always fresh

  // ── Sensor → evidence emission ─────────────────────────────────────────────

  useEffect(() => {
    if (!running || analyzerRef.current) return;
    if (!sensors.vibration?.alert) return;
    const now = Date.now();
    if (now - lastAcousticEmitTsRef.current < 2000) return;
    lastAcousticEmitTsRef.current = now;
    const ev = emitAcousticTransient({
      coherence: 0.7, subBandsAgreed: 3,
      sector: sectorReading?.sector ?? "REAR-C",
      sectorPersistedFromPrior: false, isFirstInWindow: true,
    });
    if (!ev) return;
    lastEmissionTsRef.current.acoustic = now;
    void emitEvidence({ channel: ev.channel, logLr: ev.logLr, reason: `${ev.reason} (vibration)`, metadata: ev.metadata, nowMs: now });
  }, [running, sensors.vibration?.alert, sectorReading, emitEvidence]);

  useEffect(() => {
    if (!running || !sensors.emf?.alert) return;
    const now = Date.now();
    if (now - lastMagnetometerEmitTsRef.current < 2000) return;
    lastMagnetometerEmitTsRef.current = now;
    const ev = emitMagnetometerAnomaly({
      zScore: sensors.emf.z,
      magnitudeMicrotesla: sensors.emf.value,
      baselineMicrotesla: sensors.emf.mean,
      siteBaseline: baselineRef.current,
    });
    if (!ev) return;
    lastEmissionTsRef.current.magnetometer = now;
    void emitEvidence({ channel: ev.channel, logLr: ev.logLr, reason: ev.reason, metadata: ev.metadata, nowMs: now });
    const tA = lastEmissionTsRef.current.acoustic;
    if (tA && Math.abs(now - tA) <= 200) {
      const coupling = emitTemporalCoupling({ channels: ["acoustic", "magnetometer"], deltaMs: Math.abs(now - tA) });
      if (coupling) void emitEvidence({ channel: coupling.channel, logLr: coupling.logLr, reason: coupling.reason, metadata: coupling.metadata, nowMs: now });
    }
  }, [running, sensors.emf?.alert, sensors.emf?.z, sensors.emf?.value, sensors.emf?.mean, emitEvidence]);

  // ── Live audio analyzer ────────────────────────────────────────────────────

  const startLiveAnalyzer = useCallback(async () => {
    if (analyzerRef.current) return;
    const analyzer = new LiveAnalyzer({
      onSectorReading: (r) => setSectorReading(r),
      onLevel: (rms) => {
        // 94 Hz callback. Stash the value in a ref (no render) and emit a
        // coarse 5 Hz state copy. BroadcastAudioMeter runs its own RAF
        // peak-hold off the 5 Hz prop, so we no longer need to imperatively
        // write a DOM transform here; the overlay-state consumer
        // (LiveStreamView's overlay effect) reads the same state copy.
        audioRmsRef.current = rms;
        const now = performance.now();
        if (now - lastRmsCoarseEmitRef.current >= 200) {
          lastRmsCoarseEmitRef.current = now;
          setAudioRmsCoarse(rms);
        }
      },
      onAcousticTransient: (r, rms) => {
        const now = Date.now();
        if (now - lastAcousticEmitTsRef.current < 2000) return;
        lastAcousticEmitTsRef.current = now;
        if (!r.sector) return;
        const ev = emitAcousticTransient({
          coherence: r.coherence, subBandsAgreed: r.passingBands,
          sector: r.sector, sectorPersistedFromPrior: false, isFirstInWindow: true,
          audioRms: rms, siteBaseline: baselineRef.current,
        });
        if (!ev) return;
        lastEmissionTsRef.current.acoustic = now;
        void emitEvidence({ channel: ev.channel, logLr: ev.logLr, reason: ev.reason, metadata: ev.metadata, nowMs: now });
      },
      onInfrasound: () => { /* CameraScreen omits the dedicated infrasound
        evidence channel — MissionControl handles it via the SensorsPanel.
        Leaving this as a no-op keeps the AnalyzerEvents contract satisfied
        without inflating the camera-first dock with rarely-fired evidence. */ },
      onError: (err) => console.warn("[CameraScreen] analyzer:", err.message),
    });
    try { await analyzer.start(); analyzerRef.current = analyzer; } catch { /**/ }
  }, [emitEvidence]);

  const stopLiveAnalyzer = useCallback(async () => {
    const a = analyzerRef.current;
    if (!a) return;
    analyzerRef.current = null;
    await a.stop();
    setSectorReading(null);
    audioRmsRef.current = 0.05;
    setAudioRmsCoarse(0.05);
  }, []);

  useEffect(() => () => { void stopLiveAnalyzer(); }, [stopLiveAnalyzer]);

  // ── Session handlers ────────────────────────────────────────────────────────

  const handleBegin = useCallback(async () => {
    setBusy(true);
    // Fire camera open FIRST — synchronously inside the click handler — so the
    // browser's getUserMedia permission prompt is anchored to the user gesture
    // that just happened. iOS Safari especially is strict here: if we await
    // anything before getUserMedia, the user-activation flag may be consumed
    // and the camera permission request silently fails ("no permission dialog").
    // We don't await this; LiveStreamView's `start` sets its own busy/error state.
    void startCameraRef.current?.();
    // Run pre-flight in parallel with the camera open. A blocking failure
    // (camera denied, storage full) surfaces a dialog the operator can
    // resolve before any session state is written. We capture the promise
    // so the session_start audit event can splice in the resolved telemetry
    // (battery %, free storage bytes, permission states) without having to
    // re-run the checks.
    // Read the active scene through the ref so handleBegin doesn't need to
    // re-bind every scene change (it's a stable callback with [] deps).
    const sceneOverrides = getScene(activeSceneIdRef.current)?.preflightOverrides;
    // Compose preflight + (optional) chain-integrity gate in parallel. The
    // chain check is opt-in via Setup → "Refuse to start on broken chain";
    // when on, a chain break elevates the report's overall to "block" with a
    // synthetic check so the operator hits the same preflight blocker UI.
    // Forensic-strict path — guards against piling new evidence onto a chain
    // that already failed verification, which would taint the next export.
    const preflightPromise = (async (): Promise<PreflightReport> => {
      const report = await runPreflight(resolvePreflightOverrides(preflightPrefRef.current, sceneOverrides));
      if (!preflightPrefRef.current.blockOnChainBreak) return report;
      try {
        const verification = await verifyAuditChain();
        if (verification.ok) return report;
        const synthetic: PreflightCheck = {
          id: "chain",
          level: "block",
          message: `Audit chain integrity failure at seq #${verification.brokenAtSeq} (${verification.reason}). Setup → Preflight is configured to refuse new sessions until the chain is reviewed.`,
        };
        return { overall: "block", checks: [...report.checks, synthetic] };
      } catch {
        return report;
      }
    })();
    void preflightPromise.then((report) => {
      if (report.overall === "block") {
        setPreflight(report);
        setPreflightDismissed(false);
      } else if (report.overall === "warn") {
        // Warnings still kick the session off — the report stays around
        // so the UI can surface a non-blocking hint if it wants.
        setPreflight(report);
      }
    });
    try {
      const perm = await requestSensorPermissionsForUserGesture();
      if (perm.motion === "denied" || perm.orientation === "denied") { setBusy(false); return; }
      setPermissionsGranted(true);
      // requestPersistentStorage() is deferred until AFTER the first
      // meaningful storage write (the day's investigation row, below).
      // The spec lets persist() succeed only under specific conditions —
      // user gesture + secure context + (often) at least one stored
      // asset. Calling it before the first investigation write returned
      // false on Chromium because the heuristic hadn't seen us write
      // anything yet. opfs.ts caches granted/denied in localStorage so
      // we don't keep re-asking on every Begin tap.
      // Resolve the (possibly chain-augmented) preflight BEFORE creating an
      // investigation row. When the operator has opted into "refuse on broken
      // chain", aborting here means we don't write the session_start audit
      // entry onto a tainted chain — exactly the integrity contract the pref
      // promises. Regular block-level checks still surface the blocker modal
      // (visible via the preflightPromise.then above) without aborting; the
      // forensic gate is the only path that hard-stops.
      const report = await preflightPromise;
      if (report.checks.some((c) => c.id === "chain" && c.level === "block")) {
        // The modal is already up via the side-effect .then(); just bail.
        return;
      }
      const inv = await ensureTodayInvestigation();
      // First meaningful write (the investigation row) just landed —
      // ask now so the browser's heuristic sees the storage activity.
      // Fire-and-forget; cached in localStorage so re-asking on later
      // Begin taps short-circuits.
      void requestPersistentStorage();
      setCurrent(inv);
      if (inv.protocol_json && !inv.protocol_hash) {
        await lockProtocol(inv.id).catch(() => { /* non-blocking */ });
      }
      await startInvestigation(inv.id);
      // Seed the watchdog baseline from the Begin snapshot so the periodic
      // re-check only fires a toast when the device state actually degrades
      // during the hunt — not when the operator started already on warn.
      lastWatchdogLevelRef.current = report.overall;
      await recordEvent({
        investigation_id: inv.id,
        source: "system",
        event_type: "session_start",
        title: "Session started",
        metadata: {
          preflight: {
            overall: report.overall,
            checks: report.checks.map((c) => ({
              id: c.id,
              level: c.level,
              ...(c.data ? { data: c.data } : {}),
            })),
          },
        },
      });
      setSiteSession(createSiteSession());
      setRunning(true);
      void startLiveAnalyzer();
    } catch { /**/ } finally {
      setBusy(false);
    }
  }, [startLiveAnalyzer]);

  const handleStop = useCallback(async () => {
    if (!session.current) return;
    setBusy(true);
    try {
      const stoppingId = session.current.id;
      await stopLiveAnalyzer();
      await stopInvestigation(stoppingId);
      await recordEvent({ investigation_id: stoppingId, source: "system", event_type: "session_stop", title: "Session ended" });
      setRunning(false);
      // Park the just-ended id so DispositionPicker can prompt classification
      // before the operator wanders off. Mirrors the MissionControl flow at
      // MissionControl.tsx:418 — single source of truth for "session ended,
      // not yet classified".
      setPendingDispositionFor(stoppingId);
    } catch { /**/ } finally {
      setBusy(false);
    }
  // session is a useRef — the ref object is stable, .current mutates without
  // triggering a re-render. The callback reads session.current at invoke time
  // so we don't need to re-create on every mutation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.current, stopLiveAnalyzer]);

  // ── Render ─────────────────────────────────────────────────────────────────

  // Top-left status pill — REC > LIVE > READY > IDLE. The recording / live
  // state from useLiveBroadcastState owns priority because they're billable
  // capture; the session-running state is the lowest-priority indicator.
  const topPillState: TopPillState = broadcastState.recording
    ? "rec"
    : broadcastState.broadcasting
      ? "live"
      : running
        ? "ready"
        : "idle";

  const sceneName = activeScene?.name ?? "Walkthrough";

  // Conditional return AFTER all hooks (see the matching comment up by the
  // `needsScenePickRedirect` declaration). React's rules-of-hooks require the
  // hook list to be stable across renders; on first-run we still execute
  // every hook above, then bail to the redirect here.
  if (needsScenePickRedirect) {
    return <Navigate to="/hunt-setup" replace />;
  }

  return (
    <div className={s.screen}>
      {/* Visually-hidden landing-page heading. The camera surface is
          intentionally chromeless (no visible header), but every route still
          needs an h1 so screen-reader navigation by heading works and
          Lighthouse / axe stop flagging the page. */}
      <h1 className="visually-hidden">Camera</h1>
      {/* Mandatory disposition prompt — appears immediately after a session
          stops so the operator can't wander off without classifying. Mirrors
          MissionControl's post-stop flow; without this the base-rate
          dashboard would only count Pro/Lab sessions. */}
      {pendingDispositionFor && (
        <DispositionPicker
          investigationId={pendingDispositionFor}
          onChosen={() => setPendingDispositionFor(null)}
        />
      )}
      {/* Full-bleed camera. Three viewport gestures composed together —
          composeHandlers chains the onPointerDown across long-press +
          double-tap + swipe so a single touch can prime any of them
          depending on how the operator follows through. */}
      <div
        className={s.cameraWrap}
        onPointerDown={composeHandlers(longPressProps.onPointerDown, doubleTapProps.onPointerDown, swipeProps.onPointerDown)}
        onPointerMove={swipeProps.onPointerMove}
        onPointerUp={composeHandlers(longPressProps.onPointerUp, swipeProps.onPointerUp)}
        onPointerCancel={longPressProps.onPointerCancel}
        onPointerLeave={longPressProps.onPointerLeave}
        onClick={handleFocusTap}
      >
        <LiveStreamView
          investigationId={session.current?.id ?? null}
          running={running}
          posterior={posterior}
          audioRms={audioRmsCoarse}
          sector={sectorReading?.sector ?? null}
          coherence={sectorReading?.coherence ?? 0}
          caseId={session.current?.id ?? null}
          caseTitle={session.current?.title ?? null}
          caption={narratorCaption}
          lightLux={sensors.snapshot.light?.lux}
          magnetometerUt={sensors.snapshot.magnetometer?.magnitude ?? sensors.emf?.value}
          motionMs2={sensors.snapshot.motion?.accelMagnitude ?? sensors.vibration?.value}
          emfZScore={sensors.emf?.z}
          externalChannels={channels}
          onExternalChannelChange={handleChannelChange}
          recordToggleRef={recordToggleRef}
          liveToggleRef={liveToggleRef}
          flipCameraRef={flipCameraRef}
          torchToggleRef={torchToggleRef}
          refocusRef={refocusRef}
          onSourceStream={setMicStream}
          startCameraRef={startCameraRef}
          snapThumbnailRef={snapThumbnailRef}
          defaultFacing={activeScene?.cameraDefaults.facing}
          defaultTorch={activeScene?.cameraDefaults.torch}
          onCameraState={handleCameraState}
          fullscreen
        />

        {/* ── Top-left status bug: STANDBY / READY / LIVE / REC ────────────
             Replaces the bare cornerPillTopLeft chip the camera shipped with.
             Glass shell, hairline cyan rim, SS broadcast mark, mono elapsed
             timecode. Lives in src/components/broadcast/BroadcastBug.tsx. */}
        <BroadcastBug state={topPillState} elapsedSec={sessionSecs} />

        {/* ── Broadcast audio meter — vertical green→amber→red strip with
             peak-hold cap + tick marks + mono dB readout. Mounts under the
             status bug and only renders while the session is running so the
             pre-Begin frame stays clean. The actual analyzer subscription
             still lives in CameraScreen — this component is presentation
             only and reads audioRmsCoarse off state. */}
        {running && (
          <BroadcastAudioMeter rms={audioRmsCoarse} vadActive={vadActive} />
        )}

        {/* ── Always-on device-state chip — sits under the mic meter and
             shows the live battery + free-storage readings the watchdog
             observed on the last tick. Tone shifts to amber/red when a
             check is failing, so the operator picks up trouble without
             waiting for the next toast. */}
        {running && (hudBatteryPct != null || hudStorageMb != null) && (
          <div
            className={`${s.deviceChip} ${hudBatteryWarn || hudStorageWarn ? s.deviceChipWarn : ""}`.trim()}
            aria-label="Device state"
          >
            {hudBatteryPct != null && (
              <span className={`${s.deviceChipReading} ${hudBatteryWarn ? s.deviceChipReadingWarn : ""}`.trim()}>
                {hudBatteryCharging && <span className={s.deviceChipIcon} aria-hidden="true">⚡</span>}
                <span className={s.deviceChipValue}>{hudBatteryPct}%</span>
              </span>
            )}
            {hudBatteryPct != null && hudStorageMb != null && (
              <span className={s.deviceChipSep} aria-hidden="true">·</span>
            )}
            {hudStorageMb != null && (
              <span className={`${s.deviceChipReading} ${hudStorageWarn ? s.deviceChipReadingWarn : ""}`.trim()}>
                <span className={s.deviceChipValue}>
                  {hudStorageMb >= 1024
                    ? `${(hudStorageMb / 1024).toFixed(1)}GB`
                    : `${hudStorageMb}MB`}
                </span>
                <span className={s.deviceChipUnit}>free</span>
              </span>
            )}
          </div>
        )}

        {/* ── Snooze indicator chip — only visible while a snooze window
             is active. Tap to unsnooze immediately. Without this, an
             operator who hit Snooze could forget toasts are muted and
             wonder why nothing's firing. Sits in the bottom-left HUD just
             above the marker pill. */}
        {running && watchdogSnoozeUntil != null && (
          <button
            type="button"
            className={s.snoozeChip}
            onClick={() => setWatchdogSnoozeUntil(null)}
            title="Watchdog toasts are silenced. Tap to resume immediately."
            aria-label="Watchdog snoozed — tap to resume"
          >
            <span className={s.snoozeChipIcon} aria-hidden="true">🔕</span>
            <span className={s.snoozeChipLabel}>
              Snoozed {Math.max(0, Math.ceil((watchdogSnoozeUntil - Date.now()) / 60_000))}m
            </span>
          </button>
        )}

        {/* ── Marker tally pill — bottom-left, low-prominence. Surfaces the
             session-scoped marker count so the operator knows their tag
             rhythm without leaving the camera. Tapping navigates to Review;
             dual-click safe (the navigate is the only interaction). Hidden
             until the operator drops their first marker so an empty HUD
             stays clean. */}
        {running && sessionMarkerCount > 0 && (
          <div className={s.markerCountPillWrap} ref={markerPillWrapRef}>
            <button
              type="button"
              className={s.markerCountPill}
              onClick={(e) => { e.stopPropagation(); setMarkerPillOpen((v) => !v); }}
              onPointerDown={(e) => e.stopPropagation()}
              title="Tap to see this session's marker breakdown"
              aria-expanded={markerPillOpen}
              aria-label={`${sessionMarkerCount} marker${sessionMarkerCount === 1 ? "" : "s"} this session — tap for breakdown`}
            >
              <span className={s.markerCountIcon} aria-hidden="true">●</span>
              <span className={s.markerCountValue}>{sessionMarkerCount}</span>
              <span className={s.markerCountLabel}>marker{sessionMarkerCount === 1 ? "" : "s"}</span>
            </button>
            {markerPillOpen && (
              <div
                className={s.markerCountPopover}
                role="dialog"
                aria-modal="true"
                aria-label="Marker breakdown by category"
                ref={markerPillTrapRef}
                tabIndex={-1}
              >
                <ul className={s.markerCountList}>
                  {MARKER_BREAKDOWN.filter((row) => sessionMarkerByCat[row.id] > 0).map((row) => (
                    <li key={row.id}>
                      <span className={s.markerCountDot} data-category={row.id} aria-hidden="true">●</span>
                      {sessionMarkerByCat[row.id]} {row.label}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className={s.markerCountReviewLink}
                  onClick={(e) => { e.stopPropagation(); setMarkerPillOpen(false); navigate("/review"); }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  Open Review →
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── First-run welcome card. Surfaces the four gestures that aren't
             discoverable from the chrome alone (double-tap markers, swipe
             scenes, scene pill, watchdog). Dismissal is sticky in
             localStorage so it never re-appears for this version. Hidden
             while a session is running so the operator's eye lands on the
             feed. */}
        {welcomeVisible && !running && (
          <div
            className={s.welcomeCard}
            role="dialog"
            aria-modal="true"
            aria-labelledby="ss-welcome-title"
            ref={welcomeTrapRef}
            tabIndex={-1}
          >
            <header className={s.welcomeHead}>
              <span id="ss-welcome-title" className={s.welcomeEyebrow}>Welcome</span>
              <button
                type="button"
                className={s.welcomeDismiss}
                onClick={(e) => { e.stopPropagation(); dismissWelcome(); }}
                onPointerDown={(e) => e.stopPropagation()}
                aria-label="Dismiss welcome card"
              >
                ✕
              </button>
            </header>
            <ul className={s.welcomeList}>
              <li><strong>Double-tap</strong> the viewport to drop a moment marker.</li>
              <li><strong>Swipe left/right</strong> to cycle scenes (or tap the pill ↗).</li>
              <li><strong>BIG SHUTTER</strong> below begins / ends a session.</li>
              <li>The watchdog warns if battery or storage drops mid-session.</li>
            </ul>
            <button
              type="button"
              className={s.welcomeGotIt}
              onClick={(e) => { e.stopPropagation(); dismissWelcome(); }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              Got it
            </button>
          </div>
        )}

        {/* ── Top-right scene selector — glass chip, SCENE eyebrow + display-
             cased name + SVG chevron. Opens the bottom-sheet picker. Sits
             at the same Y as the BroadcastBug; the BroadcastSensorHud
             tucks beneath it on the same edge. */}
        <BroadcastSceneSelector sceneName={sceneName} onOpen={() => setSceneSheetOpen(true)} />

        {/* ── Sensor HUD strip — compact mono key/value column under the
             scene chip. EMF / LUX / ACC rows render only when the
             underlying sensor reports samples (iOS without Magnetometer
             support drops the EMF row). Rows flash --signal cyan for
             400 ms on threshold crossings via the AnomalyTile alert flag. */}
        {running && (
          <BroadcastSensorHud
            magnetometer={sensors.snapshot.magnetometer}
            light={sensors.snapshot.light}
            motion={sensors.snapshot.motion}
            emfAlert={sensors.emf}
            motionAlert={sensors.vibration}
            lightAlert={sensors.lightAnomaly}
            magnetometerAvailable={sensors.magnetometerAvailable}
            lightAvailable={sensors.lightAvailable}
          />
        )}

        {/* ── Bottom-left timecode slate — local wall-clock, UTC, and
             session-elapsed counter. Burn-in safe for the recorded clip
             so a video editor can lift timestamps without overlaying their
             own slate. Always mounted (renders fine in idle too) so the
             chrome feels complete from the moment the route loads. */}
        <BroadcastTimestamp running={running} elapsedSec={sessionSecs} />

        {/* ── Lower-third investigation slate — slides in from below when
             an investigation is active. Title + location · date. Sticky-
             content via the component so the slide-out frame still has
             something to render against. */}
        <BroadcastLowerThird
          running={running}
          title={session.current?.title}
          location={session.current?.location_name}
          startedAt={session.current?.started_at}
        />

        {/* ── Scene-driven EVP recorder — only mounts when the active scene
             declares `evp.showRecorder`. Auto-starts on session begin when
             scene.evp.autoRecord is true; auto-stops when the operator ends
             the session via the BIG SHUTTER (active flips false). Lives in
             a fixed corner so it doesn't compete with the camera frame; the
             compact variant keeps the chrome tight. Hidden until running
             so the operator sees the empty state on the EVP tab itself. */}
        {activeScene?.evp?.showRecorder && running && session.current && (
          <div className={s.evpDock}>
            <EvpRecorderControl
              investigationId={session.current.id}
              variant="compact"
              autoStart={activeScene.evp.autoRecord === true}
              active={running}
            />
          </div>
        )}

        {/* ── Marker drop toast — top-center, 1.5s fade. Confirms that the
             double-tap landed without interrupting the camera feed. The
             actual marker is already in the audit chain via recordEvent. */}
        {markerToastVisible && (
          <div className={s.markerToast} role="status" aria-live="polite">
            ✓ MARKED
          </div>
        )}

        {/* ── Marker category picker — fires after a double-tap. Three chips
             (Sound / Movement / Felt) for reviewers to filter by later. Auto-
             commits as untagged after MARKER_PICKER_MS so fire-and-forget
             taps still land. Each chip stops pointer propagation so tapping
             a chip doesn't also re-trigger the swipe / long-press handlers. */}
        {markerPicker && (
          <div className={s.markerPickerWrap} role="group" aria-label="Tag this marker">
            <div className={s.markerQuickTags} aria-label="Quick tags — commit a marker with a pre-filled note">
              {QUICK_TAGS.map((q) => (
                <button
                  key={q.label}
                  type="button"
                  className={s.markerQuickTagBtn}
                  data-category={q.category}
                  onClick={(e) => { e.stopPropagation(); pickMarkerQuickTag(q.label, q.category); }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {q.label}
                </button>
              ))}
            </div>
            <div className={s.markerPicker}>
              {PICKER_CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={s.markerPickerBtn}
                  onClick={(e) => { e.stopPropagation(); pickMarkerCategory(c.id); }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Watchdog toast — non-blocking warning when the device state
             degraded since the session started (storage low, battery dipped
             below 20%). Sits below the corner pills so it doesn't compete
             with the REC indicator. The toast itself dismisses on tap; an
             optional inline "Install" CTA appears when storage is the
             failing check AND the browser exposed a beforeinstallprompt
             event — standalone PWAs get OPFS persistence guarantees, which
             is the durable fix for "running out of room". Hard-dismisses
             after WATCHDOG_TOAST_MS even if untouched. */}
        {watchdog && (
          // role="status" (implicit aria-live="polite") instead of "alert" so
          // a screen-reader user isn't interrupted mid-sentence by a toast
          // that auto-dismisses after WATCHDOG_TOAST_MS. The separate
          // pre-flight blocker below uses role="alertdialog" for hard stops;
          // a degraded device state is "should know" not "stop everything".
          <div
            className={`${s.watchdogToast} ${watchdog.overall === "block" ? s.watchdogToastBlock : s.watchdogToastWarn}`.trim()}
            role="status"
          >
            <button
              type="button"
              className={s.watchdogToastBody}
              onClick={() => setWatchdog(null)}
              title="Tap to dismiss"
            >
              <span className={s.watchdogToastLabel}>
                {watchdog.overall === "block" ? "Device state critical" : "Device state degraded"}
                {watchdogCount > 1 && (
                  <span className={s.watchdogToastCount}>{ordinal(watchdogCount)} warning</span>
                )}
              </span>
              <span className={s.watchdogToastDetail}>
                {formatWatchdogChecks(watchdog.checks) || "Tap to dismiss"}
                {batteryProjectionMinutes != null && watchdog.checks.some((c) => c.id === "battery" && c.level !== "ok") && (
                  <span className={s.watchdogToastEta}> · ~{formatTimeToEmpty(batteryProjectionMinutes)} until empty</span>
                )}
                {storageProjectionMinutes != null && watchdog.checks.some((c) => c.id === "storage" && c.level !== "ok") && (
                  <span className={s.watchdogToastEta}> · ~{formatTimeToEmpty(storageProjectionMinutes)} until full</span>
                )}
              </span>
            </button>
            {watchdogStorageWarn(watchdog) && installStatus.kind === "ready" && (
              <button
                type="button"
                className={s.watchdogToastCta}
                onClick={async () => {
                  setWatchdog(null);
                  installPromptOpenRef.current = true;
                  try {
                    await installStatus.prompt();
                  } finally {
                    installPromptOpenRef.current = false;
                  }
                }}
              >
                Install
              </button>
            )}
            <button
              type="button"
              className={s.watchdogToastSnooze}
              onClick={() => {
                setWatchdogSnoozeUntil(Date.now() + WATCHDOG_SNOOZE_MS);
                setWatchdog(null);
              }}
              title="Suppress watchdog toasts for the next 10 minutes. A worsening degradation will still fire."
            >
              Snooze 10m
            </button>
          </div>
        )}

        {/* ── Pre-flight blocker — only shown when a critical check failed
             (camera/mic permission denied, storage critically low). The
             operator must resolve the underlying issue + dismiss; we don't
             auto-retry because most blockers require leaving the page. */}
        {preflight && preflight.overall === "block" && !preflightDismissed && (
          <div className={s.preflightBlocker} role="alertdialog" aria-label="Pre-flight check failed">
            <div className={s.preflightCard}>
              <h2 className={s.preflightTitle}>Can't start session</h2>
              <ul className={s.preflightList}>
                {preflight.checks.filter((c) => c.level === "block").map((c) => (
                  <li key={c.id} className={s.preflightRowBlock}>
                    <span className={s.preflightRowLabel}>{c.id}</span>
                    <span>{c.message}</span>
                  </li>
                ))}
                {preflight.checks.filter((c) => c.level === "warn").map((c) => (
                  <li key={c.id} className={s.preflightRowWarn}>
                    <span className={s.preflightRowLabel}>{c.id}</span>
                    <span>{c.message}</span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className={s.preflightDismiss}
                onClick={() => setPreflightDismissed(true)}
              >
                Got it
              </button>
            </div>
          </div>
        )}

        {/* ── Tap-to-focus ring — 700ms pulse at the tap point. Visual
             confirmation that the tap registered + which point was targeted.
             The actual autofocus might or might not honour the constraint
             (hardware-dependent); the ring just confirms the gesture. */}
        {focusPulse && (
          <div
            key={focusPulse.key}
            className={s.focusPulse}
            style={{ left: focusPulse.x, top: focusPulse.y }}
            aria-hidden="true"
          />
        )}

        {/* ── BIG SHUTTER — primary action, Snapchat-grade. ─────────────
             88×88 circular button anchored above the slim dock. Red when
             idle (= "Begin"); white with red square when recording (= "End").
             This is the ONE button that should dominate the bottom of the
             viewport. Disabled while busy so the operator gets a "no-op
             during transition" pulse rather than a double-fire. */}
        <button
          type="button"
          className={`${s.shutter} ${running ? s.shutterRecording : ""}`.trim()}
          onClick={running ? handleStop : handleBegin}
          disabled={busy}
          aria-label={running ? "End session" : "Begin session"}
          title={running ? "End session" : "Begin session"}
        >
          <span className={s.shutterCore} aria-hidden="true" />
        </button>

        {/* ── Slim secondary dock — Scenes · Settings · Clip Rec ────────
             Sits BETWEEN the shutter and the BottomNav. Semi-transparent
             gradient so the camera feed bleeds through. When the active
             scene asks for a simplified dock (Vigil) we drop the
             modifier class that centres the remaining two buttons so they
             don't end up stranded at opposite edges of the 56px bar. */}
        <div
          className={`${s.dockSlim} ${activeScene?.simplifiedDock ? s.dockSlimSimplified : ""}`.trim()}
          role="toolbar"
          aria-label="Camera secondary controls"
        >
          <button
            type="button"
            className={s.dockSlimBtn}
            onClick={() => setSceneSheetOpen(true)}
            aria-label="Open scene picker"
            title="Scenes"
          >
            <span className={s.dockSlimLabel}>Scenes</span>
          </button>

          <button
            type="button"
            className={s.dockSlimBtn}
            onClick={() => navigate("/setup")}
            aria-label="Open settings"
            title="Settings"
          >
            <span className={s.dockSlimIcon} aria-hidden="true"><IconSettings /></span>
          </button>

          {/* Simplified-dock scenes (Vigil) hide the secondary buttons so
              the cinematic framing isn't broken by chip-shaped chrome. The
              BIG SHUTTER still handles start/stop; everything else lives one
              tap away via Scenes or Settings. */}
          {!activeScene?.simplifiedDock && (
            <>
              <ScreenRecordButton
                investigationId={session.current?.id ?? null}
                classNames={{
                  idle:   s.dockSlimBtn,
                  active: `${s.dockSlimBtn} ${s.dockSlimBtnRec}`,
                  icon:   s.dockSlimIcon,
                  label:  s.dockSlimLabel,
                }}
              />

              {/* Inline compositor clip-record — small (not the primary button).
                  Honours the same recordToggleRef the shutter would use if the
                  operator wanted a clip without ending the session. */}
              <button
                type="button"
                className={`${s.dockSlimBtn} ${broadcastState.recording ? s.dockSlimBtnRec : ""}`.trim()}
                onClick={() => recordToggleRef.current?.()}
                disabled={!cameraState.streamOn}
                aria-pressed={broadcastState.recording}
                aria-label={broadcastState.recording ? "Stop clip recording" : "Record clip"}
                title={broadcastState.recording ? "Stop clip" : "Clip Rec"}
              >
                <span className={s.dockSlimIcon} aria-hidden="true"><IconRecord /></span>
                <span className={s.dockSlimLabel}>{broadcastState.recording ? "Stop" : "Clip"}</span>
              </button>

              {/* Flip camera — single tap toggles rear ↔ front. (Was previously
                  wired as a double-tap gesture; double-tap is now marker drop.) */}
              <button
                type="button"
                className={s.dockSlimBtn}
                onClick={() => flipCameraRef.current?.()}
                disabled={!cameraState.streamOn}
                aria-label={cameraState.facingMode === "environment" ? "Switch to front camera" : "Switch to rear camera"}
                title="Flip camera"
              >
                <span className={s.dockSlimIcon} aria-hidden="true"><IconFlip /></span>
                <span className={s.dockSlimLabel}>{cameraState.facingMode === "environment" ? "Rear" : "Front"}</span>
              </button>

              {/* Torch — only rendered when the active camera reports torch
                  support. Front cameras and most laptops won't expose it. */}
              {cameraState.torchSupported && (
                <button
                  type="button"
                  className={`${s.dockSlimBtn} ${cameraState.torchOn ? s.dockSlimBtnRec : ""}`.trim()}
                  onClick={() => torchToggleRef.current?.()}
                  aria-pressed={cameraState.torchOn}
                  aria-label={cameraState.torchOn ? "Turn torch off" : "Turn torch on"}
                  title="Torch"
                >
                  <span className={s.dockSlimIcon} aria-hidden="true"><IconTorch /></span>
                  <span className={s.dockSlimLabel}>Torch</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Bottom-sheet scene picker — owned by Worker C. Opens when the
          top-right pill or the Scenes dock button is tapped. */}
      <SceneSheet
        open={sceneSheetOpen}
        onClose={() => setSceneSheetOpen(false)}
        activeSceneId={activeSceneId}
        onSelect={(id) => {
          saveActiveSceneId(id);
          setActiveSceneId(id);
        }}
      />
    </div>
  );
}
