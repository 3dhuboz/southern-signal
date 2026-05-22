// @vitest-environment happy-dom

/**
 * CameraWatchdogToast smoke tests — pin the warn vs block variant, the
 * count chip threshold, the Install CTA visibility, and the three
 * callback wirings.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { PreflightReport } from "../../lib/system/preflight";
import { CameraWatchdogToast } from "./CameraWatchdogToast";

afterEach(() => {
  cleanup();
});

const baseReport: PreflightReport = {
  overall: "warn",
  checks: [
    {
      id: "battery",
      level: "warn",
      message: "Battery is low",
      data: { batteryLevel: 0.18, batteryCharging: false },
    },
  ],
};

describe("<CameraWatchdogToast />", () => {
  it("warn severity → 'Device state degraded' headline", () => {
    render(
      <CameraWatchdogToast
        report={baseReport}
        count={1}
        batteryProjectionMinutes={null}
        storageProjectionMinutes={null}
        installAvailable={false}
        onDismiss={() => {}}
        onSnooze={() => {}}
        onInstall={() => {}}
      />,
    );
    expect(screen.getByText(/device state degraded/i)).toBeInTheDocument();
  });

  it("block severity → 'Device state critical' headline", () => {
    render(
      <CameraWatchdogToast
        report={{ ...baseReport, overall: "block" }}
        count={1}
        batteryProjectionMinutes={null}
        storageProjectionMinutes={null}
        installAvailable={false}
        onDismiss={() => {}}
        onSnooze={() => {}}
        onInstall={() => {}}
      />,
    );
    expect(screen.getByText(/device state critical/i)).toBeInTheDocument();
  });

  it("count=1 hides the 'Nth warning' chip; count=2 shows '2nd warning'", () => {
    const { rerender } = render(
      <CameraWatchdogToast
        report={baseReport}
        count={1}
        batteryProjectionMinutes={null}
        storageProjectionMinutes={null}
        installAvailable={false}
        onDismiss={() => {}}
        onSnooze={() => {}}
        onInstall={() => {}}
      />,
    );
    expect(screen.queryByText(/warning$/i)).not.toBeInTheDocument();

    rerender(
      <CameraWatchdogToast
        report={baseReport}
        count={2}
        batteryProjectionMinutes={null}
        storageProjectionMinutes={null}
        installAvailable={false}
        onDismiss={() => {}}
        onSnooze={() => {}}
        onInstall={() => {}}
      />,
    );
    expect(screen.getByText(/2nd warning/i)).toBeInTheDocument();
  });

  it("body aria-label is 'Dismiss device warning' for AT", () => {
    render(
      <CameraWatchdogToast
        report={baseReport}
        count={1}
        batteryProjectionMinutes={null}
        storageProjectionMinutes={null}
        installAvailable={false}
        onDismiss={() => {}}
        onSnooze={() => {}}
        onInstall={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /dismiss device warning/i })).toBeInTheDocument();
  });

  it("Install CTA renders only when storage warns AND installAvailable", () => {
    const storageReport: PreflightReport = {
      overall: "warn",
      checks: [{ id: "storage", level: "warn", message: "Low" }],
    };
    const { rerender } = render(
      <CameraWatchdogToast
        report={storageReport}
        count={1}
        batteryProjectionMinutes={null}
        storageProjectionMinutes={null}
        installAvailable
        onDismiss={() => {}}
        onSnooze={() => {}}
        onInstall={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /^install$/i })).toBeInTheDocument();

    // Same storage warn but installAvailable=false → no Install button.
    rerender(
      <CameraWatchdogToast
        report={storageReport}
        count={1}
        batteryProjectionMinutes={null}
        storageProjectionMinutes={null}
        installAvailable={false}
        onDismiss={() => {}}
        onSnooze={() => {}}
        onInstall={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /^install$/i })).toBeNull();
  });

  it("clicking the body fires onDismiss", () => {
    const onDismiss = vi.fn();
    render(
      <CameraWatchdogToast
        report={baseReport}
        count={1}
        batteryProjectionMinutes={null}
        storageProjectionMinutes={null}
        installAvailable={false}
        onDismiss={onDismiss}
        onSnooze={() => {}}
        onInstall={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /dismiss device warning/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("clicking Snooze 10m fires onSnooze", () => {
    const onSnooze = vi.fn();
    render(
      <CameraWatchdogToast
        report={baseReport}
        count={1}
        batteryProjectionMinutes={null}
        storageProjectionMinutes={null}
        installAvailable={false}
        onDismiss={() => {}}
        onSnooze={onSnooze}
        onInstall={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /snooze 10m/i }));
    expect(onSnooze).toHaveBeenCalledTimes(1);
  });

  it("clicking Install fires onInstall", () => {
    const onInstall = vi.fn();
    const storageReport: PreflightReport = {
      overall: "warn",
      checks: [{ id: "storage", level: "warn", message: "Low" }],
    };
    render(
      <CameraWatchdogToast
        report={storageReport}
        count={1}
        batteryProjectionMinutes={null}
        storageProjectionMinutes={null}
        installAvailable
        onDismiss={() => {}}
        onSnooze={() => {}}
        onInstall={onInstall}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^install$/i }));
    expect(onInstall).toHaveBeenCalledTimes(1);
  });
});
