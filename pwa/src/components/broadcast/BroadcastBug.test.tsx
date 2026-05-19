// @vitest-environment happy-dom

/**
 * BroadcastBug smoke test.
 *
 * Pure presentation component — the bug is the single most camera-visible
 * piece of broadcast chrome on the operator's screen AND in any recorded
 * clip downstream. A future copy edit or class rename should trip this
 * test rather than slipping through to a premiere recording.
 *
 * Coverage strategy
 * -----------------
 *   • Label set per state (STANDBY / READY / LIVE / REC) — these are the
 *     load-bearing badge labels a documentary OB van would burn into a
 *     feed; the lookup is hard-coded in the source so the test pins the
 *     literal strings.
 *   • Elapsed timecode rendering on non-idle states (mm:ss format).
 *   • State-specific class names. The actual colours live in CSS modules,
 *     so the test asserts the modifier class is applied — the CSS module
 *     guarantees the right tint once the class lands.
 *   • A11y contract: role=status + aria-live="polite" so screen readers
 *     announce state changes (STANDBY → REC) without being intrusive.
 *
 * The decorative SS signal-wave SVG already carries aria-hidden=true in
 * the source. We don't pin the SVG here because the wrapping <span> with
 * aria-hidden covers it — the assertion lives in the source already.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BroadcastBug } from "./BroadcastBug";

afterEach(() => {
  cleanup();
});

describe("<BroadcastBug />", () => {
  it("renders STANDBY label in idle state and omits the elapsed timecode", () => {
    render(<BroadcastBug state="idle" elapsedSec={0} />);
    expect(screen.getByText("STANDBY")).toBeInTheDocument();
    // Idle deliberately drops the elapsed counter — the bug reads as
    // "STANDBY" without a "00:00" trailing — assert the colon-pattern
    // doesn't appear.
    expect(screen.queryByText(/\d+:\d{2}/)).toBeNull();
  });

  it("renders READY label and applies the ready state class", () => {
    const { container } = render(<BroadcastBug state="ready" elapsedSec={0} />);
    expect(screen.getByText("READY")).toBeInTheDocument();
    // The CSS module hashes the class name; the literal token `ready`
    // appears in the hashed form (e.g. `_ready_abc123`). Match by suffix.
    const root = container.querySelector("[role='status']");
    const cls = root?.className ?? "";
    expect(cls).toMatch(/ready/);
  });

  it("renders LIVE label and applies the live state class (cyan halo tint)", () => {
    const { container } = render(<BroadcastBug state="live" elapsedSec={83} />);
    expect(screen.getByText("LIVE")).toBeInTheDocument();
    const root = container.querySelector("[role='status']");
    const cls = root?.className ?? "";
    expect(cls).toMatch(/live/);
  });

  it("renders REC label + elapsed mm:ss (0:42 for 42 seconds) and applies the danger-tint class", () => {
    const { container } = render(<BroadcastBug state="rec" elapsedSec={42} />);
    expect(screen.getByText("REC")).toBeInTheDocument();
    // mm:ss with zero-padded minutes (00:42).
    expect(screen.getByText("00:42")).toBeInTheDocument();
    const root = container.querySelector("[role='status']");
    const cls = root?.className ?? "";
    expect(cls).toMatch(/rec/);
  });

  it("formats two-digit minutes correctly (mm:ss for 125s = 02:05)", () => {
    render(<BroadcastBug state="rec" elapsedSec={125} />);
    expect(screen.getByText("02:05")).toBeInTheDocument();
  });

  it("announces state + elapsed via aria-label (role=status + aria-live=polite)", () => {
    const { container } = render(<BroadcastBug state="rec" elapsedSec={42} />);
    const root = container.querySelector("[role='status']");
    expect(root).not.toBeNull();
    expect(root?.getAttribute("aria-live")).toBe("polite");
    // The full aria-label contains the human label + elapsed — that's
    // what a screen reader announces on a state transition.
    expect(root?.getAttribute("aria-label")).toContain("REC");
    expect(root?.getAttribute("aria-label")).toContain("00:42");
  });

  it("idle state aria-label drops the elapsed timecode (STANDBY only)", () => {
    const { container } = render(<BroadcastBug state="idle" elapsedSec={0} />);
    const root = container.querySelector("[role='status']");
    const label = root?.getAttribute("aria-label") ?? "";
    expect(label).toContain("STANDBY");
    // No colon-and-digits pattern in the idle announcement.
    expect(label).not.toMatch(/\d+:\d{2}/);
  });
});
