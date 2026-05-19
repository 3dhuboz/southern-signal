/**
 * Rolling-baseline anomaly detector — used by EMF, vibration, light, etc.
 *
 * Maintains an exponentially-weighted moving mean and stddev. Returns a
 * z-score per sample; callers threshold (typically z > 3 sustained for
 * >= 200 ms) to fire markers.
 *
 * Self-tuning: caller can `reset()` when entering a new room or after a
 * known disturbance.
 *
 * Math references:
 *   - Welford, B. P. (1962). "Note on a method for calculating corrected
 *     sums of squares and products." Technometrics, 4(3): 419-420.
 *   - West, D. H. D. (1979). "Updating mean and variance estimates: an
 *     improved method." CACM, 22(9): 532-535.
 *   - Finch, T. (2009). "Incremental calculation of weighted mean and
 *     variance." University of Cambridge Computing Service note.
 *     https://fanf2.user.srcf.net/hermes/doc/antiforgery/stats.pdf
 *
 * Two-phase recurrence:
 *
 *   GROWTH phase (count < windowSize): canonical Welford (1962).
 *     n_{k}   = n_{k-1} + 1
 *     μ_{k}   = μ_{k-1} + (x_k - μ_{k-1}) / n_{k}
 *     M2_{k}  = M2_{k-1} + (x_k - μ_{k-1}) * (x_k - μ_{k})
 *     var^   = M2 / (n - 1)            [Bessel-corrected, unbiased]
 *
 *   STEADY-STATE phase (count = windowSize): EWMA with α = 1/n, applied
 *   such that stdev = sqrt(M2 / (n-1)) is consistent with the standard
 *   EWMA-variance estimator (RiskMetrics / pandas `ewm.var()`):
 *     var_new = (1 - α) * var_old + α * (x - μ_old) * (x - μ_new)
 *
 *   Multiplied through by (n-1) so M2 stays scaled the same as in the
 *   growth phase:
 *     M2_new = (1 - α) * M2_old
 *            + α * (x - μ_old) * (x - μ_new) * (windowSize - 1)
 *
 *   Panel P1 fix (2026-05-19): the multiplier MUST be (windowSize - 1),
 *   not windowSize. Pre-fix code used `windowSize`, which inflated M2 by
 *   a factor of n/(n-1) per sample at steady state — producing a stdev
 *   ~sqrt(n/(n-1)) too high. For the n=60 light baseline that's a ~0.83%
 *   bias on stdev; for n=300 EMF it's ~0.17%. Compound effect: z-scores
 *   at steady state ran ~0.83% / 0.17% LOW, very slightly masking
 *   borderline anomalies. Pre-air reviewers would flag the inconsistency
 *   with the growth-phase estimator (which IS canonical Welford).
 *
 *   Continuity sanity check: the LAST growth-phase increment at k=n adds
 *   M2 += (x - μ_old) * (x - μ_new) = (1 - 1/n) * (x - μ_old)². The
 *   first steady-state increment adds α * (x - μ_old) * (x - μ_new) * (n-1)
 *   = (1/n) * (1 - 1/n) * (x - μ_old)² * (n-1) = ((n-1)²/n²) * (x - μ_old)².
 *   The decay factor (1 - α) = (n-1)/n is then applied to M2_old, which
 *   smoothly transitions from the bounded growth-phase sum to the
 *   leaky-integrator steady state.
 */

export interface BaselineState {
  count: number;
  mean: number;
  /** Welford running variance accumulator. stdev = sqrt(m2 / (count - 1)). */
  m2: number;
  windowSize: number;
}

export function createBaseline(windowSize = 300): BaselineState {
  return { count: 0, mean: 0, m2: 0, windowSize };
}

/**
 * Update with a new sample, return z-score relative to the baseline as it
 * was BEFORE this sample (so detection doesn't include the spike itself).
 */
export function updateBaseline(state: BaselineState, value: number): { state: BaselineState; z: number; mean: number; stdev: number } {
  const stdev = state.count >= 2 ? Math.sqrt(state.m2 / Math.max(1, state.count - 1)) : 0;
  const z = stdev > 1e-9 ? (value - state.mean) / stdev : 0;

  // Welford with bounded window — when at capacity, decay the accumulator
  // toward the new mean. Approximates a sliding window without storing samples.
  const next = { ...state };
  if (next.count < next.windowSize) {
    // Growth phase — canonical Welford (1962). See header comment.
    next.count += 1;
    const delta = value - next.mean;
    next.mean += delta / next.count;
    const delta2 = value - next.mean;
    next.m2 += delta * delta2;
  } else {
    // Steady-state EWMA recurrence (Finch 2009 / standard EWMVar, scaled
    // so m2/(n-1) matches the unbiased estimator). The (windowSize - 1)
    // multiplier — NOT windowSize — is the panel P1 self-coupling fix
    // (2026-05-19). See header comment for derivation.
    const alpha = 1 / next.windowSize;
    const oldMean = next.mean;
    next.mean = oldMean + alpha * (value - oldMean);
    next.m2 = (1 - alpha) * next.m2 + alpha * (value - oldMean) * (value - next.mean) * (next.windowSize - 1);
  }
  return { state: next, z, mean: state.mean, stdev };
}
