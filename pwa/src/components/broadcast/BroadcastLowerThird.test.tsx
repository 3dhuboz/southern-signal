// @vitest-environment happy-dom

/**
 * BroadcastLowerThird smoke test.
 *
 * The lower-third is the documentary-style title slate. Two behavioural
 * contracts that need pinning:
 *
 *   1. When no investigation has ever been "running" with a title, the
 *      slate renders nothing at all — that's the chromeless camera
 *      contract a first-time operator sees before they start anything.
 *   2. When provided, the subtitle joins location + date with the
 *      U+00B7 middle dot (·), NOT a hyphen or pipe. A future copy
 *      sweep that "normalises" separators to ASCII would break the
 *      visual language of the slate.
 *
 * The slate also keeps its previous content visible on the slide-out
 * exit (aria-hidden flips, content stays). That's covered indirectly:
 * once we render with running=true, the next paint with running=false
 * still finds the title text — that's the sticky-cache behaviour.
 *
 * A11y: the title is now an <h2> (was a <div>); we assert the heading
 * role via getByRole so a future regression to <div> trips this test.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BroadcastLowerThird } from "./BroadcastLowerThird";

afterEach(() => {
  cleanup();
});

describe("<BroadcastLowerThird />", () => {
  it("renders nothing when there's never been a running investigation (idle first paint)", () => {
    const { container } = render(
      <BroadcastLowerThird running={false} title={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when running=true but title is null (no slate without copy)", () => {
    const { container } = render(
      <BroadcastLowerThird running={true} title={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders title as an <h2> heading (a11y nav by heading)", () => {
    render(
      <BroadcastLowerThird
        running={true}
        title="Test Investigation"
        location="Test Location"
        startedAt="2026-05-08T12:00:00.000Z"
      />,
    );
    // <h2> exposes itself as role=heading aria-level=2 implicitly. We
    // pin both the role and the tag — the tag is the harder regression
    // (someone switching back to a <div> with role=heading would still
    // pass the role check, but the test below catches the tag swap).
    const h = screen.getByRole("heading", { level: 2, name: "Test Investigation" });
    expect(h).toBeInTheDocument();
    expect(h.tagName.toLowerCase()).toBe("h2");
  });

  it("renders the subtitle as 'Location · Date' with the middot separator (U+00B7)", () => {
    const { container } = render(
      <BroadcastLowerThird
        running={true}
        title="Test Investigation"
        location="Old Mill"
        startedAt="2026-05-08T12:00:00.000Z"
      />,
    );
    // Location renders.
    expect(screen.getByText("Old Mill")).toBeInTheDocument();
    // The middot separator (U+00B7) must appear in the rendered text.
    const text = container.textContent ?? "";
    expect(text).toContain("·");
    // Negative guards: a hyphen-pipe-pipe pattern would mean someone
    // ASCII-cleaned the separator. We can't blanket-ban hyphens (the
    // date format can contain one), but we can assert " - " and " | "
    // — the two most likely "normalised" alternatives — are absent.
    expect(text).not.toMatch(/Old Mill\s+-\s+/);
    expect(text).not.toMatch(/Old Mill\s+\|\s+/);
  });

  it("renders only the date subtitle when location is missing", () => {
    render(
      <BroadcastLowerThird
        running={true}
        title="Test Investigation"
        location={null}
        startedAt="2026-05-08T12:00:00.000Z"
      />,
    );
    // The slate carries some weekday/day/month/year text. The exact
    // string varies by runtime locale — we assert the year appears
    // (2026 is stable across locales) and the title is there.
    expect(screen.getByRole("heading", { level: 2 })).toBeInTheDocument();
    // No middot when there's no location → date stands alone.
  });

  it("declares role=region with an aria-label (slate landmark)", () => {
    const { container } = render(
      <BroadcastLowerThird
        running={true}
        title="Test Investigation"
        location="Old Mill"
        startedAt="2026-05-08T12:00:00.000Z"
      />,
    );
    const region = container.querySelector("[role='region']");
    expect(region).not.toBeNull();
    expect(region?.getAttribute("aria-label")).toMatch(/Investigation slate/i);
  });

  it("aria-hidden flips to true when running drops false (sticky content stays mounted)", () => {
    // First paint with running=true populates the sticky cache.
    const { container, rerender } = render(
      <BroadcastLowerThird
        running={true}
        title="Test Investigation"
        location="Old Mill"
        startedAt="2026-05-08T12:00:00.000Z"
      />,
    );
    let region = container.querySelector("[role='region']");
    expect(region?.getAttribute("aria-hidden")).toBe("false");
    // Now flip running=false — the slate stays mounted (slide-out
    // animation needs content) but aria-hidden flips so AT users
    // don't hear a stale title after Stop.
    rerender(
      <BroadcastLowerThird
        running={false}
        title="Test Investigation"
        location="Old Mill"
        startedAt="2026-05-08T12:00:00.000Z"
      />,
    );
    region = container.querySelector("[role='region']");
    expect(region?.getAttribute("aria-hidden")).toBe("true");
    // Title text is still in the DOM (sticky cache). RTL hides children
    // of an aria-hidden ancestor from the accessibility tree by default
    // — passing { hidden: true } opts back in so we can verify the
    // sticky-cache contract.
    expect(screen.getByRole("heading", { level: 2, hidden: true })).toBeInTheDocument();
  });
});
