/**
 * Scenes — named bundles of overlay choices + tool config + camera defaults.
 *
 * The operator picks a Scene in HuntSetup BEFORE the hunt. Once selected,
 * the Scene is the source of truth for what burns into the broadcast frame
 * during the session. This is the OBS-style "scene" pattern — quick
 * recognisable presets instead of 14 individual toggles during the hunt.
 *
 * Adding a new built-in scene is a one-file change: add a Scene entry below.
 * Operators can also create custom scenes (stored in localStorage as
 * SceneOverride records) but the built-in set is the curated baseline.
 */

import type { OverlayId } from "./registry";

export type SceneId =
  | "walkthrough"
  | "spirit_box_session"
  | "vigil"
  | "calibration"
  | "pro_lab";

export interface SceneToolConfig {
  /** Auto-start Spirit Box phoneme cycle when the session begins. */
  spiritBox: boolean;
  /** Auto-start Ovilus word-gen cycle. */
  ovilus: boolean;
}

export interface SceneCameraDefaults {
  torch: boolean;
  facing: "environment" | "user";
}

export interface Scene {
  id: SceneId;
  name: string;
  /** Two-line description shown in the HuntSetup picker. */
  description: string;
  /** Sparse: only specifies what differs from registry defaults. */
  overlays: Partial<Record<OverlayId, boolean>>;
  tools: SceneToolConfig;
  cameraDefaults: SceneCameraDefaults;
}

/**
 * The 5 built-in scenes. Order here is the order shown in HuntSetup so the
 * picker reads top-to-bottom from "newcomer-friendly" to "expert/pro".
 */
export const BUILT_IN_SCENES: readonly Scene[] = [
  {
    id: "walkthrough",
    name: "Walkthrough",
    description: "Moving through the site. Lights on, raw sensor data visible — see what the phone is reading as you sweep each room.",
    overlays: {
      // Defaults handle most channels; explicit only where we diverge.
      kiiMeter: true,         // Operator wants real-time EMF feedback while moving.
      remPod: false,          // Stationary instrument; less useful in motion.
      nightVision: false,     // Walkthroughs are typically lights-on.
      directionArrow: true,   // Useful when something pings while walking.
      caption: true,          // Narration helps walkthroughs.
    },
    tools: { spiritBox: false, ovilus: false },
    cameraDefaults: { torch: false, facing: "environment" },
  },

  {
    id: "spirit_box_session",
    name: "Spirit Box Session",
    description: "Stationary, ITC running, NV on. Camera focused on the investigator's face and the phone's auto-running phoneme cycle.",
    overlays: {
      kiiMeter: true,
      remPod: true,
      nightVision: true,
      directionArrow: true,
      caption: false,         // Don't compete with the ITC text for attention.
      cornerBrackets: true,
    },
    tools: { spiritBox: true, ovilus: false },
    cameraDefaults: { torch: false, facing: "user" }, // Selfie cam — face on camera.
  },

  {
    id: "vigil",
    name: "Vigil",
    description: "Stationary, minimal HUD. Cinematic look — audio meter + timestamp + status pills only. Let the room and the investigator's reactions carry the frame.",
    overlays: {
      sensors: false,
      itc: false,
      kiiMeter: false,
      remPod: false,
      nightVision: false,
      directionArrow: false,
      caption: false,
      cornerBrackets: true,   // Subtle broadcast frame.
      // audioMeter, timestamp, statusPills stay on via mandatory / default.
    },
    tools: { spiritBox: false, ovilus: false },
    cameraDefaults: { torch: false, facing: "environment" },
  },

  {
    id: "calibration",
    name: "Calibration",
    description: "Pre-session baseline establishment. Every sensor readout visible, no ITC tools running, no Bayesian inference — pure raw data capture.",
    overlays: {
      sensors: true,
      itc: false,             // Don't generate noise during calibration.
      kiiMeter: true,
      remPod: true,
      nightVision: false,
      directionArrow: false,
      caption: false,
    },
    tools: { spiritBox: false, ovilus: false },
    cameraDefaults: { torch: false, facing: "environment" },
  },

  {
    id: "pro_lab",
    name: "Pro / Lab",
    description: "Full diagnostic surface. All sensor readouts, Bayesian posterior + activity band visible, edge glow active. Use for review-grade capture — NOT recommended for general-audience streaming.",
    overlays: {
      sensors: true,
      itc: true,
      kiiMeter: true,
      remPod: true,
      nightVision: false,
      directionArrow: true,
      caption: true,
      // Bayesian surfaces ONLY enabled in this scene.
      activityPill: true,
      posteriorPill: true,
      edgeGlow: true,
    },
    tools: { spiritBox: false, ovilus: false },
    cameraDefaults: { torch: false, facing: "environment" },
  },
];

const SCENES_BY_ID = new Map<SceneId, Scene>(BUILT_IN_SCENES.map((s) => [s.id, s]));

export function getScene(id: SceneId): Scene | undefined {
  return SCENES_BY_ID.get(id);
}

/** First-time-user default — Walkthrough (panel-chosen). */
export const DEFAULT_SCENE_ID: SceneId = "walkthrough";

// ── localStorage persistence ──────────────────────────────────────────────────

const ACTIVE_SCENE_KEY = "ss-active-scene";

export function loadActiveSceneId(): SceneId {
  try {
    const raw = localStorage.getItem(ACTIVE_SCENE_KEY);
    if (raw && SCENES_BY_ID.has(raw as SceneId)) return raw as SceneId;
  } catch { /* ignore */ }
  return DEFAULT_SCENE_ID;
}

export function saveActiveSceneId(id: SceneId): void {
  try { localStorage.setItem(ACTIVE_SCENE_KEY, id); } catch { /* ignore */ }
}

/** First-run marker — HuntSetup forces itself on a fresh install. */
const HAS_PICKED_KEY = "ss-has-picked-scene";

export function hasPickedSceneEver(): boolean {
  try { return localStorage.getItem(HAS_PICKED_KEY) === "1"; }
  catch { return false; }
}

export function markSceneEverPicked(): void {
  try { localStorage.setItem(HAS_PICKED_KEY, "1"); } catch { /* ignore */ }
}

// ── Per-scene overlay overrides ────────────────────────────────────────────
//
// HuntSetup → Customise lets the operator tweak individual overlay toggles
// for any scene WITHOUT mutating the built-in scene definition. The result
// is persisted as a sparse partial keyed by scene id. The Camera screen
// reads it at mount and merges scene.overlays ∪ overrides before passing
// the bundle through `resolveOverlaysFromScene` (forensicMandatory still
// wins inside the registry resolver — overrides can't unhide the chain).

const SCENE_OVERRIDES_KEY_PREFIX = "ss-scene-overrides:";

export function loadSceneOverrides(sceneId: SceneId): Partial<Record<OverlayId, boolean>> {
  try {
    const raw = localStorage.getItem(SCENE_OVERRIDES_KEY_PREFIX + sceneId);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // Coerce to the strict partial shape — drop any non-boolean entries
      // so a corrupt payload can't poison the override stream.
      const out: Partial<Record<OverlayId, boolean>> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "boolean") (out as Record<string, boolean>)[k] = v;
      }
      return out;
    }
  } catch { /* ignore */ }
  return {};
}

export function saveSceneOverrides(
  sceneId: SceneId,
  overrides: Partial<Record<OverlayId, boolean>>,
): void {
  try {
    // Empty overrides → remove the key so we don't accumulate dead entries.
    if (!overrides || Object.keys(overrides).length === 0) {
      localStorage.removeItem(SCENE_OVERRIDES_KEY_PREFIX + sceneId);
      return;
    }
    localStorage.setItem(SCENE_OVERRIDES_KEY_PREFIX + sceneId, JSON.stringify(overrides));
  } catch { /* ignore */ }
}
