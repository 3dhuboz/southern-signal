// @vitest-environment happy-dom

/**
 * BroadcastSensorHud DOM-structure snapshots.
 *
 * The HUD is graceful-degradation-heavy: each row only renders when
 * BOTH the hardware is available AND a sample has arrived. iOS Safari
 * has no Magnetometer API in practice, so the EMF row must drop out
 * cleanly rather than show a fake reading. These snapshots pin all the
 * possible row-presence combinations + the threshold-flash data attr.
 *
 * Fake timers: useFlashOnRising schedules a setTimeout to clear the
 * flash after 400ms. We freeze timers so the flash latches `data-alert="1"`
 * in the snapshot rather than racing the test runner.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("./BroadcastSensorHud.module.css", () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}));

import { BroadcastSensorHud } from "./BroadcastSensorHud";

const baseMag = { timestamp: 0, magnitude: 47.3, x: 12, y: 18, z: 41 };
const baseLight = { timestamp: 0, lux: 142, source: "camera" as const };
const baseMotion = {
  timestamp: 0,
  accelMagnitude: 0.34,
  ax: 0.1, ay: 0.2, az: 9.8,
  alpha: 0, beta: 0, gamma: 0,
};

beforeEach(() => {
  // Freeze the flash setTimeout so a rising-edge `alert: true` stays
  // latched in the snapshot.
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("<BroadcastSensorHud /> DOM snapshot", () => {
  it("all three sensors available + reporting → EMF + LUX + ACC rows", () => {
    const { container } = render(
      <BroadcastSensorHud
        magnetometer={baseMag}
        light={baseLight}
        motion={baseMotion}
        magnetometerAvailable={true}
        lightAvailable={true}
      />,
    );
    expect(container.firstChild).toMatchInlineSnapshot(`
      <div
        aria-label="Live sensor readings"
        class="hud"
        role="group"
      >
        <div
          class="row"
          data-alert="0"
        >
          <span
            class="key"
          >
            EMF
          </span>
          <span
            class="value"
          >
            <span
              class="num"
            >
              47.3
            </span>
            <span
              class="unit"
            >
              µT
            </span>
          </span>
        </div>
        <div
          class="row"
          data-alert="0"
        >
          <span
            class="key"
          >
            LUX
          </span>
          <span
            class="value"
          >
            <span
              class="num"
            >
              142
            </span>
            <span
              class="unit"
            >
              lx
            </span>
          </span>
        </div>
        <div
          class="row"
          data-alert="0"
        >
          <span
            class="key"
          >
            ACC
          </span>
          <span
            class="value"
          >
            <span
              class="num"
            >
              0.34
            </span>
            <span
              class="unit"
            >
              m/s²
            </span>
          </span>
        </div>
        <span
          aria-atomic="true"
          aria-live="polite"
          style="position: absolute; width: 1px; height: 1px; padding: 0px; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0px;"
        />
      </div>
    `);
  });

  it("iOS Safari shape: magnetometer hw unavailable → no EMF row", () => {
    const { container } = render(
      <BroadcastSensorHud
        magnetometer={null}
        light={baseLight}
        motion={baseMotion}
        magnetometerAvailable={false}
        lightAvailable={true}
      />,
    );
    expect(container.firstChild).toMatchInlineSnapshot(`
      <div
        aria-label="Live sensor readings"
        class="hud"
        role="group"
      >
        <div
          class="row"
          data-alert="0"
        >
          <span
            class="key"
          >
            LUX
          </span>
          <span
            class="value"
          >
            <span
              class="num"
            >
              142
            </span>
            <span
              class="unit"
            >
              lx
            </span>
          </span>
        </div>
        <div
          class="row"
          data-alert="0"
        >
          <span
            class="key"
          >
            ACC
          </span>
          <span
            class="value"
          >
            <span
              class="num"
            >
              0.34
            </span>
            <span
              class="unit"
            >
              m/s²
            </span>
          </span>
        </div>
        <span
          aria-atomic="true"
          aria-live="polite"
          style="position: absolute; width: 1px; height: 1px; padding: 0px; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0px;"
        />
      </div>
    `);
  });

  it("no ambient-light hardware (camera-only fallback skipped) → no LUX row", () => {
    const { container } = render(
      <BroadcastSensorHud
        magnetometer={baseMag}
        light={null}
        motion={baseMotion}
        magnetometerAvailable={true}
        lightAvailable={false}
      />,
    );
    expect(container.firstChild).toMatchInlineSnapshot(`
      <div
        aria-label="Live sensor readings"
        class="hud"
        role="group"
      >
        <div
          class="row"
          data-alert="0"
        >
          <span
            class="key"
          >
            EMF
          </span>
          <span
            class="value"
          >
            <span
              class="num"
            >
              47.3
            </span>
            <span
              class="unit"
            >
              µT
            </span>
          </span>
        </div>
        <div
          class="row"
          data-alert="0"
        >
          <span
            class="key"
          >
            ACC
          </span>
          <span
            class="value"
          >
            <span
              class="num"
            >
              0.34
            </span>
            <span
              class="unit"
            >
              m/s²
            </span>
          </span>
        </div>
        <span
          aria-atomic="true"
          aria-live="polite"
          style="position: absolute; width: 1px; height: 1px; padding: 0px; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0px;"
        />
      </div>
    `);
  });

  it("zero sensors reporting → component returns null (no empty glass shell)", () => {
    const { container } = render(
      <BroadcastSensorHud
        magnetometer={null}
        light={null}
        motion={null}
        magnetometerAvailable={false}
        lightAvailable={false}
      />,
    );
    // Empty container — the all-null guard must short-circuit before any
    // DOM is touched.
    expect(container.firstChild).toMatchInlineSnapshot(`null`);
  });

  it("EMF alert rising edge → data-alert='1' latched on the EMF row", () => {
    const { container } = render(
      <BroadcastSensorHud
        magnetometer={baseMag}
        light={baseLight}
        motion={baseMotion}
        emfAlert={{ alert: true }}
        magnetometerAvailable={true}
        lightAvailable={true}
      />,
    );
    expect(container.firstChild).toMatchInlineSnapshot(`
      <div
        aria-label="Live sensor readings"
        class="hud"
        role="group"
      >
        <div
          class="row"
          data-alert="1"
        >
          <span
            class="key"
          >
            EMF
          </span>
          <span
            class="value"
          >
            <span
              class="num"
            >
              47.3
            </span>
            <span
              class="unit"
            >
              µT
            </span>
          </span>
        </div>
        <div
          class="row"
          data-alert="0"
        >
          <span
            class="key"
          >
            LUX
          </span>
          <span
            class="value"
          >
            <span
              class="num"
            >
              142
            </span>
            <span
              class="unit"
            >
              lx
            </span>
          </span>
        </div>
        <div
          class="row"
          data-alert="0"
        >
          <span
            class="key"
          >
            ACC
          </span>
          <span
            class="value"
          >
            <span
              class="num"
            >
              0.34
            </span>
            <span
              class="unit"
            >
              m/s²
            </span>
          </span>
        </div>
        <span
          aria-atomic="true"
          aria-live="polite"
          style="position: absolute; width: 1px; height: 1px; padding: 0px; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0px;"
        >
          EMF anomaly: 47.3 micro-tesla
        </span>
      </div>
    `);
  });
});
