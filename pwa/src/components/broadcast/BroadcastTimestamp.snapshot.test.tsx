// @vitest-environment happy-dom

/**
 * BroadcastTimestamp DOM-structure snapshots.
 *
 * The slate is a timer (re-rendered every second by an internal interval)
 * so snapshots could trivially be non-deterministic. We address this by:
 *
 *   - vi.useFakeTimers() so the internal setInterval never fires
 *   - vi.setSystemTime() pins `new Date()` for the initial state
 *   - vi.spyOn(Date.prototype, "toLocaleTimeString") pins the formatted
 *     output across CI / locale variation
 *
 * What we pin:
 *   1. Stopped state — em-dash placeholder "—:——" in the elapsed slot
 *   2. Running, short elapsed — "T+0:42"
 *   3. Running, two-digit minutes — "T+2:05" (no leading zero on minutes)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("./BroadcastTimestamp.module.css", () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}));

import { BroadcastTimestamp } from "./BroadcastTimestamp";

beforeEach(() => {
  // Pin the wall clock. The HH:MM:SS string the slate renders comes
  // from toLocaleTimeString — mock it to a deterministic value so the
  // snapshot reads cleanly across locales. Both local + UTC calls hit
  // the same mock; we render the same "12:34:56" for both to keep the
  // snapshot tight (the contract being pinned is the structure, not
  // the timezone math which lives in fmtClock).
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-20T12:34:56.000Z"));
  vi.spyOn(Date.prototype, "toLocaleTimeString").mockReturnValue("12:34:56");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("<BroadcastTimestamp /> DOM snapshot", () => {
  it("stopped (running=false) → em-dash placeholder in the elapsed slot", () => {
    const { container } = render(
      <BroadcastTimestamp running={false} elapsedSec={0} />,
    );
    expect(container.firstChild).toMatchInlineSnapshot(`
      <div
        aria-label="Timecode 12:34:56 local"
        aria-live="off"
        class="slate"
        data-hud-drag-target="timecode"
        role="timer"
      >
        <span
          class="local blinkOn"
        >
          <span
            class="digits"
          >
            12
            <span
              class="colon"
            >
              :
            </span>
          </span>
          <span
            class="digits"
          >
            34
            <span
              class="colon"
            >
              :
            </span>
          </span>
          <span
            class="digits"
          >
            56
          </span>
        </span>
        <span
          class="utc"
        >
          <span
            class="eyebrow"
          >
            UTC
          </span>
          <span
            class="digits"
          >
            12:34:56
          </span>
        </span>
        <span
          aria-label="Session not running"
          class="elapsed"
        >
          <span
            aria-hidden="true"
            class="eyebrow"
          >
            T
          </span>
          <span
            aria-hidden="true"
            class="digits"
          >
            —:——
          </span>
        </span>
      </div>
    `);
  });

  it("running, short elapsed (42s) → T+0:42 with zero-padded seconds", () => {
    const { container } = render(
      <BroadcastTimestamp running={true} elapsedSec={42} />,
    );
    expect(container.firstChild).toMatchInlineSnapshot(`
      <div
        aria-label="Timecode 12:34:56 local"
        aria-live="off"
        class="slate running"
        data-hud-drag-target="timecode"
        role="timer"
      >
        <span
          class="local blinkOn"
        >
          <span
            class="digits"
          >
            12
            <span
              class="colon"
            >
              :
            </span>
          </span>
          <span
            class="digits"
          >
            34
            <span
              class="colon"
            >
              :
            </span>
          </span>
          <span
            class="digits"
          >
            56
          </span>
        </span>
        <span
          class="utc"
        >
          <span
            class="eyebrow"
          >
            UTC
          </span>
          <span
            class="digits"
          >
            12:34:56
          </span>
        </span>
        <span
          aria-label="Session elapsed: 42 seconds"
          class="elapsed"
        >
          <span
            aria-hidden="true"
            class="eyebrow"
          >
            T
          </span>
          <span
            aria-hidden="true"
            class="digits"
          >
            +0:42
          </span>
        </span>
      </div>
    `);
  });

  it("running, multi-minute elapsed (125s) → T+2:05 (minute is not zero-padded)", () => {
    const { container } = render(
      <BroadcastTimestamp running={true} elapsedSec={125} />,
    );
    expect(container.firstChild).toMatchInlineSnapshot(`
      <div
        aria-label="Timecode 12:34:56 local"
        aria-live="off"
        class="slate running"
        data-hud-drag-target="timecode"
        role="timer"
      >
        <span
          class="local blinkOn"
        >
          <span
            class="digits"
          >
            12
            <span
              class="colon"
            >
              :
            </span>
          </span>
          <span
            class="digits"
          >
            34
            <span
              class="colon"
            >
              :
            </span>
          </span>
          <span
            class="digits"
          >
            56
          </span>
        </span>
        <span
          class="utc"
        >
          <span
            class="eyebrow"
          >
            UTC
          </span>
          <span
            class="digits"
          >
            12:34:56
          </span>
        </span>
        <span
          aria-label="Session elapsed: 125 seconds"
          class="elapsed"
        >
          <span
            aria-hidden="true"
            class="eyebrow"
          >
            T
          </span>
          <span
            aria-hidden="true"
            class="digits"
          >
            +2:05
          </span>
        </span>
      </div>
    `);
  });
});
