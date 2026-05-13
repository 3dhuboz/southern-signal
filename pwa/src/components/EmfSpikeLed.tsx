/**
 * EmfSpikeLed — 5-LED K-II-style indicator driven by the magnetometer's
 * live z-score.
 *
 * Physical K-II meters cycle through 5 LEDs (green → green → yellow →
 * orange → red) at fixed milligauss thresholds. We use the z-score from
 * the streaming anomaly detector instead of an absolute reading, so the
 * trip thresholds adapt to whatever the local noise floor is: a building
 * with constant 80 µT field doesn't keep the bar pinned red.
 *
 * Mapping (absolute z-score):
 *   |z| < 1.0   → 0 LEDs (calm)
 *   |z| < 2.0   → 1 LED  (green)
 *   |z| < 3.0   → 2 LEDs (g, g)
 *   |z| < 4.5   → 3 LEDs (g, g, yellow)
 *   |z| < 6.0   → 4 LEDs (g, g, y, orange)
 *   |z| ≥ 6.0   → 5 LEDs (g, g, y, o, red) — flagged anomaly
 *
 * Optional clack sound on transitions to a higher LED count, so the
 * operator hears spikes even when the screen is off-axis. Uses the
 * WebAudio API; falls back silently if AudioContext is gated.
 */

import { useEffect, useRef } from "react";
import s from "./EmfSpikeLed.module.css";

interface Props {
  /** Magnetometer z-score (running mean / stdev) from useSensors. */
  z: number | null | undefined;
  /** Magnitude in microteslas — rendered as the readout. */
  magnitude: number | null | undefined;
  /** Only animate when a session is running. */
  running: boolean;
  /** Play a short clack on LED-count rise. Default false. */
  audible?: boolean;
}

const LED_COUNT = 5;
const LED_TIERS: ("green" | "yellow" | "orange" | "red")[] = [
  "green",
  "green",
  "yellow",
  "orange",
  "red",
];
const Z_THRESHOLDS = [1.0, 2.0, 3.0, 4.5, 6.0];

function ledsForZ(z: number): number {
  const az = Math.abs(z);
  let count = 0;
  for (const t of Z_THRESHOLDS) if (az >= t) count += 1;
  return count;
}

function formatMagnitude(mag: number | null | undefined): string {
  if (mag == null || !Number.isFinite(mag)) return "—";
  return `${mag.toFixed(1)} µT`;
}

function formatZ(z: number | null | undefined): string {
  if (z == null || !Number.isFinite(z)) return "—";
  const sign = z >= 0 ? "+" : "";
  return `${sign}${z.toFixed(1)}σ`;
}

export function EmfSpikeLed({ z, magnitude, running, audible = false }: Props) {
  const activeCount = running ? ledsForZ(z ?? 0) : 0;
  const prevCountRef = useRef(0);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    // Clack on LED-count rise (never on fall — avoids constant chirping
    // when readings settle back to baseline).
    if (!audible || !running) {
      prevCountRef.current = activeCount;
      return;
    }
    if (activeCount > prevCountRef.current && activeCount >= 3) {
      try {
        if (!audioCtxRef.current) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const Ctor = (window.AudioContext ?? (window as any).webkitAudioContext) as typeof AudioContext | undefined;
          if (Ctor) audioCtxRef.current = new Ctor();
        }
        const ctx = audioCtxRef.current;
        if (ctx) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "square";
          osc.frequency.value = activeCount >= 5 ? 1200 : activeCount >= 4 ? 900 : 660;
          gain.gain.setValueAtTime(0.0001, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.005);
          gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.07);
          osc.connect(gain).connect(ctx.destination);
          osc.start(ctx.currentTime);
          osc.stop(ctx.currentTime + 0.08);
        }
      } catch {
        /* audio gated or unsupported — just no clack */
      }
    }
    prevCountRef.current = activeCount;
  }, [activeCount, audible, running]);

  return (
    <section className={s.wrap} aria-label="EMF spike indicator">
      <header className={s.head}>
        <span className={s.eyebrow}>EMF · K-II</span>
        <span className={s.headStats}>
          <span className={s.statMag}>{formatMagnitude(magnitude)}</span>
          <span className={s.statSep}>·</span>
          <span className={s.statZ}>{formatZ(z)}</span>
        </span>
      </header>
      <div className={s.ledRow} role="img" aria-label={`${activeCount} of 5 LEDs lit`}>
        {Array.from({ length: LED_COUNT }, (_, i) => (
          <span
            key={i}
            className={`${s.led} ${i < activeCount ? s.ledOn : ""} ${s[`tier_${LED_TIERS[i]}`]}`}
          />
        ))}
      </div>
      <p className={s.caption}>
        {!running
          ? "Idle. Begin a session to arm the meter."
          : activeCount === 0
          ? "Field stable."
          : activeCount < 3
          ? "Mild deviation from baseline."
          : activeCount < 5
          ? "Significant deviation — note the time."
          : "Anomalous spike — full red, audit-logged."}
      </p>
    </section>
  );
}
