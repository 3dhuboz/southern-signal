/**
 * BroadcastAudioMeter — vertical peak/VU meter under the BroadcastBug.
 *
 * Drop-in replacement for the naked mic-meter pill the camera shipped with.
 * Renders a broadcast-grade strip: green→amber→red gradient, tick marks at
 * -60/-30/-18/-12/-6/-3/0 dBFS, a peak-hold cap that decays slowly, and a
 * numerical dB readout in monospace. Glass shell matches the BroadcastBug
 * exactly so the chrome reads as one composed system.
 *
 * Source-of-truth split: the parent (CameraScreen) owns the LiveAnalyzer
 * subscription and already updates a 0..1 audioRms ref at ~94 Hz. This
 * component receives a polled coarse value (~5 Hz) via state for the bar
 * fill, then derives peak-hold from local history. Decoupling avoids a
 * React render per audio tick AND keeps the meter presentation-only.
 *
 * Peak-hold semantics: the cap sticks at the highest observed level for
 * PEAK_HOLD_MS, then linearly fades to the current level over PEAK_DECAY_MS.
 * Matches the convention on any OB audio console — the cap is what tells
 * the engineer they nearly clipped.
 *
 * dB conversion: input is linear amplitude 0..1, mapped via 20 * log10(rms)
 * and clamped to [-60, 0] dBFS. We display the proper Unicode minus (U+2212)
 * not the hyphen so the readout typesets like a console scale, not a list.
 */
import { useEffect, useRef, useState } from "react";
import s from "./BroadcastAudioMeter.module.css";

interface Props {
  /** Linear amplitude 0..1. CameraScreen feeds this from audioRmsCoarse. */
  rms: number;
  /** True when VAD detects voice — rim glows cyan so the operator sees the
   *  auto-duck fired without watching the ITC tones. */
  vadActive?: boolean;
}

/** dB range we display on the bar. Below MIN_DB the bar is empty (silent
 *  floor); above MAX_DB the cap pins at red. Matches typical broadcast
 *  meter ballistics where the visible range is -60 to 0 dBFS. */
const MIN_DB = -60;
const MAX_DB = 0;

/** Tick marks rendered alongside the gradient. -3/-6/-12/-18 are the
 *  reference points an engineer uses to read level at a glance; -30/-60
 *  give the floor context. */
const TICKS_DB = [0, -3, -6, -12, -18, -30, -60] as const;

/** Peak-hold ballistics. 800 ms hold then 1 s linear decay — long enough
 *  to register a transient, short enough not to lie about steady level. */
const PEAK_HOLD_MS = 800;
const PEAK_DECAY_MS = 1000;

/** Map an RMS amplitude in [0, 1] to dBFS in [MIN_DB, MAX_DB]. Below the
 *  floor we report MIN_DB (the meter shows an empty bar + "−60.0"). */
function rmsToDb(rms: number): number {
  const clamped = Math.max(0, Math.min(1, rms));
  if (clamped <= 0) return MIN_DB;
  const db = 20 * Math.log10(clamped);
  if (!Number.isFinite(db) || db < MIN_DB) return MIN_DB;
  if (db > MAX_DB) return MAX_DB;
  return db;
}

/** Format the dB readout. Always shows one decimal so the column doesn't
 *  jump from "−6" to "−6.0" — tabular-nums keeps the width stable too.
 *  Uses Unicode minus (U+2212) instead of hyphen-minus for typography. */
function fmtDb(db: number): string {
  const fixed = db.toFixed(1);
  // 0 and positive values: just the number with a leading space for alignment.
  if (fixed.startsWith("-")) return `−${fixed.slice(1)}`;
  return ` ${fixed}`;
}

/** Map a dB value to the meter's 0..100 % vertical scale (bottom = MIN_DB,
 *  top = MAX_DB). Linear in dB so equal pixel distances mean equal dB
 *  changes — that's the readability contract of a broadcast meter. */
function dbToPercent(db: number): number {
  const clamped = Math.max(MIN_DB, Math.min(MAX_DB, db));
  return ((clamped - MIN_DB) / (MAX_DB - MIN_DB)) * 100;
}

export function BroadcastAudioMeter({ rms, vadActive = false }: Props) {
  const db = rmsToDb(rms);
  const fillPct = dbToPercent(db);

  // Peak-hold cap state. Tracked in state so the .peakHold element can
  // animate `bottom` via CSS transition; we update it from a setInterval
  // that runs at 12 Hz (cheap and smooth enough for a UI element).
  const [peakDb, setPeakDb] = useState<number>(MIN_DB);
  const peakSetAtRef = useRef<number>(0);
  // Mirror the live db value into a ref so the interval reads current
  // input without a dep churn on every render.
  const dbRef = useRef<number>(db);
  dbRef.current = db;

  useEffect(() => {
    let raf: number | null = null;
    let last = 0;
    const tick = (t: number) => {
      // Throttle to ~12 Hz to avoid burning frames on a near-stationary cap.
      if (t - last >= 80) {
        last = t;
        const now = performance.now();
        const live = dbRef.current;
        setPeakDb((prev) => {
          if (live >= prev) {
            // New peak. Reset hold timer.
            peakSetAtRef.current = now;
            return live;
          }
          const elapsed = now - peakSetAtRef.current;
          if (elapsed <= PEAK_HOLD_MS) return prev;
          // Linear decay over PEAK_DECAY_MS toward the current live level.
          const decayElapsed = elapsed - PEAK_HOLD_MS;
          if (decayElapsed >= PEAK_DECAY_MS) return live;
          const k = decayElapsed / PEAK_DECAY_MS;
          return prev + (live - prev) * k;
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, []);

  const peakPct = dbToPercent(peakDb);
  // Hide the cap when it's collapsed back onto the live fill — keeps the
  // visual quiet during silence and during slow-decaying tails.
  const peakHidden = peakDb <= MIN_DB + 0.5 || peakPct <= fillPct + 0.5;

  // A11y: the gradient is purely visual; a screen reader needs the level
  // spoken out. We render an aria-label on the root with the current dBFS
  // value rounded for human readability, and mark the bar+tick chrome
  // aria-hidden so the announcement is the level, not a wall of tick
  // strings. The text readout below the bar stays visible to sighted
  // users — only the chrome is hidden from the AT.
  const ariaLevel = Math.round(db);
  const vadSuffix = vadActive ? ", voice activity detected" : "";
  return (
    <div
      className={`${s.meter} ${vadActive ? s.active : ""}`.trim()}
      data-hud-drag-target="mic"
      role="meter"
      aria-label={`Microphone level: ${ariaLevel} dBFS${vadSuffix}`}
      aria-valuemin={MIN_DB}
      aria-valuemax={MAX_DB}
      aria-valuenow={ariaLevel}
    >
      <span className={s.label} aria-hidden="true">{vadActive ? "MIC · LIVE" : "MIC"}</span>
      <div className={s.barRow} aria-hidden="true">
        <div className={s.barTrack}>
          {/* Gradient fill — anchored to the bottom; height is the live dB
              percentage. CSS handles the green→amber→red mapping. */}
          <span
            className={s.barFill}
            style={{ transform: `scaleY(${fillPct / 100})` }}
          />
          {/* Peak-hold cap — absolute-positioned 1px line at the recent peak. */}
          <span
            className={`${s.peakHold} ${peakHidden ? s.peakHoldHidden : ""}`.trim()}
            style={{ bottom: `${peakPct}%` }}
          />
        </div>
        <div className={s.ticks}>
          {TICKS_DB.map((tdb) => (
            <span
              key={tdb}
              className={`${s.tick} ${tdb === 0 ? s.tick0 : ""}`.trim()}
              style={{ bottom: `${dbToPercent(tdb)}%` }}
            >
              <span className={s.tickMark} />
              <span>{tdb === 0 ? "0" : `−${Math.abs(tdb)}`}</span>
            </span>
          ))}
        </div>
      </div>
      <span className={s.value} aria-hidden="true">
        <span>{fmtDb(db)}</span>
        <span className={s.valueUnit}>dBFS</span>
      </span>
    </div>
  );
}
