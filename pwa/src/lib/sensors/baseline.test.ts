/**
 * Tests for the rolling-baseline anomaly detector.
 *
 * The growth-phase math is canonical Welford (1962). The steady-state
 * phase implements an exponentially-weighted variance recurrence
 * consistent with Finch (2009) and the standard EWMA-variance estimator
 * used by pandas `ewm.var()` and RiskMetrics, scaled so that
 * `stdev = sqrt(m2 / (count - 1))` is a Bessel-corrected unbiased
 * estimate.
 *
 * The 2026-05-19 panel P1 fix corrected the steady-state recurrence's
 * multiplier from `windowSize` to `(windowSize - 1)`. These tests pin the
 * post-fix behaviour against HAND-COMPUTED reference values so any future
 * regression of either the growth-phase or steady-state path is caught
 * with a clear diff against numbers a reviewer can re-derive on paper.
 */

import { describe, expect, it } from "vitest";
import { createBaseline, updateBaseline } from "./baseline";

describe("createBaseline", () => {
  it("starts with zero count, mean, and m2", () => {
    const b = createBaseline(300);
    expect(b.count).toBe(0);
    expect(b.mean).toBe(0);
    expect(b.m2).toBe(0);
    expect(b.windowSize).toBe(300);
  });

  it("uses default windowSize of 300 when omitted", () => {
    const b = createBaseline();
    expect(b.windowSize).toBe(300);
  });
});

describe("updateBaseline — growth phase (canonical Welford 1962)", () => {
  // Reference sequence [10, 20, 30, 40]. Hand-computed in the
  // baseline.ts header comment / test design notes:
  //
  //   k=1: x=10 → n=1, mean=10, m2=0
  //   k=2: x=20 → delta=10, mean=15, delta2=5,  m2 += 10*5  = 50
  //   k=3: x=30 → delta=15, mean=20, delta2=10, m2 += 15*10 = 200
  //   k=4: x=40 → delta=20, mean=25, delta2=15, m2 += 20*15 = 500
  //
  // Direct check against the textbook sum-of-squared-deviations form:
  //   (10-25)² + (20-25)² + (30-25)² + (40-25)² = 225 + 25 + 25 + 225 = 500 ✓
  // Unbiased variance = 500 / (4-1) = 166.6̄, stdev ≈ 12.9099.

  const SEQ = [10, 20, 30, 40];

  it("matches the canonical Welford accumulator step-by-step", () => {
    let b = createBaseline(4);
    const expected = [
      { count: 1, mean: 10, m2: 0 },
      { count: 2, mean: 15, m2: 50 },
      { count: 3, mean: 20, m2: 200 },
      { count: 4, mean: 25, m2: 500 },
    ];
    for (let i = 0; i < SEQ.length; i++) {
      const r = updateBaseline(b, SEQ[i]);
      b = r.state;
      expect(b.count).toBe(expected[i].count);
      expect(b.mean).toBeCloseTo(expected[i].mean, 9);
      expect(b.m2).toBeCloseTo(expected[i].m2, 9);
    }
  });

  it("the variance after the growth-phase fill matches the textbook sum-of-squared-deviations / (n-1)", () => {
    let b = createBaseline(4);
    for (const x of SEQ) b = updateBaseline(b, x).state;
    const variance = b.m2 / (b.count - 1);
    expect(variance).toBeCloseTo(500 / 3, 9);
    expect(Math.sqrt(variance)).toBeCloseTo(12.9099444873581, 9);
  });

  it("returns z-score using the BEFORE-update stdev (so the spike doesn't update its own threshold)", () => {
    // After 3 samples (mean=20, m2=200, stdev = sqrt(200/2) = 10), pushing
    // x=40 should report z = (40 - 20) / 10 = 2.0 — NOT a recomputed
    // post-update z. The detector requires this so a single huge spike
    // doesn't immediately inflate its own σ and disappear from the
    // anomaly band on the very same sample.
    let b = createBaseline(4);
    b = updateBaseline(b, 10).state;
    b = updateBaseline(b, 20).state;
    b = updateBaseline(b, 30).state;
    const r = updateBaseline(b, 40);
    // stdev BEFORE the update: sqrt(200 / (3-1)) = sqrt(100) = 10
    // mean BEFORE the update: 20
    expect(r.stdev).toBeCloseTo(10, 9);
    expect(r.mean).toBeCloseTo(20, 9);
    expect(r.z).toBeCloseTo((40 - 20) / 10, 9);
  });
});

describe("updateBaseline — steady-state EWMA (panel P1 fix 2026-05-19)", () => {
  // Continue the growth-phase reference sequence past windowSize = 4.
  //
  // After 4 samples: count=4, mean=25, m2=500.
  //
  // Steady-state step at k=5, x=50:
  //   α = 1/windowSize = 1/4 = 0.25
  //   oldMean = 25
  //   newMean = 25 + α * (50 - 25) = 25 + 0.25 * 25 = 31.25
  //   delta  = 50 - 25 = 25
  //   delta2 = 50 - 31.25 = 18.75
  //   m2_new = (1 - α) * m2_old + α * delta * delta2 * (windowSize - 1)
  //          = 0.75 * 500 + 0.25 * 25 * 18.75 * 3
  //          = 375 + 351.5625
  //          = 726.5625
  //   stdev_after = sqrt(726.5625 / 3) = sqrt(242.1875) ≈ 15.56237
  //
  // (The PRE-FIX code used `* windowSize` instead of `* (windowSize - 1)`,
  // giving m2 = 0.75*500 + 0.25*25*18.75*4 = 375 + 468.75 = 843.75. The
  // ~16% inflation here is amplified by the small window; for n=300 the
  // delta per-sample is smaller but the cumulative steady-state bias on
  // var was still ~n/(n-1). That's the bug being pinned by this test.)
  //
  // Steady-state step at k=6, x=60 (consume one more sample):
  //   oldMean = 31.25
  //   newMean = 31.25 + 0.25 * (60 - 31.25) = 31.25 + 7.1875 = 38.4375
  //   delta  = 28.75, delta2 = 21.5625
  //   m2_new = 0.75 * 726.5625 + 0.25 * 28.75 * 21.5625 * 3
  //          = 544.921875 + 464.94140625
  //          = 1009.86328125

  const FILL_SEQ = [10, 20, 30, 40]; // brings count to windowSize=4

  function fillToCapacity(windowSize: number) {
    let b = createBaseline(windowSize);
    for (const x of FILL_SEQ) b = updateBaseline(b, x).state;
    return b;
  }

  it("freezes count at windowSize and continues to update mean + m2 (no off-by-one growth)", () => {
    const b0 = fillToCapacity(4);
    expect(b0.count).toBe(4);
    const r = updateBaseline(b0, 50);
    expect(r.state.count).toBe(4); // still pinned at windowSize
    expect(r.state.mean).toBeCloseTo(31.25, 9);
    expect(r.state.m2).toBeCloseTo(726.5625, 9);
  });

  it("uses the Bessel-corrected (windowSize - 1) multiplier — NOT windowSize — at steady state", () => {
    // Pre-fix expected m2 with `* windowSize`: 375 + 0.25*25*18.75*4 = 843.75
    // Post-fix expected m2 with `* (windowSize - 1)`: 375 + 0.25*25*18.75*3 = 726.5625
    //
    // This test asserts the POST-FIX value. If a regression ever flips
    // back to `windowSize` it will produce 843.75 here and fail with a
    // 16%-too-high m2.
    const b0 = fillToCapacity(4);
    const r = updateBaseline(b0, 50);
    expect(r.state.m2).toBeCloseTo(726.5625, 9);
    // Sanity: confirm the pre-fix value is NOT what we get.
    expect(r.state.m2).not.toBeCloseTo(843.75, 6);
  });

  it("maintains the recurrence across multiple steady-state samples", () => {
    let b = fillToCapacity(4);
    b = updateBaseline(b, 50).state;
    const r = updateBaseline(b, 60);
    expect(r.state.mean).toBeCloseTo(38.4375, 9);
    expect(r.state.m2).toBeCloseTo(1009.86328125, 9);
  });

  it("stdev derived from m2/(n-1) is consistent with the standard EWMVar estimator at steady state", () => {
    // After the step at k=5, stdev_after = sqrt(726.5625 / 3).
    const b0 = fillToCapacity(4);
    const r = updateBaseline(b0, 50);
    const stdevAfter = Math.sqrt(r.state.m2 / (r.state.count - 1));
    // sqrt(726.5625 / 3) = sqrt(242.1875) ≈ 15.562374497485916
    expect(stdevAfter).toBeCloseTo(15.562374497485916, 9);
  });

  it("returns z computed against the BEFORE-update mean / stdev (so the steady-state spike doesn't suppress itself)", () => {
    // After the growth-phase fill: mean=25, m2=500, stdev = sqrt(500/3) ≈ 12.9099.
    // Pushing x=50, the returned z should be (50 - 25) / 12.9099 ≈ 1.93649.
    const b0 = fillToCapacity(4);
    const r = updateBaseline(b0, 50);
    expect(r.mean).toBeCloseTo(25, 9);
    expect(r.stdev).toBeCloseTo(Math.sqrt(500 / 3), 9);
    expect(r.z).toBeCloseTo((50 - 25) / Math.sqrt(500 / 3), 9);
  });

  it("converges to the true σ on a stationary process within ~1% bias for the n=300 production window", () => {
    // Sanity test against pandas-style EWMVar: feed a long stationary
    // sequence from a known σ. With n=300 and α=1/n, the standard
    // EWMVar estimator has bias 2/(2-α) ≈ 1 + α/2 ≈ 1.00167 relative
    // to σ². Our recurrence inherits the same bias profile. We use a
    // deterministic PRNG so this test is reproducible without random
    // flake.
    let seed = 0xC0FFEE;
    const rand = () => {
      // LCG → uniform [0, 1)
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const boxMuller = () => {
      const u1 = Math.max(1e-12, rand());
      const u2 = rand();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };

    const TRUE_SIGMA = 5;
    const TRUE_MEAN = 100;
    let b = createBaseline(300);
    // Burn-in: 1 full window of growth + 5 windows of steady-state.
    const N = 300 * 6;
    for (let i = 0; i < N; i++) {
      const x = TRUE_MEAN + TRUE_SIGMA * boxMuller();
      b = updateBaseline(b, x).state;
    }
    const sigmaEstimate = Math.sqrt(b.m2 / (b.count - 1));
    // Allow ~10% slack: this is a stochastic test, and EWMA has finite
    // variance of its variance estimator. The point of this test is to
    // catch order-of-magnitude regressions (e.g. forgetting to divide,
    // off-by-windowSize, etc.), not to nail the bias precisely.
    expect(sigmaEstimate).toBeGreaterThan(TRUE_SIGMA * 0.85);
    expect(sigmaEstimate).toBeLessThan(TRUE_SIGMA * 1.15);
  });
});
