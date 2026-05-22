// @vitest-environment happy-dom

/**
 * CameraSnoozeChip smoke tests — pin the rendering + the un-snooze callback.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { CameraSnoozeChip } from "./CameraSnoozeChip";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<CameraSnoozeChip />", () => {
  beforeEach(() => {
    // Pin Date.now so the "Snoozed Nm" countdown is deterministic.
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  });

  it("renders the chip with the minutes-remaining countdown", () => {
    render(
      <CameraSnoozeChip
        snoozeUntil={1_000_000 + 9 * 60_000}
        onClearSnooze={() => {}}
      />,
    );
    expect(screen.getByText(/snoozed 9m/i)).toBeInTheDocument();
  });

  it("aria-label communicates 'snoozed — tap to resume'", () => {
    render(
      <CameraSnoozeChip
        snoozeUntil={1_000_000 + 9 * 60_000}
        onClearSnooze={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /watchdog snoozed/i })).toBeInTheDocument();
  });

  it("clicking the chip invokes onClearSnooze", () => {
    const onClearSnooze = vi.fn();
    render(
      <CameraSnoozeChip
        snoozeUntil={1_000_000 + 9 * 60_000}
        onClearSnooze={onClearSnooze}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /watchdog snoozed/i }));
    expect(onClearSnooze).toHaveBeenCalledTimes(1);
  });

  it("snoozeUntil in the past clamps to 0m, not a negative", () => {
    render(
      <CameraSnoozeChip
        snoozeUntil={1_000_000 - 60_000}
        onClearSnooze={() => {}}
      />,
    );
    expect(screen.getByText(/snoozed 0m/i)).toBeInTheDocument();
  });
});
