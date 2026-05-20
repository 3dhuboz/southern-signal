// @vitest-environment happy-dom

/**
 * Smoke tests for CameraNoVideoOverlay — pins the 4-state contract.
 *
 * The component is the camera surface's "guaranteed-opaque dark backdrop"
 * when the live preview isn't painting. If a future copy edit or state
 * branch silently drops the CTA, the wrong button label, or the data-state
 * attribute the CSS overlay opacity rule keys on (CameraScreen.module.css
 * dims chrome to 55% whenever data-camera-state !== "streaming"), the
 * 2026-05-19 bleed-through bug returns. These tests catch that.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { CameraNoVideoOverlay } from "./CameraNoVideoOverlay";

afterEach(() => { cleanup(); });

describe("CameraNoVideoOverlay", () => {
  it("renders nothing when state === streaming (live preview owns the surface)", () => {
    const { container } = render(
      <CameraNoVideoOverlay state="streaming" onAllowAccess={() => {}} onRetry={() => {}} />,
    );
    // Pure short-circuit before any DOM is touched — assertion is that
    // the wrapper has no rendered children, NOT that some hidden element
    // is present-but-empty.
    expect(container.firstChild).toBeNull();
  });

  it("idle: renders permission prompt + 'Allow camera + mic' CTA + camera glyph", () => {
    const onAllowAccess = vi.fn();
    render(
      <CameraNoVideoOverlay state="idle" onAllowAccess={onAllowAccess} onRetry={() => {}} />,
    );
    expect(screen.getByRole("heading", { name: "Camera permission required" })).toBeInTheDocument();
    expect(screen.getByText(/needs camera \+ microphone access/i)).toBeInTheDocument();
    const cta = screen.getByRole("button", { name: "Allow camera + mic" });
    expect(cta).toBeInTheDocument();
    // No error hint in idle state — the hint is error-only.
    expect(screen.queryByText(/open your browser's site settings/i)).not.toBeInTheDocument();
  });

  it("idle: tapping CTA calls onAllowAccess (NOT onRetry)", async () => {
    const onAllowAccess = vi.fn();
    const onRetry = vi.fn();
    render(
      <CameraNoVideoOverlay state="idle" onAllowAccess={onAllowAccess} onRetry={onRetry} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Allow camera + mic" }));
    expect(onAllowAccess).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("opening: renders 'Starting camera…' + waiting copy + NO button", () => {
    render(
      <CameraNoVideoOverlay state="opening" onAllowAccess={() => {}} onRetry={() => {}} />,
    );
    expect(screen.getByRole("heading", { name: "Starting camera…" })).toBeInTheDocument();
    expect(screen.getByText(/waiting on the browser/i)).toBeInTheDocument();
    // Critical: no button in opening state — taps mid-getUserMedia would
    // re-fire the permission request and the browser deduplicates noisily.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("error: renders 'Camera unavailable' + supplied error text + Retry CTA + hint", () => {
    render(
      <CameraNoVideoOverlay
        state="error"
        errorText="NotAllowedError: permission was denied"
        onAllowAccess={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByRole("heading", { name: "Camera unavailable" })).toBeInTheDocument();
    expect(screen.getByText("NotAllowedError: permission was denied")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByText(/open your browser's site settings/i)).toBeInTheDocument();
  });

  it("error: falls back to default copy when errorText is null/missing", () => {
    render(
      <CameraNoVideoOverlay
        state="error"
        errorText={null}
        onAllowAccess={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByText("We couldn't open the camera.")).toBeInTheDocument();
  });

  it("error: tapping Retry calls onRetry (NOT onAllowAccess)", async () => {
    const onAllowAccess = vi.fn();
    const onRetry = vi.fn();
    render(
      <CameraNoVideoOverlay
        state="error"
        errorText="oops"
        onAllowAccess={onAllowAccess}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onAllowAccess).not.toHaveBeenCalled();
  });

  it("dialog semantics: role=dialog, aria-labelledby links to title, aria-modal=false", () => {
    render(
      <CameraNoVideoOverlay state="idle" onAllowAccess={() => {}} onRetry={() => {}} />,
    );
    // Non-modal dialog so it doesn't trap focus the way a true modal would
    // (the underlying camera UI is still useful — e.g. Setup tab in
    // BottomNav stays reachable).
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "false");
    const titleId = dialog.getAttribute("aria-labelledby");
    expect(titleId).toBe("ss-novideo-title");
    expect(document.getElementById("ss-novideo-title")).toHaveTextContent("Camera permission required");
  });

  it("data-state attribute reflects current state — CSS opacity dim rule depends on this", () => {
    // The CameraScreen.module.css opacity rule keys on data-camera-state
    // on the cameraWrap, but the overlay also stamps data-state for its
    // own CSS hooks. Pin both so a rename here doesn't silently desync
    // either CSS module.
    const { rerender, container } = render(
      <CameraNoVideoOverlay state="idle" onAllowAccess={() => {}} onRetry={() => {}} />,
    );
    expect(container.querySelector("[data-state='idle']")).toBeTruthy();
    rerender(
      <CameraNoVideoOverlay state="opening" onAllowAccess={() => {}} onRetry={() => {}} />,
    );
    expect(container.querySelector("[data-state='opening']")).toBeTruthy();
    rerender(
      <CameraNoVideoOverlay state="error" onAllowAccess={() => {}} onRetry={() => {}} />,
    );
    expect(container.querySelector("[data-state='error']")).toBeTruthy();
  });

  it("data-novideo-pinned attribute present — keeps overlay opaque under the chrome-dim rule", () => {
    // CameraScreen.module.css applies a 0.55 opacity rule to
    // .cameraWrap > *:not([data-novideo-pinned]) when camera-state isn't
    // streaming. If this attribute is dropped, the overlay itself gets
    // dimmed and the dark backdrop guarantee breaks.
    const { container } = render(
      <CameraNoVideoOverlay state="idle" onAllowAccess={() => {}} onRetry={() => {}} />,
    );
    expect(container.querySelector("[data-novideo-pinned]")).toBeTruthy();
  });
});
