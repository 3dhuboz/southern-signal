// @vitest-environment happy-dom

/**
 * BroadcastAudioMeter DOM-structure snapshots.
 *
 * The meter has continuous animation (peak-hold via requestAnimationFrame
 * at ~12 Hz) but happy-dom doesn't auto-drive RAF, so the initial render
 * captures a stable state with `peakDb = MIN_DB` and `peakHoldHidden = true`.
 * That's exactly what we want — the snapshot pins the first-paint DOM
 * without trying to test animation timing (which is animation timing's job).
 *
 * What we pin:
 *   1. Silent floor (rms=0) — bar fill at scaleY(0), "−60.0" readout
 *   2. Mid-range (rms=0.05) — bar fill ~57% of vertical
 *   3. Hot (rms=0.5) — bar fill ~90% of vertical, near 0 dBFS
 *   4. VAD active — `.active` class + "MIC · LIVE" label swap
 *
 * The `style="transform: scaleY(X)"` inline value is deterministic
 * (pure function of rms input) so snapshotting it is safe.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("./BroadcastAudioMeter.module.css", () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}));

import { BroadcastAudioMeter } from "./BroadcastAudioMeter";

afterEach(() => {
  cleanup();
});

describe("<BroadcastAudioMeter /> DOM snapshot", () => {
  it("silent floor (rms=0) → bar at scaleY(0), '−60.0' readout, peak-hold hidden", () => {
    const { container } = render(<BroadcastAudioMeter rms={0} />);
    expect(container.firstChild).toMatchInlineSnapshot(`
      <div
        aria-label="Microphone level: -60 dBFS"
        aria-valuemax="0"
        aria-valuemin="-60"
        aria-valuenow="-60"
        class="meter"
        data-hud-drag-target="mic"
        role="meter"
      >
        <span
          aria-hidden="true"
          class="label"
        >
          MIC
        </span>
        <div
          aria-hidden="true"
          class="barRow"
        >
          <div
            class="barTrack"
          >
            <span
              class="barFill"
              style="transform: scaleY(0);"
            />
            <span
              class="peakHold peakHoldHidden"
              style="bottom: 0%;"
            />
          </div>
          <div
            class="ticks"
          >
            <span
              class="tick tick0"
              style="bottom: 100%;"
            >
              <span
                class="tickMark"
              />
              <span>
                0
              </span>
            </span>
            <span
              class="tick"
              style="bottom: 95%;"
            >
              <span
                class="tickMark"
              />
              <span>
                −3
              </span>
            </span>
            <span
              class="tick"
              style="bottom: 90%;"
            >
              <span
                class="tickMark"
              />
              <span>
                −6
              </span>
            </span>
            <span
              class="tick"
              style="bottom: 80%;"
            >
              <span
                class="tickMark"
              />
              <span>
                −12
              </span>
            </span>
            <span
              class="tick"
              style="bottom: 70%;"
            >
              <span
                class="tickMark"
              />
              <span>
                −18
              </span>
            </span>
            <span
              class="tick"
              style="bottom: 50%;"
            >
              <span
                class="tickMark"
              />
              <span>
                −30
              </span>
            </span>
            <span
              class="tick"
              style="bottom: 0%;"
            >
              <span
                class="tickMark"
              />
              <span>
                −60
              </span>
            </span>
          </div>
        </div>
        <span
          aria-hidden="true"
          class="value"
        >
          <span>
            −60.0
          </span>
          <span
            class="valueUnit"
          >
            dBFS
          </span>
        </span>
      </div>
    `);
  });

  it("mid-range (rms=0.05) → bar fill near mid-bar, '−26.0' readout", () => {
    const { container } = render(<BroadcastAudioMeter rms={0.05} />);
    expect(container.firstChild).toMatchInlineSnapshot(`
      <div
        aria-label="Microphone level: -26 dBFS"
        aria-valuemax="0"
        aria-valuemin="-60"
        aria-valuenow="-26"
        class="meter"
        data-hud-drag-target="mic"
        role="meter"
      >
        <span
          aria-hidden="true"
          class="label"
        >
          MIC
        </span>
        <div
          aria-hidden="true"
          class="barRow"
        >
          <div
            class="barTrack"
          >
            <span
              class="barFill"
              style="transform: scaleY(0.5663233347786729);"
            />
            <span
              class="peakHold peakHoldHidden"
              style="bottom: 0%;"
            />
          </div>
          <div
            class="ticks"
          >
            <span
              class="tick tick0"
              style="bottom: 100%;"
            >
              <span
                class="tickMark"
              />
              <span>
                0
              </span>
            </span>
            <span
              class="tick"
              style="bottom: 95%;"
            >
              <span
                class="tickMark"
              />
              <span>
                −3
              </span>
            </span>
            <span
              class="tick"
              style="bottom: 90%;"
            >
              <span
                class="tickMark"
              />
              <span>
                −6
              </span>
            </span>
            <span
              class="tick"
              style="bottom: 80%;"
            >
              <span
                class="tickMark"
              />
              <span>
                −12
              </span>
            </span>
            <span
              class="tick"
              style="bottom: 70%;"
            >
              <span
                class="tickMark"
              />
              <span>
                −18
              </span>
            </span>
            <span
              class="tick"
              style="bottom: 50%;"
            >
              <span
                class="tickMark"
              />
              <span>
                −30
              </span>
            </span>
            <span
              class="tick"
              style="bottom: 0%;"
            >
              <span
                class="tickMark"
              />
              <span>
                −60
              </span>
            </span>
          </div>
        </div>
        <span
          aria-hidden="true"
          class="value"
        >
          <span>
            −26.0
          </span>
          <span
            class="valueUnit"
          >
            dBFS
          </span>
        </span>
      </div>
    `);
  });

  it("hot (rms=0.5) → bar fill near top, '−6.0' readout", () => {
    const { container } = render(<BroadcastAudioMeter rms={0.5} />);
    expect(container.firstChild).toMatchInlineSnapshot(`
      <div
        aria-label="Microphone level: -6 dBFS"
        aria-valuemax="0"
        aria-valuemin="-60"
        aria-valuenow="-6"
        class="meter"
        data-hud-drag-target="mic"
        role="meter"
      >
        <span
          aria-hidden="true"
          class="label"
        >
          MIC
        </span>
        <div
          aria-hidden="true"
          class="barRow"
        >
          <div
            class="barTrack"
          >
            <span
              class="barFill"
              style="transform: scaleY(0.8996566681120064);"
            />
            <span
              class="peakHold peakHoldHidden"
              style="bottom: 0%;"
            />
          </div>
          <div
            class="ticks"
          >
            <span
              class="tick tick0"
              style="bottom: 100%;"
            >
              <span
                class="tickMark"
              />
              <span>
                0
              </span>
            </span>
            <span
              class="tick"
              style="bottom: 95%;"
            >
              <span
                class="tickMark"
              />
              <span>
                −3
              </span>
            </span>
            <span
              class="tick"
              style="bottom: 90%;"
            >
              <span
                class="tickMark"
              />
              <span>
                −6
              </span>
            </span>
            <span
              class="tick"
              style="bottom: 80%;"
            >
              <span
                class="tickMark"
              />
              <span>
                −12
              </span>
            </span>
            <span
              class="tick"
              style="bottom: 70%;"
            >
              <span
                class="tickMark"
              />
              <span>
                −18
              </span>
            </span>
            <span
              class="tick"
              style="bottom: 50%;"
            >
              <span
                class="tickMark"
              />
              <span>
                −30
              </span>
            </span>
            <span
              class="tick"
              style="bottom: 0%;"
            >
              <span
                class="tickMark"
              />
              <span>
                −60
              </span>
            </span>
          </div>
        </div>
        <span
          aria-hidden="true"
          class="value"
        >
          <span>
            −6.0
          </span>
          <span
            class="valueUnit"
          >
            dBFS
          </span>
        </span>
      </div>
    `);
  });

  it("vadActive=true → .active modifier + 'MIC · LIVE' label", () => {
    const { container } = render(<BroadcastAudioMeter rms={0.05} vadActive={true} />);
    expect(container.firstChild).toMatchInlineSnapshot(`
      <div
        aria-label="Microphone level: -26 dBFS, voice activity detected"
        aria-valuemax="0"
        aria-valuemin="-60"
        aria-valuenow="-26"
        class="meter active"
        data-hud-drag-target="mic"
        role="meter"
      >
        <span
          aria-hidden="true"
          class="label"
        >
          MIC · LIVE
        </span>
        <div
          aria-hidden="true"
          class="barRow"
        >
          <div
            class="barTrack"
          >
            <span
              class="barFill"
              style="transform: scaleY(0.5663233347786729);"
            />
            <span
              class="peakHold peakHoldHidden"
              style="bottom: 0%;"
            />
          </div>
          <div
            class="ticks"
          >
            <span
              class="tick tick0"
              style="bottom: 100%;"
            >
              <span
                class="tickMark"
              />
              <span>
                0
              </span>
            </span>
            <span
              class="tick"
              style="bottom: 95%;"
            >
              <span
                class="tickMark"
              />
              <span>
                −3
              </span>
            </span>
            <span
              class="tick"
              style="bottom: 90%;"
            >
              <span
                class="tickMark"
              />
              <span>
                −6
              </span>
            </span>
            <span
              class="tick"
              style="bottom: 80%;"
            >
              <span
                class="tickMark"
              />
              <span>
                −12
              </span>
            </span>
            <span
              class="tick"
              style="bottom: 70%;"
            >
              <span
                class="tickMark"
              />
              <span>
                −18
              </span>
            </span>
            <span
              class="tick"
              style="bottom: 50%;"
            >
              <span
                class="tickMark"
              />
              <span>
                −30
              </span>
            </span>
            <span
              class="tick"
              style="bottom: 0%;"
            >
              <span
                class="tickMark"
              />
              <span>
                −60
              </span>
            </span>
          </div>
        </div>
        <span
          aria-hidden="true"
          class="value"
        >
          <span>
            −26.0
          </span>
          <span
            class="valueUnit"
          >
            dBFS
          </span>
        </span>
      </div>
    `);
  });
});
