import { describe, expect, it } from "vitest";
import { downsampleFloat32 } from "./wav";

describe("downsampleFloat32 — identity", () => {
  it("returns the input unchanged when fromRate === toRate", () => {
    const input = new Float32Array([0.1, -0.2, 0.3, -0.4, 0.5]);
    const out = downsampleFloat32(input, 48000, 48000);
    // Contract: same rate returns the original reference (no copy).
    expect(out).toBe(input);
    expect(out.length).toBe(5);
    // Float32 cannot represent 0.1 exactly; compare with tolerance.
    expect(out[0]).toBeCloseTo(0.1, 6);
    expect(out[1]).toBeCloseTo(-0.2, 6);
    expect(out[4]).toBeCloseTo(0.5, 6);
  });
});

describe("downsampleFloat32 — invalid arguments", () => {
  it("throws when toRate > fromRate (upsample request)", () => {
    const input = new Float32Array([0, 1, 2, 3]);
    expect(() => downsampleFloat32(input, 16000, 48000)).toThrow(/upsampling not supported/);
  });

  it("throws on non-positive or non-finite rates", () => {
    const input = new Float32Array([0, 1, 2, 3]);
    expect(() => downsampleFloat32(input, 0, 16000)).toThrow(/invalid rates/);
    expect(() => downsampleFloat32(input, 48000, -1)).toThrow(/invalid rates/);
    expect(() => downsampleFloat32(input, Number.NaN, 16000)).toThrow(/invalid rates/);
    expect(() => downsampleFloat32(input, 48000, Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("downsampleFloat32 — integer-ratio decimation", () => {
  it("takes every Nth sample for a 3:1 ratio (48k → 16k)", () => {
    // 9 input samples at 48 kHz → 3 samples at 16 kHz, indexes 0, 3, 6.
    const input = new Float32Array([10, 11, 12, 13, 14, 15, 16, 17, 18]);
    const out = downsampleFloat32(input, 48000, 16000);
    expect(out.length).toBe(3);
    expect(Array.from(out)).toEqual([10, 13, 16]);
  });

  it("produces exact length 160 for 480 input samples at 48k → 16k", () => {
    const input = new Float32Array(480);
    for (let i = 0; i < input.length; i++) input[i] = i;
    const out = downsampleFloat32(input, 48000, 16000);
    expect(out.length).toBe(160);
    // Decimation: out[i] === input[i * 3].
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(3);
    expect(out[159]).toBe(477);
  });

  it("decimates 2:1 (32k → 16k) without interpolation", () => {
    const input = new Float32Array([0, 0.25, 0.5, 0.75, 1, -1]);
    const out = downsampleFloat32(input, 32000, 16000);
    expect(out.length).toBe(3);
    expect(Array.from(out)).toEqual([0, 0.5, 1]);
  });
});

describe("downsampleFloat32 — non-integer-ratio linear interpolation", () => {
  it("produces output length 160 for 441 samples at 44.1k → 16k", () => {
    // floor(441 * 16000 / 44100) = floor(160.0) = 160.
    const input = new Float32Array(441);
    for (let i = 0; i < input.length; i++) input[i] = i;
    const out = downsampleFloat32(input, 44100, 16000);
    expect(out.length).toBe(160);
    // First sample is exactly input[0]. Last output index 159 maps to
    // input position 159 * (44100/16000) = 159 * 2.75625 = 438.24375,
    // which lerps between input[438] = 438 and input[439] = 439.
    expect(out[0]).toBeCloseTo(0, 4);
    // Float32 precision drops for values near 438; loose tolerance is fine.
    expect(out[159]).toBeCloseTo(438.24375, 1);
  });

  it("interpolates a linear ramp accurately at every output index", () => {
    // For a perfectly linear input, linear interpolation should reproduce
    // the underlying line at the resampled positions.
    const fromRate = 44100;
    const toRate = 16000;
    const input = new Float32Array(4410);
    for (let i = 0; i < input.length; i++) input[i] = i * 0.5; // y = 0.5 * x
    const out = downsampleFloat32(input, fromRate, toRate);

    expect(out.length).toBe(Math.floor(4410 * toRate / fromRate));
    // Spot-check a handful of indices: out[i] should be 0.5 * (i * fromRate/toRate).
    const ratio = fromRate / toRate;
    for (const i of [0, 1, 17, 100, 999, out.length - 1]) {
      const expected = 0.5 * (i * ratio);
      // Linear interpolation of a linear ramp is exact in real arithmetic;
      // the residual error here is purely Float32 round-off.
      const tolerance = Math.max(1e-3, Math.abs(expected) * 1e-6);
      expect(Math.abs(out[i] - expected)).toBeLessThan(tolerance);
    }
  });
});

describe("downsampleFloat32 — edge cases", () => {
  it("returns an empty Float32Array for empty input", () => {
    const out = downsampleFloat32(new Float32Array(0), 48000, 16000);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(0);
  });

  it("handles single-sample input (output length floor(1 * toRate/fromRate))", () => {
    // 1 sample at 48 kHz → floor(1 * 16000/48000) = 0 output samples.
    const out48 = downsampleFloat32(new Float32Array([0.42]), 48000, 16000);
    expect(out48.length).toBe(0);

    // 1 sample at 16 kHz → 1 sample at 16 kHz (identity).
    const input16 = new Float32Array([0.42]);
    const out16 = downsampleFloat32(input16, 16000, 16000);
    expect(out16.length).toBe(1);
    // Float32 cannot represent 0.42 exactly; compare with tolerance.
    expect(out16[0]).toBeCloseTo(0.42, 6);
  });
});
