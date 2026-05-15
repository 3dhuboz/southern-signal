/**
 * Stereo / Multi-Channel Differential Analysis (Tier 3 #4).
 *
 * Provides two complementary spatial cues over a selected segment:
 *
 *   ITD — Inter-Aural Time Difference (µs precision, via cross-correlation).
 *         Positive ITD = right channel leads = source on the right.
 *
 *   ILD — Inter-Aural Level Difference (dB, via RMS power ratio).
 *         Positive ILD = left channel is louder = source on the left.
 *
 * For a physically consistent point source, ITD and ILD always have
 * OPPOSITE signs (right-leading ↔ right-louder). Same signs → conflict.
 *
 * Additionally flags ITD values that exceed the human-head physical maximum
 * (~0.65 ms), which may indicate heavy reverberation, unmatched microphone
 * latency, or an impossible source geometry.
 *
 * No external dependencies — runs synchronously in the React render cycle
 * on slices of up to XCORR_FRAMES samples.
 */

export interface StereoAnalysis {
  /** Inter-aural time difference in ms. Positive = right channel leads. */
  itdMs: number;
  /** Normalized cross-correlation peak, 0–1. Confidence in the ITD. */
  confidence: number;
  /** Inter-aural level difference in dB. Positive = left channel louder. */
  ildDb: number;
  /** True when ITD and ILD point in opposite directions. */
  conflictFlag: boolean;
  /**
   * True when |ITD| exceeds the human-head physical maximum (≈ 0.65 ms).
   * Suggests the estimate may be driven by reflections rather than a true
   * direct-path source, or that the stereo channels have unequal latency.
   */
  impossibleItd: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum physical ITD for the human head (interaural distance ~220 mm ÷ 340 m/s). */
const HEAD_MAX_ITD_MS = 0.65;

/** ITD values below this threshold are treated as "effectively centre". */
const ITD_NOISE_MS = 0.05;

/** ILD values below this threshold are treated as "effectively equal". */
const ILD_NOISE_DB = 0.5;

/**
 * Maximum number of frames used for cross-correlation.
 * At 48 kHz, 8 192 frames ≈ 170 ms — long enough for stable estimation,
 * short enough to stay well under 5 ms of JS time.
 */
const XCORR_FRAMES = 8192;

// ── ITD estimation ────────────────────────────────────────────────────────────

/**
 * Estimate inter-aural time difference via normalized cross-correlation.
 *
 * Uses up to XCORR_FRAMES samples from the start of each slice.
 * Search range: ±maxLagMs (default 2 ms).
 *
 * Sign: positive lag = right leads = source on the right.
 */
function estimateItd(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  maxLagMs = 2.0,
): { itdMs: number; confidence: number } {
  const n = Math.min(left.length, right.length, XCORR_FRAMES);
  const maxLag = Math.ceil((maxLagMs / 1000) * sampleRate);

  // Energy norms at lag 0 for normalization.
  let autoL = 0, autoR = 0;
  for (let i = 0; i < n; i++) {
    autoL += left[i] * left[i];
    autoR += right[i] * right[i];
  }
  const denom = Math.sqrt(autoL * autoR);
  if (denom < 1e-12) return { itdMs: 0, confidence: 0 };

  // Brute-force normalized cross-correlation over ±maxLag.
  // For lag ≥ 0: right is shifted forward by `lag` (right leads).
  // For lag < 0: left is shifted forward by `-lag` (left leads).
  let bestLag = 0, bestCorr = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const lo = lag < 0 ? -lag : 0;
    const hi = lag < 0 ? n : n - lag;
    let sum = 0;
    for (let i = lo; i < hi; i++) sum += left[i] * right[i + lag];
    const r = sum / denom;
    if (r > bestCorr) { bestCorr = r; bestLag = lag; }
  }

  return {
    itdMs: (bestLag / sampleRate) * 1000,
    confidence: Math.max(0, Math.min(1, bestCorr)),
  };
}

// ── ILD computation ───────────────────────────────────────────────────────────

/**
 * Compute inter-aural level difference via RMS power ratio.
 * Returns dB: positive = left louder.
 */
function computeIld(left: Float32Array, right: Float32Array): number {
  let sumL = 0, sumR = 0;
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i++) {
    sumL += left[i] * left[i];
    sumR += right[i] * right[i];
  }
  if (sumR < 1e-20) return sumL > 1e-20 ? 60 : 0;
  if (sumL < 1e-20) return -60;
  return 10 * Math.log10(sumL / sumR);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the full stereo differential analysis on a segment.
 *
 * @param left        Left-channel samples (full recording).
 * @param right       Right-channel samples (full recording).
 * @param sampleRate  Sample rate in Hz.
 * @param startFrame  First frame of the selection (inclusive).
 * @param endFrame    Last frame of the selection (exclusive).
 */
export function analyzeStereoSegment(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  startFrame: number,
  endFrame: number,
): StereoAnalysis {
  const sliceL = left.slice(startFrame, endFrame);
  const sliceR = right.slice(startFrame, endFrame);

  const { itdMs, confidence } = estimateItd(sliceL, sliceR, sampleRate);
  const ildDb = computeIld(sliceL, sliceR);

  // A consistent point source has ITD and ILD with OPPOSITE signs
  // (right-leading ↔ right-louder → itdMs > 0 but ildDb < 0).
  // Matching signs → direction conflict.
  const itdSignificant = Math.abs(itdMs) > ITD_NOISE_MS;
  const ildSignificant = Math.abs(ildDb) > ILD_NOISE_DB;
  const conflictFlag = itdSignificant && ildSignificant && Math.sign(itdMs) === Math.sign(ildDb);

  return {
    itdMs,
    confidence,
    ildDb,
    conflictFlag,
    impossibleItd: Math.abs(itdMs) > HEAD_MAX_ITD_MS,
  };
}
