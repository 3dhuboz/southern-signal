import { describe, expect, it } from "vitest";
import { aggregateSector, ASI_CONSTANTS, processFrame, quantizeSector } from "./sectorIndicator";

const BANDS = ASI_CONSTANTS.DEFAULT_BANDS;

function syntheticFrame(opts: {
  itdSeconds: number;
  perBandMscPattern: number[]; // length = BANDS.length
}) {
  // Build a per-band cross-spectrum that encodes the requested ITD via phase
  // = -2π f τ, with magnitude scaled to make MSC = pattern[i] when L*R = 1.
  const perBandCross = BANDS.map((b, i) => {
    const phase = -2 * Math.PI * b.centre * opts.itdSeconds;
    const targetMsc = opts.perBandMscPattern[i] ?? 0;
    const magnitude = Math.sqrt(Math.max(0, Math.min(1, targetMsc)));
    return { real: magnitude * Math.cos(phase), imag: magnitude * Math.sin(phase) };
  });
  const perBandLeftPower = BANDS.map(() => 1);
  const perBandRightPower = BANDS.map(() => 1);
  return { perBandCross, perBandLeftPower, perBandRightPower, sampleRate: 48000 };
}

describe("processFrame", () => {
  it("recovers ITD from synthetic phase, gated by coherence", () => {
    const itdSec = 100e-6; // 100 µs
    const f = processFrame(syntheticFrame({ itdSeconds: itdSec, perBandMscPattern: [0.9, 0.85, 0.95, 0.85, 0.9, 0.92, 0.9, 0.88] }));
    const passingMscs = f.cohPerBand.filter((m) => m >= 0.7);
    expect(passingMscs.length).toBeGreaterThanOrEqual(8);
    // Median ITD should be very close to 100 µs.
    const passing = f.itdPerBand.filter(Number.isFinite).sort((a, b) => a - b);
    expect(passing[Math.floor(passing.length / 2)]).toBeCloseTo(itdSec, 6);
  });

  it("ignores low-MSC bands", () => {
    const f = processFrame(syntheticFrame({ itdSeconds: 100e-6, perBandMscPattern: [0.3, 0.2, 0.1, 0.4, 0.5, 0.6, 0.65, 0.55] }));
    expect(f.itdPerBand.every((v) => Number.isNaN(v))).toBe(true);
    expect(f.cohPerBand.every((m) => m < 0.7)).toBe(true);
  });
});

describe("aggregateSector — gating", () => {
  it("returns null sector when fewer than 3 bands pass", () => {
    // Only 2 bands above threshold.
    const frame = processFrame(syntheticFrame({ itdSeconds: 100e-6, perBandMscPattern: [0.9, 0.9, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4] }));
    const reading = aggregateSector({ frame, micSpacingMm: 146 });
    expect(reading.sector).toBeNull();
    expect(reading.trustworthy).toBe(false);
  });

  it("returns null when 3 bands pass but they are all adjacent", () => {
    const frame = processFrame(syntheticFrame({ itdSeconds: 100e-6, perBandMscPattern: [0.9, 0.9, 0.9, 0.4, 0.4, 0.4, 0.4, 0.4] }));
    const reading = aggregateSector({ frame, micSpacingMm: 146 });
    expect(reading.sector).toBeNull();
  });

  it("reports a sector when ≥3 non-adjacent bands pass", () => {
    // Bands 0, 2, 4 — non-adjacent with stride 2 each.
    const frame = processFrame(syntheticFrame({ itdSeconds: 100e-6, perBandMscPattern: [0.9, 0.4, 0.9, 0.4, 0.9, 0.4, 0.4, 0.4] }));
    const reading = aggregateSector({ frame, micSpacingMm: 146 });
    expect(reading.sector).not.toBeNull();
    expect(reading.trustworthy).toBe(true);
    expect(reading.itdMs).toBeCloseTo(0.1, 1);
  });
});

describe("quantizeSector", () => {
  it("returns CENTER for near-zero ITD", () => {
    expect(quantizeSector(0, 146, 0.6)?.endsWith("-C")).toBe(true);
  });
  it("returns L for negative ITD with right-leading convention", () => {
    expect(quantizeSector(-200e-6, 146, 0.6)?.endsWith("-L")).toBe(true);
  });
  it("returns R for positive ITD", () => {
    expect(quantizeSector(200e-6, 146, 0.6)?.endsWith("-R")).toBe(true);
  });
  it("returns null when ITD exceeds physical maximum", () => {
    expect(quantizeSector(2e-3, 146, 0.6)).toBeNull(); // 2ms way beyond 426µs limit
  });
  it("uses front-probability for the front/back axis", () => {
    expect(quantizeSector(100e-6, 146, 0.8)?.startsWith("FRONT")).toBe(true);
    expect(quantizeSector(100e-6, 146, 0.2)?.startsWith("REAR")).toBe(true);
  });
});
