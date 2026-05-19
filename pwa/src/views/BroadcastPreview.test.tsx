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
import { cleanup, render, screen } from "@testing-library/react";
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
});
