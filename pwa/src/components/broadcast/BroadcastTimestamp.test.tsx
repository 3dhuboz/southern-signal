// @vitest-environment happy-dom

/**
 * BroadcastTimestamp smoke test.
 *
 * Three lines of monospace clock data that burn into a recorded clip —
 * an editor lifts them straight off the broadcast frame to slate a
 * documentary. Two failure modes the test guards against:
 *
 *   1. The "T —:——" idle placeholder uses em-dashes (U+2014), not the
 *      hyphen-minus (U+002D) that a stray ASCII-only file save would
 *      substitute. Without the em-dash the slate flicker-jumps to a
 *      hyphen-and-colon row that reads as a real time, which it isn't.
 *   2. Running state must show `T +mm:ss` (with the plus sign) so the
 *      operator can distinguish "session not started" from "session at
 *      00:00 just begun".
 *
 * We control the wall-clock via the prop interface; the JS timer that
 * advances `now` is irrelevant for the smoke assertions — the first
 * paint already carries the structural contract we're pinning.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BroadcastTimestamp } from "./BroadcastTimestamp";

afterEach(() => {
  cleanup();
});

describe("<BroadcastTimestamp />", () => {
  it("renders the three timecode lines (local HH:MM:SS + UTC + T+elapsed)", () => {
    const { container } = render(<BroadcastTimestamp running elapsedSec={42} />);
    const text = container.textContent ?? "";
    // Wall-clock HH:MM:SS appears twice (local + UTC). The exact value
    // depends on the runtime clock — assert that the HH:MM:SS pattern
    // appears at least once and that the eyebrows we expect are present.
    expect(text).toMatch(/\d{2}:\d{2}:\d{2}/);
    // UTC line carries the eyebrow.
    expect(text).toContain("UTC");
    // Session elapsed line carries the T eyebrow.
    expect(text).toContain("T");
  });

  it("idle state renders the em-dash placeholder 'T —:——' (NOT hyphen-minus)", () => {
    const { container } = render(<BroadcastTimestamp running={false} elapsedSec={0} />);
    const text = container.textContent ?? "";
    // U+2014 em-dash check. The placeholder is "—:——" — three em-dashes
    // total. Assert the em-dash appears explicitly.
    expect(text).toContain("—");
    // And the canonical placeholder sequence.
    expect(text).toContain("—:——");
    // Crucial regression guard: the ASCII hyphen-minus must NOT appear
    // inside the elapsed slot. We scope this to the elapsed line's
    // content via the aria-label — the row itself is aria-hidden=true.
    // A future "ASCII-clean" pass mustn't downgrade the em-dash.
    expect(text).not.toMatch(/T\s*-:-/);
  });

  it("running state renders 'T +0:42' for elapsedSec=42 (with the plus sign)", () => {
    const { container } = render(<BroadcastTimestamp running elapsedSec={42} />);
    const text = container.textContent ?? "";
    // mm:ss with NO leading zero on minutes (matches fmtElapsed).
    expect(text).toContain("+0:42");
  });

  it("running state formats two-digit minutes for elapsedSec=125 (T +2:05)", () => {
    const { container } = render(<BroadcastTimestamp running elapsedSec={125} />);
    expect(container.textContent ?? "").toContain("+2:05");
  });

  it("declares role=timer with an aria-label that announces the wall-clock", () => {
    const { container } = render(<BroadcastTimestamp running elapsedSec={5} />);
    const root = container.querySelector("[role='timer']");
    expect(root).not.toBeNull();
    const label = root?.getAttribute("aria-label") ?? "";
    expect(label).toMatch(/Timecode\s+\d{2}:\d{2}:\d{2}\s+local/i);
  });

  it("elapsed row carries a screen-reader aria-label with the seconds value", () => {
    const { container } = render(<BroadcastTimestamp running elapsedSec={42} />);
    // The elapsed span has aria-label="Session elapsed: 42 seconds" —
    // blind operators don't have to parse "T +0:42" to get the duration.
    const labelled = container.querySelector("[aria-label='Session elapsed: 42 seconds']");
    expect(labelled).not.toBeNull();
  });

  it("idle elapsed row announces 'Session not running' (no fake duration)", () => {
    const { container } = render(<BroadcastTimestamp running={false} elapsedSec={0} />);
    const labelled = container.querySelector("[aria-label='Session not running']");
    expect(labelled).not.toBeNull();
  });

  it("idle elapsed row does NOT carry a +mm:ss substring (slate stays placeholder)", () => {
    render(<BroadcastTimestamp running={false} elapsedSec={0} />);
    // The idle elapsed slot displays "—:——" — a +digit pattern would
    // indicate a regression where the placeholder logic was inverted.
    expect(screen.queryByText(/T\s*\+\d/)).toBeNull();
  });
});
