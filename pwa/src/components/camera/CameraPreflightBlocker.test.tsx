// @vitest-environment happy-dom

/**
 * CameraPreflightBlocker smoke tests — pin the alertdialog semantics,
 * the per-level row rendering, and the dismiss wiring.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { CameraPreflightBlocker } from "./CameraPreflightBlocker";

afterEach(() => {
  cleanup();
});

describe("<CameraPreflightBlocker />", () => {
  it("alertdialog semantics — role=alertdialog + aria-label", () => {
    render(
      <CameraPreflightBlocker
        report={{ overall: "block", checks: [] }}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByRole("alertdialog", { name: /pre-flight check failed/i })).toBeInTheDocument();
  });

  it("renders block-level checks with their message", () => {
    render(
      <CameraPreflightBlocker
        report={{
          overall: "block",
          checks: [
            { id: "camera", level: "block", message: "Camera permission denied" },
          ],
        }}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText("camera")).toBeInTheDocument();
    expect(screen.getByText("Camera permission denied")).toBeInTheDocument();
  });

  it("renders warn-level checks alongside block-level ones", () => {
    render(
      <CameraPreflightBlocker
        report={{
          overall: "block",
          checks: [
            { id: "camera", level: "block", message: "Camera denied" },
            { id: "battery", level: "warn", message: "Battery low" },
          ],
        }}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText("Camera denied")).toBeInTheDocument();
    expect(screen.getByText("Battery low")).toBeInTheDocument();
  });

  it("skips ok-level checks in the visible list", () => {
    render(
      <CameraPreflightBlocker
        report={{
          overall: "block",
          checks: [
            { id: "camera", level: "block", message: "Camera denied" },
            { id: "mic",    level: "ok",    message: "Microphone OK" },
          ],
        }}
        onDismiss={() => {}}
      />,
    );
    expect(screen.queryByText("Microphone OK")).toBeNull();
    expect(screen.getByText("Camera denied")).toBeInTheDocument();
  });

  it("clicking Got it invokes onDismiss", () => {
    const onDismiss = vi.fn();
    render(
      <CameraPreflightBlocker
        report={{ overall: "block", checks: [] }}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /got it/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
