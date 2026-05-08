/**
 * Rolling-baseline anomaly detector — used by EMF, vibration, light, etc.
 *
 * Maintains an exponentially-weighted moving mean and stddev. Returns a
 * z-score per sample; callers threshold (typically z > 3 sustained for
 * >= 200 ms) to fire markers.
 *
 * Self-tuning: caller can `reset()` when entering a new room or after a
 * known disturbance.
 */

export interface BaselineState {
  count: number;
  mean: number;
  /** Welford running variance accumulator. */
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
    next.count += 1;
    const delta = value - next.mean;
    next.mean += delta / next.count;
    const delta2 = value - next.mean;
    next.m2 += delta * delta2;
  } else {
    // Steady-state: approximate sliding window by leaky-integrator update.
    const alpha = 1 / next.windowSize;
    const oldMean = next.mean;
    next.mean = oldMean + alpha * (value - oldMean);
    next.m2 = (1 - alpha) * next.m2 + alpha * (value - oldMean) * (value - next.mean) * next.windowSize;
  }
  return { state: next, z, mean: state.mean, stdev };
}
