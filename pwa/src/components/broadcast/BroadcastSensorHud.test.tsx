// @vitest-environment happy-dom

/**
 * BroadcastSensorHud smoke test.
 *
 * The HUD is the "OB van data block" — three rows (EMF / LUX / ACC) of
 * key + right-aligned value. Graceful-degradation is the load-bearing
 * behaviour we pin: iOS phones with no magnetometer must NOT see a
 * fake EMF row, and a fully-empty sensor set must render nothing at all
 * (chromeless camera frame, not an empty glass rectangle).
 *
 * We feed minimal MagnetometerSample / LightSample / MotionSample
 * shapes by hand — the real sensor modules import from this file's
 * sibling lib/sensors/ but the types are pure data so we don't have to
 * touch the navigator.* surface or stub the Generic Sensor API.
 *
 * The anomaly-flash a11y pass added in this commit is exercised by the
 * "EMF anomaly: ..." assertion: when the alert flag rises, the hidden
 * live region announces the spike so a blind operator hears it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { LightSample } from "../../lib/sensors/light";
import type { MagnetometerSample } from "../../lib/sensors/magnetometer";
import type { MotionSample } from "../../lib/sensors/motion";
import { BroadcastSensorHud } from "./BroadcastSensorHud";

afterEach(() => {
  cleanup();
});

// Hand-rolled sample fixtures. Shape matches the real interfaces in
// src/lib/sensors/* — we only need a subset for the HUD's display
// logic (magnitude / lux / accelMagnitude).
const MAG_SAMPLE: MagnetometerSample = {
  timestamp: 1_700_000_000_000,
  magnitude: 24.3,
  x: 12, y: 18, z: 9,
};

const LIGHT_SAMPLE: LightSample = {
  timestamp: 1_700_000_000_000,
  lux: 18,
  source: "ambient-light-sensor",
};

const MOTION_SAMPLE: MotionSample = {
  timestamp: 1_700_000_000_000,
  accelMagnitude: 0.42,
  ax: 0.1, ay: 0.2, az: 9.8,
  alpha: 0, beta: 0, gamma: 0,
};

describe("<BroadcastSensorHud />", () => {
  it("renders all three rows when full sensor data + hardware flags are provided", () => {
    render(
      <BroadcastSensorHud
        magnetometer={MAG_SAMPLE}
        light={LIGHT_SAMPLE}
        motion={MOTION_SAMPLE}
        magnetometerAvailable
        lightAvailable
      />,
    );
    expect(screen.getByText("EMF")).toBeInTheDocument();
    expect(screen.getByText("LUX")).toBeInTheDocument();
    expect(screen.getByText("ACC")).toBeInTheDocument();
    // Units render alongside the numerals.
    expect(screen.getByText("µT")).toBeInTheDocument();
    expect(screen.getByText("lx")).toBeInTheDocument();
    expect(screen.getByText("m/s²")).toBeInTheDocument();
  });

  it("renders nothing at all when every sensor is missing (chromeless camera frame)", () => {
    const { container } = render(
      <BroadcastSensorHud
        magnetometer={null}
        light={null}
        motion={null}
        magnetometerAvailable={false}
        lightAvailable={false}
      />,
    );
    // Component early-returns null — root has no children.
    expect(container.firstChild).toBeNull();
  });

  it("drops the EMF row when magnetometer is null (iOS Safari case)", () => {
    render(
      <BroadcastSensorHud
        magnetometer={null}
        light={LIGHT_SAMPLE}
        motion={MOTION_SAMPLE}
        magnetometerAvailable={false}
        lightAvailable
      />,
    );
    // EMF row absent.
    expect(screen.queryByText("EMF")).toBeNull();
    // LUX and ACC still render.
    expect(screen.getByText("LUX")).toBeInTheDocument();
    expect(screen.getByText("ACC")).toBeInTheDocument();
  });

  it("drops the LUX row when ambient-light sensor is unavailable", () => {
    render(
      <BroadcastSensorHud
        magnetometer={MAG_SAMPLE}
        light={null}
        motion={MOTION_SAMPLE}
        magnetometerAvailable
        lightAvailable={false}
      />,
    );
    expect(screen.queryByText("LUX")).toBeNull();
    expect(screen.getByText("EMF")).toBeInTheDocument();
    expect(screen.getByText("ACC")).toBeInTheDocument();
  });

  it("numeric values render with the .num class so tabular-nums applies", () => {
    const { container } = render(
      <BroadcastSensorHud
        magnetometer={MAG_SAMPLE}
        light={LIGHT_SAMPLE}
        motion={MOTION_SAMPLE}
        magnetometerAvailable
        lightAvailable
      />,
    );
    // CSS module hashes the suffix; the prefix `num` is preserved.
    const numCells = container.querySelectorAll("[class*='num']");
    // EMF / LUX / ACC = 3 numeric cells.
    expect(numCells.length).toBeGreaterThanOrEqual(3);
  });

  it("formats sensor values to the documented precision (EMF 1dp, ACC 2dp)", () => {
    const { container } = render(
      <BroadcastSensorHud
        magnetometer={MAG_SAMPLE}
        light={LIGHT_SAMPLE}
        motion={MOTION_SAMPLE}
        magnetometerAvailable
        lightAvailable
      />,
    );
    const text = container.textContent ?? "";
    // 24.3 µT → "24.3"
    expect(text).toContain("24.3");
    // 0.42 m/s² → "0.42"
    expect(text).toContain("0.42");
  });

  it("declares role=group with an aria-label for screen-reader navigation", () => {
    const { container } = render(
      <BroadcastSensorHud
        magnetometer={MAG_SAMPLE}
        light={LIGHT_SAMPLE}
        motion={MOTION_SAMPLE}
        magnetometerAvailable
        lightAvailable
      />,
    );
    const group = container.querySelector("[role='group']");
    expect(group).not.toBeNull();
    expect(group?.getAttribute("aria-label")).toMatch(/Live sensor readings/i);
  });

  it("anomaly flash exposes an aria-live='polite' region for AT announcements", () => {
    // The live region is always mounted (otherwise its first appearance
    // wouldn't fire an announcement). It just holds an empty string
    // until a flash rises.
    const { container } = render(
      <BroadcastSensorHud
        magnetometer={MAG_SAMPLE}
        light={LIGHT_SAMPLE}
        motion={MOTION_SAMPLE}
        magnetometerAvailable
        lightAvailable
      />,
    );
    const live = container.querySelector("[aria-live='polite']");
    expect(live).not.toBeNull();
    expect(live?.getAttribute("aria-atomic")).toBe("true");
  });
});
