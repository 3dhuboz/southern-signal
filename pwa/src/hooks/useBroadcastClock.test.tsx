// @vitest-environment happy-dom

/**
 * useBroadcastClock + getBroadcastClockSnapshot unit tests.
 *
 * The hook is the shared time source that the on-screen BroadcastTimestamp
 * slate and the canvas compositor's burn-in both consume. Two failure modes
 * the test guards against:
 *
 *   1. Elapsed seconds disagree with the elapsedText pill — drift between
 *      these two views inside the same tick means an editor would see
 *      "T+0:42" on the slate and "00:00:42" on the burn-in differ across
 *      frame boundaries.
 *   2. The pure formatter and the hook can fall out of sync — both must
 *      agree exactly for the same inputs, since the compositor uses the
 *      pure formatter while the React DOM uses the hook.
 *
 * We use vi.useFakeTimers() so the 250ms interval is observable without real
 * wall-clock delays. The `now` argument is injected explicitly so the format
 * strings stay deterministic across CI locales.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  getBroadcastClockSnapshot,
  useBroadcastClock,
  type BroadcastClockSnapshot,
} from "./useBroadcastClock";

beforeEach(() => {
  vi.useFakeTimers();
  // Pin the system clock so any code that falls back to `Date.now()` returns
  // the same value the explicit `now` injection produces.
  vi.setSystemTime(new Date("2026-05-22T03:34:18.000Z"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── Pure formatter ────────────────────────────────────────────────────────

describe("getBroadcastClockSnapshot", () => {
  it("returns elapsedSec=0 and '00:00:00' elapsedText when not running", () => {
    const snap = getBroadcastClockSnapshot({
      running: false,
      startedAtMs: null,
      now: () => Date.parse("2026-05-22T03:34:18.000Z"),
    });
    expect(snap.elapsedSec).toBe(0);
    expect(snap.elapsedText).toBe("00:00:00");
  });

  it("computes elapsedSec≈65 + elapsedText='00:01:05' for startedAt=now-65000", () => {
    const now = Date.parse("2026-05-22T03:34:18.000Z");
    const snap = getBroadcastClockSnapshot({
      running: true,
      startedAtMs: now - 65_000,
      now: () => now,
    });
    expect(snap.elapsedSec).toBe(65);
    expect(snap.elapsedText).toBe("00:01:05");
  });

  it("hour-pads elapsedText past 1h (3725s → '01:02:05')", () => {
    const now = 1000_000_000;
    const snap = getBroadcastClockSnapshot({
      running: true,
      startedAtMs: now - 3_725_000,
      now: () => now,
    });
    expect(snap.elapsedSec).toBe(3725);
    expect(snap.elapsedText).toBe("01:02:05");
  });

  it("clamps elapsedSec to 0 when startedAtMs is in the future (clock skew defense)", () => {
    const now = Date.parse("2026-05-22T03:34:18.000Z");
    const snap = getBroadcastClockSnapshot({
      running: true,
      startedAtMs: now + 5000, // session "started" in the future → bogus
      now: () => now,
    });
    expect(snap.elapsedSec).toBe(0);
    expect(snap.elapsedText).toBe("00:00:00");
  });

  it("clamps to 0 when running=true but startedAtMs is null (half-initialised)", () => {
    const snap = getBroadcastClockSnapshot({
      running: true,
      startedAtMs: null,
      now: () => Date.parse("2026-05-22T03:34:18.000Z"),
    });
    expect(snap.elapsedSec).toBe(0);
    expect(snap.elapsedText).toBe("00:00:00");
  });

  it("emits UTC HH:MM:SS via utcText (forced UTC tz)", () => {
    // 03:34:18 UTC for the pinned ISO above.
    const snap = getBroadcastClockSnapshot({
      running: false,
      startedAtMs: null,
      now: () => Date.parse("2026-05-22T03:34:18.000Z"),
    });
    expect(snap.utcText).toBe("03:34:18");
  });

  it("emits the UTC calendar date as YYYY-MM-DD in utcDateText", () => {
    const snap = getBroadcastClockSnapshot({
      running: false,
      startedAtMs: null,
      now: () => Date.parse("2026-05-22T03:34:18.000Z"),
    });
    expect(snap.utcDateText).toBe("2026-05-22");
  });

  it("utcDateText is UTC-anchored — does NOT flip with local timezone offsets", () => {
    // 23:59 UTC on the 22nd is still the 22nd no matter the operator's TZ.
    const snap = getBroadcastClockSnapshot({
      running: false,
      startedAtMs: null,
      now: () => Date.parse("2026-05-22T23:59:59.000Z"),
    });
    expect(snap.utcDateText).toBe("2026-05-22");
  });

  it("wallClock + utc numeric fields equal `now()` (snapshot is one moment)", () => {
    const t = 1_716_345_658_000;
    const snap = getBroadcastClockSnapshot({
      running: false,
      startedAtMs: null,
      now: () => t,
    });
    expect(snap.wallClock).toBe(t);
    expect(snap.utc).toBe(t);
  });

  it("uses Date.now() when no `now` is injected (default behaviour)", () => {
    // System time is pinned in beforeEach.
    const snap = getBroadcastClockSnapshot({
      running: false,
      startedAtMs: null,
    });
    expect(snap.utcDateText).toBe("2026-05-22");
    expect(snap.utcText).toBe("03:34:18");
  });
});

// ─── React hook ────────────────────────────────────────────────────────────

/**
 * Probe component — exposes the hook output via data-testid attributes so
 * the test can assert against the rendered DOM. This is the same probe
 * pattern usePresentationMode.test.tsx already uses in this codebase.
 */
function Probe({
  running,
  startedAtMs,
  nowMs,
  onSnapshot,
}: {
  running: boolean;
  startedAtMs: number | null;
  nowMs: number;
  onSnapshot?: (snap: BroadcastClockSnapshot) => void;
}) {
  const snap = useBroadcastClock({
    running,
    startedAtMs,
    now: () => nowMs,
  });
  onSnapshot?.(snap);
  return (
    <div>
      <span data-testid="elapsed-sec">{snap.elapsedSec}</span>
      <span data-testid="elapsed-text">{snap.elapsedText}</span>
      <span data-testid="utc-text">{snap.utcText}</span>
      <span data-testid="utc-date">{snap.utcDateText}</span>
    </div>
  );
}

describe("useBroadcastClock", () => {
  it("returns elapsedSec=0 and elapsedText='00:00:00' when not running", () => {
    const { getByTestId } = render(
      <Probe
        running={false}
        startedAtMs={null}
        nowMs={Date.parse("2026-05-22T03:34:18.000Z")}
      />,
    );
    expect(getByTestId("elapsed-sec").textContent).toBe("0");
    expect(getByTestId("elapsed-text").textContent).toBe("00:00:00");
  });

  it("returns elapsedSec=65 and elapsedText='00:01:05' for a 65s session", () => {
    const now = Date.parse("2026-05-22T03:34:18.000Z");
    const { getByTestId } = render(
      <Probe running={true} startedAtMs={now - 65_000} nowMs={now} />,
    );
    expect(getByTestId("elapsed-sec").textContent).toBe("65");
    expect(getByTestId("elapsed-text").textContent).toBe("00:01:05");
  });

  it("publishes UTC time + date text matching the pinned clock", () => {
    const { getByTestId } = render(
      <Probe
        running={false}
        startedAtMs={null}
        nowMs={Date.parse("2026-05-22T03:34:18.000Z")}
      />,
    );
    expect(getByTestId("utc-text").textContent).toBe("03:34:18");
    expect(getByTestId("utc-date").textContent).toBe("2026-05-22");
  });

  it("agrees with getBroadcastClockSnapshot for the same inputs", () => {
    const now = Date.parse("2026-05-22T03:34:18.000Z");
    let hookSnap: BroadcastClockSnapshot | null = null;
    render(
      <Probe
        running={true}
        startedAtMs={now - 42_000}
        nowMs={now}
        onSnapshot={(s) => {
          hookSnap = s;
        }}
      />,
    );
    const pureSnap = getBroadcastClockSnapshot({
      running: true,
      startedAtMs: now - 42_000,
      now: () => now,
    });
    expect(hookSnap).not.toBeNull();
    // The two views of the same moment must agree across all fields — that's
    // the invariant the shared clock exists to enforce.
    expect(hookSnap!.elapsedSec).toBe(pureSnap.elapsedSec);
    expect(hookSnap!.elapsedText).toBe(pureSnap.elapsedText);
    expect(hookSnap!.utcText).toBe(pureSnap.utcText);
    expect(hookSnap!.utcDateText).toBe(pureSnap.utcDateText);
    expect(hookSnap!.wallClockText).toBe(pureSnap.wallClockText);
    expect(hookSnap!.wallClock).toBe(pureSnap.wallClock);
    expect(hookSnap!.utc).toBe(pureSnap.utc);
  });

  it("re-renders on the 250ms interval (elapsed advances under fake timers)", () => {
    const start = Date.parse("2026-05-22T03:34:18.000Z");
    // We need the probe's nowMs to advance with the fake clock; close over a
    // mutable holder so we can bump it between fake-timer ticks.
    let mockNow = start;
    function Live() {
      const snap = useBroadcastClock({
        running: true,
        startedAtMs: start,
        now: () => mockNow,
      });
      return <span data-testid="el">{snap.elapsedSec}</span>;
    }
    const { getByTestId } = render(<Live />);
    expect(getByTestId("el").textContent).toBe("0");

    // Advance both the fake timer (so the interval fires) AND mockNow (so the
    // snapshot sees a later moment).
    act(() => {
      mockNow = start + 1500;
      vi.advanceTimersByTime(1500);
    });
    // 1500ms → 1 second floored
    expect(getByTestId("el").textContent).toBe("1");

    act(() => {
      mockNow = start + 4250;
      vi.advanceTimersByTime(2750);
    });
    expect(getByTestId("el").textContent).toBe("4");
  });

  it("clears its interval on unmount (no stray timers)", () => {
    const now = Date.parse("2026-05-22T03:34:18.000Z");
    const { unmount } = render(
      <Probe running={true} startedAtMs={now - 1000} nowMs={now} />,
    );
    // Before unmount we expect at least the recurring 250ms interval to exist.
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    // After unmount the interval must be cleared so the test runner doesn't
    // leak handles between cases.
    expect(vi.getTimerCount()).toBe(0);
  });
});
