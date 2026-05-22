// @vitest-environment happy-dom

/**
 * CameraDeviceChip smoke tests — pin the render branches across the
 * "battery only / storage only / both / neither" matrix and the warn
 * styling toggle.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { CameraDeviceChip } from "./CameraDeviceChip";

afterEach(() => {
  cleanup();
});

describe("<CameraDeviceChip />", () => {
  it("renders null when both readings are missing — no empty pill", () => {
    const { container } = render(
      <CameraDeviceChip
        batteryPct={null}
        batteryCharging={false}
        storageMb={null}
        batteryWarn={false}
        storageWarn={false}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("battery only — shows '83%' and no storage block", () => {
    render(
      <CameraDeviceChip
        batteryPct={83}
        batteryCharging={false}
        storageMb={null}
        batteryWarn={false}
        storageWarn={false}
      />,
    );
    expect(screen.getByText("83%")).toBeInTheDocument();
    expect(screen.queryByText(/free/i)).toBeNull();
  });

  it("storage only — shows MB free and no battery block", () => {
    render(
      <CameraDeviceChip
        batteryPct={null}
        batteryCharging={false}
        storageMb={420}
        batteryWarn={false}
        storageWarn={false}
      />,
    );
    expect(screen.getByText("420MB")).toBeInTheDocument();
    expect(screen.getByText(/free/i)).toBeInTheDocument();
  });

  it("storage ≥ 1024MB renders in GB with one decimal", () => {
    render(
      <CameraDeviceChip
        batteryPct={null}
        batteryCharging={false}
        storageMb={1860}
        batteryWarn={false}
        storageWarn={false}
      />,
    );
    expect(screen.getByText("1.8GB")).toBeInTheDocument();
  });

  it("both readings — renders battery + dot separator + storage", () => {
    const { container } = render(
      <CameraDeviceChip
        batteryPct={73}
        batteryCharging={false}
        storageMb={1860}
        batteryWarn={false}
        storageWarn={false}
      />,
    );
    expect(screen.getByText("73%")).toBeInTheDocument();
    expect(screen.getByText("1.8GB")).toBeInTheDocument();
    expect(container.textContent).toContain("·");
  });

  it("charging=true renders the ⚡ glyph", () => {
    render(
      <CameraDeviceChip
        batteryPct={73}
        batteryCharging
        storageMb={null}
        batteryWarn={false}
        storageWarn={false}
      />,
    );
    expect(screen.getByText("⚡")).toBeInTheDocument();
  });

  it("aria-label is 'Device state' on the root chip", () => {
    render(
      <CameraDeviceChip
        batteryPct={73}
        batteryCharging={false}
        storageMb={null}
        batteryWarn={false}
        storageWarn={false}
      />,
    );
    expect(screen.getByLabelText("Device state")).toBeInTheDocument();
  });
});
