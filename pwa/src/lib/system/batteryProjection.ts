/**
 * Time-to-zero projection — linear regression of recent samples to a
 * "minutes until value hits 0" estimate. Used by both:
 *
 *   - CameraScreen watchdog toast (battery → time-to-empty; storage → time-to-full)
 *   - Review spark headline (same two surfaces, expanded view)
 *
 * Why linear? Battery and storage curves both have non-linear regimes (the
 * battery cliff under 20%; storage fills slower as media compression takes
 * effect). Linear regression on the most recent samples is a "if the next
 * 10 minutes look like the last 10, you've got X minutes" estimate —
 * directional not predictive. Good enough to tell the operator "swap a
 * battery in the next 20 minutes" without pretending it's a real
 * time-of-death prediction.
 *
 * Refuses to project when:
 *   - slope is non-negative (flat or rising — the resource isn't depleting)
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

export interface ZeroProjection {
  /** Minutes until value reaches 0 at the current slope. */
  minutesToZero: number;
  /** Per-minute slope (negative when depleting). */
  slopePerMinute: number;
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
 * Domain-neutral — feeds both battery and storage projections.
 */
export function projectTimeToZero(samples: readonly { value: number; ts: string }[], now: number = Date.now()): ZeroProjection | null {
  if (samples.length < MIN_SAMPLES) return null;
  const last = samples[samples.length - 1];
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
  const slope = (sumXY - n * meanX * meanY) / denom; // value per second
  if (slope >= -1e-9) return null; // not depleting
  const intercept = meanY - slope * meanX; // value at t=0 (first sample)
  const lastT = points[points.length - 1].x;
  const fittedNow = intercept + slope * lastT;
  if (fittedNow <= 0) return null; // already at zero per the fit
  const secondsToZero = -fittedNow / slope;
  if (!Number.isFinite(secondsToZero) || secondsToZero <= 0) return null;
  const lastSampleAgeSec = Math.max(0, (now - Date.parse(last.ts)) / 1000);
  const minutesToZero = Math.max(0, (secondsToZero - lastSampleAgeSec) / 60);
  return {
    minutesToZero,
    slopePerMinute: slope * 60,
    sampleCount: n,
    windowMinutes: elapsedSec / 60,
  };
}

/**
 * Battery flavour — refuses additionally when the latest sample is
 * charging (cable plugged in invalidates discharge-rate semantics).
 */
export function projectTimeToEmpty(samples: readonly BatterySample[], now: number = Date.now()): BatteryProjection | null {
  if (samples.length === 0) return null;
  const last = samples[samples.length - 1];
  if (last.charging === true) return null;
  const proj = projectTimeToZero(samples, now);
  if (!proj) return null;
  return {
    minutesToEmpty: proj.minutesToZero,
    drainPerMinute: -proj.slopePerMinute,
    sampleCount: proj.sampleCount,
    windowMinutes: proj.windowMinutes,
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
