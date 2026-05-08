/**
 * Acoustic Sector Indicator (ASI) — SRP-PHAT with sub-band coherence mask.
 *
 * Replaces the original "Bearing 217°" claim, which the physics panel
 * killed because:
 *   - iPhone 14 mic baseline ~146 mm caps theoretical ITD at ~426 µs
 *   - Pixel 8 has only ~10–15 mm of acoustically usable separation
 *   - In RT60 ≥ 0.8 s, raw GCC-PHAT locks onto the strongest specular
 *     reflection, not the source
 *
 * Mitigations adopted from the DSP critique:
 *   - Output is 6 sectors (60° each), NOT degrees
 *   - Cross-correlation gated by Magnitude-Squared Coherence (MSC)
 *     across 1/3-octave sub-bands; require MSC > 0.7 in ≥ 3 non-adjacent
 *     bands before reporting a sector
 *   - Below the gate: sector reads "—", coherence dot dark
 *   - σ values are NEVER produced
 *
 * Calibration is mandatory before ASI readings are trusted — see
 * lib/audio/calibration.ts.
 */

export type Sector = "FRONT-L" | "FRONT-C" | "FRONT-R" | "REAR-L" | "REAR-C" | "REAR-R" | null;

export interface SectorReading {
  sector: Sector;
  coherence: number; // mean MSC across passing bands, 0..1
  passingBands: number;
  itdMs: number; // signed ITD; sign convention: positive = R lead
  /** True if the reading passed the coherence gate. */
  trustworthy: boolean;
}

const SECTOR_LABELS: Sector[] = ["FRONT-L", "FRONT-C", "FRONT-R", "REAR-L", "REAR-C", "REAR-R"];

/** Default 1/3-octave centre frequencies — Hz — covering speech band. */
const DEFAULT_BANDS: { low: number; high: number; centre: number }[] = [
  { low: 250, high: 315, centre: 281 },
  { low: 315, high: 400, centre: 354 },
  { low: 400, high: 500, centre: 447 },
  { low: 500, high: 630, centre: 562 },
  { low: 630, high: 800, centre: 707 },
  { low: 800, high: 1000, centre: 891 },
  { low: 1000, high: 1250, centre: 1122 },
  { low: 1250, high: 1600, centre: 1414 },
];

const COHERENCE_THRESHOLD = 0.7;
const REQUIRED_PASSING_BANDS = 3;
const REQUIRE_NON_ADJACENT_BANDS = true;

/**
 * Map a signed ITD (in seconds) and front/back hint to one of 6 sectors.
 * Without a true second axis, front/back is ambiguous on a linear array;
 * caller may supply `frontProbability` from a higher-band shadowing
 * heuristic (energy in the directional band reaching the rear mic).
 */
export function quantizeSector(itdSeconds: number, micSpacingMm: number, frontProbability = 0.5): Sector {
  // Speed of sound 343 m/s. Maximum ITD = micSpacingMm/1000 / 343.
  const maxItd = micSpacingMm / 1000 / 343;
  if (Math.abs(itdSeconds) > maxItd * 1.05) return null; // out-of-range = noise, not bearing
  // Normalise to [-1, 1] across the full physical range.
  const norm = Math.max(-1, Math.min(1, itdSeconds / maxItd));
  // L/C/R quantization on the lateral axis.
  let lateral: "L" | "C" | "R";
  if (norm < -0.33) lateral = "L";
  else if (norm > 0.33) lateral = "R";
  else lateral = "C";
  // Front/back from caller's hint.
  const facing = frontProbability >= 0.5 ? "FRONT" : "REAR";
  return `${facing}-${lateral}` as Sector;
}

export interface FrameResult {
  /** ITD estimate per band in seconds (NaN where the band failed). */
  itdPerBand: number[];
  /** MSC per band 0..1. */
  cohPerBand: number[];
}

/**
 * Process one stereo frame and return per-band ITD + MSC. Pure function;
 * caller is responsible for FFT etc. — this consumes already-transformed
 * complex spectra. Implementation-light because the production version
 * uses a hand-rolled radix-2 FFT in lib/audio/fft.ts (forthcoming).
 *
 * For the V1 dress-rehearsal flow we expose this API surface so callers
 * can wire it once the FFT lands; tests construct synthetic spectra to
 * verify the gating logic.
 */
export function processFrame(opts: {
  /** Per-band cross-spectrum (left × conj(right)) sampled at the band centre. */
  perBandCross: { real: number; imag: number }[];
  /** Per-band auto-spectrum magnitudes for left and right. */
  perBandLeftPower: number[];
  perBandRightPower: number[];
  /** Sample rate for converting phase to ITD. */
  sampleRate: number;
  /** Optional band table override. */
  bands?: { low: number; high: number; centre: number }[];
}): FrameResult {
  const bands = opts.bands ?? DEFAULT_BANDS;
  const itdPerBand: number[] = [];
  const cohPerBand: number[] = [];
  for (let i = 0; i < bands.length; i++) {
    const { centre } = bands[i];
    const c = opts.perBandCross[i];
    const lP = opts.perBandLeftPower[i] ?? 0;
    const rP = opts.perBandRightPower[i] ?? 0;
    const denom = Math.max(1e-30, lP * rP);
    const crossMag2 = c.real * c.real + c.imag * c.imag;
    const msc = Math.min(1, crossMag2 / denom);
    cohPerBand.push(msc);
    if (msc < COHERENCE_THRESHOLD) {
      itdPerBand.push(NaN);
      continue;
    }
    // Phase delay → ITD: tau = -phase / (2 pi f)
    const phase = Math.atan2(c.imag, c.real);
    const itdSeconds = -phase / (2 * Math.PI * centre);
    itdPerBand.push(itdSeconds);
  }
  return { itdPerBand, cohPerBand };
}

/** Aggregate per-band results into a single sector reading. */
export function aggregateSector(opts: {
  frame: FrameResult;
  micSpacingMm: number;
  frontProbability?: number;
}): SectorReading {
  const passingIndices: number[] = [];
  for (let i = 0; i < opts.frame.cohPerBand.length; i++) {
    if (opts.frame.cohPerBand[i] >= COHERENCE_THRESHOLD && Number.isFinite(opts.frame.itdPerBand[i])) {
      passingIndices.push(i);
    }
  }
  const passingBands = passingIndices.length;
  if (passingBands < REQUIRED_PASSING_BANDS) {
    return { sector: null, coherence: 0, passingBands, itdMs: 0, trustworthy: false };
  }
  if (REQUIRE_NON_ADJACENT_BANDS) {
    const nonAdjacent = countNonAdjacent(passingIndices);
    if (nonAdjacent < REQUIRED_PASSING_BANDS) {
      return { sector: null, coherence: 0, passingBands, itdMs: 0, trustworthy: false };
    }
  }
  // Median ITD across passing bands — robust to a single bad outlier.
  const sortedItds = passingIndices.map((i) => opts.frame.itdPerBand[i]).sort((a, b) => a - b);
  const median = sortedItds[Math.floor(sortedItds.length / 2)];
  const meanCoh = passingIndices.reduce((s, i) => s + opts.frame.cohPerBand[i], 0) / passingIndices.length;
  const sector = quantizeSector(median, opts.micSpacingMm, opts.frontProbability ?? 0.5);
  return {
    sector,
    coherence: meanCoh,
    passingBands,
    itdMs: median * 1000,
    trustworthy: sector !== null,
  };
}

function countNonAdjacent(indices: number[]): number {
  // Greedy: keep an index if it's at least 2 away from the last kept.
  if (indices.length === 0) return 0;
  let kept = 1;
  let last = indices[0];
  for (let k = 1; k < indices.length; k++) {
    if (indices[k] - last >= 2) {
      kept += 1;
      last = indices[k];
    }
  }
  return kept;
}

export const ASI_CONSTANTS = {
  COHERENCE_THRESHOLD,
  REQUIRED_PASSING_BANDS,
  REQUIRE_NON_ADJACENT_BANDS,
  SECTOR_LABELS,
  DEFAULT_BANDS,
};
