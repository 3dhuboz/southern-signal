// @vitest-environment happy-dom

/**
 * BroadcastBug DOM-structure snapshots — pin the four broadcast states.
 *
 * State priority is `rec > live > ready > idle`; the bug renders a
 * different className modifier per state, and `idle` is the only state
 * that suppresses the elapsed timecode. A CSS refactor that drops the
 * modifier class or rewires the conditional will surface here as a diff.
 *
 * CSS module is stubbed with an identity Proxy so class names render as
 * readable strings (`class="bug rec"`) instead of vite-hashed gibberish
 * that would churn on every build.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("./BroadcastBug.module.css", () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}));

import { BroadcastBug } from "./BroadcastBug";

afterEach(() => {
  cleanup();
});

describe("<BroadcastBug /> DOM snapshot", () => {
  it("idle: STANDBY label, no elapsed timecode rendered", () => {
    const { container } = render(<BroadcastBug state="idle" elapsedSec={0} />);
    expect(container.firstChild).toMatchInlineSnapshot(`
      <div
        aria-label="Broadcast status: STANDBY"
        aria-live="polite"
        class="bug idle"
        data-hud-drag-target="status"
        role="status"
      >
        <span
          aria-hidden="true"
          class="mark"
        >
          <svg
            aria-hidden="true"
            class="markGlyph"
            focusable="false"
            viewBox="0 0 14 14"
            xmlns="http://www.w3.org/2000/svg"
          >
            <circle
              cx="3"
              cy="7"
              fill="currentColor"
              r="1.3"
            />
            <path
              d="M5.5 4.5 Q7.5 7 5.5 9.5"
              fill="none"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-width="1.2"
            />
            <path
              d="M8 3 Q11 7 8 11"
              fill="none"
              opacity="0.7"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-width="1.2"
            />
          </svg>
          <span
            class="markText"
          >
            SS
          </span>
        </span>
        <span
          class="body"
        >
          <span
            aria-hidden="true"
            class="dot"
          />
          <span
            class="label"
          >
            STANDBY
          </span>
        </span>
      </div>
    `);
  });

  it("ready: READY label + elapsed mm:ss visible", () => {
    const { container } = render(<BroadcastBug state="ready" elapsedSec={5} />);
    expect(container.firstChild).toMatchInlineSnapshot(`
      <div
        aria-label="Broadcast status: READY, 00:05 elapsed"
        aria-live="polite"
        class="bug ready"
        data-hud-drag-target="status"
        role="status"
      >
        <span
          aria-hidden="true"
          class="mark"
        >
          <svg
            aria-hidden="true"
            class="markGlyph"
            focusable="false"
            viewBox="0 0 14 14"
            xmlns="http://www.w3.org/2000/svg"
          >
            <circle
              cx="3"
              cy="7"
              fill="currentColor"
              r="1.3"
            />
            <path
              d="M5.5 4.5 Q7.5 7 5.5 9.5"
              fill="none"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-width="1.2"
            />
            <path
              d="M8 3 Q11 7 8 11"
              fill="none"
              opacity="0.7"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-width="1.2"
            />
          </svg>
          <span
            class="markText"
          >
            SS
          </span>
        </span>
        <span
          class="body"
        >
          <span
            aria-hidden="true"
            class="dot"
          />
          <span
            class="label"
          >
            READY
          </span>
          <span
            class="elapsed"
          >
            00:05
          </span>
        </span>
      </div>
    `);
  });

  it("live: LIVE label + elapsed mm:ss visible", () => {
    const { container } = render(<BroadcastBug state="live" elapsedSec={47} />);
    expect(container.firstChild).toMatchInlineSnapshot(`
      <div
        aria-label="Broadcast status: LIVE, 00:47 elapsed"
        aria-live="polite"
        class="bug live"
        data-hud-drag-target="status"
        role="status"
      >
        <span
          aria-hidden="true"
          class="mark"
        >
          <svg
            aria-hidden="true"
            class="markGlyph"
            focusable="false"
            viewBox="0 0 14 14"
            xmlns="http://www.w3.org/2000/svg"
          >
            <circle
              cx="3"
              cy="7"
              fill="currentColor"
              r="1.3"
            />
            <path
              d="M5.5 4.5 Q7.5 7 5.5 9.5"
              fill="none"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-width="1.2"
            />
            <path
              d="M8 3 Q11 7 8 11"
              fill="none"
              opacity="0.7"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-width="1.2"
            />
          </svg>
          <span
            class="markText"
          >
            SS
          </span>
        </span>
        <span
          class="body"
        >
          <span
            aria-hidden="true"
            class="dot"
          />
          <span
            class="label"
          >
            LIVE
          </span>
          <span
            class="elapsed"
          >
            00:47
          </span>
        </span>
      </div>
    `);
  });

  it("rec: REC label + elapsed mm:ss visible (danger styling on the modifier class)", () => {
    const { container } = render(<BroadcastBug state="rec" elapsedSec={125} />);
    expect(container.firstChild).toMatchInlineSnapshot(`
      <div
        aria-label="Broadcast status: REC, 02:05 elapsed"
        aria-live="polite"
        class="bug rec"
        data-hud-drag-target="status"
        role="status"
      >
        <span
          aria-hidden="true"
          class="mark"
        >
          <svg
            aria-hidden="true"
            class="markGlyph"
            focusable="false"
            viewBox="0 0 14 14"
            xmlns="http://www.w3.org/2000/svg"
          >
            <circle
              cx="3"
              cy="7"
              fill="currentColor"
              r="1.3"
            />
            <path
              d="M5.5 4.5 Q7.5 7 5.5 9.5"
              fill="none"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-width="1.2"
            />
            <path
              d="M8 3 Q11 7 8 11"
              fill="none"
              opacity="0.7"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-width="1.2"
            />
          </svg>
          <span
            class="markText"
          >
            SS
          </span>
        </span>
        <span
          class="body"
        >
          <span
            aria-hidden="true"
            class="dot"
          />
          <span
            class="label"
          >
            REC
          </span>
          <span
            class="elapsed"
          >
            02:05
          </span>
        </span>
      </div>
    `);
  });
});
