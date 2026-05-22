/**
 * Overlay plugin registry — declarative metadata for every burnt-in overlay
 * channel. The canvas compositor still owns the draw functions themselves;
 * this registry owns the SHAPE of the overlay surface so Scenes can reference
 * overlays by id and the HuntSetup picker can render them without hard-coding
 * the list anywhere.
 *
 * Adding a new overlay channel is a 3-step contract:
 *   1. Add the boolean field to `OverlayChannels` (canvasCompositor.ts).
 *   2. Add the draw call to `renderFrame` (canvasCompositor.ts).
 *   3. Add the OverlayPlugin entry here.
 *
 * Step 3 is what makes the overlay discoverable to Scenes + HuntSetup + Setup
 * → Customise. Without it, the overlay still works at the compositor level
 * but nobody can find it in the UI.
 *
 * Forensic-mandatory overlays (`timestamp`, `caseId`) are pinned to ALWAYS-ON
 * so the burnt-in chain-of-custody data cannot be hidden, regardless of which
 * scene the operator selected.
 */

import type { OverlayChannels } from "../media/canvasCompositor";

/**
 * Every key in OverlayChannels is a valid OverlayId — the registry tracks the
 * superset, scenes pick subsets. Keeping the types coupled means TS will flag
 * any divergence between the compositor channels and the plugin list.
 */
export type OverlayId = keyof OverlayChannels;

/**
 * Sensor dependencies — drives the HuntSetup warning "this overlay needs the
 * magnetometer, which your device doesn't expose". Empty array = no sensor
 * needed (forensic strip, status pills, etc).
 */
export type SensorDependency =
  | "magnetometer"
  | "accelerometer"
  | "audio"
  | "light"
  | "geolocation";

/**
 * Grouping for the HuntSetup picker so the operator can scan by intent:
 *   - instrument : virtual hardware widgets (K-II, REM Pod, audio meter)
 *   - data       : raw / processed sensor readouts (sensors block, ITC text)
 *   - broadcast  : status indicators a viewer needs (REC pill, timestamp)
 *   - forensic   : evidence-chain provenance (mandatory on all scenes)
 *   - effect     : visual treatments (night vision, edge glow)
 *   - bayesian   : probability / activity-band UI — skeptical-panel flagged
 *                  these as needing Pro/Lab scenes only, NOT default broadcast
 */
export type OverlayGroup = "instrument" | "data" | "broadcast" | "forensic" | "effect" | "bayesian";

export interface OverlayPlugin {
  /** Matches a key in OverlayChannels. */
  id: OverlayId;
  /** User-facing label in HuntSetup / Customise. */
  name: string;
  /** One-line explainer shown under the name in the picker. */
  description: string;
  /** Bucket for the picker. */
  group: OverlayGroup;
  /** Fallback state when no scene specifies this overlay. */
  defaultEnabled: boolean;
  /**
   * When true, the overlay cannot be turned off — used for the burnt-in
   * forensic strip so the chain-of-custody data is always present in the
   * recorded / streamed frame.
   */
  forensicMandatory?: boolean;
  /** Sensors required; empty array means no hardware dependency. */
  sensors: SensorDependency[];
  /**
   * When true, only surfaces in Pro/Lab scenes — kept off the default broadcast
   * frame because it can be misread by general audiences ("ghost-o-meter").
   */
  proOnly?: boolean;
}

// ── Plugin definitions ──────────────────────────────────────────────────────

const ACTIVITY_PILL: OverlayPlugin = {
  id: "activityPill",
  name: "Activity band",
  description: "Top-left pill — CALM / LIGHT / POSSIBLE / NOTABLE / STRONG label.",
  group: "bayesian",
  defaultEnabled: false, // Skeptical-panel rule — only on Pro/Lab scenes.
  sensors: [],
  proOnly: true,
};

const POSTERIOR_PILL: OverlayPlugin = {
  id: "posteriorPill",
  name: "Posterior probability",
  description: "Top-right pill — Bayesian site posterior as a percentage.",
  group: "bayesian",
  defaultEnabled: false, // Off on default broadcast; pro/lab only.
  sensors: [],
  proOnly: true,
};

const EDGE_GLOW: OverlayPlugin = {
  id: "edgeGlow",
  name: "Edge glow",
  description: "Radial tint at the frame edges, posterior-driven.",
  group: "bayesian",
  defaultEnabled: false,
  sensors: [],
  proOnly: true,
};

const SENSORS: OverlayPlugin = {
  id: "sensors",
  name: "Sensor readouts",
  description: "Left column — LIGHT · MAG · MOTION · TEMP textual values.",
  group: "data",
  defaultEnabled: true,
  sensors: ["magnetometer", "accelerometer", "light"],
};

const ITC: OverlayPlugin = {
  id: "itc",
  name: "ITC channels",
  description: "Spirit Box / Ovilus / EVP word readouts in the left column.",
  group: "data",
  defaultEnabled: true,
  sensors: ["audio"],
};

const DIRECTION_ARROW: OverlayPlugin = {
  id: "directionArrow",
  name: "Direction arrow",
  description: "Acoustic sector indicator — points at recent transients.",
  group: "instrument",
  defaultEnabled: true,
  sensors: ["audio"],
};

const CAPTION: OverlayPlugin = {
  id: "caption",
  name: "AI narration caption",
  description: "Bottom strip — plain-English commentary from the live narrator.",
  group: "broadcast",
  defaultEnabled: false, // Off for the broadcast frame; opt-in.
  sensors: [],
};

const TIMESTAMP: OverlayPlugin = {
  id: "timestamp",
  name: "Timestamp + case",
  description: "Bottom-right — ISO time, date, case ID. Forensic chain.",
  group: "forensic",
  defaultEnabled: true,
  forensicMandatory: true,
  sensors: [],
};

const CORNER_BRACKETS: OverlayPlugin = {
  id: "cornerBrackets",
  name: "Viewfinder brackets",
  description: "Corner L-shaped framing marks — broadcast aesthetic cue.",
  group: "broadcast",
  defaultEnabled: true,
  sensors: [],
};

const STATUS_PILLS: OverlayPlugin = {
  id: "statusPills",
  name: "REC / LIVE / OFFLINE pills",
  description: "Centre-top — recording, live broadcast, and offline state with elapsed timer.",
  group: "broadcast",
  defaultEnabled: true,
  forensicMandatory: true, // Recording state must be visible in the frame.
  sensors: [],
};

const KII_METER: OverlayPlugin = {
  id: "kiiMeter",
  name: "K-II EMF meter",
  description: "5-LED bar (G·G·Y·O·R) driven by raw magnetometer z-score.",
  group: "instrument",
  defaultEnabled: false,
  sensors: ["magnetometer"],
};

const REM_POD: OverlayPlugin = {
  id: "remPod",
  name: "REM Pod",
  description: "Animated EM-proximity widget — antenna + perimeter LEDs + pulse rings.",
  group: "instrument",
  defaultEnabled: false,
  sensors: ["magnetometer"],
};

const NIGHT_VISION: OverlayPlugin = {
  id: "nightVision",
  name: "Night vision",
  description: "Green-channel IR filter applied to the camera feed.",
  group: "effect",
  defaultEnabled: false,
  sensors: [],
};

const AUDIO_METER: OverlayPlugin = {
  id: "audioMeter",
  name: "Audio level meter",
  description: "Horizontal VU bar — green→yellow→red. Confirms mic is live.",
  group: "instrument",
  defaultEnabled: true, // Bradshaw/BBC: audio meter is non-negotiable for any session.
  sensors: ["audio"],
};

// ── Phase B plugins ────────────────────────────────────────────────────────

/**
 * False-color "full spectrum" video filter. Honest framing locked in here:
 *   - Phone cameras have a hardware IR-cut filter we can't remove in software.
 *   - This is a hue + saturation + contrast filter applied to the video frame,
 *     mimicking the look of an IR-modified DSLR.
 *   - Description copy uses "false-color" / "faux-IR" — NEVER "infrared
 *     sensor" / "Full Spectrum sensor". The on-frame badge label also says
 *     "FAUX-IR PROCESSING" so the recorded frame doesn't lie about what's
 *     happening.
 */
const FULL_SPECTRUM_CAM: OverlayPlugin = {
  id: "fullSpectrumCam",
  name: "Full-spectrum (faux-IR)",
  description: "False-color filter mimicking an IR-modified DSLR. NOT a real IR sensor — phone cameras have a hardware IR-cut filter we can't remove in software.",
  group: "effect",
  defaultEnabled: false,
  sensors: [],
};

/**
 * Analog EMF galvanometer — 1960s field-meter aesthetic. Reads the SAME
 * magnetometer z-score the K-II uses; this is gear-archetype diversity, not
 * a separate data stream. Both meters can run simultaneously without
 * conflict. Honest copy — silkscreen reads "EMF FIELD METER" / "MAG FLUX".
 */
const EMF_GALVANOMETER: OverlayPlugin = {
  id: "emfGalvanometer",
  name: "EMF galvanometer",
  description: "Analog needle meter (white face + brushed-aluminum bezel) driven by the same magnetometer z-score as the K-II.",
  group: "instrument",
  defaultEnabled: false,
  sensors: ["magnetometer"],
};

/**
 * PIR-style motion detector mockup. Driven by the device accelerometer
 * magnitude delta — NOT a real passive-infrared sensor. The silkscreen
 * label "PIR MOTION SENSE / ACCEL TRIGGER" + this description text both
 * say so explicitly so the operator can't be misled about what's firing.
 */
const MOTION_DETECTOR: OverlayPlugin = {
  id: "motionDetector",
  name: "PIR motion detector",
  description: "Fresnel-lens dome + trigger LED, fired by accelerometer-magnitude deltas. NOT a real PIR sensor — phones don't have one; we use the IMU.",
  group: "instrument",
  defaultEnabled: false,
  sensors: ["accelerometer"],
};

/**
 * The canonical registry. Order here is the order Scenes / HuntSetup show
 * overlays in their pickers — group similar entries together for scannability.
 */
export const OVERLAY_REGISTRY: readonly OverlayPlugin[] = [
  // Forensic strip — always first, always on.
  TIMESTAMP,
  STATUS_PILLS,
  // Broadcast aesthetic.
  CORNER_BRACKETS,
  CAPTION,
  // Data readouts.
  SENSORS,
  ITC,
  DIRECTION_ARROW,
  // Virtual instruments.
  AUDIO_METER,
  KII_METER,
  REM_POD,
  EMF_GALVANOMETER,
  MOTION_DETECTOR,
  // Visual effects.
  NIGHT_VISION,
  FULL_SPECTRUM_CAM,
  // Pro / Lab — Bayesian probability surfaces.
  ACTIVITY_PILL,
  POSTERIOR_PILL,
  EDGE_GLOW,
];

const REGISTRY_BY_ID = new Map<OverlayId, OverlayPlugin>(
  OVERLAY_REGISTRY.map((p) => [p.id, p]),
);

export function getOverlayPlugin(id: OverlayId): OverlayPlugin | undefined {
  return REGISTRY_BY_ID.get(id);
}

/**
 * Build an `OverlayChannels` object from a sparse Scene overlay map.
 * Resolution order, highest to lowest priority:
 *   1. `forensicMandatory` — always on, the audit chain can't be turned off.
 *   2. `proOnly && !proMode` — Bayesian "ghost-o-meter" overlays stay off
 *      for non-Pro users even if the scene asked for them. The skeptical
 *      panel was firm on this: posterior pills mislead amateur audiences.
 *   3. The scene's explicit choice (if any).
 *   4. The plugin's `defaultEnabled`.
 */
export function resolveOverlaysFromScene(
  sceneOverlays: Partial<Record<OverlayId, boolean>>,
  options: { proMode?: boolean } = {},
): OverlayChannels {
  const proMode = options.proMode === true;
  const out = {} as OverlayChannels;
  for (const plugin of OVERLAY_REGISTRY) {
    const sceneChoice = sceneOverlays[plugin.id];
    let enabled: boolean;
    if (plugin.forensicMandatory) {
      enabled = true;
    } else if (plugin.proOnly && !proMode) {
      enabled = false;
    } else if (sceneChoice !== undefined) {
      enabled = sceneChoice;
    } else {
      enabled = plugin.defaultEnabled;
    }
    (out as Record<OverlayId, boolean>)[plugin.id] = enabled;
  }
  return out;
}

/**
 * Group overlays for the HuntSetup / Customise picker. Pure helper — no
 * React; the view layer decides how to render the groups.
 */
export function groupedRegistry(): Record<OverlayGroup, OverlayPlugin[]> {
  const groups: Record<OverlayGroup, OverlayPlugin[]> = {
    forensic: [],
    broadcast: [],
    data: [],
    instrument: [],
    effect: [],
    bayesian: [],
  };
  for (const p of OVERLAY_REGISTRY) groups[p.group].push(p);
  return groups;
}
