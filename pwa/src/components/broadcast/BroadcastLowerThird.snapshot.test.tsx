// @vitest-environment happy-dom

/**
 * BroadcastLowerThird DOM-structure snapshots.
 *
 * The slate is mounted unconditionally once it's had a title so the
 * slide-out CSS transition has a frame to run on. The `running` prop
 * toggles `.visible` ↔ `.hidden` className modifiers + the `aria-hidden`
 * attribute. These snapshots pin both:
 *
 *   1. The null-on-first-paint branch (no sticky title yet)
 *   2. The full-slate render (title + location + date)
 *   3. The no-location branch (the · separator must NOT appear)
 *   4. The hidden-but-mounted branch (after running flips false)
 *
 * Locale handling: fmtDate calls Date.prototype.toLocaleDateString which
 * varies across CI vs local. We pin it to a deterministic string so the
 * snapshot is reproducible.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("./BroadcastLowerThird.module.css", () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}));

import { BroadcastLowerThird } from "./BroadcastLowerThird";

beforeEach(() => {
  // Pin locale-dependent date formatting. The slate burns this into the
  // muted subtitle so a 1-character drift here would be a visible diff
  // every time CI's locale skewed from a contributor's machine.
  vi.spyOn(Date.prototype, "toLocaleDateString").mockReturnValue("Wed 8 May 2026");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<BroadcastLowerThird /> DOM snapshot", () => {
  it("renders nothing when never running + no sticky title yet", () => {
    const { container } = render(
      <BroadcastLowerThird running={false} title={null} />,
    );
    // Pure short-circuit before any sticky cache lands — container is
    // empty rather than holding a hidden slate.
    expect(container.firstChild).toMatchInlineSnapshot(`null`);
  });

  it("running + title + location + startedAt → full slate visible", () => {
    const { container } = render(
      <BroadcastLowerThird
        running={true}
        title="Cold Spot Sweep"
        location="Hill End Hospital, NSW"
        startedAt="2026-05-08T12:00:00.000Z"
      />,
    );
    expect(container.firstChild).toMatchInlineSnapshot(`
      <div
        aria-hidden="false"
        aria-label="Investigation slate"
        class="slate visible"
        data-hud-drag-target="lowerThird"
        role="region"
      >
        <h2
          class="title"
        >
          Cold Spot Sweep
        </h2>
        <div
          class="subtitle"
        >
          <span
            class="location"
          >
            Hill End Hospital, NSW
          </span>
          <span
            aria-hidden="true"
            class="sep"
          >
            ·
          </span>
          <span
            class="date"
          >
            Wed 8 May 2026
          </span>
        </div>
      </div>
    `);
  });

  it("running + title only (no location) → · separator absent", () => {
    const { container } = render(
      <BroadcastLowerThird
        running={true}
        title="Walkthrough"
        location={null}
        startedAt="2026-05-08T12:00:00.000Z"
      />,
    );
    expect(container.firstChild).toMatchInlineSnapshot(`
      <div
        aria-hidden="false"
        aria-label="Investigation slate"
        class="slate visible"
        data-hud-drag-target="lowerThird"
        role="region"
      >
        <h2
          class="title"
        >
          Walkthrough
        </h2>
        <div
          class="subtitle"
        >
          <span
            class="date"
          >
            Wed 8 May 2026
          </span>
        </div>
      </div>
    `);
  });

  it("rerender to running=false keeps the sticky title but hides + aria-hides", () => {
    const { container, rerender } = render(
      <BroadcastLowerThird
        running={true}
        title="EVP Capture"
        location="Roslyn Park Asylum"
        startedAt="2026-05-08T12:00:00.000Z"
      />,
    );
    rerender(
      <BroadcastLowerThird
        running={false}
        title="EVP Capture"
        location="Roslyn Park Asylum"
        startedAt="2026-05-08T12:00:00.000Z"
      />,
    );
    expect(container.firstChild).toMatchInlineSnapshot(`
      <div
        aria-hidden="true"
        aria-label="Investigation slate"
        class="slate hidden"
        data-hud-drag-target="lowerThird"
        role="region"
      >
        <h2
          class="title"
        >
          EVP Capture
        </h2>
        <div
          class="subtitle"
        >
          <span
            class="location"
          >
            Roslyn Park Asylum
          </span>
          <span
            aria-hidden="true"
            class="sep"
          >
            ·
          </span>
          <span
            class="date"
          >
            Wed 8 May 2026
          </span>
        </div>
      </div>
    `);
  });
});
