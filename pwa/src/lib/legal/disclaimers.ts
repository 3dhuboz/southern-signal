/**
 * Standing disclaimers — frozen at module load.
 *
 * Hard constraint from southern_signal_premiere_headline.md (2026-05-08):
 * the eight standing disclaimers SHIP at module load and cannot be
 * removed at runtime. This file is the single source of truth.
 *
 * The constants are exported as a deep-frozen array so any code path
 * that tries to mutate (e.g. `STANDING_DISCLAIMERS.pop()`) throws in
 * strict mode. The render layer iterates the array; it does NOT
 * hand-type each sentence into JSX. That is the contract that makes a
 * future copy-tidying pass unable to silently delete a disclaimer.
 *
 * The ENTERTAINMENT_ONLY_LABEL is a separate, prominent, always-on
 * surface: a small fixed-position banner that the render layer of every
 * Case Card / session screen must include. It is NOT removable at
 * runtime. Hard constraint #3 from the customer-readiness brief.
 */

/**
 * The 8 disclaimers, in the canonical order they appear in
 * southern_signal_premiere_headline.md §51-60.
 *
 * Each entry includes:
 *  - id: stable identifier for tests / analytics.
 *  - text: the exact sentence as it must appear on screen / in print.
 *  - context: where this disclaimer is most load-bearing (informational only).
 */
export interface Disclaimer {
  readonly id: string;
  readonly text: string;
  readonly context: string;
}

export const STANDING_DISCLAIMERS: ReadonlyArray<Disclaimer> = Object.freeze([
  Object.freeze({
    id: "sector-accuracy",
    text: "Sector accuracy ±60°. Posterior is a model estimate, not a measurement of presence.",
    context: "Every frame footer (acoustician sign-off requirement).",
  }),
  Object.freeze({
    id: "calibration-required",
    text: "Calibration is mandatory at every session start. Failure marks the instrument DEGRADED and sector readings render grey for the rest of the session.",
    context: "Pre-air calibration ritual gating.",
  }),
  Object.freeze({
    id: "threshold-labels",
    text: "Posterior thresholds (INCONCLUSIVE / ELEVATED / FLAG) are burned into the Posterior Bar and cannot be cropped without revealing the crop.",
    context: "PosteriorBar uncroppable threshold labels.",
  }),
  Object.freeze({
    id: "lr-channel-attribution",
    text: "Every log-odds increment is labelled with its likelihood ratio AND the sensor channel that produced it. No movement is unlabelled.",
    context: "PosteriorBar inline annotations.",
  }),
  Object.freeze({
    id: "aht-h0-visible",
    text: "AHT post-roll review surfaces the H₀ (AI insufficiency confidence). When H₀ exceeds 0.4 the verdict is INCONCLUSIVE — never confirmed.",
    context: "AHT post-roll renderer.",
  }),
  Object.freeze({
    id: "hash-chain-receipts",
    text: "A hash-chained audit log of every prompt, response, sensor frame, and posterior increment is downloadable from every export bundle.",
    context: "Forensic chain receipts.",
  }),
  Object.freeze({
    id: "no-degrees-no-sigma",
    text: "No bearing in degrees. No σ values. These are hard-coded out of the renderer.",
    context: "ASI sector-only quantisation.",
  }),
  Object.freeze({
    id: "aht-eliminates-not-confirms",
    text: "AHT eliminates explanations; it does not confirm causes.",
    context: "Permanent post-roll AHT segment banner.",
  }),
]);

/**
 * Entertainment-only label.
 *
 * Hard constraint #3: an Entertainment-only label must appear at the
 * render layer of every Case Card / session screen. It cannot be
 * removed at runtime.
 *
 * The label is intentionally short — long enough to be readable on a
 * 360 px phone, short enough to live inside a fixed-position banner
 * that does not eat the live video frame.
 */
export const ENTERTAINMENT_ONLY_LABEL =
  "For entertainment & research purposes only. Not scientific proof of paranormal activity.";

/**
 * Frozen list-style accessor for tests + the disclaimer-rendering helper.
 * Returns the canonical array; mutating it throws under strict mode.
 */
export function getStandingDisclaimers(): ReadonlyArray<Disclaimer> {
  return STANDING_DISCLAIMERS;
}

/**
 * Returns the entertainment-only label exactly as it must appear in the UI.
 * A helper exists rather than a bare string export so callers go through
 * one place — and so a future i18n pass has one chokepoint.
 */
export function getEntertainmentOnlyLabel(): string {
  return ENTERTAINMENT_ONLY_LABEL;
}

// Sanity assertion at module load: catches the failure mode where a
// future refactor accidentally wipes the array. Module load fails loudly
// instead of silently shipping zero disclaimers. The assertion runs once
// per worker, so the perf cost is irrelevant.
if (STANDING_DISCLAIMERS.length !== 8) {
  throw new Error(
    `Standing disclaimers must be exactly 8; got ${STANDING_DISCLAIMERS.length}. ` +
      `See southern_signal_premiere_headline.md §51-60.`,
  );
}
if (!ENTERTAINMENT_ONLY_LABEL || ENTERTAINMENT_ONLY_LABEL.length === 0) {
  throw new Error("Entertainment-only label must be non-empty (hard constraint #3).");
}
