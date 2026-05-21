import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AcousticSectorIndicator } from "../components/AcousticSectorIndicator";
import { AiAssistant } from "../components/AiAssistant";
import { CameraCapture } from "../components/CameraCapture";
import { ContaminationMarker } from "../components/ContaminationMarker";
import { DispositionPicker } from "../components/DispositionPicker";
import { EntertainmentOnlyLabel } from "../components/EntertainmentOnlyLabel";
import { LiveARView } from "../components/LiveARView";
import { LiveStreamView } from "../components/LiveStreamView";
import { SensorsPanel } from "../components/SensorsPanel";
import { useLiveNarrator } from "../lib/posterior/liveNarrator";
import { EvidenceLedger, type LedgerStream } from "../components/EvidenceLedger";
import { OvilusTool } from "../components/OvilusTool";
import { PosteriorBar } from "../components/PosteriorBar";
import { PreAirReadinessChip } from "../components/PreAirReadinessChip";
import { ScreenRecordButton } from "../components/ScreenRecordButton";
import { SessionBaselineCard } from "../components/SessionBaselineCard";
import { SessionSummaryCard } from "../components/SessionSummaryCard";
import { SimpleMissionView } from "../components/SimpleMissionView";
import { SpiritBoxTool } from "../components/SpiritBoxTool";
import { BaitToneTool } from "../components/BaitToneTool";
import { TriggerObjectTracker } from "../components/TriggerObjectTracker";
import { EmfSpikeLed } from "../components/EmfSpikeLed";
import { SlsPoseTracker } from "../components/SlsPoseTracker";
import { VideoEvpCaptureTile } from "../components/VideoEvpCaptureTile";
import { usePreferences } from "../lib/preferences";
import {
  createCalibrationState,
  isInstrumentTrustworthy,
  recordAttempt,
  startCalibration,
  summary as calibrationSummary,
  type CalibrationState,
} from "../lib/audio/calibration";
import { LiveAnalyzer } from "../lib/audio/liveAnalyzer";
import { type SectorReading } from "../lib/audio/sectorIndicator";
import { ensureTodayInvestigation } from "../lib/bootstrap";
import { requestPersistentStorage } from "../lib/opfs";
import { getInvestigation, recordEvent, setCulturallySensitive, startInvestigation, stopInvestigation } from "../lib/db/repo";
import { lockProtocol } from "../lib/db/protocolRepo";
import {
  emitAcousticTransient,
  emitInfrasoundPulse,
  emitMagnetometerAnomaly,
  emitTemporalCoupling,
} from "../lib/posterior/likelihoods";
import { getPosterior } from "../lib/posterior/posterior";
import { applyAndAudit, createSiteSession, type SiteSession } from "../lib/posterior/siteSession";
import { type BaselineSummary, loadBaseline, saveBaseline } from "../lib/posterior/sessionBaseline";
import { getCurrentPoint } from "../lib/sensors/geolocation";
import { requestSensorPermissionsForUserGesture } from "../lib/sensors/permissions";
import { useSensors } from "../lib/sensors/useSensors";
import { setCurrent, setPermissionsGranted, useSession } from "../lib/session";
import { useWakeLock } from "../lib/system/wakeLock";
import s from "./View.module.css";
import m from "./MissionControl.module.css";

function formatHMS(totalSeconds: number): string {
  const t = Math.max(0, Math.floor(totalSeconds));
  const hh = Math.floor(t / 3600).toString().padStart(2, "0");
  const mm = Math.floor((t % 3600) / 60).toString().padStart(2, "0");
  const ss = (t % 60).toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

const SECTOR_DEMO_PLAN = ["FRONT-R", "REAR-C", "FRONT-L"] as const;

export function MissionControl() {
  const [prefs] = usePreferences();
  const isPro = prefs.experienceMode === "pro";
  const session = useSession();
  const sensors = useSensors(session.permissionsGranted);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  // On-camera mode — ephemeral. Toggling it scales up the hero / timer /
  // primary controls and hides on-camera clutter (case id, calibration
  // ritual once trustworthy). Operators tend to toggle on for the take
  // and off for the rest, so we deliberately don't persist it.
  const [liveTake, setLiveTake] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string>("Tap Begin to grant sensor permissions.");
  const [calibration, setCalibration] = useState<CalibrationState>(() => createCalibrationState());
  const [siteSession, setSiteSession] = useState<SiteSession>(() => createSiteSession());
  const [posterior, setPosterior] = useState<number>(siteSession.state.prior);
  const [sectorReading, setSectorReading] = useState<SectorReading | null>(null);
  // audioRms gets fed from the LiveAnalyzer's onLevel callback at the same
  // ~94 Hz rate as the camera path. setState there storms the parent and
  // every child (SessionBaselineCard, LiveStreamView, posterior dial, etc.)
  // at native frame rate. Mirror the CameraScreen fix: keep the fast value
  // in a ref so any future consumer that needs the freshest sample can
  // read it without subscribing to renders, and throttle the public state
  // ("Coarse") to 5 Hz for UI consumers. The acoustic-transient handler
  // already receives the fresh rms as a callback param, so it doesn't need
  // to read the ref — but the ref is cheap to keep current.
  const audioRmsRef = useRef<number>(0.05);
  const [audioRmsCoarse, setAudioRmsCoarse] = useState<number>(0.05);
  const lastAudioRmsEmitRef = useRef<number>(0);
  const analyzerRef = useRef<LiveAnalyzer | null>(null);
  const sectorReadingRef = useRef<SectorReading | null>(null);
  // Debounce refs — set on every emit ATTEMPT, including refused ones.
  // Prevents a flood of LR computations when the upstream sensor alarm
  // fires repeatedly. Distinct from lastEmissionTsRef.current.* below,
  // which only updates on SUCCESSFUL fires (so coupling checks never see
  // a refused emit as a "recent fire").
  const lastAcousticEmitTsRef = useRef<number>(0);
  const lastMagnetometerEmitTsRef = useRef<number>(0);
  const aiAssistantRef = useRef<HTMLDivElement | null>(null);
  const liveStreamRef = useRef<HTMLDivElement | null>(null);
  const [pendingDispositionFor, setPendingDispositionFor] = useState<string | null>(null);
  const [pendingSummary, setPendingSummary] = useState<{ id: string; startIso: string; endIso: string; peak: number; final: number } | null>(null);
  const [posteriorPeak, setPosteriorPeak] = useState<number>(0);
  const [narrationSpeak, setNarrationSpeak] = useState<boolean>(false);
  const [culturallySensitive, setCulturallySensitiveState] = useState<boolean>(false);
  const [liveStreamState, setLiveStreamState] = useState<{ recording: boolean; broadcasting: boolean }>({ recording: false, broadcasting: false });
  const [baseline, setBaseline] = useState<BaselineSummary | null>(null);
  // Live ref so analyzer callbacks (created once when the session starts)
  // always see the latest baseline — capturing after Begin still applies.
  const baselineRef = useRef<BaselineSummary | null>(null);
  useEffect(() => { baselineRef.current = baseline; }, [baseline]);

  // Load any previously-captured baseline for the active investigation.
  // session is a useRef across the next four hooks — the ref object is stable
  // and .current mutates without re-rendering. session.current?.id is the
  // read-out scalar used as a re-key trigger; eslint can't see through that.
  useEffect(() => {
    const id = session.current?.id;
    if (!id) {
      setBaseline(null);
      return;
    }
    setBaseline(loadBaseline(id));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.current?.id]);

  const handleBaselineComplete = useCallback((summary: BaselineSummary) => {
    setBaseline(summary);
    const id = session.current?.id;
    if (id) saveBaseline(id, summary);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.current?.id]);

  // Reflect the active investigation's stored cultural-sensitivity flag.
  useEffect(() => {
    const id = session.current?.id;
    if (!id) {
      setCulturallySensitiveState(false);
      return;
    }
    let cancelled = false;
    void getInvestigation(id).then((inv) => {
      if (!cancelled) setCulturallySensitiveState(!!inv && inv.culturally_sensitive === 1);
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.current?.id]);

  const handleToggleSensitive = useCallback(async () => {
    const id = session.current?.id;
    if (!id) return;
    if (culturallySensitive) {
      // Turning protection OFF: confirm first (high risk — cloud + sync resume).
      const ok = window.confirm("Clear cultural-sensitivity flag for this case? Cloud AI and sync will resume.");
      if (!ok) return;
      await setCulturallySensitive(id, false);
      setCulturallySensitiveState(false);
      setStatusMsg("Cultural-sensitivity flag cleared. Cloud AI and sync re-enabled for this case.");
    } else {
      // Turning protection ON: low risk, flip immediately.
      await setCulturallySensitive(id, true);
      setCulturallySensitiveState(true);
      setStatusMsg("Site flagged as culturally sensitive. Cloud AI and sync are blocked for this case.");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.current?.id, culturallySensitive]);

  const handleAskQuestion = useCallback(() => {
    aiAssistantRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const handleBroadcastLive = useCallback(() => {
    liveStreamRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // Live narrator — plain-English caption per posterior increment, optionally spoken.
  const narratorCaption = useLiveNarrator(siteSession.recentIncrements, {
    speak: narrationSpeak && running,
    captionMs: 7000,
  });

  const ledgerStreams = useMemo<LedgerStream[]>(() => {
    const now = Date.now();
    const samples = (z: number | undefined) => {
      if (z === undefined || !running) return [];
      // Single sample at "now"; the canvas redraw handles persistence.
      return [{ ts: now, magnitude: Math.max(-1, Math.min(1, z / 6)) }];
    };
    return [
      { id: "acoustic", label: "ACOUSTIC", color: "rgba(93, 242, 199, 0.85)", samples: samples(sensors.vibration?.z) },
      { id: "magnetometer", label: "EMF", color: "rgba(242, 185, 93, 0.85)", samples: samples(sensors.emf?.z ?? sensors.compassAnomaly?.z) },
      { id: "infrasound", label: "INFRASOUND", color: "rgba(127, 252, 215, 0.45)", samples: [] },
    ];
  }, [running, sensors.vibration?.z, sensors.emf?.z, sensors.compassAnomaly?.z]);

  // 1Hz timer tick when running.
  useEffect(() => {
    if (!running) return;
    const handle = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(handle);
  }, [running]);

  const elapsedSeconds = useMemo(() => {
    if (!running || !startedAt) return 0;
    void tick;
    return (Date.now() - startedAt) / 1000;
  }, [running, startedAt, tick]);

  // Posterior re-read on tick (decay) and on explicit updates.
  // Gate the read on `running` so post-session siteSession.state changes
  // (e.g. an export pass touching the state object) don't keep recomputing
  // the posterior + peak every change after Stop.
  useEffect(() => {
    if (!running) return;
    const next = getPosterior(siteSession.state, Date.now());
    setPosterior(next);
    setPosteriorPeak((peak) => (next > peak ? next : peak));
  }, [siteSession.state, tick, running]);

  // ----- Sensor anomaly → likelihood emission → posterior update -----

  const lastEmissionTsRef = useRef<{ acoustic: number | null; magnetometer: number | null; infrasound: number | null }>({ acoustic: null, magnetometer: null, infrasound: null });

  const emitEvidence = useCallback(async (input: Parameters<typeof applyAndAudit>[1]) => {
    const result = await applyAndAudit(siteSession, input);
    setSiteSession(result.session);
    setPosterior(getPosterior(result.session.state, Date.now()));
  }, [siteSession]);

  // Vibration anomaly is now a backup channel — when LiveAnalyzer is wired,
  // the acoustic-transient channel comes from real audio in the worklet path.
  useEffect(() => {
    if (!running || analyzerRef.current) return; // skip if real audio analyzer is running
    if (!sensors.vibration?.alert) return;
    const now = Date.now();
    // Debounce ALL attempts (including refused) — prevents flooding when
    // the vibration sensor alarm fires repeatedly.
    if (lastAcousticEmitTsRef.current && now - lastAcousticEmitTsRef.current < 2000) return;
    lastAcousticEmitTsRef.current = now;
    const evidence = emitAcousticTransient({
      coherence: 0.7,
      subBandsAgreed: 3,
      sector: sectorReading?.sector ?? "REAR-C",
      sectorPersistedFromPrior: false,
      isFirstInWindow: true,
    });
    if (!evidence) return;
    // Only update the fires ref on successful emit so coupling checks
    // never see a refused attempt as a "recent acoustic fire."
    lastEmissionTsRef.current.acoustic = now;
    void emitEvidence({ channel: evidence.channel, logLr: evidence.logLr, reason: `${evidence.reason} (vibration fallback)`, metadata: evidence.metadata, nowMs: now });
  }, [running, sensors.vibration?.alert, sectorReading, emitEvidence]);

  // Magnetometer anomaly: when EMF tile alerts.
  useEffect(() => {
    if (!running || !sensors.emf?.alert) return;
    const now = Date.now();
    // Debounce ALL attempts (including refused). Distinct from the fires
    // ref below, which only updates on successful emit so coupling checks
    // never see a baseline-refused attempt as a "recent magnetometer fire."
    if (lastMagnetometerEmitTsRef.current && now - lastMagnetometerEmitTsRef.current < 2000) return;
    lastMagnetometerEmitTsRef.current = now;
    const evidence = emitMagnetometerAnomaly({
      zScore: sensors.emf.z,
      magnitudeMicrotesla: sensors.emf.value,
      baselineMicrotesla: sensors.emf.mean,
      // V2: pass the captured site baseline so readings within the
      // measured noise floor are refused, not piled into the posterior.
      siteBaseline: baseline,
    });
    if (!evidence) return;
    lastEmissionTsRef.current.magnetometer = now;
    void emitEvidence({ channel: evidence.channel, logLr: evidence.logLr, reason: evidence.reason, metadata: evidence.metadata, nowMs: now });

    // Coupling check: if acoustic fired within 200 ms of this magnetometer event, emit a coupling.
    const tA = lastEmissionTsRef.current.acoustic;
    if (tA && Math.abs(now - tA) <= 200) {
      const coupling = emitTemporalCoupling({ channels: ["acoustic", "magnetometer"], deltaMs: Math.abs(now - tA) });
      if (coupling) {
        void emitEvidence({ channel: coupling.channel, logLr: coupling.logLr, reason: coupling.reason, metadata: coupling.metadata, nowMs: now });
      }
    }
  // `baseline` is intentionally read from closure each emf alert tick — the
  // surrounding state changes (sensors.emf.*) cause this effect to re-run
  // frequently enough to pick up baseline updates, and the alternative
  // (adding baseline to deps) would needlessly re-bind on every Sound-Check
  // sample during baseline capture. The companion baselineRef (set at line
  // 119) is the explicit "always latest" pattern; this effect uses closure.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, sensors.emf?.alert, sensors.emf?.z, sensors.emf?.value, sensors.emf?.mean, emitEvidence]);

  // ----- UI handlers -----

  const startLiveAnalyzer = useCallback(async () => {
    if (analyzerRef.current) return;
    const analyzer = new LiveAnalyzer({
      onSectorReading: (reading) => {
        sectorReadingRef.current = reading;
        setSectorReading(reading);
      },
      onLevel: (rms) => {
        // Fast path: always store the latest sample in the ref so the
        // acoustic-transient computation downstream sees the freshest
        // value. Slow path: coalesce the React-visible state update to
        // 5 Hz so the parent + child consumers re-render at a sustainable
        // cadence instead of native ~94 Hz.
        audioRmsRef.current = rms;
        const now = performance.now();
        if (now - lastAudioRmsEmitRef.current >= 200) {
          lastAudioRmsEmitRef.current = now;
          setAudioRmsCoarse(rms);
        }
      },
      onAcousticTransient: (reading, rms, _frameTs) => {
        const now = Date.now();
        // 2s debounce
        if (now - lastAcousticEmitTsRef.current < 2000) return;
        lastAcousticEmitTsRef.current = now;
        const sector = reading.sector;
        if (!sector) return;
        const evidence = emitAcousticTransient({
          coherence: reading.coherence,
          subBandsAgreed: reading.passingBands,
          sector,
          sectorPersistedFromPrior: false,
          isFirstInWindow: true,
          // V2 baseline awareness — read via ref so the analyzer closure
          // (created once at startLiveAnalyzer time) always sees the
          // latest captured baseline.
          audioRms: rms,
          siteBaseline: baselineRef.current,
        });
        if (!evidence) return;
        lastEmissionTsRef.current.acoustic = now;
        void emitEvidence({
          channel: evidence.channel,
          logLr: evidence.logLr,
          reason: evidence.reason,
          metadata: evidence.metadata,
          nowMs: now,
        });
      },
      onInfrasound: (detection) => {
        const now = Date.now();
        const evidence = emitInfrasoundPulse({
          peakHz: detection.peakHz,
          durationSeconds: detection.durationSeconds,
          envelopeDb: detection.envelopeDb,
          baselineEnvelopeDb: detection.baselineEnvelopeDb,
        });
        if (!evidence) return;
        lastEmissionTsRef.current.infrasound = now;
        void emitEvidence({
          channel: evidence.channel,
          logLr: evidence.logLr,
          reason: evidence.reason,
          metadata: evidence.metadata,
          nowMs: now,
        });
        // No acoustic+infrasound coupling — both channels share the audio
        // RMS chain (see infrasound.ts: InfrasoundDetector.pushFrameRms
        // consumes the same rms value the acoustic transient detector
        // gates on in liveAnalyzer.ts L159). emitTemporalCoupling also
        // refuses such pairs defensively (likelihoods.ts shareAudioChain),
        // but we don't even attempt them here so the audit log stays
        // clean. Infrasound + magnetometer would qualify as an
        // independent coupling; the magnetometer effect above handles
        // any acoustic+magnetometer coupling on its own ts ref.
      },
      onError: (err) => {
        setStatusMsg(`Audio analyzer error: ${err.message}`);
      },
    });
    try {
      await analyzer.start();
      analyzerRef.current = analyzer;
    } catch {
      // already surfaced via onError
    }
  }, [emitEvidence]);

  const stopLiveAnalyzer = useCallback(async () => {
    const analyzer = analyzerRef.current;
    if (!analyzer) return;
    analyzerRef.current = null;
    await analyzer.stop();
    setSectorReading(null);
    sectorReadingRef.current = null;
  }, []);

  const handleBegin = useCallback(async () => {
    setBusy(true);
    try {
      const perm = await requestSensorPermissionsForUserGesture();
      if (perm.motion === "denied" || perm.orientation === "denied") {
        setStatusMsg("Motion / orientation permission denied. Sensors can't run.");
        setBusy(false);
        return;
      }
      setPermissionsGranted(true);
      const inv = await ensureTodayInvestigation();
      // iOS Safari caps OPFS near 1 GiB without persistent-storage; on
      // Chromium the persist() heuristic also weights "has stored data".
      // Calling AFTER the first investigation write means the browser
      // sees the storage activity tied to the user gesture, which lifts
      // the success rate. opfs.ts caches granted/denied in localStorage
      // so the re-ask on later Begin taps short-circuits.
      void requestPersistentStorage();
      // No re-confirmation modal here. The Simple-mode readiness banner
      // already surfaces baseline absence + staleness with explanatory
      // copy; a window.confirm() on top is jarring on mobile and breaks
      // a streamer's broadcast aesthetic mid-take. Tap Begin = consent.
      // Baseline-aware likelihoods downstream still apply / refuse based
      // on whatever baseline data exists for the investigation.

      setCurrent(inv);
      // Auto-lock the pre-registered protocol at session start if it was
      // written as a draft but not yet cryptographically locked. Best-effort —
      // a lock failure must NOT block the session; the amber chip in CaseManager
      // will continue to remind the operator.
      if (inv.protocol_json && !inv.protocol_hash) {
        await lockProtocol(inv.id).catch((err) => {
          console.warn("[protocol] auto-lock at session start failed:", err);
        });
      }
      await startInvestigation(inv.id);
      await recordEvent({ investigation_id: inv.id, source: "system", event_type: "session_start", title: "Session started" });
      setSiteSession(createSiteSession());
      setRunning(true);
      setStartedAt(Date.now());
      setPosteriorPeak(0); // reset peak tracker for the new session
      // Kick off real-time stereo audio analyzer (FFT → cross-spectrum → ASI).
      void startLiveAnalyzer();
      setStatusMsg("Recording. Calibrate the rig before trusting any sector reading.");
    } catch (err) {
      setStatusMsg(`Couldn't start: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [startLiveAnalyzer]);

  const handleStop = useCallback(async () => {
    if (!session.current) return;
    setBusy(true);
    try {
      const sessionStartIso = startedAt ? new Date(startedAt).toISOString() : new Date().toISOString();
      const sessionEndIso = new Date().toISOString();
      const finalPosterior = posterior;
      const peakSnapshot = Math.max(posteriorPeak, finalPosterior);
      await stopLiveAnalyzer();
      await stopInvestigation(session.current.id);
      await recordEvent({ investigation_id: session.current.id, source: "system", event_type: "session_stop", title: "Session ended" });
      setRunning(false);
      setStartedAt(null);
      setPendingDispositionFor(session.current.id);
      // Stash the snapshot so SessionSummaryCard can render with stable data
      // even after the React state for posterior keeps decaying post-stop.
      setPendingSummary({
        id: session.current.id,
        startIso: sessionStartIso,
        endIso: sessionEndIso,
        peak: peakSnapshot,
        final: finalPosterior,
      });
      setStatusMsg("Session stopped. Classify the disposition before reviewing.");
    } finally {
      setBusy(false);
    }
  // session is a useRef — the ref object is stable, .current mutates without
  // triggering a re-render. Callback reads session.current at invoke time.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.current, stopLiveAnalyzer, startedAt, posterior, posteriorPeak]);

  const handleMarker = useCallback(async () => {
    if (!session.current) return;
    const point = await getCurrentPoint().catch(() => null);
    await recordEvent({
      investigation_id: session.current.id,
      source: "user",
      event_type: "marker",
      title: "Marker",
      metadata: { geo: point },
    });
    setStatusMsg(point ? `Marker dropped (±${Math.round(point.accuracy ?? 0)} m).` : "Marker dropped.");
  // session is a useRef — the ref object is stable, .current mutates without
  // triggering a re-render. Callback reads session.current at invoke time.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.current]);

  // Calibration: simulated for V1 — operator says they placed the speaker at the expected sector.
  const handleCalibrationStart = useCallback(() => {
    setCalibration(startCalibration(createCalibrationState()));
  }, []);

  const handleCalibrationConfirm = useCallback((measured: typeof SECTOR_DEMO_PLAN[number]) => {
    setCalibration((prev) => recordAttempt(prev, { measured, coherence: 0.85, itdMs: 0, ts: Date.now() }));
  }, []);

  // Stop the analyzer when the component unmounts.
  useEffect(() => {
    return () => { void stopLiveAnalyzer(); };
  }, [stopLiveAnalyzer]);

  // Keep the screen awake while the session is live. iOS Safari otherwise
  // suspends AudioContext when the lock screen kicks in, silently killing
  // EVP and broadcast recording mid-take.
  useWakeLock(running);

  const trustworthy = isInstrumentTrustworthy(calibration);
  // Prefer real audio RMS for the breath-line; fall back to vibration sensor when audio not running.
  // Uses the 5 Hz coarse copy — breath-line scale doesn't need 94 Hz updates,
  // and the noiseFloor is consumed by re-render-y child components.
  const noiseFloor = Math.max(0.04, Math.min(0.6, audioRmsCoarse > 0 ? audioRmsCoarse * 4 : (sensors.vibration?.value ?? 0.05) / 4));

  return (
    <section className={s.view}>
      {/* Hard constraint #3 — Entertainment-only label is rendered inline at
          the top of MissionControl. Pulls its copy from the frozen
          module-load constant in src/lib/legal/disclaimers.ts so it cannot
          be removed at runtime. Inline variant flows with document layout
          (no live video to overlay here). */}
      <EntertainmentOnlyLabel variant="inline" />
      {/* ROOM BASELINE — capture noise floor before the session, render above
          the activity dial in both Simple and Pro modes. */}
      <SessionBaselineCard
        investigationId={session.current?.id ?? null}
        baseline={baseline}
        audioRms={audioRmsCoarse}
        emfMagnitude={sensors.snapshot.magnetometer?.magnitude ?? sensors.emf?.value ?? null}
        sessionRunning={running}
        onComplete={handleBaselineComplete}
        ensureInvestigation={async () => {
          // Lazy investigation creation when the operator captures a
          // baseline before formally beginning a session. Same helper
          // handleBegin uses — idempotent: returns today's existing
          // investigation if one exists, otherwise creates a fresh one
          // with an auto-name. The baseline ends up correctly anchored
          // to whichever case the operator runs the session under.
          const inv = await ensureTodayInvestigation();
          setCurrent(inv);
          return inv.id;
        }}
      />

      {!isPro && (
        <SimpleMissionView
          running={running}
          busy={busy}
          posterior={posterior}
          elapsedSeconds={elapsedSeconds}
          caseId={session.current?.id ?? null}
          caseTitle={session.current?.title ?? null}
          caseLocationName={session.current?.location_name ?? null}
          statusMsg={statusMsg}
          recentIncrements={siteSession.recentIncrements}
          trustworthy={trustworthy}
          baseline={baseline}
          hasInvestigation={!!session.current}
          investigationId={session.current?.id ?? null}
          audioRms={audioRmsCoarse}
          sectorReading={sectorReading ? { sector: sectorReading.sector, coherence: sectorReading.coherence, trustworthy: sectorReading.trustworthy } : null}
          narratorCaption={narratorCaption}
          narratorSpeak={narrationSpeak}
          onToggleNarratorSpeak={setNarrationSpeak}
          onBegin={handleBegin}
          onStop={handleStop}
          onMarker={handleMarker}
          onAskQuestion={handleAskQuestion}
          onBroadcastLive={handleBroadcastLive}
          broadcasting={liveStreamState.broadcasting}
          recordingClip={liveStreamState.recording}
          culturallySensitive={culturallySensitive}
          onToggleSensitive={session.current ? handleToggleSensitive : null}
          emitEvidence={emitEvidence}
        />
      )}

      {isPro && (
      /* INSTRUMENT CLUSTER */
      <div className={m.instrumentCluster} data-live-take={liveTake ? "on" : "off"}>
        <div className={m.heroRow}>
          <div className={m.hero}>
            <div className={m.heroTopRow}>
              <span className={`${m.recPill} ${running ? m.recPillActive : m.recPillIdle}`.trim()}>
                <span className={m.recPillDot} />
                <span>{running ? "RECORDING" : "STANDBY"}</span>
              </span>
              <ScreenRecordButton investigationId={session.current?.id ?? null} />
              <button
                type="button"
                className={`${m.takePill} ${liveTake ? m.takePillActive : ""}`.trim()}
                onClick={() => setLiveTake((v) => !v)}
                title={liveTake ? "Exit on-camera layout" : "Switch to on-camera layout — bigger primary controls, less clutter"}
                aria-pressed={liveTake}
              >
                <span className={m.takePillDot} />
                <span>{liveTake ? "ON-CAMERA · ON" : "ON-CAMERA · OFF"}</span>
              </button>
              {session.current && (
                <button
                  type="button"
                  className={`${m.sensitivePill} ${culturallySensitive ? m.sensitivePillActive : ""}`.trim()}
                  onClick={handleToggleSensitive}
                  title={culturallySensitive ? "Tap to clear cultural-sensitivity flag" : "Tap to flag this site as culturally sensitive"}
                >
                  <span className={m.sensitivePillDot} />
                  <span>{culturallySensitive ? "SENSITIVE · cloud blocked" : "Site OK"}</span>
                </button>
              )}
              <span className={m.caseId}>
                {session.current ? `CASE ${session.current.id.slice(0, 8).toUpperCase()}` : "NO CASE"}
              </span>
              <PreAirReadinessChip />
            </div>
            <h1 className={m.heroTitle}>{session.current?.title ?? "Begin a session"}</h1>
            <p className={m.heroSub}>{statusMsg}</p>
            <div className={m.heroTimer}>{formatHMS(elapsedSeconds)}</div>
            <div className={m.heroTimerLabel}>ELAPSED</div>
          </div>
          <AcousticSectorIndicator reading={sectorReading} trustworthy={trustworthy} />
        </div>

        {/* POSTERIOR BAR — the headline */}
        <PosteriorBar
          posterior={posterior}
          recentIncrements={siteSession.recentIncrements}
          prior={siteSession.state.prior}
        />

        {/* EVIDENCE LEDGER — substrate */}
        <EvidenceLedger streams={ledgerStreams} pixelsPerSecond={24} columnMs={80} noiseFloor={noiseFloor} />

        {/* CALIBRATION RITUAL — the cold-open */}
        <div className={m.calibration}>
          <div className={m.calibrationHead}>
            <span className={m.calibrationEyebrow}>CALIBRATION</span>
            <span className={`${m.calibrationStatus} ${trustworthy ? m.calibrationPassed : ""}`.trim()}>
              {calibrationSummary(calibration)}
            </span>
          </div>
          {calibration.status === "idle" && (
            <button type="button" className={m.calibrationStart} onClick={handleCalibrationStart}>
              Start 3-of-3 sector calibration
            </button>
          )}
          {calibration.status === "running" && (
            <div className={m.calibrationStep}>
              <p>
                Place the speaker at <strong>{calibration.plan[calibration.cursor]}</strong>, fire a 200&nbsp;ms click,
                then confirm what you observed:
              </p>
              <div className={m.calibrationButtons}>
                {SECTOR_DEMO_PLAN.map((sec) => (
                  <button
                    key={sec}
                    type="button"
                    className={m.calibrationOption}
                    onClick={() => handleCalibrationConfirm(sec)}
                  >
                    {sec}
                  </button>
                ))}
              </div>
            </div>
          )}
          {calibration.status === "degraded" && (
            <button type="button" className={m.calibrationStart} onClick={handleCalibrationStart}>
              Re-run calibration
            </button>
          )}
        </div>

        {/* SESSION CONTROLS */}
        <div className={m.heroActions}>
          {!running ? (
            <button className={m.primaryAction} onClick={handleBegin} disabled={busy}>
              {busy ? "…" : "Begin session"}
            </button>
          ) : (
            <>
              <button className={m.dangerAction} onClick={handleStop} disabled={busy}>End session</button>
              <button className={m.secondaryAction} onClick={handleMarker} disabled={busy}>+ Marker</button>
            </>
          )}
        </div>
      </div>
      )}

      {/* DISPOSITION PICKER — shown after a session stops, before the summary */}
      {pendingDispositionFor && (
        <DispositionPicker
          investigationId={pendingDispositionFor}
          onChosen={() => {
            setPendingDispositionFor(null);
            setStatusMsg("Disposition recorded. Review tab has the chain.");
          }}
        />
      )}

      {/* SESSION DIGEST — closes every session with a one-glance summary */}
      {!pendingDispositionFor && pendingSummary && (
        <SessionSummaryCard
          investigationId={pendingSummary.id}
          sessionStartIso={pendingSummary.startIso}
          sessionEndIso={pendingSummary.endIso}
          peakPosterior={pendingSummary.peak}
          finalPosterior={pendingSummary.final}
          onClose={() => setPendingSummary(null)}
        />
      )}

      {/* LIVE BROADCAST — camera + mic + sensor overlays composited; record + go live */}
      <div ref={liveStreamRef}>
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
        onStateChange={setLiveStreamState}
      />
      </div>

      {/* AR VIEW — quick camera open without composited stream (Simple-mode discovery) */}
      {!isPro && (
        <details className={m.optionalSection}>
          <summary>Quick AR camera (no recording)</summary>
          <LiveARView
            investigationId={session.current?.id ?? null}
            running={running}
            posterior={posterior}
            audioRms={audioRmsCoarse}
            sector={sectorReading?.sector ?? null}
            coherence={sectorReading?.coherence ?? 0}
            caption={narratorCaption}
          />
        </details>
      )}

      {/* EMF SPIKE LEDS — K-II-style 5-LED bar driven by magnetometer z-score */}
      {prefs.rig.modules.emfSpikeLed && (
        <EmfSpikeLed
          z={sensors.emf?.z ?? sensors.compassAnomaly?.z ?? null}
          magnitude={sensors.snapshot.magnetometer?.magnitude ?? sensors.emf?.value ?? null}
          running={running}
          audible={isPro}
        />
      )}

      {/* VIDEO + EVP SESSION REEL — back-cam video w/ synced mic audio,
          overlays composited onto the recording (timestamp, REC, venue,
          posterior, EMF µT, audio RMS, narrator caption). */}
      {isPro && prefs.rig.modules.videoEvpCapture && (
        <VideoEvpCaptureTile
          investigationId={session.current?.id ?? null}
          sessionRunning={running}
          caseId={session.current?.id ?? null}
          caseTitle={session.current?.title ?? null}
          posterior={posterior}
          audioRms={audioRmsCoarse}
          sector={sectorReading?.sector ?? null}
          coherence={sectorReading?.coherence ?? 0}
          caption={narratorCaption}
          magnetometerUt={sensors.snapshot.magnetometer?.magnitude ?? sensors.emf?.value ?? undefined}
          lightLux={sensors.snapshot.light?.lux ?? undefined}
          motionMs2={sensors.snapshot.motion?.accelMagnitude ?? undefined}
        />
      )}

      {/* SLS STICK-FIGURE TRACKER — motion-shape heuristic with audit
          chain. Honestly framed (not depth-sensor) in the tile itself. */}
      {isPro && prefs.rig.modules.slsTracker && (
        <SlsPoseTracker
          investigationId={session.current?.id ?? null}
          running={running}
          showDebug={isPro}
        />
      )}

      {/* CAMERA — scene snapshots (Pro plain tile) */}
      {isPro && prefs.rig.modules.camera && (
        <CameraCapture investigationId={session.current?.id ?? null} running={running} />
      )}

      {/* CONTAMINATION MARKERS — Pro grid (Simple mode uses an in-place sheet) */}
      {isPro && prefs.rig.modules.contaminationMarkers && (
        <ContaminationMarker
          investigationId={session.current?.id ?? null}
          running={running}
          emitEvidence={emitEvidence}
        />
      )}

      {/* AI ASSIST — question generator + auto-debunker */}
      <div ref={aiAssistantRef}>
        <AiAssistant
          investigationId={session.current?.id ?? null}
          posterior={posterior}
          recentIncrements={siteSession.recentIncrements}
          siteContext={session.current?.location_name ? `Location: ${session.current.location_name}.` : ""}
          culturallySensitive={culturallySensitive}
        />
      </div>

      {/* TRIGGER OBJECT TRACKER — Tier 3 #5 */}
      {session.current && (
        <TriggerObjectTracker investigationId={session.current.id} />
      )}

      {/* ITC TOOLS — rig-gated */}
      {prefs.rig.modules.spiritBox && (
        <SpiritBoxTool
          entropy={sensors.snapshot.magnetometer?.magnitude ?? sensors.snapshot.motion?.accelMagnitude ?? 0}
          investigationId={session.current?.id ?? null}
        />
      )}
      {prefs.rig.modules.ovilus && (
        <OvilusTool entropy={sensors.snapshot.magnetometer?.magnitude ?? sensors.snapshot.orientation?.heading ?? 0} investigationId={session.current?.id ?? null} />
      )}

      {/* BAIT TOOLS — sub-audible carrier */}
      {isPro && prefs.rig.modules.baitTone && <BaitToneTool investigationId={session.current?.id ?? null} />}

      {/* ESTES MODE — dual-phone sensory-deprivation rig */}
      {isPro && prefs.rig.modules.estesTile && (
        <a href="/estes" className={m.estesTile}>
          <span className={m.estesEyebrow}>ESTES METHOD · DUAL-PHONE</span>
          <span className={m.estesTitle}>Pair two phones for a sensory-deprivation session</span>
          <span className={m.estesHint}>Receiver blacks out + spirit-box-cycles + streams mic. Questioner types questions, hears responses, watches a timestamped log. Open →</span>
        </a>
      )}

      {/* SENSOR INVENTORY — what this phone exposes */}
      {prefs.rig.modules.sensorsPanel && <SensorsPanel />}

      {isPro && (
        <p className={m.disclaimer}>
          Sector accuracy ±60°. Posterior is a model estimate, not a measurement of presence. Every increment is hash-chained — receipts in the audit log.
        </p>
      )}
    </section>
  );
}
