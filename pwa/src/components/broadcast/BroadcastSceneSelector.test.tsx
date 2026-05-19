// @vitest-environment happy-dom

/**
 * BroadcastSceneSelector smoke test.
 *
 * The chip lives top-right of the camera frame. Three load-bearing
 * pieces of contract that should be pinned:
 *
 *   1. Scene name renders display-cased (the picker should not SHOUT
 *      "WALKTHROUGH" into the broadcast frame; the parent controls
 *      casing and the chip must respect it).
 *   2. The chevron is an SVG, not the unicode ▼ glyph the old chip
 *      used — ▼ rendered inconsistently across Android Chrome / iOS
 *      Safari and we replaced it on purpose.
 *   3. Semantics: it's a <button> (not a div with onClick), it has an
 *      aria-label, and the chevron is aria-hidden so the AT
 *      announcement reads cleanly.
 *
 * The fireEvent click is the canonical "did the prop get wired" check —
 * not strictly a smoke concern, but cheap to include.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BroadcastSceneSelector } from "./BroadcastSceneSelector";

afterEach(() => {
  cleanup();
});

describe("<BroadcastSceneSelector />", () => {
  it("renders the scene name exactly as provided (display case respected)", () => {
    render(<BroadcastSceneSelector sceneName="Walkthrough" onOpen={() => {}} />);
    expect(screen.getByText("Walkthrough")).toBeInTheDocument();
    // No uppercase variant in the DOM.
    expect(screen.queryByText("WALKTHROUGH")).toBeNull();
    // Nor lowercase.
    expect(screen.queryByText("walkthrough")).toBeNull();
  });

  it("renders the SCENE eyebrow above the name", () => {
    render(<BroadcastSceneSelector sceneName="Walkthrough" onOpen={() => {}} />);
    expect(screen.getByText("SCENE")).toBeInTheDocument();
  });

  it("respects a custom eyebrow prop (so investigator surfaces can re-purpose the chip)", () => {
    render(<BroadcastSceneSelector sceneName="Walkthrough" eyebrow="MODE" onOpen={() => {}} />);
    expect(screen.getByText("MODE")).toBeInTheDocument();
  });

  it("renders an <svg> chevron (NOT the unicode ▼ glyph)", () => {
    const { container } = render(<BroadcastSceneSelector sceneName="Walkthrough" onOpen={() => {}} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    // The decorative chevron must be aria-hidden so the chip's
    // aria-label is the only thing the AT announces.
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    // And the unicode glyph absolutely must not appear anywhere — the
    // old chip rendered ▼ literally and we replaced it on purpose.
    expect(container.textContent ?? "").not.toContain("▼");
  });

  it("is a real <button> with proper button semantics + aria-haspopup", () => {
    render(<BroadcastSceneSelector sceneName="Walkthrough" onOpen={() => {}} />);
    const btn = screen.getByRole("button", { name: /Scene: Walkthrough/i });
    expect(btn).toBeInTheDocument();
    // Belt-and-braces: assert the tag name as well as the role.
    expect(btn.tagName.toLowerCase()).toBe("button");
    // The chip opens a sheet (dialog-style picker), so aria-haspopup is
    // the right hint for an AT.
    expect(btn.getAttribute("aria-haspopup")).toBe("dialog");
    // Defensive: type="button" prevents the chip from accidentally
    // submitting a form if it's ever nested inside one.
    expect(btn.getAttribute("type")).toBe("button");
  });

  it("invokes onOpen on click", () => {
    const onOpen = vi.fn();
    render(<BroadcastSceneSelector sceneName="Walkthrough" onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /Scene: Walkthrough/i }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("aria-label includes both the scene name AND the call-to-action", () => {
    render(<BroadcastSceneSelector sceneName="Walkthrough" onOpen={() => {}} />);
    const btn = screen.getByRole("button", { name: /Scene: Walkthrough\. Tap to change\./i });
    expect(btn).toBeInTheDocument();
  });
});
