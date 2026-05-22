// @vitest-environment happy-dom

/**
 * CameraMarkerPicker smoke tests — pin the chip set, the dialog semantics,
 * and the click → callback wiring (with note vs without).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { CameraMarkerPicker } from "./CameraMarkerPicker";

afterEach(() => {
  cleanup();
});

describe("<CameraMarkerPicker />", () => {
  it("dialog a11y: role=dialog + aria-modal=false + aria-label + aria-live", () => {
    render(
      <CameraMarkerPicker onPickQuickTag={() => {}} onPickCategory={() => {}} />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "false");
    expect(dialog).toHaveAttribute("aria-label", "Tag this marker");
    expect(dialog).toHaveAttribute("aria-live", "polite");
  });

  it("renders the five quick-tag chips with their visible labels", () => {
    render(
      <CameraMarkerPicker onPickQuickTag={() => {}} onPickCategory={() => {}} />,
    );
    expect(screen.getByRole("button", { name: /cold spot/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /footstep/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /voice/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /object moved/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /touched/i })).toBeInTheDocument();
  });

  it("renders the three category chips", () => {
    render(
      <CameraMarkerPicker onPickQuickTag={() => {}} onPickCategory={() => {}} />,
    );
    expect(screen.getByRole("button", { name: /^sound$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^movement$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^felt$/i })).toBeInTheDocument();
  });

  it("clicking a quick-tag chip invokes onPickQuickTag with label + category", () => {
    const onPickQuickTag = vi.fn();
    render(
      <CameraMarkerPicker onPickQuickTag={onPickQuickTag} onPickCategory={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /cold spot/i }));
    expect(onPickQuickTag).toHaveBeenCalledWith("Cold spot", "felt");
  });

  it("clicking a category chip invokes onPickCategory (no note)", () => {
    const onPickCategory = vi.fn();
    render(
      <CameraMarkerPicker onPickQuickTag={() => {}} onPickCategory={onPickCategory} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^sound$/i }));
    expect(onPickCategory).toHaveBeenCalledWith("sound");
  });

  it("focuses the first chip on mount (keyboard a11y)", () => {
    render(
      <CameraMarkerPicker onPickQuickTag={() => {}} onPickCategory={() => {}} />,
    );
    // First chip in the quick-tag row is "Cold spot".
    expect(document.activeElement?.textContent).toBe("Cold spot");
  });
});
