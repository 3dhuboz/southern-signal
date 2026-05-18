/**
 * Battery time-to-empty projection — linear regression of recent battery
 * samples to a "minutes until 0%" estimate. Surfaces in:
 *
 *   - CameraScreen watchdog toast (when battery is the failing check)
 *   - Review spark headline (when tone === "battery")
 *
 * Why linear? The phone's battery curve is famously non-linear at the
 * extremes (above 80% it's roughly linear, then it falls off a cliff under
 * 20%). Linear regression on the most recent samples is a "if the next 10
 * minutes look like the last 10, you've got X minutes" estimate — directional
 * not predictive. Good enough to tell the operator "swap a battery in the
 * next 20 minutes" without pretending it's a real time-of-death prediction.
 *
 * Refuses to project when:
 *   - charging (slope is up; "time to empty" is undefined)
 *   - slope is non-negative (flat or rising — battery's holding steady)
 *   - fewer than 3 samples (insufficient data)
 *   - elapsed window < 90 seconds (too short to average out noise)
 */

export interface BatterySample {
  /** Charge level, 0..1. */
  value: number;
  /** ISO timestamp. */
  ts: string;
  /** True iff `getBattery().charging` was true at sample time. */
  charging?: boolean;
}

export interface BatteryProjection {
  /** Minutes until level reaches 0 at the current discharge slope. */
  minutesToEmpty: number;
  /** Per-minute drain rate as a fraction of full charge (e.g. 0.012 = 1.2%/min). */
  drainPerMinute: number;
  /** Number of samples that went into the fit. */
  sampleCount: number;
  /** Wall-clock span the fit covered, in minutes. */
  windowMinutes: number;
}

const MIN_SAMPLES = 3;
const MIN_WINDOW_SECONDS = 90;

/**
 * Run a linear least-squares fit on `value ~ t (seconds)` and project
 * forward to value=0. Returns null when refusing to project (see header
 * comment for why).
 *
 * Accepts an optional `now` (defaults to Date.now()) so tests can pin time.
 */
export function projectTimeToEmpty(samples: readonly BatterySample[], now: number = Date.now()): BatteryProjection | null {
  if (samples.length < MIN_SAMPLES) return null;
  // Refuse if the most recent sample is charging — discharge slope is
  // physically meaningless when the cable is plugged in.
  const last = samples[samples.length - 1];
  if (last.charging === true) return null;

  // Convert timestamps to seconds-from-first-sample so the regression
  // doesn't lose precision on huge wall-clock numbers.
  const firstMs = Date.parse(samples[0].ts);
  if (!Number.isFinite(firstMs)) return null;
  const points: { x: number; y: number }[] = [];
  for (const s of samples) {
    const ms = Date.parse(s.ts);
    if (!Number.isFinite(ms)) continue;
    points.push({ x: (ms - firstMs) / 1000, y: s.value });
  }
  if (points.length < MIN_SAMPLES) return null;
  const elapsedSec = points[points.length - 1].x - points[0].x;
  if (elapsedSec < MIN_WINDOW_SECONDS) return null;

  // Least-squares slope.
  const n = points.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumX2 += p.x * p.x;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  const denom = sumX2 - n * meanX * meanX;
  if (Math.abs(denom) < 1e-9) return null;
  const slope = (sumXY - n * meanX * meanY) / denom; // fraction per second
  if (slope >= -1e-9) return null; // not draining
  const intercept = meanY - slope * meanX; // fraction at t=0 (first sample)
  const lastT = points[points.length - 1].x;
  // Project from "now" (i.e. the latest fitted value) to y=0 along the
  // fitted line. fittedNow = intercept + slope * lastT.
  const fittedNow = intercept + slope * lastT;
  if (fittedNow <= 0) return null; // already empty per the fit; nothing to project
  const secondsToEmpty = -fittedNow / slope;
  if (!Number.isFinite(secondsToEmpty) || secondsToEmpty <= 0) return null;
  // Account for time elapsed since the last sample arrived — a 5-minute-old
  // sample shouldn't project as if it just landed.
  const lastSampleAgeSec = Math.max(0, (now - Date.parse(last.ts)) / 1000);
  const minutesToEmpty = Math.max(0, (secondsToEmpty - lastSampleAgeSec) / 60);
  return {
    minutesToEmpty,
    drainPerMinute: -slope * 60,
    sampleCount: n,
    windowMinutes: elapsedSec / 60,
  };
}

/**
 * Compact human-readable formatter — "12 min", "1 h 24 min", or "<1 min".
 * Used by the watchdog toast and the spark headline; both want a short
 * label rather than a 3-digit decimal.
 */
export function formatTimeToEmpty(minutes: number): string {
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes - h * 60);
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}
