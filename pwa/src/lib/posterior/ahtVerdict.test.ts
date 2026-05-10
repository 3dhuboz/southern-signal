import { describe, expect, it } from "vitest";
import {
  AHT_H0_DEFAULT,
  AHT_H0_SUSPEND_THRESHOLD,
  computeAhtVerdict,
  computeH0Confidence,
} from "./ahtVerdict";

describe("computeH0Confidence", () => {
  it("returns the default 0.18 with fromData=false on empty input", () => {
    const r = computeH0Confidence([]);
    expect(r.value).toBeCloseTo(AHT_H0_DEFAULT, 6);
    expect(r.fromData).toBe(false);
    expect(r.n).toBe(0);
  });

  it("ignores out-of-range / non-finite values, falls back if none usable", () => {
    const r = computeH0Confidence([NaN, -0.2, 1.5, Infinity]);
    expect(r.fromData).toBe(false);
    expect(r.value).toBeCloseTo(AHT_H0_DEFAULT, 6);
  });

  it("computes mean(1 - maxPlausibility) over usable values", () => {
    // maxPlausibilities 0.9, 0.7, 0.5 → insufficiencies 0.1, 0.3, 0.5 → mean 0.3
    const r = computeH0Confidence([0.9, 0.7, 0.5]);
    expect(r.value).toBeCloseTo(0.3, 6);
    expect(r.fromData).toBe(true);
    expect(r.n).toBe(3);
  });

  it("a single perfect debunk drives H₀ near zero", () => {
    const r = computeH0Confidence([1]);
    expect(r.value).toBeCloseTo(0, 6);
  });

  it("a single failed debunk (max plausibility 0) drives H₀ to 1", () => {
    const r = computeH0Confidence([0]);
    expect(r.value).toBeCloseTo(1, 6);
  });

  it("mixes valid and invalid, only counting valid", () => {
    const r = computeH0Confidence([0.8, NaN, 0.6]);
    // insufficiencies 0.2, 0.4 → mean 0.3
    expect(r.value).toBeCloseTo(0.3, 6);
    expect(r.n).toBe(2);
  });
});

describe("computeAhtVerdict", () => {
  it("suspends when H₀ is at or above the suspend threshold, regardless of posterior", () => {
    const high = computeAhtVerdict({ h0Confidence: AHT_H0_SUSPEND_THRESHOLD, peakPosterior: 0.99 });
    expect(high.verdict).toBe("suspended");
    expect(high.label).toBe("INCONCLUSIVE");
    const above = computeAhtVerdict({ h0Confidence: 0.7, peakPosterior: 0.1 });
    expect(above.verdict).toBe("suspended");
  });

  it("renders UNEXPLAINED only when peak posterior crosses the flag threshold and engine is active", () => {
    const r = computeAhtVerdict({ h0Confidence: 0.18, peakPosterior: 0.96 });
    expect(r.verdict).toBe("unexplained");
    expect(r.label).toBe("UNEXPLAINED");
    expect(r.detail).toContain("never 'confirmed paranormal'");
  });

  it("renders INCONCLUSIVE for the elevated band (below flag)", () => {
    const r = computeAhtVerdict({ h0Confidence: 0.1, peakPosterior: 0.85 });
    expect(r.verdict).toBe("inconclusive");
    expect(r.detail).toContain("elevated band");
  });

  it("renders INCONCLUSIVE for the inconclusive band (0.5 ≤ peak < 0.8)", () => {
    const r = computeAhtVerdict({ h0Confidence: 0.1, peakPosterior: 0.6 });
    expect(r.verdict).toBe("inconclusive");
    expect(r.detail).toContain("below the elevated band");
  });

  it("renders NULL when peak posterior never reached the inconclusive band", () => {
    const r = computeAhtVerdict({ h0Confidence: 0.05, peakPosterior: 0.2 });
    expect(r.verdict).toBe("null");
    expect(r.label).toBe("NULL");
  });

  it("the suspend gate dominates a flag-level posterior", () => {
    // Even an extreme posterior gets INCONCLUSIVE if the debunker was unreliable.
    const r = computeAhtVerdict({ h0Confidence: 0.5, peakPosterior: 0.999 });
    expect(r.verdict).toBe("suspended");
  });
});
