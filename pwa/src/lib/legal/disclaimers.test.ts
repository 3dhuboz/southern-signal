/**
 * Tests for src/lib/legal/disclaimers.ts.
 *
 * Hard constraint #2 (8 disclaimers) and #3 (entertainment-only label)
 * say these MUST exist as module-load constants that cannot be removed
 * at runtime. The tests assert the count, the freeze status, and the
 * non-emptiness so any future PR that quietly drops a disclaimer fails
 * CI rather than shipping silently.
 */

import { describe, expect, it } from "vitest";
import {
  ENTERTAINMENT_ONLY_LABEL,
  STANDING_DISCLAIMERS,
  getEntertainmentOnlyLabel,
  getStandingDisclaimers,
} from "./disclaimers";

describe("STANDING_DISCLAIMERS", () => {
  it("contains exactly 8 disclaimers (premiere-headline contract)", () => {
    expect(STANDING_DISCLAIMERS).toHaveLength(8);
  });

  it("is frozen at module load (mutation throws in strict mode)", () => {
    expect(Object.isFrozen(STANDING_DISCLAIMERS)).toBe(true);
    // Each entry is independently frozen so an attacker that gets a
    // reference to a single item still can't rewrite its text.
    for (const d of STANDING_DISCLAIMERS) {
      expect(Object.isFrozen(d)).toBe(true);
    }
  });

  it("every entry has a non-empty id, text, and context", () => {
    for (const d of STANDING_DISCLAIMERS) {
      expect(d.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(d.text.length).toBeGreaterThan(0);
      expect(d.context.length).toBeGreaterThan(0);
    }
  });

  it("ids are unique", () => {
    const ids = STANDING_DISCLAIMERS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes the canonical premiere-headline sentences", () => {
    const all = STANDING_DISCLAIMERS.map((d) => d.text).join(" ");
    expect(all).toMatch(/Sector accuracy ±60°/);
    expect(all).toMatch(/Posterior is a model estimate/);
    expect(all).toMatch(/AHT eliminates explanations/);
    expect(all).toMatch(/No bearing in degrees/);
    expect(all).toMatch(/likelihood ratio/);
    expect(all).toMatch(/H₀/);
  });

  it("getStandingDisclaimers returns the same frozen array", () => {
    expect(getStandingDisclaimers()).toBe(STANDING_DISCLAIMERS);
  });
});

describe("ENTERTAINMENT_ONLY_LABEL", () => {
  it("is a non-empty string", () => {
    expect(typeof ENTERTAINMENT_ONLY_LABEL).toBe("string");
    expect(ENTERTAINMENT_ONLY_LABEL.length).toBeGreaterThan(0);
  });

  it("mentions 'entertainment' (constraint #3)", () => {
    expect(ENTERTAINMENT_ONLY_LABEL.toLowerCase()).toContain("entertainment");
  });

  it("disclaims scientific proof", () => {
    expect(ENTERTAINMENT_ONLY_LABEL.toLowerCase()).toMatch(/not scientific|not proof|research purposes/);
  });

  it("getEntertainmentOnlyLabel returns the same string", () => {
    expect(getEntertainmentOnlyLabel()).toBe(ENTERTAINMENT_ONLY_LABEL);
  });
});
