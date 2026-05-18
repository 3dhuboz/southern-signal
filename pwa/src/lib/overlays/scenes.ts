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
import type { PreflightOverrides } from "../system/preflight";

export type SceneId =
  | "walkthrough"
  | "evp_session"
  | "spirit_box_session"
  | "vigil"
  | "outdoor_cemetery"
  | "interview"
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

/**
 * Scene-driven EVP recorder behaviour. When `showRecorder` is true, the
 * camera HUD mounts a compact EvpRecorderControl near the dock so the
 * operator can start/stop forensic-grade audio capture without leaving
 * the camera. When `autoRecord` is also true, the recorder starts itself
 * the moment the session begins — useful for "EVP Session" scenes where
 * the whole point is audio capture, and matches what the operator would
 * have manually clicked anyway.
 *
 * Stop-on-session-end is implicit: when `running` flips off, the recorder
 * auto-stops + saves so the operator doesn't lose the clip by simply
 * hitting the BIG SHUTTER's end-session action.
 */
export interface SceneEvpConfig {
  showRecorder: boolean;
  autoRecord?: boolean;
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
  /**
   * Preflight tuning. Plugged-in benchwork scenes (Calibration, Pro/Lab)
   * skip the battery check; mobile scenes (Walkthrough) tighten the warn
   * threshold because there's no opportunity to charge mid-hunt. Undefined
   * = use module defaults.
   */
  preflightOverrides?: PreflightOverrides;
  /**
   * Strip the camera dock down to Scenes + Settings only — hides Clip Rec,
   * Flip, and Torch buttons. The Vigil scene uses this to preserve the
   * "cinematic, hands-off" framing the panel called for; the BIG SHUTTER
   * still works as the primary action so the operator can start/stop.
   */
  simplifiedDock?: boolean;
  /**
   * EVP recorder mount + auto-start config. Undefined = no embedded
   * recorder; the EVP tab remains the only path to capture clips for that
   * scene. Defined → mounts on the camera HUD; honour autoRecord if set.
   */
  evp?: SceneEvpConfig;
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
    // Walkthroughs are mobile — the operator can't charge mid-hunt, so warn
    // earlier (30%) to give time to wrap up before the device cuts out.
    preflightOverrides: { lowBatteryFraction: 0.30 },
  },

  {
    id: "evp_session",
    name: "EVP Session",
    description: "Stationary, mic is the instrument. Auto-starts a forensic 16-bit / 48 kHz capture the moment the session begins; the recorder sits on the camera HUD so you can pause / stop without leaving the scene.",
    overlays: {
      // Mic is the centrepiece — keep the visual HUD calm so the operator's
      // ear can do the work. Sensors visible but no ITC noise.
      sensors: true,
      itc: false,
      kiiMeter: false,
      remPod: false,
      nightVision: false,
      directionArrow: false,
      caption: true,            // Captions are critical when the audience is listening.
      cornerBrackets: true,
    },
    tools: { spiritBox: false, ovilus: false },
    cameraDefaults: { torch: false, facing: "environment" },
    evp: { showRecorder: true, autoRecord: true },
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
    // Spirit-box runs ARE EVP territory — auto-mount the recorder so the
    // operator captures the phoneme output stream alongside the ITC tones.
    // Don't auto-start: the operator should hit it explicitly so the clip
    // boundary is intentional (start when they begin a "question round").
    evp: { showRecorder: true, autoRecord: false },
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
    // Vigil is cinematic — strip the dock down so nothing competes with the
    // frame. Shutter still anchors the bottom for start/stop.
    simplifiedDock: true,
  },

  {
    id: "outdoor_cemetery",
    name: "Outdoor Cemetery",
    description: "Daylight outdoor sweep. EMF + magnetometer are the workhorses; ITC tools are off because outdoor noise floors make spirit-box phonemes unintelligible. Tighter battery threshold — you're mobile and can't charge between graves.",
    overlays: {
      sensors: true,
      itc: false,
      kiiMeter: true,
      remPod: false,            // Stationary instrument — doesn't track outdoors.
      nightVision: false,       // Daylight scene; NV would just black-clip.
      directionArrow: true,     // Useful for "which way did the spike come from".
      caption: true,
      cornerBrackets: false,
    },
    tools: { spiritBox: false, ovilus: false },
    cameraDefaults: { torch: false, facing: "environment" },
    // Outdoor → mobile → mid-day low charge can sneak up. Warn at 30% like
    // Walkthrough so the operator has time to wrap before the device cuts.
    preflightOverrides: { lowBatteryFraction: 0.30 },
  },

  {
    id: "interview",
    name: "Interview",
    description: "Witness interview capture. Front camera, captions on, mic prioritised. Auto-starts the EVP recorder so the testimony lands in OPFS as a forensic clip alongside the audit-chain entry.",
    overlays: {
      sensors: false,
      itc: false,
      kiiMeter: false,
      remPod: false,
      nightVision: false,
      directionArrow: false,
      caption: true,            // Captions are mandatory in interview mode.
      cornerBrackets: true,
    },
    tools: { spiritBox: false, ovilus: false },
    cameraDefaults: { torch: false, facing: "user" }, // Selfie cam — face the witness.
    evp: { showRecorder: true, autoRecord: true },
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
    // Calibration is pre-session benchwork — typically plugged in for the
    // walkaround. Skip the battery check so a low charge doesn't fire warn
    // toasts while the operator's literally next to the wall outlet.
    preflightOverrides: { skipBattery: true },
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
    // Pro / Lab is review-grade analysis — operator is at a desk, plugged in.
    // Same as Calibration: skip battery checks.
    preflightOverrides: { skipBattery: true },
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

/** Custom event name fired alongside the localStorage write so same-tab
 *  listeners (e.g. Setup's preflight panel) can react to scene swaps. The
 *  browser's native `storage` event fires only in OTHER tabs by spec —
 *  this event covers the same-tab gap. */
export const ACTIVE_SCENE_CHANGE_EVENT = "ss-active-scene-changed";

export function saveActiveSceneId(id: SceneId): void {
  try { localStorage.setItem(ACTIVE_SCENE_KEY, id); } catch { /* ignore */ }
  // Same-tab notification: localStorage.setItem doesn't dispatch a `storage`
  // event in the tab that wrote, so any in-tab listener (e.g. an open Setup
  // panel) needs this event to stay in sync without a page reload.
  try {
    window.dispatchEvent(new CustomEvent(ACTIVE_SCENE_CHANGE_EVENT, { detail: id }));
  } catch { /* swallow — SSR or stripped CustomEvent constructor */ }
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
