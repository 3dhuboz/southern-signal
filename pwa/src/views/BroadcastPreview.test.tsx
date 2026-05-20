// @vitest-environment happy-dom

/**
 * Smoke test for the BroadcastPreview view.
 *
 * BroadcastPreview is the design-review surface for the broadcast HUD — it
 * mounts the six broadcast components against a placeholder backdrop in
 * each of the four status states (idle / ready / rec / live). The view is
 * presentational only (no data layer, no router-dependent loaders) so the
 * smoke test just needs to prove that:
 *
 *   1. The page mounts and the heading renders.
 *   2. All four status frames render with their canonical captions.
 *
 * Anything beyond that is covered by the individual broadcast components'
 * own tests (or — for chrome that's still visual-only — by manual review at
 * /preview/broadcast in dev).
 *
 * Routing: the page uses <Link> for the back-link, so it has to mount
 * inside a <MemoryRouter>. No route params are consumed.
 *
 * Theme application: applyTheme() touches document.documentElement which
 * happy-dom provides; usePreferences reads localStorage which happy-dom
 * also provides. No mocks required for either.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { BroadcastPreview } from "./BroadcastPreview";

afterEach(() => {
  cleanup();
});

describe("<BroadcastPreview />", () => {
  it("renders the page heading + four broadcast frames with state captions", () => {
    render(
      <MemoryRouter>
        <BroadcastPreview />
      </MemoryRouter>,
    );

    // Page heading lands.
    expect(
      screen.getByRole("heading", { level: 1, name: /Broadcast HUD preview/i }),
    ).toBeInTheDocument();

    // All four frame captions render — these are the load-bearing labels
    // the design-review user scans to navigate the grid. Captions live in
    // the <figcaption> below each frame.
    expect(screen.getByText(/Standby \(idle\)/)).toBeInTheDocument();
    expect(screen.getByText(/Ready \(pre-roll\)/)).toBeInTheDocument();
    expect(screen.getByText(/Recording \(REC 0:42\)/)).toBeInTheDocument();
    expect(screen.getByText(/Going live \(LIVE 1:23\)/)).toBeInTheDocument();

    // Group landmarks — each frame is rendered as a role="group" with an
    // aria-label naming its variant. Four total. We assert on count rather
    // than per-name so a future caption tweak doesn't break the test.
    const groups = screen.getAllByRole("group", { name: /Broadcast HUD preview/ });
    expect(groups).toHaveLength(4);
  });

  // ── Per-frame composition rules ──────────────────────────────────────────
  //
  // The component-level snapshot tests pin each broadcast component's DOM in
  // isolation. What they CAN'T catch is "BroadcastPreview accidentally
  // mounted AudioMeter on the STANDBY frame" — a composition bug. These
  // tests pin the running-gate contract (which is the same gate CameraScreen
  // uses in production, so a desync here predicts a desync there).

  it("STANDBY frame omits AudioMeter, SensorHud, LowerThird (production-running-gate parity)", () => {
    render(
      <MemoryRouter>
        <BroadcastPreview />
      </MemoryRouter>,
    );
    const standby = screen.getByRole("group", { name: /Standby \(idle\)/ });
    // AudioMeter mounts as role="meter". Standby must NOT contain one.
    expect(within(standby).queryByRole("meter")).toBeNull();
    // SensorHud mounts as role="group" labelled "Live sensor readings".
    expect(within(standby).queryByRole("group", { name: /Live sensor readings/i })).toBeNull();
    // LowerThird mounts as role="region" labelled "Investigation slate".
    expect(within(standby).queryByRole("region", { name: /Investigation slate/i })).toBeNull();
    // BroadcastBug and BroadcastSceneSelector are always rendered — verify
    // STANDBY still has them so the omissions are intentional, not a mount
    // failure.
    expect(within(standby).getByRole("status")).toBeInTheDocument();
    expect(within(standby).getByRole("button", { name: /Scene: Walkthrough/ })).toBeInTheDocument();
  });

  it("each running frame mounts AudioMeter + SensorHud + LowerThird (the full HUD)", () => {
    render(
      <MemoryRouter>
        <BroadcastPreview />
      </MemoryRouter>,
    );
    for (const captionRe of [/Ready \(pre-roll\)/, /Recording \(REC 0:42\)/, /Going live \(LIVE 1:23\)/]) {
      const frame = screen.getByRole("group", { name: captionRe });
      expect(within(frame).getByRole("meter")).toBeInTheDocument();
      expect(within(frame).getByRole("group", { name: /Live sensor readings/i })).toBeInTheDocument();
      expect(within(frame).getByRole("region", { name: /Investigation slate/i })).toBeInTheDocument();
    }
  });

  // ── Header preview-controls ──────────────────────────────────────────────
  //
  // The theme toggle is the visual differentiator for the design-review
  // session — losing a segment silently would force the reviewer to leave
  // the page to compare scotopic vs daylight. Pin all three.

  it("theme segmented control renders all three options as radios", () => {
    render(
      <MemoryRouter>
        <BroadcastPreview />
      </MemoryRouter>,
    );
    const themeGroup = screen.getByRole("radiogroup", { name: /Theme/i });
    const radios = within(themeGroup).getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios.map((r) => r.textContent)).toEqual(["phosphor", "scotopic", "daylight"]);
    // The default radio (phosphor) is the only one checked at mount because
    // usePreferences() returns the persisted default; no other radio should
    // already be aria-checked or screen readers would announce two states.
    const checked = radios.filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
  });

  it("reduced-motion toggle flips the page-level data attribute", () => {
    render(
      <MemoryRouter>
        <BroadcastPreview />
      </MemoryRouter>,
    );
    const toggle = screen.getByRole("checkbox", { name: /Reduced motion/i });
    // The data attribute is on the .page root that wraps everything; we read
    // it via the toggle's nearest data-prefers-reduced-motion ancestor so
    // this test stays decoupled from any DOM-tree restructure that doesn't
    // change the contract.
    const page = toggle.closest("[data-prefers-reduced-motion]");
    expect(page).not.toBeNull();
    expect(page!.getAttribute("data-prefers-reduced-motion")).toBe("no-preference");
    fireEvent.click(toggle);
    expect(page!.getAttribute("data-prefers-reduced-motion")).toBe("reduce");
  });
});
