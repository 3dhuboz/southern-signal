/**
 * CameraScreen — the camera-first primary route.
 *
 * The camera fills the full viewport. Sensor data, posterior probability,
 * and acoustic sector are composited directly onto the live video as
 * broadcast-grade overlays. A floating dock above the bottom nav lets the
 * operator toggle each overlay channel on/off with a single tap.
 *
 * All sensor/posterior management that MissionControl does is reproduced
 * here in a leaner form: same hooks, same Bayesian engine, minimal UI.
 * Navigating to /investigate mounts MissionControl with its full panel
 * suite; navigating back to / mounts this screen with fresh hooks.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { LiveStreamView } from "../components/LiveStreamView";
import { ScreenRecordButton } from "../components/ScreenRecordButton";
import { useLiveBroadcastState } from "../lib/system/liveBroadcast";
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
import { useWakeLock } from "../lib/system/wakeLock";
import type { OverlayChannels } from "../lib/media/canvasCompositor";
import { resolveOverlaysFromScene } from "../lib/overlays/registry";
import {
  hasPickedSceneEver, loadActiveSceneId, getScene, loadSceneOverrides,
  type SceneId,
} from "../lib/overlays/scenes";
import { useSpiritBox } from "../lib/itc/useSpiritBox";
import { useOvilus } from "../lib/itc/useOvilus";
import { Navigate, useNavigate } from "react-router-dom";
import s from "./CameraScreen.module.css";

// ── Dock button icons ──────────────────────────────────────────────────────
// The 14-toggle channel grid is gone — overlay configuration now happens in
// HuntSetup via Scenes (see lib/overlays/scenes.ts). The dock keeps only the
// broadcast action icons and the ITC tool toggles.

function IconRecord() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <circle cx="12" cy="12" r="7" fill="currentColor" />
    </svg>
  );
}
function IconLive() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <circle cx="12" cy="15" r="2.5" fill="currentColor" />
      <path d="M8 11.5 A5.5 5.5 0 0 1 16 11.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M5 8.5 A8.5 8.5 0 0 1 19 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />
    </svg>
  );
}
function IconFlip() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      {/* Camera body */}
      <rect x="2" y="7" width="20" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      {/* Lens */}
      <circle cx="12" cy="14" r="4" stroke="currentColor" strokeWidth="1.4" />
      {/* Flip-arrow arc above body */}
      <path d="M9 4.5 Q12 2 15 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <polyline points="13.5,3 15,4.5 13.5,6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconTorch() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      {/* Beam cone */}
      <path d="M9 2 H15 L20 21 H4 Z" fill="currentColor" opacity="0.2" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      {/* Lens housing */}
      <rect x="8.5" y="0.5" width="7" height="3.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      {/* Centre highlight */}
      <circle cx="12" cy="2.25" r="1" fill="currentColor" />
    </svg>
  );
}
function IconSpiritBox() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      {/* Radio sweep arcs */}
      <path d="M5.5 8 A8.5 8.5 0 0 1 18.5 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M8 10.5 A5.5 5.5 0 0 1 16 10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.6" />
      {/* Tuner dial */}
      <circle cx="12" cy="16" r="3.5" stroke="currentColor" strokeWidth="1.5" />
      <line x1="12" y1="12.5" x2="12" y2="9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="12" cy="16" r="1.3" fill="currentColor" />
    </svg>
  );
}
function IconOvilus() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      {/* Speech bubble */}
      <path d="M3 4 H21 Q23 4 23 6 V14 Q23 16 21 16 H13.5 L9.5 20.5 L9.5 16 H3 Q1 16 1 14 V6 Q1 4 3 4 Z"
        stroke="currentColor" strokeWidth="1.4" fill="none" />
      {/* Three dots — word generation */}
      <circle cx="8"  cy="10" r="1.4" fill="currentColor" />
      <circle cx="12" cy="10" r="1.4" fill="currentColor" />
      <circle cx="16" cy="10" r="1.4" fill="currentColor" />
    </svg>
  );
}

function fmtSecs(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}


// ── Component ────────────────────────────────────────────────────────────────

export function CameraScreen() {
  const session = useSession();
  const sensors = useSensors(session.permissionsGranted);

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
  const torchToggleRef  = useRef<(() => void) | null>(null);
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
  const itcEntropy = sensors.snapshot.magnetometer?.magnitude ?? sensors.snapshot.motion?.accelMagnitude ?? 0;

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
    resolveOverlaysFromScene({ ...(activeScene?.overlays ?? {}), ...loadSceneOverrides(activeSceneId) }),
  );
  // Whenever the active scene changes (operator picked a different one from
  // the dock chip or HuntSetup), reset channels to that scene's resolution.
  useEffect(() => {
    setChannels(resolveOverlaysFromScene({ ...(activeScene?.overlays ?? {}), ...loadSceneOverrides(activeSceneId) }));
  }, [activeSceneId, activeScene]);
  const handleChannelChange = useCallback((key: keyof OverlayChannels, value: boolean) => {
    setChannels((prev) => prev[key] === value ? prev : { ...prev, [key]: value });
  }, []);
  void setActiveSceneId; // Reserved for the scene-chip switch in Phase 4.

  // ITC hooks read the scene's tools config — Spirit Box Session auto-starts
  // the spirit box; Pro/Lab leaves Ovilus to manual. Hooks live after scene
  // resolution so the autoStart flag is always coherent with the active scene.
  const spiritBox = useSpiritBox(itcEntropy, running, activeScene?.tools.spiritBox === true);
  const ovilus    = useOvilus(itcEntropy, running, activeScene?.tools.ovilus === true);

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

  const sessionBtnLabel = busy ? "…" : running ? "End" : "Begin";
  const sessionBtnClass = `${s.sessionBtn} ${running ? s.sessionBtnStop : s.sessionBtnBegin}`;

  // Go Live disabled unless camera is open (can always stop an active broadcast)
  const liveDisabled = broadcastState.broadcasting
    ? false
    : !cameraState.streamOn || !cameraState.whipConfigured;
  const liveBtnTitle = broadcastState.broadcasting
    ? "End live"
    : !cameraState.streamOn
      ? "Open camera first"
      : !cameraState.whipConfigured
        ? "Set WHIP URL in Setup → Broadcast first"
        : "Go live";

  return (
    <div className={s.screen}>
      {/* Full-screen camera compositor */}
      <div className={s.cameraWrap}>
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
          torchToggleRef={torchToggleRef}
          flipCameraRef={flipCameraRef}
          startCameraRef={startCameraRef}
          defaultFacing={activeScene?.cameraDefaults.facing}
          defaultTorch={activeScene?.cameraDefaults.torch}
          onCameraState={handleCameraState}
          fullscreen
        />
      </div>

      {/* Sensor dock — floats above the bottom nav */}
      <div className={s.dock} role="toolbar" aria-label="Camera controls">
        {/* Session control */}
        <button
          type="button"
          className={sessionBtnClass}
          onClick={running ? handleStop : handleBegin}
          disabled={busy}
          aria-label={running ? "End session" : "Begin session"}
        >
          <span className={s.sessionDot} aria-hidden="true" />
          <span className={s.sessionLabel}>{sessionBtnLabel}</span>
          {running && <span className={s.sessionTimer}>{fmtSecs(sessionSecs)}</span>}
        </button>

        {/* Record compositor clip */}
        <button
          type="button"
          className={`${s.broadcastBtn} ${broadcastState.recording ? s.broadcastBtnRec : ""}`.trim()}
          onClick={() => recordToggleRef.current?.()}
          disabled={!cameraState.streamOn}
          aria-pressed={broadcastState.recording}
          aria-label={broadcastState.recording ? "Stop recording" : "Record clip"}
          title={broadcastState.recording ? "Stop recording" : "Record clip"}
        >
          <span className={s.channelIcon} aria-hidden="true"><IconRecord /></span>
          <span className={s.channelLabel}>{broadcastState.recording ? "Stop" : "Rec"}</span>
        </button>

        {/* Go Live via WHIP */}
        <button
          type="button"
          className={`${s.broadcastBtn} ${broadcastState.broadcasting ? s.broadcastBtnLive : ""}`.trim()}
          onClick={() => liveToggleRef.current?.()}
          disabled={liveDisabled}
          aria-pressed={broadcastState.broadcasting}
          aria-label={broadcastState.broadcasting ? "End live broadcast" : "Go live"}
          title={liveBtnTitle}
        >
          <span className={s.channelIcon} aria-hidden="true"><IconLive /></span>
          <span className={s.channelLabel}>{broadcastState.broadcasting ? "End" : "Live"}</span>
        </button>

        {/* Screen recorder — captures raw device pixels (WebM on Android; iOS
            native via Control Center with audit-chain timestamps). Uses the
            dock's classNames so it matches the other 52×52 tile buttons. */}
        <ScreenRecordButton
          investigationId={session.current?.id ?? null}
          classNames={{
            idle:   s.broadcastBtn,
            active: `${s.broadcastBtn} ${s.broadcastBtnRec}`,
            icon:   s.channelIcon,
            label:  s.channelLabel,
          }}
        />

        {/* Camera flip — rear ↔ front. Label shows the current lens so the
            operator can confirm at a glance which camera is live. */}
        <button
          type="button"
          className={s.broadcastBtn}
          onClick={() => flipCameraRef.current?.()}
          disabled={!cameraState.streamOn}
          aria-label={cameraState.facingMode === "environment" ? "Switch to front camera" : "Switch to rear camera"}
          title="Flip camera"
        >
          <span className={s.channelIcon} aria-hidden="true"><IconFlip /></span>
          <span className={s.channelLabel}>{cameraState.facingMode === "environment" ? "Rear" : "Front"}</span>
        </button>

        {/* Torch — only shown when the active camera reports torch support.
            Hidden entirely on cameras that lack a torch rather than showing
            a permanently-disabled tile. */}
        {cameraState.torchSupported && (
          <button
            type="button"
            className={`${s.broadcastBtn} ${cameraState.torchOn ? s.broadcastBtnRec : ""}`.trim()}
            onClick={() => torchToggleRef.current?.()}
            aria-pressed={cameraState.torchOn}
            aria-label={cameraState.torchOn ? "Turn torch off" : "Turn torch on"}
            title="Camera torch / flashlight"
          >
            <span className={s.channelIcon} aria-hidden="true"><IconTorch /></span>
            <span className={s.channelLabel}>Torch</span>
          </button>
        )}

        {/* Divider */}
        <div className={s.dockDivider} aria-hidden="true" />

        {/* Scene chip — replaces the 14-toggle overlay scroll. Shows the
            active scene name; tap navigates to /hunt-setup where the
            operator can pick a different scene. Single source of truth
            for overlay configuration (the F1 cockpit principle —
            drivers don't tune their dashboard at 200 mph). */}
        <button
          type="button"
          className={s.sceneChip}
          onClick={() => navigate("/hunt-setup")}
          aria-label={`Scene: ${activeScene?.name ?? "Walkthrough"}. Tap to change.`}
          title="Change scene"
        >
          <span className={s.sceneChipEyebrow}>Scene</span>
          <span className={s.sceneChipName}>
            {activeScene?.name ?? "Walkthrough"}
            <span className={s.sceneChipChevron} aria-hidden="true">▾</span>
          </span>
        </button>

        {/* ITC instruments — spirit box + ovilus quick-toggles.
            When active the label shows the current phoneme / word so the
            operator can glance at what's being burned into the overlay.
            The `itc` channel above must also be on for output to appear. */}
        <div className={s.dockDivider} aria-hidden="true" />
        <div className={`${s.dockChannels} ${s.dockChannelsItc}`} role="group" aria-label="ITC instruments">
          <button
            type="button"
            className={`${s.channelBtn} ${spiritBox.active ? s.channelBtnOn : ""}`.trim()}
            onClick={spiritBox.toggle}
            aria-pressed={spiritBox.active}
            aria-label={spiritBox.active ? "Stop spirit box" : "Start spirit box"}
            title="Spirit Box — cycles phonemes seeded by sensor entropy and burns them to the ITC overlay"
          >
            <span className={s.channelIcon} aria-hidden="true"><IconSpiritBox /></span>
            <span className={s.channelLabel}>{spiritBox.active ? spiritBox.current : "SBX"}</span>
          </button>
          <button
            type="button"
            className={`${s.channelBtn} ${ovilus.active ? s.channelBtnOn : ""}`.trim()}
            onClick={ovilus.toggle}
            aria-pressed={ovilus.active}
            aria-label={ovilus.active ? "Stop ovilus" : "Start ovilus"}
            title="Ovilus — generates words from a seeded dictionary and burns them to the ITC overlay"
          >
            <span className={s.channelIcon} aria-hidden="true"><IconOvilus /></span>
            <span className={s.channelLabel}>{ovilus.active ? ovilus.current : "OVL"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
