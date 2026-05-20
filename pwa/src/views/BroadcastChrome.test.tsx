// @vitest-environment happy-dom

/**
 * Smoke test for the BroadcastChrome HDMI-output surface.
 *
 * BroadcastChrome is the Pi 5 kiosk variant of the broadcast HUD — a
 * single 16:9 frame meant to fill an HDMI display in fullscreen
 * Chromium. The component reads its state from URL query params so a
 * downstream operator can drive it without re-routing.
 *
 * What we pin:
 *   1. Default URL ("/broadcast/chrome" with no params) renders a LIVE
 *      state with the full HUD (bug + meter + sensor HUD + timestamp +
 *      lower-third + scene chip). LIVE is the overwhelming default for
 *      Pi 5 usage.
 *   2. ?state=idle suppresses the audio meter, sensor HUD, and
 *      lower-third — matching the CameraScreen running-gate contract.
 *   3. ?elapsed=42 drives the timecode through to the bug and timestamp.
 *   4. ?scene= overrides the default scene name in the chip.
 *   5. ?investigation=hidden suppresses the lower-third even when
 *      running, so the Pi 5 operator can hide the slate during a
 *      title-card moment without changing CameraScreen state.
 *   6. Unknown / malformed query values fall back to defaults rather
 *      than blanking the screen — a Pi 5 kiosk must never show an
 *      error overlay.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { BroadcastChrome } from "./BroadcastChrome";

/** Mount BroadcastChrome at a specific URL — we drive the route via a
 *  MemoryRouter initialised at the URL string, since react-router's
 *  useSearchParams() reads from the current router location. */
function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <BroadcastChrome />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe("<BroadcastChrome />", () => {
  it("default URL: renders LIVE state with full HUD", () => {
    renderAt("/broadcast/chrome");
    // BroadcastBug at role="status" with the LIVE label embedded in its
    // aria-label. The aria-label format is "Broadcast status: LIVE, ..."
    const bug = screen.getByRole("status");
    expect(bug.getAttribute("aria-label")).toMatch(/LIVE/);
    // AudioMeter (role="meter"), SensorHud (role="group" labelled "Live
    // sensor readings"), LowerThird (role="region" labelled
    // "Investigation slate") — all mounted in LIVE.
    expect(screen.getByRole("meter")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Live sensor readings/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /Investigation slate/i })).toBeInTheDocument();
    // Scene selector chip always renders.
    expect(screen.getByRole("button", { name: /Scene: Outdoor Cemetery/i })).toBeInTheDocument();
  });

  it("?state=idle suppresses meter + sensor HUD + lower-third (running-gate parity)", () => {
    renderAt("/broadcast/chrome?state=idle");
    // The bug must still mount in idle state (CameraScreen also always
    // mounts it). Aria-label format for idle is "Broadcast status: STANDBY".
    const bug = screen.getByRole("status");
    expect(bug.getAttribute("aria-label")).toMatch(/STANDBY/);
    // The four running-gated components must NOT mount.
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.queryByRole("group", { name: /Live sensor readings/i })).toBeNull();
    expect(screen.queryByRole("region", { name: /Investigation slate/i })).toBeNull();
  });

  it("?elapsed=42 drives the bug + timestamp timecode", () => {
    renderAt("/broadcast/chrome?state=rec&elapsed=42");
    // The bug includes "00:42 elapsed" in its aria-label when elapsedSec=42.
    const bug = screen.getByRole("status");
    expect(bug.getAttribute("aria-label")).toMatch(/REC, 00:42 elapsed/);
    // The timestamp slate exposes an elapsed aria-label of
    // "Session elapsed: 42 seconds" — pin that too.
    const timer = screen.getByRole("timer");
    expect(within(timer).getByLabelText(/Session elapsed: 42 seconds/i)).toBeInTheDocument();
  });

  it("?scene= overrides the default scene name", () => {
    renderAt("/broadcast/chrome?scene=Indoor%20Quiet");
    expect(screen.getByRole("button", { name: /Scene: Indoor Quiet/i })).toBeInTheDocument();
  });

  it("?investigation=hidden suppresses the lower-third even when running", () => {
    renderAt("/broadcast/chrome?state=live&investigation=hidden");
    // Bug + meter + sensor HUD still mount (running is still true).
    expect(screen.getByRole("meter")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Live sensor readings/i })).toBeInTheDocument();
    // Lower-third explicitly hidden.
    expect(screen.queryByRole("region", { name: /Investigation slate/i })).toBeNull();
  });

  // ── Defensive: malformed URL never blanks the kiosk ──────────────────────
  //
  // A Pi 5 kiosk that crashes to a blank screen is worse than one that
  // shows the wrong scene. These tests pin the "always render SOMETHING
  // sensible" contract.

  it("?state=garbage falls back to LIVE (not blank, not error)", () => {
    renderAt("/broadcast/chrome?state=garbage");
    expect(screen.getByRole("status").getAttribute("aria-label")).toMatch(/LIVE/);
  });

  it("?elapsed=NaN falls back to default 125 seconds (02:05 on the bug)", () => {
    renderAt("/broadcast/chrome?state=rec&elapsed=NaN");
    const bug = screen.getByRole("status");
    expect(bug.getAttribute("aria-label")).toMatch(/REC, 02:05 elapsed/);
  });

  it("?rms=99 clamps to 1.0 (the max linear amplitude) rather than overflowing", () => {
    renderAt("/broadcast/chrome?state=live&rms=99");
    // The audio meter's aria-label encodes the level in dBFS. Linear
    // rms=1.0 corresponds to 0 dBFS (the max of the displayed range).
    const meter = screen.getByRole("meter");
    expect(meter.getAttribute("aria-label")).toMatch(/Microphone level: 0 dBFS/);
  });

  it("?elapsed=-5 clamps to 0 (no negative timecode on the bug)", () => {
    renderAt("/broadcast/chrome?state=rec&elapsed=-5");
    const bug = screen.getByRole("status");
    expect(bug.getAttribute("aria-label")).toMatch(/REC, 00:00 elapsed/);
  });

  // ── Layout / a11y contract ──────────────────────────────────────────────

  it("the frame has role='group' with a recognisable aria-label", () => {
    renderAt("/broadcast/chrome");
    expect(screen.getByRole("group", { name: /Broadcast HDMI output/i })).toBeInTheDocument();
  });

  it("the stage stamps data-broadcast-state for downstream OBS / CSS hooks", () => {
    const { container } = renderAt("/broadcast/chrome?state=rec");
    expect(container.querySelector("[data-broadcast-state='rec']")).not.toBeNull();
  });
});
