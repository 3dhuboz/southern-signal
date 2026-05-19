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
    // Coherence kept below 0.85 to isolate the baseLogLr from the
    // RMS-orthogonal coherence-novelty bonus (added in the panel P1
    // self-coupling decouple).
    const e = emitAcousticTransient({ coherence: 0.75, subBandsAgreed: 4, sector: "REAR-L", sectorPersistedFromPrior: false, isFirstInWindow: true });
    expect(e?.logLr).toBeCloseTo(3.0, 6);
  });
  it("emits +1.0 on subsequent fires within window", () => {
    const e = emitAcousticTransient({ coherence: 0.75, subBandsAgreed: 4, sector: "REAR-L", sectorPersistedFromPrior: false, isFirstInWindow: false });
    expect(e?.logLr).toBeCloseTo(1.0, 6);
  });
  it("adds persistence bonus", () => {
    const e = emitAcousticTransient({ coherence: 0.75, subBandsAgreed: 4, sector: "REAR-L", sectorPersistedFromPrior: true, isFirstInWindow: true });
    expect(e?.logLr).toBeCloseTo(4.4, 6);
  });
  it("adds +0.5 coherence-novelty bonus when coherence ≥ 0.85 (RMS-orthogonal evidence)", () => {
    const e = emitAcousticTransient({ coherence: 0.9, subBandsAgreed: 4, sector: "REAR-L", sectorPersistedFromPrior: false, isFirstInWindow: true });
    expect(e?.logLr).toBeCloseTo(3.5, 6);
    expect(e?.metadata?.coherence_novelty_bonus).toBe(0.5);
  });
  it("does not add the coherence-novelty bonus just below the 0.85 threshold", () => {
    const e = emitAcousticTransient({ coherence: 0.84, subBandsAgreed: 4, sector: "REAR-L", sectorPersistedFromPrior: false, isFirstInWindow: true });
    expect(e?.logLr).toBeCloseTo(3.0, 6);
    expect(e?.metadata?.coherence_novelty_bonus).toBe(0);
  });

  describe("with site baseline (V2)", () => {
    const baseline = {
      audioRmsMean: 0.04,
      audioRmsP95: 0.08,
      audioRmsMax: 0.12,
      emfMean: 0,
      emfP95: 0,
      emfMax: 0,
      durationSeconds: 90,
      sampleCount: 360,
      capturedAt: "2026-05-10T00:00:00.000Z",
    };

    it("refuses when audioRms is at or below site audioRmsP95 even on a first-fire transient", () => {
      const result = emitAcousticTransient({
        coherence: 0.9,
        subBandsAgreed: 4,
        sector: "REAR-L",
        sectorPersistedFromPrior: false,
        isFirstInWindow: true,
        audioRms: 0.07, // below site p95 = 0.08
        siteBaseline: baseline,
      });
      expect(result).toBeNull();
    });

    it("emits standard 3.0 log LR when audioRms exceeds p95 but is at or below max (coherence below novelty threshold)", () => {
      // Coherence kept below 0.85 to isolate baseline-gate behaviour from
      // the (now coherence-driven) novelty bonus.
      const e = emitAcousticTransient({
        coherence: 0.75,
        subBandsAgreed: 4,
        sector: "REAR-L",
        sectorPersistedFromPrior: false,
        isFirstInWindow: true,
        audioRms: 0.10,
        siteBaseline: baseline,
      });
      expect(e?.logLr).toBeCloseTo(3.0, 6);
      expect(e?.metadata?.above_site_p95).toBe(true);
      expect(e?.metadata?.above_site_max).toBe(false);
    });

    it("does NOT add an RMS-magnitude bonus even when audioRms exceeds site max (decouples self-coupling)", () => {
      // PRE-FIX: this returned 3.5 (+0.5 RMS-novelty bonus). That bonus
      // double-counted the same RMS spike that already (a) gated the
      // transient firing upstream in liveAnalyzer.ts L159 and (b) the
      // 3.0 base LR was calibrated against. POST-FIX: the RMS-novelty
      // bonus is REMOVED; `above_site_max` is still recorded in metadata
      // for audit-trail transparency but does NOT add to log-LR. See
      // likelihoods.ts "Self-coupling decouple" comment for the full
      // reasoning.
      const e = emitAcousticTransient({
        coherence: 0.75, // below 0.85 novelty threshold — no coherence bonus either
        subBandsAgreed: 4,
        sector: "REAR-L",
        sectorPersistedFromPrior: false,
        isFirstInWindow: true,
        audioRms: 0.15, // above site max 0.12
        siteBaseline: baseline,
      });
      expect(e?.logLr).toBeCloseTo(3.0, 6);
      expect(e?.metadata?.above_site_max).toBe(true);
      expect(e?.metadata?.coherence_novelty_bonus).toBe(0);
    });

    it("adds a +0.5 coherence-novelty bonus when coherence ≥ 0.85 (RMS-orthogonal)", () => {
      // The novelty bonus moved from `audioRms > site.audioRmsMax`
      // (self-coupled with the RMS-gated transient detector) to
      // `coherence >= 0.85` (orthogonal to RMS magnitude — it's spectral
      // directional consistency from the FFT cross-spectrum).
      const e = emitAcousticTransient({
        coherence: 0.9, // ≥ 0.85 → novelty bonus fires
        subBandsAgreed: 4,
        sector: "REAR-L",
        sectorPersistedFromPrior: false,
        isFirstInWindow: true,
        audioRms: 0.10, // above p95, at/below max — adds NO LR itself now
        siteBaseline: baseline,
      });
      expect(e?.logLr).toBeCloseTo(3.5, 6);
      expect(e?.metadata?.coherence_novelty_bonus).toBe(0.5);
    });

    it("falls back to baseline-less behaviour when audioRms is missing", () => {
      // No audioRms provided — baseline can't be applied; legacy LR fires.
      const e = emitAcousticTransient({
        coherence: 0.75, // keep below 0.85 to isolate the legacy LR
        subBandsAgreed: 4,
        sector: "REAR-L",
        sectorPersistedFromPrior: false,
        isFirstInWindow: true,
        siteBaseline: baseline,
      });
      expect(e?.logLr).toBeCloseTo(3.0, 6);
      expect(e?.metadata?.above_site_p95).toBe(false);
    });

    it("ignores baseline with zero audioRmsP95 (no audio captured)", () => {
      const noAudioBaseline = { ...baseline, audioRmsMean: 0, audioRmsP95: 0, audioRmsMax: 0 };
      const e = emitAcousticTransient({
        coherence: 0.75,
        subBandsAgreed: 4,
        sector: "REAR-L",
        sectorPersistedFromPrior: false,
        isFirstInWindow: true,
        audioRms: 0.03,
        siteBaseline: noAudioBaseline,
      });
      expect(e?.logLr).toBeCloseTo(3.0, 6);
      expect(e?.metadata?.above_site_p95).toBe(false);
    });

    it("stacks coherence-novelty bonus on top of persistence bonus", () => {
      const e = emitAcousticTransient({
        coherence: 0.9,
        subBandsAgreed: 4,
        sector: "REAR-L",
        sectorPersistedFromPrior: true,
        isFirstInWindow: true,
        audioRms: 0.20,
        siteBaseline: baseline,
      });
      // base 3.0 + persistence 1.4 + coherence-novelty 0.5 = 4.9
      // (capped at 4.0 by posterior.ts but this fn returns the raw value)
      expect(e?.logLr).toBeCloseTo(4.9, 6);
    });
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

  describe("with site baseline (V2)", () => {
    const baseline = {
      audioRmsMean: 0,
      audioRmsP95: 0,
      audioRmsMax: 0,
      emfMean: 45,
      emfP95: 52,
      emfMax: 58,
      durationSeconds: 90,
      sampleCount: 360,
      capturedAt: "2026-05-10T00:00:00.000Z",
    };

    it("refuses when reading is at or below site emfP95 even if z-score crosses 3", () => {
      // z=3.5 would normally fire, but |B|=50 μT is below site p95=52 — site noise.
      const result = emitMagnetometerAnomaly({
        zScore: 3.5,
        magnitudeMicrotesla: 50,
        baselineMicrotesla: 45,
        siteBaseline: baseline,
      });
      expect(result).toBeNull();
    });

    it("emits the standard 2.6 log LR when above site p95 but at or below site max", () => {
      const e = emitMagnetometerAnomaly({
        zScore: 3.5,
        magnitudeMicrotesla: 55,
        baselineMicrotesla: 45,
        siteBaseline: baseline,
      });
      expect(e?.logLr).toBeCloseTo(2.6, 6);
      expect(e?.metadata?.above_site_p95).toBe(true);
      expect(e?.metadata?.above_site_max).toBe(false);
    });

    it("adds a +0.5 bonus when reading exceeds site emfMax (novelty)", () => {
      const e = emitMagnetometerAnomaly({
        zScore: 3.5,
        magnitudeMicrotesla: 70,
        baselineMicrotesla: 45,
        siteBaseline: baseline,
      });
      expect(e?.logLr).toBeCloseTo(3.1, 6);
      expect(e?.metadata?.above_site_max).toBe(true);
      expect(e?.metadata?.site_emf_p95_uT).toBe(52);
      expect(e?.metadata?.site_emf_max_uT).toBe(58);
    });

    it("ignores baseline with emfP95 of 0 (e.g. magnetometer-less device)", () => {
      const noEmfBaseline = { ...baseline, emfP95: 0, emfMax: 0, emfMean: 0 };
      const e = emitMagnetometerAnomaly({
        zScore: 3.5,
        magnitudeMicrotesla: 60,
        baselineMicrotesla: 45,
        siteBaseline: noEmfBaseline,
      });
      // Falls back to baseline-less behaviour; standard 2.6 fires.
      expect(e?.logLr).toBeCloseTo(2.6, 6);
      expect(e?.metadata?.above_site_p95).toBe(false);
    });

    it("treats undefined and null siteBaseline identically to the legacy path", () => {
      const a = emitMagnetometerAnomaly({ zScore: 3.5, magnitudeMicrotesla: 60, baselineMicrotesla: 45 });
      const b = emitMagnetometerAnomaly({ zScore: 3.5, magnitudeMicrotesla: 60, baselineMicrotesla: 45, siteBaseline: null });
      expect(a?.logLr).toBeCloseTo(b?.logLr ?? -1, 6);
      // Both paths uniformly populate baseline-related metadata as falsy/null
      // so audit-log readers don't need to special-case the shape.
      expect(a?.metadata?.above_site_p95).toBe(false);
      expect(b?.metadata?.above_site_p95).toBe(false);
      expect(a?.metadata?.site_emf_p95_uT).toBe(null);
    });
  });
});

describe("temporal coupling", () => {
  it("requires ≥ 2 channels", () => {
    expect(emitTemporalCoupling({ channels: ["acoustic"], deltaMs: 50 })).toBeNull();
  });
  it("requires Δt ≤ 200 ms", () => {
    expect(emitTemporalCoupling({ channels: ["acoustic", "magnetometer"], deltaMs: 250 })).toBeNull();
  });
  it("emits 2.3 log LR on a valid coupling between independent channels (acoustic + magnetometer)", () => {
    const e = emitTemporalCoupling({ channels: ["acoustic", "magnetometer"], deltaMs: 80 });
    expect(e?.logLr).toBeCloseTo(2.3, 6);
  });
  // Channel-independence rule (panel P1 self-coupling decouple): both
  // `acoustic` and `infrasound` are derived from the audio RMS sequence
  // (see infrasound.ts pushFrameRms(rms, …) consuming the very same rms
  // value used by the acoustic transient detector in liveAnalyzer.ts).
  // A coupling event on those two channels would triple-count the same
  // RMS spike. Coupling between audio-chain channels must REFUSE.
  it("refuses acoustic + infrasound coupling (shared audio RMS — not independent)", () => {
    expect(emitTemporalCoupling({ channels: ["acoustic", "infrasound"], deltaMs: 50 })).toBeNull();
  });
  it("refuses infrasound + acoustic regardless of order", () => {
    expect(emitTemporalCoupling({ channels: ["infrasound", "acoustic"], deltaMs: 50 })).toBeNull();
  });
  it("still couples infrasound with a NON-audio-chain channel (e.g. magnetometer)", () => {
    const e = emitTemporalCoupling({ channels: ["infrasound", "magnetometer"], deltaMs: 50 });
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
