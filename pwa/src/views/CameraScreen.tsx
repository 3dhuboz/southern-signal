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
import { useLiveBroadcastState } from "../lib/system/liveBroadcast";
import { usePushToTalk } from "../lib/audio/usePushToTalk";
import { useLongPress, useDoubleTap } from "../lib/gestures";
import { useLiveNarrator } from "../lib/posterior/liveNarrator";
import { LiveAnalyzer } from "../lib/audio/liveAnalyzer";
import { type SectorReading } from "../lib/audio/sectorIndicator";
import { ensureTodayInvestigation } from "../lib/bootstrap";
import { requestPersistentStorage } from "../lib/opfs";
import { recordEvent, startInvestigation, stopInvestigation } from "../lib/db/repo";
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
  hasPickedSceneEver, loadActiveSceneId, saveActiveSceneId, getScene, loadSceneOverrides,
  type SceneId,
} from "../lib/overlays/scenes";
import { useSpiritBox } from "../lib/itc/useSpiritBox";
import { useOvilus } from "../lib/itc/useOvilus";
import { Navigate, useNavigate } from "react-router-dom";
import s from "./CameraScreen.module.css";

// ── Dock button icons ──────────────────────────────────────────────────────
// The chrome-heavy 14-toggle channel grid AND the secondary action grid
// (Flip / Torch / SBX / OVL) are gone. Flip is a double-tap gesture on the
// camera wrap; torch is reserved for a long-press gesture (post-V1); SBX/OVL
// are scene-managed via tools.autoStart. The slim dock keeps just the icons
// for Settings (gear) and the still-supported Clip-Record button.

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

/** mm:ss formatter for the top-left REC pill. */
function fmtSecs(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// Top-left status pill — lookup table replaces three parallel ternary chains
// (state, class, label). Adding a new state means one entry, not three.
type TopPillState = "rec" | "live" | "ready" | "idle";
type StyleMap = Record<string, string>;
interface TopPillSpec {
  /** Optional extra class added alongside the base `.cornerPillTopLeft`. */
  extraClass?: (styles: StyleMap) => string;
  label: (sessionSecs: number) => string;
}
const TOP_PILL_STATES: Record<TopPillState, TopPillSpec> = {
  rec:   { extraClass: (st) => st.cornerPillRec,  label: (s) => `REC ${fmtSecs(s)}` },
  live:  { extraClass: (st) => st.cornerPillLive, label: (s) => `LIVE ${fmtSecs(s)}` },
  ready: {                                         label: (s) => `READY ${fmtSecs(s)}` },
  idle:  {                                         label: ()  => "STANDBY" },
};


// ── Component ────────────────────────────────────────────────────────────────

export function CameraScreen() {
  const session = useSession();
  const sensors = useSensors(session.permissionsGranted);
  const [prefs] = usePreferences();
  const proMode = prefs.proMode;

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
  const startCameraRef  = useRef<(() => Promise<void>) | null>(null);
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
  const [audioRms, setAudioRms] = useState<number>(0.05);

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
  // Double-tap on the camera wrap flips between rear/front camera (replaces
  // the old dock Flip button). Long-press primes Push-To-Talk for EVP capture
  // (Worker A's audio module). usePushToTalk is the activation hook — it
  // mounts the audio pipeline while `pttActive` is true and tears it down
  // when released.
  const [pttActive, setPttActive] = useState(false);
  usePushToTalk(pttActive);
  const longPressProps = useLongPress(setPttActive);
  const doubleTapProps = useDoubleTap(() => { void flipCameraRef.current?.(); });

  // ITC hooks read the scene's tools config — Spirit Box Session auto-starts
  // the spirit box; Pro/Lab leaves Ovilus to manual. Output is consumed via
  // the live overlay compositor, so we call the hooks for their side effects
  // (publishing to the ITC channel store) and ignore their returned API.
  useSpiritBox(itcEntropy, running, activeScene?.tools.spiritBox === true);
  useOvilus(itcEntropy, running, activeScene?.tools.ovilus === true);

  // First-run redirect: if the operator has NEVER picked a scene, send them
  // to HuntSetup before showing the camera surface. Once they pick once,
  // the scene persists and this hook becomes a no-op on every subsequent boot.
  const navigate = useNavigate();
  useEffect(() => {
    if (!hasPickedSceneEver()) {
      navigate("/hunt-setup", { replace: true });
    }
  }, [navigate]);
  if (!hasPickedSceneEver()) {
    // Avoid one frame of camera-screen render before the redirect fires.
    return <Navigate to="/hunt-setup" replace />;
  }

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
      onLevel: (rms) => setAudioRms(rms),
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
    setAudioRms(0.05);
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
    try {
      const perm = await requestSensorPermissionsForUserGesture();
      if (perm.motion === "denied" || perm.orientation === "denied") { setBusy(false); return; }
      setPermissionsGranted(true);
      void requestPersistentStorage();
      const inv = await ensureTodayInvestigation();
      setCurrent(inv);
      if (inv.protocol_json && !inv.protocol_hash) {
        await lockProtocol(inv.id).catch(() => { /* non-blocking */ });
      }
      await startInvestigation(inv.id);
      await recordEvent({ investigation_id: inv.id, source: "system", event_type: "session_start", title: "Session started" });
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
      await stopLiveAnalyzer();
      await stopInvestigation(session.current.id);
      await recordEvent({ investigation_id: session.current.id, source: "system", event_type: "session_stop", title: "Session ended" });
      setRunning(false);
    } catch { /**/ } finally {
      setBusy(false);
    }
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
  const pillSpec = TOP_PILL_STATES[topPillState];
  const topPillClass = pillSpec.extraClass
    ? `${s.cornerPillTopLeft} ${pillSpec.extraClass(s)}`
    : s.cornerPillTopLeft;
  const topPillLabel = pillSpec.label(sessionSecs);

  const sceneName = activeScene?.name ?? "Walkthrough";

  return (
    <div className={s.screen}>
      {/* Full-bleed camera. Gesture wrap captures double-tap (flip) and
          long-press (push-to-talk). Pointer/touch handlers spread on the
          OUTER wrap so they fire above LiveStreamView's internal canvas. */}
      <div
        className={s.cameraWrap}
        {...longPressProps}
        {...doubleTapProps}
      >
        <LiveStreamView
          investigationId={session.current?.id ?? null}
          running={running}
          posterior={posterior}
          audioRms={audioRms}
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
          startCameraRef={startCameraRef}
          defaultFacing={activeScene?.cameraDefaults.facing}
          defaultTorch={activeScene?.cameraDefaults.torch}
          onCameraState={handleCameraState}
          fullscreen
        />

        {/* ── Top-left floating pill: REC / LIVE / READY indicator ────── */}
        <div
          className={topPillClass}
          role="status"
          aria-live="polite"
          aria-label={`Session: ${topPillLabel}`}
        >
          <span className={s.cornerPillDot} aria-hidden="true" />
          <span className={s.cornerPillText}>{topPillLabel}</span>
        </div>

        {/* ── Top-right floating pill: active scene name (opens SceneSheet) ── */}
        <button
          type="button"
          className={s.cornerPillTopRight}
          onClick={() => setSceneSheetOpen(true)}
          aria-label={`Scene: ${sceneName}. Tap to change.`}
          title="Change scene"
        >
          <span className={s.cornerPillText}>{sceneName}</span>
          <span className={s.cornerPillChevron} aria-hidden="true">▾</span>
        </button>

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
             gradient so the camera feed bleeds through. */}
        <div className={s.dockSlim} role="toolbar" aria-label="Camera secondary controls">
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
