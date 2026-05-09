import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AcousticSectorIndicator } from "../components/AcousticSectorIndicator";
import { AiAssistant } from "../components/AiAssistant";
import { CameraCapture } from "../components/CameraCapture";
import { ContaminationMarker } from "../components/ContaminationMarker";
import { DispositionPicker } from "../components/DispositionPicker";
import { LiveARView } from "../components/LiveARView";
import { LiveStreamView } from "../components/LiveStreamView";
import { SensorsPanel } from "../components/SensorsPanel";
import { useLiveNarrator } from "../lib/posterior/liveNarrator";
import { EvidenceLedger, type LedgerStream } from "../components/EvidenceLedger";
import { OvilusTool } from "../components/OvilusTool";
import { PosteriorBar } from "../components/PosteriorBar";
import { ScreenRecordButton } from "../components/ScreenRecordButton";
import { SimpleMissionView } from "../components/SimpleMissionView";
import { SpiritBoxTool } from "../components/SpiritBoxTool";
import { BaitToneTool } from "../components/BaitToneTool";
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
import { getInvestigation, recordEvent, setCulturallySensitive, startInvestigation, stopInvestigation } from "../lib/db/repo";
import {
  emitAcousticTransient,
  emitInfrasoundPulse,
  emitMagnetometerAnomaly,
  emitTemporalCoupling,
} from "../lib/posterior/likelihoods";
import { getPosterior } from "../lib/posterior/posterior";
import { applyAndAudit, createSiteSession, type SiteSession } from "../lib/posterior/siteSession";
import { getCurrentPoint } from "../lib/sensors/geolocation";
import { requestSensorPermissionsForUserGesture } from "../lib/sensors/permissions";
import { useSensors } from "../lib/sensors/useSensors";
import { setCurrent, setPermissionsGranted, useSession } from "../lib/session";
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
  const [statusMsg, setStatusMsg] = useState<string>("Tap Begin to grant sensor permissions.");
  const [calibration, setCalibration] = useState<CalibrationState>(() => createCalibrationState());
  const [siteSession, setSiteSession] = useState<SiteSession>(() => createSiteSession());
  const [posterior, setPosterior] = useState<number>(siteSession.state.prior);
  const [sectorReading, setSectorReading] = useState<SectorReading | null>(null);
  const [audioRms, setAudioRms] = useState<number>(0.05);
  const analyzerRef = useRef<LiveAnalyzer | null>(null);
  const sectorReadingRef = useRef<SectorReading | null>(null);
  const lastAcousticEmitTsRef = useRef<number>(0);
  const aiAssistantRef = useRef<HTMLDivElement | null>(null);
  const liveStreamRef = useRef<HTMLDivElement | null>(null);
  const [pendingDispositionFor, setPendingDispositionFor] = useState<string | null>(null);
  const [narrationSpeak, setNarrationSpeak] = useState<boolean>(false);
  const [culturallySensitive, setCulturallySensitiveState] = useState<boolean>(false);

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
  useEffect(() => {
    setPosterior(getPosterior(siteSession.state, Date.now()));
  }, [siteSession.state, tick]);

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
    const last = lastEmissionTsRef.current.acoustic;
    if (last && now - last < 2000) return;
    lastEmissionTsRef.current.acoustic = now;
    const evidence = emitAcousticTransient({
      coherence: 0.7,
      subBandsAgreed: 3,
      sector: sectorReading?.sector ?? "REAR-C",
      sectorPersistedFromPrior: false,
      isFirstInWindow: true,
    });
    if (!evidence) return;
    void emitEvidence({ channel: evidence.channel, logLr: evidence.logLr, reason: `${evidence.reason} (vibration fallback)`, metadata: evidence.metadata, nowMs: now });
  }, [running, sensors.vibration?.alert, sectorReading, emitEvidence]);

  // Magnetometer anomaly: when EMF tile alerts.
  useEffect(() => {
    if (!running || !sensors.emf?.alert) return;
    const now = Date.now();
    const last = lastEmissionTsRef.current.magnetometer;
    if (last && now - last < 2000) return;
    lastEmissionTsRef.current.magnetometer = now;
    const evidence = emitMagnetometerAnomaly({
      zScore: sensors.emf.z,
      magnitudeMicrotesla: sensors.emf.value,
      baselineMicrotesla: sensors.emf.mean,
    });
    if (!evidence) return;
    void emitEvidence({ channel: evidence.channel, logLr: evidence.logLr, reason: evidence.reason, metadata: evidence.metadata, nowMs: now });

    // Coupling check: if acoustic fired within 200 ms of this magnetometer event, emit a coupling.
    const tA = lastEmissionTsRef.current.acoustic;
    if (tA && Math.abs(now - tA) <= 200) {
      const coupling = emitTemporalCoupling({ channels: ["acoustic", "magnetometer"], deltaMs: Math.abs(now - tA) });
      if (coupling) {
        void emitEvidence({ channel: coupling.channel, logLr: coupling.logLr, reason: coupling.reason, metadata: coupling.metadata, nowMs: now });
      }
    }
  }, [running, sensors.emf?.alert, sensors.emf?.z, sensors.emf?.value, sensors.emf?.mean, emitEvidence]);

  // ----- UI handlers -----

  const startLiveAnalyzer = useCallback(async () => {
    if (analyzerRef.current) return;
    const analyzer = new LiveAnalyzer({
      onSectorReading: (reading) => {
        sectorReadingRef.current = reading;
        setSectorReading(reading);
      },
      onLevel: (rms) => setAudioRms(rms),
      onAcousticTransient: (reading, _rms, _frameTs) => {
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
        // Cross-channel coupling check (acoustic + infrasound).
        const tA = lastEmissionTsRef.current.acoustic;
        if (tA && Math.abs(now - tA) <= 200) {
          const coupling = emitTemporalCoupling({ channels: ["acoustic", "infrasound"], deltaMs: Math.abs(now - tA) });
          if (coupling) {
            void emitEvidence({ channel: coupling.channel, logLr: coupling.logLr, reason: coupling.reason, metadata: coupling.metadata, nowMs: now });
          }
        }
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
      setCurrent(inv);
      await startInvestigation(inv.id);
      await recordEvent({ investigation_id: inv.id, source: "system", event_type: "session_start", title: "Session started" });
      setSiteSession(createSiteSession());
      setRunning(true);
      setStartedAt(Date.now());
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
      await stopLiveAnalyzer();
      await stopInvestigation(session.current.id);
      await recordEvent({ investigation_id: session.current.id, source: "system", event_type: "session_stop", title: "Session ended" });
      setRunning(false);
      setStartedAt(null);
      setPendingDispositionFor(session.current.id);
      setStatusMsg("Session stopped. Classify the disposition before reviewing.");
    } finally {
      setBusy(false);
    }
  }, [session.current, stopLiveAnalyzer]);

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

  const trustworthy = isInstrumentTrustworthy(calibration);
  // Prefer real audio RMS for the breath-line; fall back to vibration sensor when audio not running.
  const noiseFloor = Math.max(0.04, Math.min(0.6, audioRms > 0 ? audioRms * 4 : (sensors.vibration?.value ?? 0.05) / 4));

  return (
    <section className={s.view}>
      {!isPro && (
        <SimpleMissionView
          running={running}
          busy={busy}
          posterior={posterior}
          elapsedSeconds={elapsedSeconds}
          caseId={session.current?.id ?? null}
          caseTitle={session.current?.title ?? null}
          statusMsg={statusMsg}
          recentIncrements={siteSession.recentIncrements}
          trustworthy={trustworthy}
          hasInvestigation={!!session.current}
          investigationId={session.current?.id ?? null}
          audioRms={audioRms}
          sectorReading={sectorReading ? { sector: sectorReading.sector, coherence: sectorReading.coherence, trustworthy: sectorReading.trustworthy } : null}
          narratorCaption={narratorCaption}
          narratorSpeak={narrationSpeak}
          onToggleNarratorSpeak={setNarrationSpeak}
          onBegin={handleBegin}
          onStop={handleStop}
          onMarker={handleMarker}
          onAskQuestion={handleAskQuestion}
          onBroadcastLive={handleBroadcastLive}
          emitEvidence={emitEvidence}
        />
      )}

      {isPro && (
      /* INSTRUMENT CLUSTER */
      <div className={m.instrumentCluster}>
        <div className={m.heroRow}>
          <div className={m.hero}>
            <div className={m.heroTopRow}>
              <span className={`${m.recPill} ${running ? m.recPillActive : m.recPillIdle}`.trim()}>
                <span className={m.recPillDot} />
                <span>{running ? "RECORDING" : "STANDBY"}</span>
              </span>
              <ScreenRecordButton investigationId={session.current?.id ?? null} />
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

      {/* DISPOSITION PICKER — shown after a session stops, before review */}
      {pendingDispositionFor && (
        <DispositionPicker
          investigationId={pendingDispositionFor}
          onChosen={() => {
            setPendingDispositionFor(null);
            setStatusMsg("Disposition recorded. Review tab has the chain.");
          }}
        />
      )}

      {/* LIVE BROADCAST — camera + mic + sensor overlays composited; record + go live */}
      <div ref={liveStreamRef}>
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
            audioRms={audioRms}
            sector={sectorReading?.sector ?? null}
            coherence={sectorReading?.coherence ?? 0}
            caption={narratorCaption}
          />
        </details>
      )}

      {/* CAMERA — scene snapshots (Pro plain tile) */}
      {isPro && (
        <CameraCapture investigationId={session.current?.id ?? null} running={running} />
      )}

      {/* CONTAMINATION MARKERS — Pro grid (Simple mode uses an in-place sheet) */}
      {isPro && (
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

      {/* ITC TOOLS */}
      <SpiritBoxTool
        entropy={sensors.snapshot.magnetometer?.magnitude ?? sensors.snapshot.motion?.accelMagnitude ?? 0}
        investigationId={session.current?.id ?? null}
      />
      <OvilusTool entropy={sensors.snapshot.magnetometer?.magnitude ?? sensors.snapshot.orientation?.heading ?? 0} investigationId={session.current?.id ?? null} />

      {/* BAIT TOOLS — sub-audible carrier */}
      {isPro && <BaitToneTool investigationId={session.current?.id ?? null} />}

      {/* ESTES MODE — dual-phone sensory-deprivation rig */}
      {isPro && (
        <a href="/estes" className={m.estesTile}>
          <span className={m.estesEyebrow}>ESTES METHOD · DUAL-PHONE</span>
          <span className={m.estesTitle}>Pair two phones for a sensory-deprivation session</span>
          <span className={m.estesHint}>Receiver blacks out + spirit-box-cycles + streams mic. Questioner types questions, hears responses, watches a timestamped log. Open →</span>
        </a>
      )}

      {/* SENSOR INVENTORY — what this phone exposes */}
      <SensorsPanel />

      {isPro && (
        <p className={m.disclaimer}>
          Sector accuracy ±60°. Posterior is a model estimate, not a measurement of presence. Every increment is hash-chained — receipts in the audit log.
        </p>
      )}
    </section>
  );
}
