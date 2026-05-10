/**
 * Session baseline capture — establish a noise floor for the site before
 * accumulating evidence.
 *
 * Real paranormal field practice begins with a 5–10 minute "empty room"
 * recording. The posterior likelihood functions otherwise compare every
 * incoming reading against an implicit "default room" (a fixed prior of
 * 0.05) — a noisy HVAC plant and a quiet stone chapel get the same
 * treatment. Capturing a per-site baseline lets the LR computation, in a
 * follow-up PR, use the *deviation from this site's noise floor* instead
 * of a global one.
 *
 * V1 scope (what this module IS):
 * - Operator-driven sample collection (caller pushes audioRms +
 *   emfMagnitude readings at whatever cadence they have them).
 * - Mean / p95 / max summary statistics over the captured samples.
 * - localStorage round-trip per investigation id — no SQLite migration.
 *
 * V1 non-goals (what this module is NOT):
 * - It does NOT modify likelihoods.ts. The captured summary is
 *   informational for the operator in V1; the posterior LR pipeline
 *   stays untouched.
 * - It does NOT mandate a specific sampling cadence. The default capture
 *   target is 90 s; samples per second are whatever the caller can push.
 *
 * p95 uses the standard sorted-array index `floor(0.95 * (n-1))` so the
 * value returned is one of the actual observed samples (not an
 * interpolation). For small n this is the conservative choice — never
 * extrapolates.
 */

export type BaselineState = "idle" | "capturing" | "completed";

export interface BaselineSummary {
  audioRmsMean: number;
  audioRmsP95: number;
  audioRmsMax: number;
  emfMean: number;
  emfP95: number;
  emfMax: number;
  durationSeconds: number;
  sampleCount: number;
  /** ISO-8601 timestamp of the moment summarize() was called. */
  capturedAt: string;
}

export interface BaselineSample {
  /** Audio RMS in [0..1] from the existing MicLevelMeter (already amplified). */
  audioRms: number;
  /** Magnetometer magnitude in microteslas, or null if the sensor is unavailable on this device. */
  emfMagnitude: number | null;
}

export interface BaselineController {
  state(): BaselineState;
  /**
   * Begin a capture session. The optional `onSample` callback fires every
   * time a sample is pushed, useful for live UI updates.
   */
  start(opts?: { onSample?: (sample: BaselineSample, count: number) => void }): void;
  /** Push one sample into the running capture. No-op if not capturing. */
  pushSample(sample: BaselineSample): void;
  /** Stop accepting samples — does not erase what's been collected. */
  stop(): void;
  /** Compute the summary from captured samples. Throws if no samples were captured. */
  summarize(): BaselineSummary;
  /** Number of samples captured so far. */
  sampleCount(): number;
  /** Wall-clock duration of the capture in seconds (start → most recent sample). */
  durationSeconds(): number;
}

/**
 * Mean of a numeric array. Returns 0 for an empty array — callers should
 * also check sampleCount() before trusting summary values.
 */
function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += values[i];
  return sum / values.length;
}

/**
 * 95th percentile via sorted-array index. floor(0.95 * (n-1)) — for n=1
 * this returns index 0 (the only value), for n=20 it returns index 18.
 * Using floor (not round/ceil) is the conservative choice: it picks the
 * highest sample at or below the 95% mark, never above.
 */
function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor(0.95 * (sorted.length - 1));
  return sorted[idx];
}

function max(values: number[]): number {
  if (values.length === 0) return 0;
  let m = values[0];
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] > m) m = values[i];
  }
  return m;
}

export function createBaselineCapture(): BaselineController {
  let state: BaselineState = "idle";
  const audioRmsSamples: number[] = [];
  const emfSamples: number[] = [];
  let startedAtMs: number | null = null;
  let lastSampleAtMs: number | null = null;
  let onSample: ((sample: BaselineSample, count: number) => void) | undefined;

  return {
    state(): BaselineState {
      return state;
    },
    start(opts) {
      state = "capturing";
      audioRmsSamples.length = 0;
      emfSamples.length = 0;
      startedAtMs = Date.now();
      lastSampleAtMs = startedAtMs;
      onSample = opts?.onSample;
    },
    pushSample(sample) {
      if (state !== "capturing") return;
      audioRmsSamples.push(Math.max(0, sample.audioRms));
      if (sample.emfMagnitude != null && Number.isFinite(sample.emfMagnitude)) {
        emfSamples.push(Math.max(0, sample.emfMagnitude));
      }
      lastSampleAtMs = Date.now();
      onSample?.(sample, audioRmsSamples.length);
    },
    stop() {
      if (state === "capturing") state = "completed";
    },
    summarize(): BaselineSummary {
      if (audioRmsSamples.length === 0) {
        throw new Error("baseline: cannot summarize — no samples captured");
      }
      const durationSeconds = startedAtMs && lastSampleAtMs
        ? Math.max(0, (lastSampleAtMs - startedAtMs) / 1000)
        : 0;
      return {
        audioRmsMean: mean(audioRmsSamples),
        audioRmsP95: p95(audioRmsSamples),
        audioRmsMax: max(audioRmsSamples),
        emfMean: mean(emfSamples),
        emfP95: p95(emfSamples),
        emfMax: max(emfSamples),
        durationSeconds,
        sampleCount: audioRmsSamples.length,
        capturedAt: new Date().toISOString(),
      };
    },
    sampleCount(): number {
      return audioRmsSamples.length;
    },
    durationSeconds(): number {
      if (!startedAtMs || !lastSampleAtMs) return 0;
      return Math.max(0, (lastSampleAtMs - startedAtMs) / 1000);
    },
  };
}

const STORAGE_PREFIX = "ss-baseline-";

/** Build the localStorage key for a given investigation id. */
export function baselineStorageKey(investigationId: string): string {
  return `${STORAGE_PREFIX}${investigationId}`;
}

function readLocalStorage(): Storage | null {
  try {
    if (typeof globalThis === "undefined") return null;
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    return ls ?? null;
  } catch {
    return null;
  }
}

/**
 * Validate a parsed JSON blob is a BaselineSummary. Defensive against
 * stale/corrupt entries — better to return null and let the operator
 * re-capture than to surface garbage.
 */
function isBaselineSummary(value: unknown): value is BaselineSummary {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.audioRmsMean === "number" &&
    typeof v.audioRmsP95 === "number" &&
    typeof v.audioRmsMax === "number" &&
    typeof v.emfMean === "number" &&
    typeof v.emfP95 === "number" &&
    typeof v.emfMax === "number" &&
    typeof v.durationSeconds === "number" &&
    typeof v.sampleCount === "number" &&
    typeof v.capturedAt === "string"
  );
}

/**
 * Load a previously-captured baseline for this investigation. Returns
 * null if nothing has been stored, the entry is malformed, or the
 * runtime has no localStorage (SSR, private mode hostile to writes).
 */
export function loadBaseline(investigationId: string): BaselineSummary | null {
  if (!investigationId) return null;
  const ls = readLocalStorage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(baselineStorageKey(investigationId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isBaselineSummary(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Persist a baseline summary for this investigation. Silent no-op when
 * localStorage is unavailable — never crashes the caller.
 */
export function saveBaseline(investigationId: string, summary: BaselineSummary): void {
  if (!investigationId) return;
  const ls = readLocalStorage();
  if (!ls) return;
  try {
    ls.setItem(baselineStorageKey(investigationId), JSON.stringify(summary));
  } catch {
    /* swallow — quota exceeded, private mode, etc. Operator can re-capture. */
  }
}

/**
 * Erase any stored baseline for this investigation. Useful when the
 * operator wants to start fresh mid-session.
 */
export function clearBaseline(investigationId: string): void {
  if (!investigationId) return;
  const ls = readLocalStorage();
  if (!ls) return;
  try {
    ls.removeItem(baselineStorageKey(investigationId));
  } catch {
    /* swallow */
  }
}

/** Default duration the UI captures for. 90 seconds is the V1 target. */
export const BASELINE_DEFAULT_DURATION_SECONDS = 90;

/**
 * Patient-mode duration presets. Real paranormal field practice runs a
 * 5–10 minute "empty room" recording; the 90s quick mode is a condensed
 * version for impatient operators or noisy public sites where a longer
 * passive capture isn't feasible.
 */
export const BASELINE_DURATIONS_SECONDS = {
  quick: 90,
  standard: 300,
  patient: 600,
} as const;

export type BaselineDurationKey = keyof typeof BASELINE_DURATIONS_SECONDS;
