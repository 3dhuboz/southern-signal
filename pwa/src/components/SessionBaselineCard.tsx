/**
 * SessionBaselineCard — pre-session room-baseline capture.
 *
 * Real paranormal field practice begins with a 5–10 minute "empty room"
 * recording. We do a 90-second condensed version. The captured summary
 * (mean / p95 / max for audio RMS and EMF magnitude) is informational in
 * V1 — it gives the operator a per-site noise floor to eyeball against
 * incoming readings. A follow-up PR will feed it into the LR pipeline.
 *
 * Three states render distinct UI:
 *   1. idle + no stored baseline   → capture button + 1-line framing
 *   2. capturing                   → countdown + live RMS bar + sample count
 *   3. completed (or stored)       → small read-out card with summary
 *
 * Skippable. Operator can begin a session without baseline; the
 * downstream summary stays null and nothing breaks.
 */

import { useEffect, useRef, useState } from "react";
import {
  BASELINE_DURATIONS_SECONDS,
  type BaselineDurationKey,
  type BaselineState,
  type BaselineSummary,
  createBaselineCapture,
} from "../lib/posterior/sessionBaseline";
import s from "./SessionBaselineCard.module.css";

interface SessionBaselineCardProps {
  /** Investigation this baseline applies to. When null, the button calls
   *  `ensureInvestigation` on click (if supplied) so the operator can
   *  capture the baseline before formally beginning a session. */
  investigationId: string | null;
  /** Existing baseline (loaded from localStorage by the parent), or null. */
  baseline: BaselineSummary | null;
  /** Live audio RMS in [0..1] from MissionControl. */
  audioRms: number;
  /** Live EMF magnitude (microteslas), or null on devices without a magnetometer. */
  emfMagnitude: number | null;
  /** Hide the capture button when a session is already running. */
  sessionRunning: boolean;
  /** Called once with the finalized summary when capture completes. Persistence is the parent's job. */
  onComplete: (summary: BaselineSummary) => void;
  /**
   * Optional: provide an investigation to attach the baseline to, called
   * lazily when the operator taps capture without an active session.
   * Resolves to the investigation id. When omitted, the button stays
   * disabled until the parent supplies investigationId directly.
   */
  ensureInvestigation?: () => Promise<string>;
}

const SAMPLE_INTERVAL_MS = 200; // 5 Hz — comfortably inside the 4–8 Hz target

const DURATION_OPTIONS: { key: BaselineDurationKey; label: string; sub: string }[] = [
  { key: "quick",    label: "Quick · 90s",     sub: "Public sites, noisy rooms" },
  { key: "standard", label: "Standard · 5 min", sub: "Field practice default" },
  { key: "patient",  label: "Patient · 10 min", sub: "Forensic-grade silence" },
];

function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

/** Format remaining seconds: ≤90s as "Ns", longer as "M:SS" so a 10-min countdown reads naturally. */
function formatRemaining(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  if (t < 100) return `${t}s`;
  const mm = Math.floor(t / 60);
  const ss = (t % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

export function SessionBaselineCard(props: SessionBaselineCardProps) {
  const { investigationId, baseline, audioRms, emfMagnitude, sessionRunning, onComplete, ensureInvestigation } = props;

  const [captureState, setCaptureState] = useState<BaselineState>("idle");
  const [selectedDuration, setSelectedDuration] = useState<BaselineDurationKey>("quick");
  const [secondsRemaining, setSecondsRemaining] = useState<number>(BASELINE_DURATIONS_SECONDS.quick);
  const [sampleCount, setSampleCount] = useState<number>(0);
  const [liveRms, setLiveRms] = useState<number>(0);

  const controllerRef = useRef<ReturnType<typeof createBaselineCapture> | null>(null);
  const sampleTimerRef = useRef<number | null>(null);
  const countdownTimerRef = useRef<number | null>(null);
  // Keep the latest live readings in refs so the sample timer doesn't need to be
  // re-created every time audioRms / emfMagnitude updates (which would be every frame).
  const audioRmsRef = useRef<number>(audioRms);
  const emfRef = useRef<number | null>(emfMagnitude);

  useEffect(() => { audioRmsRef.current = audioRms; }, [audioRms]);
  useEffect(() => { emfRef.current = emfMagnitude; }, [emfMagnitude]);

  // Cleanup any timers if the component unmounts mid-capture.
  useEffect(() => {
    return () => {
      if (sampleTimerRef.current != null) window.clearInterval(sampleTimerRef.current);
      if (countdownTimerRef.current != null) window.clearInterval(countdownTimerRef.current);
      controllerRef.current?.stop();
    };
  }, []);

  const beginCapture = async () => {
    if (captureState === "capturing") return;
    // If the operator hasn't started a session yet, lazily create one so
    // the baseline has somewhere to attach. The parent supplies the
    // creator via `ensureInvestigation` so this component doesn't have
    // to know about DB plumbing.
    if (!investigationId && ensureInvestigation) {
      try { await ensureInvestigation(); }
      catch (err) { console.warn("[baseline] ensureInvestigation failed", err); return; }
    } else if (!investigationId) {
      return;
    }
    const controller = createBaselineCapture();
    controllerRef.current = controller;
    setSampleCount(0);
    setLiveRms(0);
    setSecondsRemaining(BASELINE_DURATIONS_SECONDS[selectedDuration]);
    controller.start({
      onSample: (_sample, count) => {
        setSampleCount(count);
        setLiveRms(audioRmsRef.current);
      },
    });
    setCaptureState("capturing");

    sampleTimerRef.current = window.setInterval(() => {
      controllerRef.current?.pushSample({
        audioRms: audioRmsRef.current,
        emfMagnitude: emfRef.current,
      });
    }, SAMPLE_INTERVAL_MS);

    countdownTimerRef.current = window.setInterval(() => {
      setSecondsRemaining((prev) => {
        if (prev <= 1) {
          finalizeCapture();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const finalizeCapture = () => {
    if (sampleTimerRef.current != null) {
      window.clearInterval(sampleTimerRef.current);
      sampleTimerRef.current = null;
    }
    if (countdownTimerRef.current != null) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    const controller = controllerRef.current;
    if (!controller) {
      setCaptureState("idle");
      return;
    }
    controller.stop();
    if (controller.sampleCount() === 0) {
      // Edge case — never received a sample (e.g. permission was revoked mid-capture).
      setCaptureState("idle");
      controllerRef.current = null;
      return;
    }
    const summary = controller.summarize();
    controllerRef.current = null;
    setCaptureState("completed");
    onComplete(summary);
  };

  const cancelCapture = () => {
    if (sampleTimerRef.current != null) {
      window.clearInterval(sampleTimerRef.current);
      sampleTimerRef.current = null;
    }
    if (countdownTimerRef.current != null) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    controllerRef.current?.stop();
    controllerRef.current = null;
    setCaptureState("idle");
    setSecondsRemaining(BASELINE_DURATIONS_SECONDS[selectedDuration]);
  };

  // Live RMS bar — clamp + slight amplification for visual range.
  const rmsPct = Math.min(100, Math.max(0, liveRms * 100));

  // Render the summary card if either we just completed OR a saved baseline exists.
  const summaryToShow = captureState === "completed" || baseline ? baseline : null;
  const showCapturing = captureState === "capturing";
  // Hide the capture button while capturing or once we have a baseline; also
  // keep it hidden during a live session so the operator can't kick off a
  // baseline mid-recording (would clobber the noise floor with real activity).
  const showCaptureButton = !showCapturing && !summaryToShow && !sessionRunning;

  return (
    <section className={s.wrap} aria-label="Room baseline capture">
      <header className={s.head}>
        <span className={s.eyebrow}>ROOM BASELINE</span>
        {summaryToShow && (
          <span className={s.headNote}>
            captured {formatTimestamp(summaryToShow.capturedAt)}
          </span>
        )}
      </header>

      {showCaptureButton && (
        <>
          <p className={s.framing}>
            Establishes a noise floor for this site so deviations have a reference point. Don't talk during the capture.
          </p>
          <div className={s.durationRow} role="radiogroup" aria-label="Baseline capture duration">
            {DURATION_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                role="radio"
                aria-checked={selectedDuration === opt.key}
                className={`${s.durationChip} ${selectedDuration === opt.key ? s.durationChipActive : ""}`.trim()}
                onClick={() => setSelectedDuration(opt.key)}
              >
                <span className={s.durationLabel}>{opt.label}</span>
                <span className={s.durationSub}>{opt.sub}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className={s.captureBtn}
            onClick={() => { void beginCapture(); }}
            disabled={!investigationId && !ensureInvestigation}
          >
            Capture room baseline ({DURATION_OPTIONS.find((o) => o.key === selectedDuration)?.label})
          </button>
          <p className={s.skipNote}>Optional. You can begin a session without it.</p>
        </>
      )}

      {showCapturing && (
        <div className={s.capturingBlock}>
          <div className={s.countdownRow}>
            <span className={s.countdown}>{formatRemaining(secondsRemaining)}</span>
            <span className={s.countdownLabel}>REMAINING</span>
          </div>
          <div className={s.rmsBarOuter} aria-hidden="true">
            <div className={s.rmsBarFill} style={{ width: `${rmsPct}%` }} />
          </div>
          <div className={s.metaRow}>
            <span className={s.metaItem}>Samples: <strong>{sampleCount}</strong></span>
            <span className={s.metaItem}>RMS: <strong>{formatNumber(liveRms, 3)}</strong></span>
          </div>
          <button type="button" className={s.cancelBtn} onClick={cancelCapture}>
            Cancel capture
          </button>
        </div>
      )}

      {summaryToShow && !showCapturing && (
        <div className={s.summaryGrid}>
          <div className={s.summaryCol}>
            <span className={s.colHead}>AUDIO RMS</span>
            <div className={s.statRow}>
              <span className={s.statLabel}>mean</span>
              <span className={s.statValue}>{formatNumber(summaryToShow.audioRmsMean, 3)}</span>
            </div>
            <div className={s.statRow}>
              <span className={s.statLabel}>p95</span>
              <span className={s.statValue}>{formatNumber(summaryToShow.audioRmsP95, 3)}</span>
            </div>
            <div className={s.statRow}>
              <span className={s.statLabel}>max</span>
              <span className={s.statValue}>{formatNumber(summaryToShow.audioRmsMax, 3)}</span>
            </div>
          </div>
          <div className={s.summaryCol}>
            <span className={s.colHead}>EMF (μT)</span>
            <div className={s.statRow}>
              <span className={s.statLabel}>mean</span>
              <span className={s.statValue}>{formatNumber(summaryToShow.emfMean, 1)}</span>
            </div>
            <div className={s.statRow}>
              <span className={s.statLabel}>p95</span>
              <span className={s.statValue}>{formatNumber(summaryToShow.emfP95, 1)}</span>
            </div>
            <div className={s.statRow}>
              <span className={s.statLabel}>max</span>
              <span className={s.statValue}>{formatNumber(summaryToShow.emfMax, 1)}</span>
            </div>
          </div>
          <div className={s.summaryFoot}>
            <span>{summaryToShow.sampleCount} samples</span>
            <span>·</span>
            <span>{Math.round(summaryToShow.durationSeconds)}s</span>
          </div>
        </div>
      )}
    </section>
  );
}
