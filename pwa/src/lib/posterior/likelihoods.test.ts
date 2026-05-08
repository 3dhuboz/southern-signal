import { describe, expect, it } from "vitest";
import {
  emitAcousticTransient,
  emitContamination,
  emitInfrasoundPulse,
  emitMagnetometerAnomaly,
  emitTemporalCoupling,
} from "./likelihoods";

describe("acoustic transient", () => {
  it("requires coherence ≥ 0.7", () => {
    expect(emitAcousticTransient({ coherence: 0.5, subBandsAgreed: 4, sector: "REAR-L", sectorPersistedFromPrior: false, isFirstInWindow: true })).toBeNull();
  });
  it("requires ≥ 3 sub-bands agreed", () => {
    expect(emitAcousticTransient({ coherence: 0.9, subBandsAgreed: 2, sector: "REAR-L", sectorPersistedFromPrior: false, isFirstInWindow: true })).toBeNull();
  });
  it("emits +3.0 log LR on first fire", () => {
    const e = emitAcousticTransient({ coherence: 0.9, subBandsAgreed: 4, sector: "REAR-L", sectorPersistedFromPrior: false, isFirstInWindow: true });
    expect(e?.logLr).toBeCloseTo(3.0, 6);
  });
  it("emits +1.0 on subsequent fires within window", () => {
    const e = emitAcousticTransient({ coherence: 0.9, subBandsAgreed: 4, sector: "REAR-L", sectorPersistedFromPrior: false, isFirstInWindow: false });
    expect(e?.logLr).toBeCloseTo(1.0, 6);
  });
  it("adds persistence bonus", () => {
    const e = emitAcousticTransient({ coherence: 0.9, subBandsAgreed: 4, sector: "REAR-L", sectorPersistedFromPrior: true, isFirstInWindow: true });
    expect(e?.logLr).toBeCloseTo(4.4, 6);
  });
});

describe("infrasound pulse", () => {
  it("requires 7 ≤ peakHz ≤ 19", () => {
    expect(emitInfrasoundPulse({ peakHz: 5, durationSeconds: 12, envelopeDb: -30, baselineEnvelopeDb: -40 })).toBeNull();
    expect(emitInfrasoundPulse({ peakHz: 25, durationSeconds: 12, envelopeDb: -30, baselineEnvelopeDb: -40 })).toBeNull();
  });
  it("requires duration ≥ 10s", () => {
    expect(emitInfrasoundPulse({ peakHz: 12, durationSeconds: 5, envelopeDb: -30, baselineEnvelopeDb: -40 })).toBeNull();
  });
  it("requires +6 dB above baseline", () => {
    expect(emitInfrasoundPulse({ peakHz: 12, durationSeconds: 12, envelopeDb: -39, baselineEnvelopeDb: -40 })).toBeNull();
  });
  it("emits 1.7 log LR when all gates pass", () => {
    const e = emitInfrasoundPulse({ peakHz: 12, durationSeconds: 12, envelopeDb: -30, baselineEnvelopeDb: -40 });
    expect(e?.logLr).toBeCloseTo(1.7, 6);
  });
});

describe("magnetometer anomaly", () => {
  it("requires |z| ≥ 3", () => {
    expect(emitMagnetometerAnomaly({ zScore: 2.5, magnitudeMicrotesla: 50, baselineMicrotesla: 45 })).toBeNull();
  });
  it("emits 2.6 log LR at z = 3", () => {
    const e = emitMagnetometerAnomaly({ zScore: 3.5, magnitudeMicrotesla: 60, baselineMicrotesla: 45 });
    expect(e?.logLr).toBeCloseTo(2.6, 6);
  });
});

describe("temporal coupling", () => {
  it("requires ≥ 2 channels", () => {
    expect(emitTemporalCoupling({ channels: ["acoustic"], deltaMs: 50 })).toBeNull();
  });
  it("requires Δt ≤ 200 ms", () => {
    expect(emitTemporalCoupling({ channels: ["acoustic", "magnetometer"], deltaMs: 250 })).toBeNull();
  });
  it("emits 2.3 log LR on a valid coupling", () => {
    const e = emitTemporalCoupling({ channels: ["acoustic", "magnetometer"], deltaMs: 80 });
    expect(e?.logLr).toBeCloseTo(2.3, 6);
  });
});

describe("contamination", () => {
  it("emits a negative log LR", () => {
    const e = emitContamination({ tag: "hvac", appliesToWindowSeconds: 60 });
    expect(e.logLr).toBeLessThan(0);
    expect(e.channel).toBe("contamination");
  });
});
