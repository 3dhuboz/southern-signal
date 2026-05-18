import { describe, it, expect } from "vitest";
import { projectTimeToEmpty, formatTimeToEmpty, type BatterySample } from "./batteryProjection";

function makeSamples(values: number[], stepSeconds = 60, start = "2024-01-01T00:00:00.000Z"): BatterySample[] {
  const startMs = Date.parse(start);
  return values.map((v, i) => ({ value: v, ts: new Date(startMs + i * stepSeconds * 1000).toISOString() }));
}

describe("projectTimeToEmpty", () => {
  it("returns null with fewer than 3 samples", () => {
    expect(projectTimeToEmpty(makeSamples([0.5, 0.4]))).toBeNull();
  });

  it("returns null when the window is too short", () => {
    // 3 samples 30s apart = 60s window, below the 90s minimum.
    const samples = makeSamples([0.5, 0.45, 0.4], 30);
    expect(projectTimeToEmpty(samples)).toBeNull();
  });

  it("returns null when charging", () => {
    const samples = makeSamples([0.5, 0.55, 0.6, 0.65], 60);
    samples[samples.length - 1].charging = true;
    expect(projectTimeToEmpty(samples)).toBeNull();
  });

  it("returns null on a flat / rising slope", () => {
    expect(projectTimeToEmpty(makeSamples([0.5, 0.5, 0.5, 0.5], 60))).toBeNull();
    expect(projectTimeToEmpty(makeSamples([0.4, 0.5, 0.6, 0.7], 60))).toBeNull();
  });

  it("projects a steady linear drain to empty", () => {
    // 1%/min drain starting from 60%. Should project ~60 min to 0%.
    const samples = makeSamples([0.60, 0.59, 0.58, 0.57, 0.56], 60);
    const proj = projectTimeToEmpty(samples, Date.parse(samples[samples.length - 1].ts));
    expect(proj).not.toBeNull();
    expect(proj!.minutesToEmpty).toBeGreaterThan(50);
    expect(proj!.minutesToEmpty).toBeLessThan(60);
    expect(proj!.drainPerMinute).toBeCloseTo(0.01, 3);
    expect(proj!.sampleCount).toBe(5);
  });

  it("subtracts time elapsed since the last sample", () => {
    const samples = makeSamples([0.50, 0.49, 0.48, 0.47, 0.46], 60);
    const lastMs = Date.parse(samples[samples.length - 1].ts);
    // Fresh: should project ~46 min from the last sample.
    const fresh = projectTimeToEmpty(samples, lastMs);
    // 10 min later: should project ~36 min remaining.
    const stale = projectTimeToEmpty(samples, lastMs + 10 * 60 * 1000);
    expect(fresh).not.toBeNull();
    expect(stale).not.toBeNull();
    expect(fresh!.minutesToEmpty - stale!.minutesToEmpty).toBeCloseTo(10, 0);
  });
});

describe("formatTimeToEmpty", () => {
  it("formats sub-minute as <1 min", () => {
    expect(formatTimeToEmpty(0.5)).toBe("<1 min");
  });
  it("formats minutes as N min", () => {
    expect(formatTimeToEmpty(12.4)).toBe("12 min");
    expect(formatTimeToEmpty(59)).toBe("59 min");
  });
  it("formats hour-plus as h + min", () => {
    expect(formatTimeToEmpty(60)).toBe("1 h");
    expect(formatTimeToEmpty(84.6)).toBe("1 h 25 min");
    expect(formatTimeToEmpty(125)).toBe("2 h 5 min");
  });
});
