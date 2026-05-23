// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_OVERLAY_LAYOUT_SETTINGS,
  OVERLAY_LAYOUT_STORAGE_KEY,
  loadOverlayLayoutSettings,
  normalizeOverlayLayoutSettings,
  saveOverlayLayoutSettings,
  updateOverlayOpacity,
  updateOverlayPlacement,
} from "./overlayLayout";

describe("overlayLayout storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("loads defaults when no saved profile exists", () => {
    const loaded = loadOverlayLayoutSettings();
    expect(loaded.landscape.opacity).toBe(DEFAULT_OVERLAY_LAYOUT_SETTINGS.landscape.opacity);
    expect(loaded.portrait.placements.audioStack.anchor).toBe("middle-left");
  });

  it("normalizes corrupt and partial saved profiles", () => {
    localStorage.setItem(OVERLAY_LAYOUT_STORAGE_KEY, JSON.stringify({
      version: 1,
      landscape: {
        opacity: 2,
        placements: {
          audioStack: { anchor: "not-real", offsetX: 9999, offsetY: -9999 },
          emfStack: { anchor: "bottom-right", offsetX: 24, offsetY: 18 },
        },
      },
    }));

    const loaded = loadOverlayLayoutSettings();
    expect(loaded.landscape.opacity).toBe(1);
    expect(loaded.landscape.placements.audioStack.anchor).toBe("middle-left");
    expect(loaded.landscape.placements.audioStack.offsetX).toBe(480);
    expect(loaded.landscape.placements.audioStack.offsetY).toBe(-480);
    expect(loaded.landscape.placements.emfStack.anchor).toBe("bottom-right");
    expect(loaded.portrait.placements.scene.anchor).toBe("top-right");
  });

  it("updates opacity and placements without touching the other orientation", () => {
    const afterOpacity = updateOverlayOpacity(DEFAULT_OVERLAY_LAYOUT_SETTINGS, "landscape", 0.5);
    const afterPlacement = updateOverlayPlacement(afterOpacity, "landscape", "evp", {
      anchor: "middle-right",
      offsetX: 22,
      offsetY: -14,
    });

    expect(afterPlacement.landscape.opacity).toBe(0.5);
    expect(afterPlacement.landscape.placements.evp).toMatchObject({
      anchor: "middle-right",
      offsetX: 22,
      offsetY: -14,
    });
    expect(afterPlacement.portrait).toEqual(DEFAULT_OVERLAY_LAYOUT_SETTINGS.portrait);
  });

  it("saves normalized profiles", () => {
    const settings = normalizeOverlayLayoutSettings({
      landscape: {
        opacity: 0.4,
        placements: { caption: { anchor: "bottom-left", offsetX: 10, offsetY: 20 } },
      },
    });

    saveOverlayLayoutSettings(settings);
    const raw = localStorage.getItem(OVERLAY_LAYOUT_STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw ?? "{}").landscape.opacity).toBe(0.4);
  });
});
