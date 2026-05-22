// @vitest-environment happy-dom

/**
 * CameraHud DOM-structure snapshots — pin the grid skeleton + the six
 * visibility branches the camera surface cycles through.
 *
 * The wrapper used to be a scatter of `{cond && <X />}` inside CameraScreen;
 * extracting it into one component means a CSS / visibility refactor only
 * has to update these snapshots, not chase predicates across a 1800-line
 * view. Each snapshot pins:
 *   1. idle (no chrome, scene chip + (empty) lower-third row only)
 *   2. running with audio meter + sensors visible (Pro mode)
 *   3. running but Simple mode — sensor HUD suppressed
 *   4. snooze chip visible
 *   5. marker pill closed (count > 0)
 *   6. marker pill open (popover visible)
 *
 * CSS module is stubbed with an identity Proxy so class names render as
 * readable strings instead of vite-hashed build-output gibberish.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createRef } from "react";

vi.mock("./CameraHud.module.css", () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock("./BroadcastBug.module.css", () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock("./BroadcastAudioMeter.module.css", () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock("./BroadcastSceneSelector.module.css", () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock("./BroadcastSensorHud.module.css", () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock("./BroadcastLowerThird.module.css", () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}));
// Wave 3 extractions — device + snooze chips + marker pill moved out of
// CameraHud's module.css. Stub their CSS too so snapshot classnames stay
// readable (vite-hashed otherwise).
vi.mock("../camera/CameraDeviceChip.module.css", () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock("../camera/CameraSnoozeChip.module.css", () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock("../camera/CameraMarkerPill.module.css", () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}));

import { CameraHud, type CameraHudProps } from "./CameraHud";

afterEach(() => {
  cleanup();
});

// Pin Date.prototype.toLocaleDateString for the BroadcastLowerThird
// burn-in. CI locale drift would otherwise churn snapshots that include
// the lower-third slate.
beforeEach(() => {
  vi.spyOn(Date.prototype, "toLocaleDateString").mockReturnValue("Wed 8 May 2026");
});

const baseSensors = {
  snapshot: { motion: null, orientation: null, magnetometer: null, light: null },
  emf: null,
  vibration: null,
  lightAnomaly: null,
  magnetometerAvailable: false,
  lightAvailable: false,
};

// Populated sensor snapshot for the Pro-mode snapshot. Driving the
// BroadcastSensorHud rows from real values is what makes the Pro vs
// Simple snapshots actually look different — BroadcastSensorHud short-
// circuits to null when no sensors report samples, so a sensor-empty
// fixture would produce identical Pro / Simple outputs.
const populatedSensors = {
  snapshot: {
    motion: {
      timestamp: 1716336000000,
      accelMagnitude: 1.2,
      ax: 0.1, ay: 0.2, az: 1.18,
      alpha: 0, beta: 0, gamma: 0,
    },
    orientation: null,
    magnetometer: {
      timestamp: 1716336000000,
      magnitude: 42.5,
      x: 30, y: 25, z: 12,
    },
    light: {
      timestamp: 1716336000000,
      lux: 35,
      source: "ambient-light-sensor" as const,
    },
  },
  emf: null,
  vibration: null,
  lightAnomaly: null,
  magnetometerAvailable: true,
  lightAvailable: true,
};

const baseProps: CameraHudProps = {
  running: false,
  topPillState: "idle",
  sessionSecs: 0,
  audioRmsCoarse: 0.05,
  vadActive: false,
  sensors: baseSensors,
  hudBatteryPct: null,
  hudBatteryCharging: false,
  hudStorageMb: null,
  hudBatteryWarn: false,
  hudStorageWarn: false,
  watchdogSnoozeUntil: null,
  onClearSnooze: () => {},
  sceneName: "Walkthrough",
  onOpenScenePicker: () => {},
  sessionMarkerCount: 0,
  markerPillOpen: false,
  onToggleMarkerPill: () => {},
  sessionMarkerByCat: { sound: 0, movement: 0, felt: 0, untagged: 0 },
  markerPillWrapRef: createRef<HTMLDivElement>(),
  markerPillTrapRef: createRef<HTMLDivElement>(),
  onNavigateReview: () => {},
  caseTitle: null,
  caseLocation: null,
  caseStartedAt: null,
  evpDock: null,
  proMode: true,
};

describe("<CameraHud /> grid structure snapshot", () => {
  it("idle — only scene chip in sense rail, no running-gated chrome", () => {
    const { container } = render(<CameraHud {...baseProps} />);
    expect(container.firstChild).toMatchSnapshot();
  });

  it("running — Pro mode shows BroadcastAudioMeter + BroadcastSensorHud", () => {
    const { container } = render(
      <CameraHud
        {...baseProps}
        running
        topPillState="ready"
        sessionSecs={42}
        sensors={populatedSensors}
        hudBatteryPct={73}
        hudStorageMb={1860}
        caseTitle="Cold Spot Sweep"
        caseLocation="Hill End Hospital"
        caseStartedAt="2026-05-08T12:00:00.000Z"
      />,
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it("running — Simple mode suppresses BroadcastSensorHud", () => {
    const { container } = render(
      <CameraHud
        {...baseProps}
        running
        proMode={false}
        topPillState="ready"
        sessionSecs={42}
        sensors={populatedSensors}
        hudBatteryPct={73}
        hudStorageMb={1860}
      />,
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it("running — snooze chip rendered when watchdogSnoozeUntil is in the future", () => {
    // Pin Date.now so the "Snoozed Nm" label is deterministic for the
    // snapshot. 9 minutes ahead → label reads "Snoozed 9m".
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const { container } = render(
      <CameraHud
        {...baseProps}
        running
        topPillState="ready"
        sessionSecs={42}
        watchdogSnoozeUntil={1_000_000 + 9 * 60_000}
      />,
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it("running — marker pill closed (count > 0, popover absent)", () => {
    const { container } = render(
      <CameraHud
        {...baseProps}
        running
        topPillState="ready"
        sessionSecs={42}
        sessionMarkerCount={3}
        sessionMarkerByCat={{ sound: 2, movement: 1, felt: 0, untagged: 0 }}
      />,
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it("running — marker pill open: popover with category list + Review link visible", () => {
    const { container } = render(
      <CameraHud
        {...baseProps}
        running
        topPillState="ready"
        sessionSecs={42}
        sessionMarkerCount={3}
        sessionMarkerByCat={{ sound: 2, movement: 1, felt: 0, untagged: 0 }}
        markerPillOpen
      />,
    );
    expect(container.firstChild).toMatchSnapshot();
  });
});
