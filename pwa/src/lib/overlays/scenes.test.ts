import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory localStorage shim — same pattern as stream.test.ts /
// sessionBaseline.test.ts. Node's default vitest env has no localStorage.
const { storage } = vi.hoisted(() => {
  const map = new Map<string, string>();
  const storage: Storage = {
    get length() { return map.size; },
    clear() { map.clear(); },
    getItem(key) { return map.has(key) ? (map.get(key) as string) : null; },
    key(i) { return Array.from(map.keys())[i] ?? null; },
    removeItem(key) { map.delete(key); },
    setItem(key, value) { map.set(key, String(value)); },
  };
  return { storage };
});
vi.stubGlobal("localStorage", storage);

// window.dispatchEvent fires on saveActiveSceneId. Provide a CustomEvent shim
// and capture dispatches.
class FakeCustomEvent {
  type: string;
  detail: unknown;
  constructor(type: string, init?: { detail?: unknown }) {
    this.type = type;
    this.detail = init?.detail;
  }
}
const dispatchedEvents: FakeCustomEvent[] = [];
vi.stubGlobal("CustomEvent", FakeCustomEvent as unknown as typeof CustomEvent);
vi.stubGlobal("window", {
  dispatchEvent: (ev: FakeCustomEvent) => { dispatchedEvents.push(ev); return true; },
});

import {
  ACTIVE_SCENE_CHANGE_EVENT,
  BUILT_IN_SCENES,
  DEFAULT_SCENE_ID,
  getScene,
  hasPickedSceneEver,
  loadActiveSceneId,
  loadSceneOverrides,
  markSceneEverPicked,
  resolveSceneOverlayChannels,
  saveActiveSceneId,
  saveSceneOverrides,
  type SceneId,
} from "./scenes";

beforeEach(() => {
  localStorage.clear();
  dispatchedEvents.length = 0;
});

afterEach(() => {
  localStorage.clear();
});

describe("BUILT_IN_SCENES — manifest invariants", () => {
  it("includes the expected 8 built-in scene ids", () => {
    const ids = BUILT_IN_SCENES.map((s) => s.id).sort();
    expect(ids).toEqual([
      "calibration",
      "evp_session",
      "interview",
      "outdoor_cemetery",
      "pro_lab",
      "spirit_box_session",
      "vigil",
      "walkthrough",
    ]);
  });

  it("every scene has a non-empty name and description", () => {
    for (const s of BUILT_IN_SCENES) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
    }
  });

  it("walkthrough is the default", () => {
    expect(DEFAULT_SCENE_ID).toBe("walkthrough");
  });

  it("calibration + pro_lab opt out of the battery check (plugged-in benchwork)", () => {
    expect(getScene("calibration")?.preflightOverrides?.skipBattery).toBe(true);
    expect(getScene("pro_lab")?.preflightOverrides?.skipBattery).toBe(true);
  });

  it("walkthrough + outdoor_cemetery tighten the battery warn to 30%", () => {
    expect(getScene("walkthrough")?.preflightOverrides?.lowBatteryFraction).toBe(0.3);
    expect(getScene("outdoor_cemetery")?.preflightOverrides?.lowBatteryFraction).toBe(0.3);
  });

  it("evp_session + interview auto-record on session start", () => {
    expect(getScene("evp_session")?.evp).toEqual({ showRecorder: true, autoRecord: true });
    expect(getScene("interview")?.evp).toEqual({ showRecorder: true, autoRecord: true });
  });

  it("spirit_box_session mounts the recorder but does NOT auto-start (intentional clip boundary)", () => {
    expect(getScene("spirit_box_session")?.evp).toEqual({ showRecorder: true, autoRecord: false });
  });

  it("vigil flags simplifiedDock for cinematic framing", () => {
    expect(getScene("vigil")?.simplifiedDock).toBe(true);
  });
});

describe("getScene", () => {
  it("returns the matching scene by id", () => {
    expect(getScene("walkthrough")?.id).toBe("walkthrough");
  });

  it("returns undefined for unknown ids", () => {
    expect(getScene("not_a_scene" as unknown as SceneId)).toBeUndefined();
  });
});

describe("loadActiveSceneId / saveActiveSceneId", () => {
  it("returns the default when nothing is persisted", () => {
    expect(loadActiveSceneId()).toBe(DEFAULT_SCENE_ID);
  });

  it("round-trips a saved scene id", () => {
    saveActiveSceneId("vigil");
    expect(loadActiveSceneId()).toBe("vigil");
  });

  it("falls back to the default when localStorage holds an unknown id", () => {
    localStorage.setItem("ss-active-scene", "made_up");
    expect(loadActiveSceneId()).toBe(DEFAULT_SCENE_ID);
  });

  it("dispatches a same-tab CustomEvent so open Setup panels can react", () => {
    saveActiveSceneId("interview");
    expect(dispatchedEvents).toHaveLength(1);
    expect(dispatchedEvents[0].type).toBe(ACTIVE_SCENE_CHANGE_EVENT);
    expect(dispatchedEvents[0].detail).toBe("interview");
  });
});

describe("hasPickedSceneEver / markSceneEverPicked", () => {
  it("starts false on a fresh install", () => {
    expect(hasPickedSceneEver()).toBe(false);
  });

  it("becomes true after markSceneEverPicked", () => {
    markSceneEverPicked();
    expect(hasPickedSceneEver()).toBe(true);
  });
});

describe("scene overrides — load/save round trip", () => {
  it("returns an empty object when no overrides are stored", () => {
    expect(loadSceneOverrides("walkthrough")).toEqual({});
  });

  it("round-trips a sparse override map per scene", () => {
    saveSceneOverrides("walkthrough", { kiiMeter: false, caption: true });
    expect(loadSceneOverrides("walkthrough")).toEqual({ kiiMeter: false, caption: true });
  });

  it("isolates overrides per scene id", () => {
    saveSceneOverrides("walkthrough", { kiiMeter: false });
    saveSceneOverrides("vigil", { caption: true });
    expect(loadSceneOverrides("walkthrough")).toEqual({ kiiMeter: false });
    expect(loadSceneOverrides("vigil")).toEqual({ caption: true });
  });

  it("removes the localStorage key when saving an empty override map", () => {
    saveSceneOverrides("walkthrough", { kiiMeter: false });
    expect(localStorage.getItem("ss-scene-overrides:walkthrough")).not.toBeNull();
    saveSceneOverrides("walkthrough", {});
    expect(localStorage.getItem("ss-scene-overrides:walkthrough")).toBeNull();
  });

  it("ignores non-boolean entries in a corrupt override payload", () => {
    localStorage.setItem(
      "ss-scene-overrides:walkthrough",
      JSON.stringify({ kiiMeter: true, evil: "not a bool", nope: 42 }),
    );
    expect(loadSceneOverrides("walkthrough")).toEqual({ kiiMeter: true });
  });

  it("returns empty when the persisted payload is not parseable JSON", () => {
    localStorage.setItem("ss-scene-overrides:walkthrough", "not json {{{");
    expect(loadSceneOverrides("walkthrough")).toEqual({});
  });

  it("returns empty when the persisted payload is an array (defensive)", () => {
    localStorage.setItem("ss-scene-overrides:walkthrough", JSON.stringify([1, 2, 3]));
    expect(loadSceneOverrides("walkthrough")).toEqual({});
  });
});

describe("resolveSceneOverlayChannels", () => {
  it("keeps EVP Session presentation-safe even when stale localStorage tries to re-enable clutter", () => {
    saveSceneOverrides("evp_session", {
      audioMeter: true,
      caption: true,
      directionArrow: true,
      itc: true,
      kiiMeter: true,
      remPod: true,
      sensors: true,
    });

    const channels = resolveSceneOverlayChannels("evp_session");

    expect(channels.audioMeter).toBe(false);
    expect(channels.caption).toBe(false);
    expect(channels.directionArrow).toBe(false);
    expect(channels.itc).toBe(false);
    expect(channels.kiiMeter).toBe(false);
    expect(channels.remPod).toBe(false);
    expect(channels.sensors).toBe(false);
    expect(channels.statusPills).toBe(true);
    expect(channels.timestamp).toBe(true);
  });

  it("still honors ordinary overrides for non-EVP scenes", () => {
    saveSceneOverrides("walkthrough", { caption: false, kiiMeter: false });

    const channels = resolveSceneOverlayChannels("walkthrough");

    expect(channels.caption).toBe(false);
    expect(channels.kiiMeter).toBe(false);
  });
});
