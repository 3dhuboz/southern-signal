import { describe, expect, it } from "vitest";
import {
  applyEvidence,
  classifyPosterior,
  combinedLrLabel,
  createPosteriorState,
  decayLogit,
  getPosterior,
  logitFromProbability,
  POSTERIOR_THRESHOLDS,
  probabilityFromLogit,
} from "./posterior";

const EPS = 1e-6;

describe("logit / probability conversions", () => {
  it("round-trips standard probabilities", () => {
    for (const p of [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99]) {
      expect(probabilityFromLogit(logitFromProbability(p))).toBeCloseTo(p, 6);
    }
  });

  it("clamps extremes safely", () => {
    expect(probabilityFromLogit(40)).toBeCloseTo(1, EPS);
    expect(probabilityFromLogit(-40)).toBeCloseTo(0, EPS);
    expect(logitFromProbability(0)).toBeLessThanOrEqual(-30);
    expect(logitFromProbability(1)).toBeGreaterThanOrEqual(30);
  });
});

describe("createPosteriorState", () => {
  it("starts at the prior", () => {
    const s = createPosteriorState({ prior: 0.05 });
    expect(getPosterior(s, s.lastUpdateMs)).toBeCloseTo(0.05, 6);
    expect(s.incrementCount).toBe(0);
    expect(s.channelContribution).toEqual({});
  });
});

describe("applyEvidence", () => {
  it("multiplies LRs (additive in log space)", () => {
    let s = createPosteriorState({ prior: 0.05, nowMs: 0 });
    // LR 6.2 (acoustic), 4.1 (persistence), 2.3 (coupling).
    // Combined LR = 6.2 * 4.1 * 2.3 = 58.4 - prior odds 0.05/0.95 = 0.0526.
    // Posterior odds = 58.4 * 0.0526 = 3.075 → P = 0.755.
    s = applyEvidence(s, { channel: "acoustic", logLr: Math.log(6.2), reason: "transient", nowMs: 1000 }).state;
    s = applyEvidence(s, { channel: "acoustic", logLr: Math.log(4.1), reason: "persistence", nowMs: 2000 }).state;
    s = applyEvidence(s, { channel: "coupling", logLr: Math.log(2.3), reason: "temporal coupling", nowMs: 3000 }).state;
    // No decay across 3 seconds at τ=1200s — close to 0% decay.
    expect(getPosterior(s, 3000)).toBeCloseTo(0.755, 2);
    expect(s.incrementCount).toBe(3);
    expect(s.channelContribution).toHaveProperty("acoustic");
    expect(s.channelContribution).toHaveProperty("coupling");
  });

  it("caps individual LR contributions at exp(±4)", () => {
    let s = createPosteriorState({ prior: 0.05, nowMs: 0 });
    const result = applyEvidence(s, { channel: "x", logLr: 100, reason: "huge", nowMs: 10 });
    s = result.state;
    expect(result.capped).toBe(true);
    expect(result.increment.logLr).toBeCloseTo(4, 6);
    // Posterior bounded.
    expect(getPosterior(s, 10)).toBeLessThan(0.85);
  });

  it("contamination evidence decreases the posterior", () => {
    let s = createPosteriorState({ prior: 0.5, nowMs: 0 });
    s = applyEvidence(s, { channel: "contamination", logLr: -3, reason: "hvac", nowMs: 100 }).state;
    expect(getPosterior(s, 100)).toBeLessThan(0.1);
  });
});

describe("decay", () => {
  it("decays logit toward prior over time", () => {
    let s = createPosteriorState({ prior: 0.05, nowMs: 0, decayTauSeconds: 60 });
    s = applyEvidence(s, { channel: "x", logLr: Math.log(50), reason: "spike", nowMs: 1000 }).state;
    const p1 = getPosterior(s, 1000);
    expect(p1).toBeGreaterThan(0.5);
    // After one tau (60s), logit moves ~63% of the way back toward prior.
    const decayedLogitAfterTau = decayLogit(s, 1000 + 60_000);
    expect(decayedLogitAfterTau).toBeCloseTo(
      logitFromProbability(0.05) + (s.logit - logitFromProbability(0.05)) * Math.exp(-1),
      4,
    );
    // Eventually back near prior.
    const p_late = getPosterior(s, 1000 + 60_000 * 10);
    expect(p_late).toBeCloseTo(0.05, 1);
  });

  it("zero decay for τ=0 (disabled)", () => {
    let s = createPosteriorState({ prior: 0.05, nowMs: 0, decayTauSeconds: 0 });
    s = applyEvidence(s, { channel: "x", logLr: 2, reason: "x", nowMs: 1000 }).state;
    const p_a = getPosterior(s, 1000);
    const p_b = getPosterior(s, 1_000_000);
    expect(p_a).toBeCloseTo(p_b, 6);
  });
});

describe("classifyPosterior", () => {
  it("matches threshold band labels", () => {
    expect(classifyPosterior(0.10)).toBe("below");
    expect(classifyPosterior(POSTERIOR_THRESHOLDS.inconclusive)).toBe("inconclusive");
    expect(classifyPosterior(0.65)).toBe("inconclusive");
    expect(classifyPosterior(POSTERIOR_THRESHOLDS.elevated)).toBe("elevated");
    expect(classifyPosterior(POSTERIOR_THRESHOLDS.flag)).toBe("flag");
    expect(classifyPosterior(0.99)).toBe("flag");
  });
});

describe("combinedLrLabel", () => {
  it("produces a multiplication-style label", () => {
    const inc = (logLr: number) => ({ ts: 0, channel: "x", logLr, logitBefore: 0, logitAfter: 0, posteriorBefore: 0, posteriorAfter: 0, reason: "" });
    expect(combinedLrLabel([inc(Math.log(6.2)), inc(Math.log(4.1)), inc(Math.log(2.3))])).toBe("6.2 × 4.1 × 2.3");
    expect(combinedLrLabel([])).toBe("—");
  });
});
