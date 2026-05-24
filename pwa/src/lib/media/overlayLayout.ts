/**
 * Persisted HUD layout controls for the camera/broadcast surface.
 *
 * The same profile feeds two layers:
 *   - DOM chrome on CameraScreen (operator view).
 *   - Canvas compositor overlays (recorded/live audience view).
 *
 * Portrait and landscape are intentionally separate. A phone rig may need the
 * K-II/EVP displays down the side in landscape, but tucked into different
 * corners when held upright.
 */

export const OVERLAY_LAYOUT_STORAGE_KEY = "ss-overlay-layout-v1";

export type OverlayLayoutOrientation = "portrait" | "landscape";

export const OVERLAY_LAYOUT_ORIENTATIONS: readonly OverlayLayoutOrientation[] = [
  "portrait",
  "landscape",
];

export type OverlayAnchor =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-left"
  | "middle-center"
  | "middle-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export const OVERLAY_ANCHORS: readonly OverlayAnchor[] = [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

export type OverlayLayoutTarget =
  | "status"
  | "mic"
  | "scene"
  | "timecode"
  | "lowerThird"
  | "activity"
  | "evp"
  | "sensors"
  | "emfStack"
  | "audioStack"
  | "direction"
  | "caption"
  | "timestamp";

export const OVERLAY_LAYOUT_TARGETS: readonly OverlayLayoutTarget[] = [
  "status",
  "mic",
  "scene",
  "timecode",
  "lowerThird",
  "activity",
  "evp",
  "sensors",
  "emfStack",
  "audioStack",
  "direction",
  "caption",
  "timestamp",
];

export const OVERLAY_LAYOUT_TARGET_LABELS: Record<OverlayLayoutTarget, string> = {
  status: "Status bug",
  mic: "Mic strip",
  scene: "Scene chip",
  timecode: "Clock slate",
  lowerThird: "Session slate",
  activity: "Activity pills",
  evp: "EVP readout",
  sensors: "Sensor panel",
  emfStack: "EMF gear",
  audioStack: "Audio tools",
  direction: "Direction arrow",
  caption: "Caption strip",
  timestamp: "Forensic time",
};

export interface OverlayPlacement {
  anchor: OverlayAnchor;
  offsetX: number;
  offsetY: number;
  opacity?: number;
  hidden?: boolean;
}

export interface OverlayLayoutProfile {
  opacity: number;
  placements: Record<OverlayLayoutTarget, OverlayPlacement>;
}

export interface OverlayLayoutSettings {
  version: 1;
  portrait: OverlayLayoutProfile;
  landscape: OverlayLayoutProfile;
}

const DEFAULT_PLACEMENT: OverlayPlacement = {
  anchor: "top-left",
  offsetX: 0,
  offsetY: 0,
};

const DEFAULT_LANDSCAPE_PLACEMENTS: Record<OverlayLayoutTarget, OverlayPlacement> = {
  status: { anchor: "top-left", offsetX: 14, offsetY: 14 },
  mic: { anchor: "top-left", offsetX: 14, offsetY: 58 },
  scene: { anchor: "top-right", offsetX: 14, offsetY: 14 },
  timecode: { anchor: "bottom-left", offsetX: 16, offsetY: 24 },
  lowerThird: { anchor: "bottom-center", offsetX: 0, offsetY: 180 },
  activity: { anchor: "top-center", offsetX: 0, offsetY: 14 },
  evp: { anchor: "top-right", offsetX: 14, offsetY: 14 },
  sensors: { anchor: "top-right", offsetX: 14, offsetY: 84 },
  emfStack: { anchor: "middle-right", offsetX: 14, offsetY: -36 },
  audioStack: { anchor: "middle-left", offsetX: 14, offsetY: -36 },
  direction: { anchor: "middle-center", offsetX: 0, offsetY: -16 },
  caption: { anchor: "bottom-center", offsetX: 0, offsetY: 76 },
  timestamp: { anchor: "bottom-center", offsetX: 0, offsetY: 12 },
};

const DEFAULT_PORTRAIT_PLACEMENTS: Record<OverlayLayoutTarget, OverlayPlacement> = {
  status: { anchor: "top-left", offsetX: 12, offsetY: 12 },
  mic: { anchor: "middle-left", offsetX: 12, offsetY: -30 },
  scene: { anchor: "top-right", offsetX: 12, offsetY: 12 },
  timecode: { anchor: "bottom-left", offsetX: 12, offsetY: 132 },
  lowerThird: { anchor: "bottom-center", offsetX: 0, offsetY: 166 },
  activity: { anchor: "top-center", offsetX: 0, offsetY: 58 },
  evp: { anchor: "top-right", offsetX: 12, offsetY: 70 },
  sensors: { anchor: "bottom-right", offsetX: 12, offsetY: 132 },
  emfStack: { anchor: "middle-right", offsetX: 12, offsetY: -16 },
  audioStack: { anchor: "middle-left", offsetX: 12, offsetY: -16 },
  direction: { anchor: "middle-center", offsetX: 0, offsetY: -56 },
  caption: { anchor: "bottom-center", offsetX: 0, offsetY: 94 },
  timestamp: { anchor: "bottom-center", offsetX: 0, offsetY: 12 },
};

export const DEFAULT_OVERLAY_LAYOUT_SETTINGS: OverlayLayoutSettings = {
  version: 1,
  portrait: {
    opacity: 0.86,
    placements: DEFAULT_PORTRAIT_PLACEMENTS,
  },
  landscape: {
    opacity: 0.86,
    placements: DEFAULT_LANDSCAPE_PLACEMENTS,
  },
};

export function clampOverlayOpacity(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0.86;
  return Math.min(1, Math.max(0.25, n));
}

export function clampOverlayOffset(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(480, Math.max(-480, n)));
}

function isOverlayAnchor(value: unknown): value is OverlayAnchor {
  return typeof value === "string" && (OVERLAY_ANCHORS as readonly string[]).includes(value);
}

function normalizePlacement(value: unknown, fallback: OverlayPlacement): OverlayPlacement {
  if (!value || typeof value !== "object") return { ...fallback };
  const input = value as Partial<OverlayPlacement>;
  const placement: OverlayPlacement = {
    anchor: isOverlayAnchor(input.anchor) ? input.anchor : fallback.anchor,
    offsetX: clampOverlayOffset(input.offsetX ?? fallback.offsetX),
    offsetY: clampOverlayOffset(input.offsetY ?? fallback.offsetY),
    hidden: input.hidden === true,
  };
  const opacity = input.opacity ?? fallback.opacity;
  if (opacity !== undefined) placement.opacity = clampOverlayOpacity(opacity);
  return placement;
}

function normalizeProfile(value: unknown, fallback: OverlayLayoutProfile): OverlayLayoutProfile {
  const input = value && typeof value === "object" ? value as Partial<OverlayLayoutProfile> : {};
  const placementsInput = input.placements && typeof input.placements === "object"
    ? input.placements as Partial<Record<OverlayLayoutTarget, OverlayPlacement>>
    : {};

  const placements = {} as Record<OverlayLayoutTarget, OverlayPlacement>;
  for (const target of OVERLAY_LAYOUT_TARGETS) {
    placements[target] = normalizePlacement(
      placementsInput[target],
      fallback.placements[target] ?? DEFAULT_PLACEMENT,
    );
  }

  return {
    opacity: clampOverlayOpacity(input.opacity ?? fallback.opacity),
    placements,
  };
}

export function normalizeOverlayLayoutSettings(value: unknown): OverlayLayoutSettings {
  const input = value && typeof value === "object" ? value as Partial<OverlayLayoutSettings> : {};
  return {
    version: 1,
    portrait: normalizeProfile(input.portrait, DEFAULT_OVERLAY_LAYOUT_SETTINGS.portrait),
    landscape: normalizeProfile(input.landscape, DEFAULT_OVERLAY_LAYOUT_SETTINGS.landscape),
  };
}

export function loadOverlayLayoutSettings(): OverlayLayoutSettings {
  try {
    const raw = localStorage.getItem(OVERLAY_LAYOUT_STORAGE_KEY);
    if (!raw) return DEFAULT_OVERLAY_LAYOUT_SETTINGS;
    return normalizeOverlayLayoutSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_OVERLAY_LAYOUT_SETTINGS;
  }
}

export function saveOverlayLayoutSettings(settings: OverlayLayoutSettings): void {
  try {
    const normalized = normalizeOverlayLayoutSettings(settings);
    localStorage.setItem(OVERLAY_LAYOUT_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Private mode / quota failures should never break camera capture.
  }
}

export function getViewportOverlayOrientation(): OverlayLayoutOrientation {
  if (typeof window === "undefined") return "landscape";
  return window.innerHeight > window.innerWidth ? "portrait" : "landscape";
}

export function getOverlayProfile(
  settings: OverlayLayoutSettings,
  orientation: OverlayLayoutOrientation,
): OverlayLayoutProfile {
  return settings[orientation];
}

export function updateOverlayOpacity(
  settings: OverlayLayoutSettings,
  orientation: OverlayLayoutOrientation,
  opacity: number,
): OverlayLayoutSettings {
  return {
    ...settings,
    [orientation]: {
      ...settings[orientation],
      opacity: clampOverlayOpacity(opacity),
    },
  };
}

export function getOverlayTargetOpacity(
  profile: OverlayLayoutProfile,
  target: OverlayLayoutTarget,
): number {
  return clampOverlayOpacity(profile.placements[target]?.opacity ?? profile.opacity);
}

export function updateOverlayPlacement(
  settings: OverlayLayoutSettings,
  orientation: OverlayLayoutOrientation,
  target: OverlayLayoutTarget,
  placement: Partial<OverlayPlacement>,
): OverlayLayoutSettings {
  const profile = settings[orientation];
  const current = profile.placements[target] ?? DEFAULT_PLACEMENT;
  return {
    ...settings,
    [orientation]: {
      ...profile,
      placements: {
        ...profile.placements,
        [target]: normalizePlacement({ ...current, ...placement }, current),
      },
    },
  };
}

export function moveOverlayPlacementByPointerDelta(
  placement: OverlayPlacement,
  delta: { deltaX: number; deltaY: number },
): OverlayPlacement {
  const [vertical, horizontal] = placement.anchor.split("-") as [
    "top" | "middle" | "bottom",
    "left" | "center" | "right",
  ];

  const xSign = horizontal === "right" ? -1 : 1;
  const ySign = vertical === "bottom" ? -1 : 1;

  return {
    ...placement,
    offsetX: clampOverlayOffset(placement.offsetX + delta.deltaX * xSign),
    offsetY: clampOverlayOffset(placement.offsetY + delta.deltaY * ySign),
  };
}
