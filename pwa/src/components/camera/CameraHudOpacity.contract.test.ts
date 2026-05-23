import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function css(relativePath: string): string {
  return readFileSync(resolve(here, relativePath), "utf8");
}

function blockContains(source: string, selector: string, needle: RegExp): boolean {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[\\s\\S]*?)\\}`).exec(source);
  return needle.test(match?.groups?.body ?? "");
}

describe("camera HUD opacity contract", () => {
  it("secondary overlay chips consume the shared HUD opacity variable", () => {
    const deviceChipCss = css("./CameraDeviceChip.module.css");
    const snoozeChipCss = css("./CameraSnoozeChip.module.css");
    const markerPillCss = css("./CameraMarkerPill.module.css");
    const cameraHudCss = css("../broadcast/CameraHud.module.css");
    const opacityRule = /opacity:\s*var\(--ss-hud-opacity,\s*1\)/;

    expect(blockContains(deviceChipCss, ".deviceChip", opacityRule)).toBe(true);
    expect(blockContains(snoozeChipCss, ".snoozeChip", opacityRule)).toBe(true);
    expect(blockContains(markerPillCss, ".markerPillWrap", opacityRule)).toBe(true);
    expect(blockContains(cameraHudCss, ".evpDockSlot", opacityRule)).toBe(true);
  });
});
