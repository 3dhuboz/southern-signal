/**
 * Adversarial Hypothesis Tournament (AHT) post-roll verdict.
 *
 * The AHT method: the AI proposes mundane explanations for accumulated
 * evidence; the posterior survives (or doesn't) those proposals. The
 * post-roll verdict combines two signals:
 *
 *   1. H₀ — "AI insufficiency" confidence. Computed from the plausibility
 *      of the best mundane explanation the debunker could propose, averaged
 *      over recent debunk requests. High H₀ = the AI kept failing to find
 *      anything plausible. That is a MODEL limitation, never evidence of the
 *      paranormal — so when H₀ is high enough the verdict engine SUSPENDS:
 *      every case renders INCONCLUSIVE rather than any positive verdict.
 *
 *   2. Peak posterior across the session — only consulted when the engine
 *      is not suspended.
 *
 * The verdict NEVER says "confirmed paranormal". The strongest positive
 * outcome is UNEXPLAINED ("survived adversarial debunking"). This is a
 * hard-coded floor, not a tuning knob.
 */

import { POSTERIOR_THRESHOLDS } from "./posterior";

/** When H₀ "AI insufficiency" confidence is at or above this, the post-roll suspends. */
export const AHT_H0_SUSPEND_THRESHOLD = 0.4;

/** Historical placeholder used when there's no debunk history yet. */
export const AHT_H0_DEFAULT = 0.18;

export type AhtVerdict = "suspended" | "null" | "inconclusive" | "unexplained";

export interface AhtVerdictResult {
  verdict: AhtVerdict;
  /** Short ALL-CAPS label for a badge. */
  label: string;
  /** One-sentence plain-English explanation. */
  detail: string;
}

export interface H0Confidence {
  /** The confidence value in [0, 1]. */
  value: number;
  /** True when computed from real debunk data; false when the default fallback. */
  fromData: boolean;
  /** Number of debunk requests that contributed. */
  n: number;
}

/**
 * Compute H₀ from a list of max-plausibility values (one per debunk
 * request — the plausibility of the BEST mundane explanation the AI
 * proposed that time). Insufficiency per request = 1 − maxPlausibility;
 * the result is the mean. Empty / all-invalid input → the default 0.18.
 */
export function computeH0Confidence(maxPlausibilities: readonly number[]): H0Confidence {
  const usable = maxPlausibilities.filter((p) => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1);
  if (usable.length === 0) return { value: AHT_H0_DEFAULT, fromData: false, n: 0 };
  const mean = usable.reduce((sum, p) => sum + (1 - p), 0) / usable.length;
  return { value: mean, fromData: true, n: usable.length };
}

/**
 * Derive the post-roll verdict from the H₀ confidence and the peak
 * posterior reached during the session.
 */
export function computeAhtVerdict(opts: { h0Confidence: number; peakPosterior: number }): AhtVerdictResult {
  if (opts.h0Confidence >= AHT_H0_SUSPEND_THRESHOLD) {
    return {
      verdict: "suspended",
      label: "INCONCLUSIVE",
      detail:
        "Model limitations exceed the evidence threshold — the AI debunker couldn't reliably propose mundane explanations, so no positive verdict is rendered.",
    };
  }
  const peak = opts.peakPosterior;
  if (peak >= POSTERIOR_THRESHOLDS.flag) {
    return {
      verdict: "unexplained",
      label: "UNEXPLAINED",
      detail:
        "Peak posterior crossed the flag threshold and survived adversarial debunking. This means 'still unexplained' — never 'confirmed paranormal'.",
    };
  }
  if (peak >= POSTERIOR_THRESHOLDS.inconclusive) {
    return {
      verdict: "inconclusive",
      label: "INCONCLUSIVE",
      detail:
        peak >= POSTERIOR_THRESHOLDS.elevated
          ? "Posterior reached the elevated band but not the flag threshold. Worth a follow-up session; not enough on its own."
          : "Some signal accumulated but stayed below the elevated band. Worth a follow-up; not enough on its own.",
    };
  }
  return {
    verdict: "null",
    label: "NULL",
    detail:
      "Nothing accumulated above the site noise floor. A quiet site is honest data — the base-rate dashboard counts it.",
  };
}
