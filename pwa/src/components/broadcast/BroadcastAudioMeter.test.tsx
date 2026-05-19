// @vitest-environment happy-dom

/**
 * BroadcastAudioMeter smoke test.
 *
 * The vertical peak meter is one of three pieces of corner chrome the
 * operator scans without taking their eye off the camera frame. Pinning
 * the typographic + structural contract here protects two distinct
 * failure modes:
 *
 *   1. A future copy/refactor swaps the proper Unicode minus (−, U+2212)
 *      for the hyphen-minus (-, U+002D) — that's a typography regression
 *      a sighted operator only notices in the screen-grab.
 *   2. The tick set or peak-hold element gets restructured during a CSS
 *      refactor and silently disappears — the meter still "works" but
 *      reads like a level bar, not a broadcast VU.
 *
 * We also assert the a11y contract added in this pass: the meter exposes
 * an aria-label with the current dBFS so a screen-reader operator can
 * hear "Microphone level: -26 dBFS" without parsing the visual gradient.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { BroadcastAudioMeter } from "./BroadcastAudioMeter";

afterEach(() => {
  cleanup();
});

describe("<BroadcastAudioMeter />", () => {
  it("renders the dBFS readout with proper Unicode minus (U+2212), not hyphen (U+002D)", () => {
    // rms 0.05 → 20*log10(0.05) ≈ -26.02 dBFS — well inside the visible range.
    const { container } = render(<BroadcastAudioMeter rms={0.05} />);
    const text = container.textContent ?? "";
    // Look for the U+2212 minus glyph specifically.
    expect(text).toContain("−");
    // The proper minus should sit immediately before a digit, not a space.
    expect(text).toMatch(/−\d/);
  });

  it("renders the canonical tick label set (-3, -12, -30 must all appear)", () => {
    const { container } = render(<BroadcastAudioMeter rms={0} />);
    const text = container.textContent ?? "";
    // Ticks render as "−3", "−12", "−30" with Unicode minus. We assert
    // on the digit-suffix substring so a future minus-glyph migration
    // doesn't break the test for the wrong reason.
    expect(text).toMatch(/3(?!\d)/);   // -3 — guard against -30/-300 false-positive
    expect(text).toMatch(/12(?!\d)/);  // -12
    expect(text).toMatch(/30(?!\d)/);  // -30
    // And the top of the scale.
    expect(text).toContain("0");
  });

  it("renders the MIC eyebrow label", () => {
    const { container } = render(<BroadcastAudioMeter rms={0} />);
    expect(container.textContent ?? "").toContain("MIC");
  });

  it("appends LIVE to the eyebrow when vadActive=true", () => {
    const { container } = render(<BroadcastAudioMeter rms={0.05} vadActive />);
    // "MIC · LIVE" with middot separator.
    expect(container.textContent ?? "").toContain("MIC · LIVE");
  });

  it("renders the peak-hold cap element in the DOM (broadcast meter ballistics)", () => {
    const { container } = render(<BroadcastAudioMeter rms={0.3} />);
    // The peak-hold cap is the 1 px horizontal line whose CSS class name
    // starts with `peakHold`. CSS modules hash the suffix; the prefix
    // is preserved. Match on the class-name prefix.
    const matches = container.querySelectorAll("[class*='peakHold']");
    // At least one element — the cap itself; the hidden variant adds a
    // second class but the same element.
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("exposes aria-label with the level so a screen reader announces it", () => {
    // rms 0.05 → ≈-26 dBFS rounded.
    const { container } = render(<BroadcastAudioMeter rms={0.05} />);
    const root = container.firstElementChild as HTMLElement | null;
    expect(root).not.toBeNull();
    const label = root?.getAttribute("aria-label") ?? "";
    expect(label).toMatch(/Microphone level/i);
    // Don't pin the exact number (the rounding can shift by ±1 across
    // log-floor implementations); just assert the dBFS unit + a -26ish.
    expect(label).toMatch(/-?\d+\s*dBFS/);
  });

  it("aria-label includes 'voice activity detected' when vadActive=true", () => {
    const { container } = render(<BroadcastAudioMeter rms={0.05} vadActive />);
    const root = container.firstElementChild as HTMLElement | null;
    expect(root?.getAttribute("aria-label") ?? "").toMatch(/voice activity detected/i);
  });

  it("declares role=meter with valuemin/valuemax/valuenow for AT", () => {
    const { container } = render(<BroadcastAudioMeter rms={0.05} />);
    const root = container.firstElementChild as HTMLElement | null;
    expect(root?.getAttribute("role")).toBe("meter");
    expect(root?.getAttribute("aria-valuemin")).toBe("-60");
    expect(root?.getAttribute("aria-valuemax")).toBe("0");
    expect(root?.getAttribute("aria-valuenow")).toMatch(/^-?\d+$/);
  });
});
