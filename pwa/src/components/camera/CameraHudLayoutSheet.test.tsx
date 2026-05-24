// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  DEFAULT_OVERLAY_LAYOUT_SETTINGS,
  type OverlayLayoutSettings,
} from "../../lib/media/overlayLayout";
import { CameraHudLayoutSheet } from "./CameraHudLayoutSheet";

afterEach(() => {
  cleanup();
});

function renderSheet({
  settings = DEFAULT_OVERLAY_LAYOUT_SETTINGS,
  editingOrientation = "landscape",
  activeOrientation = "portrait",
  onSettingsChange = vi.fn(),
  onEditingOrientationChange = vi.fn(),
  onClose = vi.fn(),
}: {
  settings?: OverlayLayoutSettings;
  editingOrientation?: "portrait" | "landscape";
  activeOrientation?: "portrait" | "landscape";
  onSettingsChange?: (settings: OverlayLayoutSettings) => void;
  onEditingOrientationChange?: (orientation: "portrait" | "landscape") => void;
  onClose?: () => void;
} = {}) {
  render(
    <CameraHudLayoutSheet
      open
      settings={settings}
      editingOrientation={editingOrientation}
      activeOrientation={activeOrientation}
      onEditingOrientationChange={onEditingOrientationChange}
      onSettingsChange={onSettingsChange}
      onClose={onClose}
    />,
  );
  return { onSettingsChange, onEditingOrientationChange, onClose };
}

describe("<CameraHudLayoutSheet />", () => {
  it("exposes portrait and landscape tabs and reports orientation changes", () => {
    const onEditingOrientationChange = vi.fn();
    renderSheet({ editingOrientation: "portrait", onEditingOrientationChange });

    expect(screen.getByRole("tab", { name: /portrait/i })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: /landscape/i }));

    expect(onEditingOrientationChange).toHaveBeenCalledWith("landscape");
  });

  it("changing transparency updates only the edited orientation", () => {
    const onSettingsChange = vi.fn();
    renderSheet({ editingOrientation: "landscape", onSettingsChange });

    fireEvent.change(screen.getByRole("slider", { name: /display transparency/i }), { target: { value: "50" } });

    const next = onSettingsChange.mock.calls.at(-1)?.[0] as OverlayLayoutSettings;
    expect(next.landscape.opacity).toBe(0.5);
    expect(next.portrait.opacity).toBe(DEFAULT_OVERLAY_LAYOUT_SETTINGS.portrait.opacity);
  });

  it("changing target transparency updates only that target in the edited orientation", () => {
    const onSettingsChange = vi.fn();
    renderSheet({ editingOrientation: "landscape", onSettingsChange });

    fireEvent.change(screen.getByRole("slider", { name: /status.*transparency/i }), {
      target: { value: "60" },
    });

    const next = onSettingsChange.mock.calls.at(-1)?.[0] as OverlayLayoutSettings;
    expect(next.landscape.placements.status.opacity).toBeCloseTo(0.4);
    expect(next.landscape.placements.mic.opacity).toBeUndefined();
    expect(next.portrait.placements.status.opacity).toBeUndefined();
    expect(next.landscape.opacity).toBe(DEFAULT_OVERLAY_LAYOUT_SETTINGS.landscape.opacity);
  });

  it("show toggle hides the first phone HUD target for the edited orientation", () => {
    const onSettingsChange = vi.fn();
    renderSheet({ editingOrientation: "landscape", onSettingsChange });

    fireEvent.click(screen.getAllByLabelText("Show")[0]);

    const next = onSettingsChange.mock.calls.at(-1)?.[0] as OverlayLayoutSettings;
    expect(next.landscape.placements.status.hidden).toBe(true);
    expect(next.portrait.placements.status.hidden).toBeFalsy();
  });

  it("reset restores the edited orientation defaults without touching the other orientation", () => {
    const onSettingsChange = vi.fn();
    const dirtySettings: OverlayLayoutSettings = {
      ...DEFAULT_OVERLAY_LAYOUT_SETTINGS,
      landscape: {
        opacity: 0.4,
        placements: {
          ...DEFAULT_OVERLAY_LAYOUT_SETTINGS.landscape.placements,
          status: { anchor: "bottom-right", offsetX: 111, offsetY: -33, hidden: true },
        },
      },
    };
    renderSheet({ settings: dirtySettings, editingOrientation: "landscape", onSettingsChange });

    fireEvent.click(screen.getByRole("button", { name: /reset landscape/i }));

    const next = onSettingsChange.mock.calls.at(-1)?.[0] as OverlayLayoutSettings;
    expect(next.landscape).toEqual(DEFAULT_OVERLAY_LAYOUT_SETTINGS.landscape);
    expect(next.portrait).toEqual(DEFAULT_OVERLAY_LAYOUT_SETTINGS.portrait);
  });
});
