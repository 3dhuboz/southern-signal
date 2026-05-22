/**
 * Canvas compositor — the engine behind both the on-device video
 * recorder and the live broadcast.
 *
 *   videoElement (camera)  ─┐
 *                           ├─► <canvas>  ──► canvas.captureStream(fps)
 *   sensor overlays  ──────┘                       │
 *                                                   ├─► MediaRecorder (saves)
 *                                                   └─► WHIP/RTC (live)
 *
 * The overlays are drawn frame-by-frame at the same resolution as the
 * source video, so they survive lossy codecs and YouTube/Twitch's
 * re-encoding. Timestamp + case ID are baked in for TV-production
 * record-keeping (defensible against editing-room drift).
 *
 * BURN-IN LAYOUT (Apple Watch complication style — corner-mounted, small,
 * translucent). Combined burn-in elements stay under ~20% of frame pixels:
 *
 *   ┌─[REC/LIVE]──────[Activity·Posterior]──────[ITC]─┐
 *   │ A                                              K  │
 *   │ U                                              -  │
 *   │ D                                              I  │
 *   │ I                                              I  │
 *   │ O                                              R  │
 *   │                                                E  │
 *   │                                                M  │
 *   │            [caption — bottom-center]              │
 *   ├─[CASE ID]────────────────────────[TIMESTAMP]─────┤
 *   └───────────────────────────────────────────────────┘
 *
 * Use:
 *   const compositor = createCanvasCompositor({ video, getOverlay, fps: 30 });
 *   compositor.start();
 *   const stream = compositor.captureStream();   // composited stream
 *   ...
 *   compositor.stop();
 */

import { OVERLAY_REGISTRY, type OverlayId } from "../overlays/registry";
import {
  getBroadcastClockSnapshot,
  type BroadcastClockSnapshot,
} from "../../hooks/useBroadcastClock";

/**
 * Per-channel visibility toggles. Operator picks which channels show on
 * the overlay from the "Overlay channels" panel on LiveStreamView — that
 * panel persists to localStorage so preferences stick session-to-session.
 * Missing on overlay state = all channels visible (back-compat with any
 * caller that doesn't supply channels).
 */
export interface OverlayChannels {
  activityPill: boolean;
  posteriorPill: boolean;
  edgeGlow: boolean;
  sensors: boolean;
  itc: boolean;
  directionArrow: boolean;
  caption: boolean;
  timestamp: boolean;
  statusPills: boolean;
  /** Corner viewfinder bracket marks. Defaults to on when unset. */
  cornerBrackets?: boolean;
  /**
   * Virtual K-II EMF meter — 5-LED bar driven by activity band.
   * Off by default; operator enables when they want the device widget visible.
   */
  kiiMeter?: boolean;
  /**
   * Virtual REM pod — animated EM proximity widget with pulsing rings.
   * Off by default; operator enables per session.
   */
  remPod?: boolean;
  /**
   * Night-vision filter — applies green-channel boost + contrast to the
   * camera feed so dark environments look like classic NV footage.
   * Off by default.
   */
  nightVision?: boolean;
  /**
   * Horizontal audio level meter — gradient bar (green→yellow→red) driven
   * by the audio RMS, drawn below the REC/LIVE status pills. Essential for
   * confirming mic levels during a broadcast. Off by default.
   */
  audioMeter?: boolean;
  /**
   * Phase B — false-color "full-spectrum" filter applied to the camera frame.
   * Phone cameras have an IR-cut filter that we CANNOT remove in software,
   * so this is a video-filter effect (hue rotation + saturation + contrast)
   * mimicking the look of a modified DSLR. NEVER "infrared sensor" — the
   * on-frame label is "FAUX-IR PROCESSING". Off by default; opt-in per session.
   */
  fullSpectrumCam?: boolean;
  /**
   * Phase B — analog EMF galvanometer (1960s field-meter aesthetic). Reads
   * the SAME magnetometer z-score the K-II does; different gear paradigm,
   * same signal. Both meters can run simultaneously. Off by default.
   */
  emfGalvanometer?: boolean;
  /**
   * Phase B — PIR-style motion-detector mockup. Driven by the accelerometer
   * magnitude delta (NOT a real PIR sensor); silkscreen says so explicitly.
   * Off by default.
   */
  motionDetector?: boolean;
}

/**
 * Default overlay channel set. Derived from the registry at module load so
 * the source of truth for "is this overlay on by default" stays in one
 * place (`OVERLAY_REGISTRY`). Used as the fallback when a caller renders a
 * frame without an explicit `channels` map, and as the target of the
 * Customise → Reset button in LiveStreamView. Forensic-mandatory channels
 * are forced on inside `resolveChannels` regardless of what's stored here.
 */
export const DEFAULT_OVERLAY_CHANNELS: OverlayChannels = (() => {
  const out: Partial<Record<OverlayId, boolean>> = {};
  for (const plugin of OVERLAY_REGISTRY) out[plugin.id] = plugin.defaultEnabled;
  return out as OverlayChannels;
})();

/**
 * An ITC (Instrumental Trans-Communication) channel emission — a phoneme
 * from Spirit Box, a word from Ovilus, or a transcript line from EVP.
 * `ageMs` is computed at frame draw time so the readout fades smoothly.
 */
export interface ItcChannelView {
  text: string;
  ageMs: number;
}

export interface OverlayState {
  caseId?: string;
  caseTitle?: string;
  /** ISO 8601 stamp — still required for back-compat with downstream tooling
   *  (recorder metadata, audit log). When `nowMs` is also supplied the
   *  compositor uses that for the burn-in to avoid a Date round-trip per frame. */
  isoTimestamp: string;
  /** Optional numeric Unix-ms. Preferred over `isoTimestamp` for the burn-in
   *  clock because we can format directly without parsing/reserialising. */
  nowMs?: number;
  posterior: number;
  activityLabel: string;
  activityBand: "calm" | "light" | "possible" | "notable" | "strong";
  sector: string | null;
  coherence: number;
  caption?: string | null;
  audioRms: number;
  recording: boolean;
  liveStreaming: boolean;
  /**
   * Unix-ms timestamp captured when the recorder started. Lets the status
   * pills render an elapsed-time readout per frame (Date.now() - this)
   * without needing React state churn for the seconds tick. Undefined when
   * not recording.
   */
  recordingStartedAt?: number;
  /**
   * Unix-ms timestamp captured when the WHIP session went live. Same role
   * as recordingStartedAt for the LIVE pill.
   */
  liveStartedAt?: number;
  /**
   * Whether the device currently has internet connectivity. When false and
   * `recording` is true, the status pills render an "OFFLINE" badge so the
   * recorded frame proves the footage was captured local-only — important
   * for forensic chain integrity ("this clip pre-dates any cloud upload").
   * Undefined = treat as online (back-compat with callers that don't supply it).
   */
  online?: boolean;
  /**
   * Raw magnetometer z-score from the EMF sensor — used by the K-II virtual
   * meter as a fast-path input so the LEDs respond directly to EMF spikes
   * without waiting for the Bayesian smoother to catch up.
   * When absent the K-II falls back to `activityBand`.
   */
  emfZScore?: number;
  sensors?: {
    light?: number;
    magnetometer?: number;
    motion?: number;
    temperature?: number;
  };
  itc?: {
    spiritBox?: ItcChannelView;
    ovilus?: ItcChannelView;
    evp?: ItcChannelView;
  };
  /** Per-channel visibility. Undefined → all channels render (back-compat). */
  channels?: OverlayChannels;
}

/**
 * Forensic-mandatory channel ids — computed once at module load from the
 * overlay registry. Any plugin flagged `forensicMandatory: true` (currently
 * `timestamp` + `statusPills`) is forced on by `resolveChannels` regardless
 * of what the scene config or localStorage says. The Set is the source of
 * truth — adding a `forensicMandatory: true` plugin to the registry auto-
 * propagates here without further compositor edits.
 */
const MANDATORY_OVERLAY_IDS = new Set<OverlayId>(
  OVERLAY_REGISTRY.filter((p) => p.forensicMandatory).map((p) => p.id),
);

/** Internal helper — fall back to all-on if the caller didn't supply channels. */
function resolveChannels(overlay: OverlayState): OverlayChannels {
  const base = overlay.channels ?? DEFAULT_OVERLAY_CHANNELS;
  // Defense-in-depth: forensic-mandatory channels (timestamp, statusPills)
  // are forced on regardless of scene config. A malformed scene or a bad
  // localStorage write cannot hide the chain-of-custody strip.
  let result = base;
  for (const id of MANDATORY_OVERLAY_IDS) {
    if (!result[id]) {
      // Lazy-clone only when we actually have to flip a bit, so the hot
      // path stays zero-alloc when channels are already correctly configured.
      result = result === base ? { ...base } : result;
      (result as Record<OverlayId, boolean>)[id] = true;
    }
  }
  return result;
}

/** ITC channel max age — after this many ms the overlay drops the readout. */
const ITC_MAX_AGE_MS = 30_000;
/** EVP transcripts get a longer window because they're rarer and meatier. */
const ITC_EVP_MAX_AGE_MS = 120_000;

export interface CanvasCompositorOptions {
  video: HTMLVideoElement;
  getOverlay: () => OverlayState;
  fps?: number;
  /** Output dimensions; default to source video. */
  width?: number;
  height?: number;
}

export interface CanvasCompositor {
  canvas: HTMLCanvasElement;
  start(): void;
  stop(): void;
  captureStream(): MediaStream;
}

const SECTOR_DEG: Record<string, number> = {
  "FRONT-L": 300,
  "FRONT-C": 0,
  "FRONT-R": 60,
  "REAR-R": 120,
  "REAR-C": 180,
  "REAR-L": 240,
};

interface BandColor {
  stroke: string;
  glow: string;
  /** R,G,B components only — used to compose rgba() strings without parsing the
   *  baked `glow` string per-frame (regex-replace in the hot path was the old
   *  approach). */
  glowRgb: string;
  fill: string;
  /** Stable id used as a cache key for derived gradient objects. */
  id: OverlayState["activityBand"];
}

const BAND_COLOR: Record<OverlayState["activityBand"], BandColor> = {
  calm:     { id: "calm",     stroke: "rgba(93, 242, 199, 0.55)",  glow: "rgba(93, 242, 199, 0.35)",  glowRgb: "93, 242, 199",  fill: "#5DF2C7" },
  light:    { id: "light",    stroke: "rgba(127, 252, 215, 0.70)", glow: "rgba(127, 252, 215, 0.45)", glowRgb: "127, 252, 215", fill: "#7FFCD7" },
  possible: { id: "possible", stroke: "rgba(242, 185, 93, 0.85)",  glow: "rgba(242, 185, 93, 0.50)",  glowRgb: "242, 185, 93",  fill: "#F2B95D" },
  notable:  { id: "notable",  stroke: "rgba(255, 122, 122, 0.95)", glow: "rgba(255, 122, 122, 0.60)", glowRgb: "255, 122, 122", fill: "#FF7A7A" },
  strong:   { id: "strong",   stroke: "rgba(255, 90, 90, 1.0)",    glow: "rgba(255, 90, 90, 0.75)",   glowRgb: "255, 90, 90",   fill: "#FF4A4A" },
};

/**
 * Scale factor mapping a logical pixel size (designed against a 1080p frame)
 * to the actual frame size. Lets us specify "14px font" in human-readable
 * spec values and have it size sensibly on 4K canvases without exploding the
 * burn-in to dashboard proportions. `min(W, H) / 720` keeps the burn-in
 * legible on a vertical phone-capture (720×1280) too — there `W/720 ≈ 1` so
 * sizes stay at the spec values.
 */
function scaleFactor(W: number, H: number): number {
  return Math.max(0.7, Math.min(1.8, Math.min(W, H) / 720));
}

/**
 * Mutable state passed to renderFrame — geometry + per-context gradient caches.
 * Lives on the compositor closure so allocations survive only as long as the
 * compositor instance. Each gradient is keyed by the inputs that affect its
 * geometry/colour; invalidation happens via cache.key string compare.
 *
 * The skeuomorphic gear meters (K-II + REM Pod) also pin smoothing state and
 * theme-token snapshots here so each compositor instance keeps its own LED
 * smoother (no cross-talk between recorder + broadcast compositors that may
 * co-exist on the same page) and a single resolved theme palette (cheap re-
 * read on theme flip rather than 30 reads/sec).
 */
interface FrameContext {
  W: number;
  H: number;
  s: number;
  edgeGlow: { key: string; grad: CanvasGradient } | null;
  /**
   * Resolved meter palette (CSS custom properties → hex / rgba strings).
   * `themeKey` is `data-theme` + `data-scotopic-level` concatenated; re-resolves
   *  when the operator flips themes mid-session. `null` = not yet resolved.
   */
  meterTokens: { themeKey: string; tokens: MeterTokens } | null;
  /**
   * K-II LED smoother — tracks the displayed LED count as a float so we can
   * lerp towards the target (integer 1–5) over ~200 ms. Without this the LEDs
   * pop frame-to-frame on every EMF z-score wobble, which looks fake.
   * `lastMs` = last update wall-clock so the lerp is frame-rate independent.
   */
  kiiSmooth: { led: number; lastMs: number } | null;
  /**
   * REM Pod pulse — emitted on z-score ≥ 2.5σ. `startedAtMs` lets the next 600 ms
   * of frames draw the expanding/fading ring without restarting unless a new
   * trigger fires while a pulse is still in-flight.
   */
  remPulse: { startedAtMs: number; lastZ: number } | null;
  /**
   * VU needle smoother — tracks the displayed needle position as a 0..1 float
   * with a real-VU "300 ms ballistic" RC-style lag (the integration time the
   * actual ANSI/IEC standard specifies). Without this the needle pops between
   * every audio frame, which looks digital not analog. `lastMs` keeps the lerp
   * frame-rate independent.
   */
  vuNeedleSmooth: { value: number; lastMs: number } | null;
  /**
   * Phase B — analog EMF galvanometer needle smoother. Same RC-ballistic
   * pattern as `vuNeedleSmooth` (200 ms time-constant gives a gentle sweep
   * over a magnetometer spike without the digital pop you'd get from a
   * direct value plot). Independent state per compositor instance so the
   * needle doesn't cross-talk between concurrent recorder + WHIP streams.
   */
  galvoNeedleSmooth: { value: number; lastMs: number } | null;
  /**
   * Phase B — motion-detector accelerometer-magnitude tracker. Stores the
   * last accel magnitude seen and the wall-clock time at which the last
   * trigger fired (above-threshold delta). `lastMotionAtMs` drives the
   * trigger LED pulse over a 1 s decay window so the LED stays lit briefly
   * after motion stops — the same way a real PIR sensor latches its output.
   */
  motionDetector: { lastMag: number; lastMs: number; lastTriggerMs: number } | null;
}

/**
 * Resolved theme tokens for the skeuomorphic gear meters. Read once per theme
 * flip from `document.documentElement` (via `getComputedStyle`) and cached on
 * the FrameContext. Fallbacks here match the default-theme values from
 * `tokens.css` so the meters still render in jsdom / SSR / detached-canvas
 * contexts where `getComputedStyle` returns empty strings for custom props.
 */
interface MeterTokens {
  kiiBody: string;
  kiiBodyEdge: string;
  kiiSilkscreen: string;
  kiiBezel: string;
  kiiLedOff: string;
  kiiLedGreen: string;
  kiiLedYellow: string;
  kiiLedOrange: string;
  kiiLedRed: string;
  kiiLedGlow: string;
  remBody: string;
  remBodyEdge: string;
  remSilkscreen: string;
  remAntenna: string;
  remLedR: string;
  remLedG: string;
  remLedB: string;
  remLedY: string;
  remLedOff: string;
  remPulse: string;
  // Phase A.2 — vintage VU audio meter.
  vuBody: string;
  vuBodyEdge: string;
  vuScaleBg: string;
  vuScaleEdge: string;
  vuScaleInk: string;
  vuNeedle: string;
  vuOverload: string;
  vuSilkscreen: string;
  vuGlow: string;
  // Phase A.2 — Spirit Box amber 7-segment LCD.
  spiritLcdBezel: string;
  spiritLcdBg: string;
  spiritLcdOff: string;
  spiritLcdAmber: string;
  spiritLcdGlow: string;
  spiritLcdSilkscreen: string;
  // Phase A.2 — Ovilus green dot-matrix LCD.
  ovilusLcdBezel: string;
  ovilusLcdBg: string;
  ovilusLcdOff: string;
  ovilusLcdGreen: string;
  ovilusLcdGlow: string;
  ovilusLcdSilkscreen: string;
  // Phase A.3 — sensors lab panel (rack-mount anodized steel with corner screws).
  labPanelBody: string;
  labPanelBodyEdge: string;
  labPanelFaceplate: string;
  labPanelScrew: string;
  labPanelScrewSlot: string;
  labPanelSilkscreen: string;
  labPanelRail: string;
  labLcdLabelBg: string;
  labLcdLabelOff: string;
  labLcdLabelOn: string;
  labLcdLabelGlow: string;
  labLcdValueBg: string;
  labLcdValueOff: string;
  labLcdValueOn: string;
  labLcdValueGlow: string;
  // Phase A.3 — EVP paper teletype frame.
  evpPaperBg: string;
  evpPaperEdge: string;
  evpPaperInk: string;
  evpPaperStamp: string;
  evpPaperShadow: string;
  // Phase B — Faux-IR full-spectrum badge (filter math itself doesn't depend
  // on theme tokens; this palette only colours the on-frame label pill).
  fullspecBadgeBg: string;
  fullspecBadgeRim: string;
  fullspecBadgeText: string;
  // Phase B — Analog EMF galvanometer (brushed-aluminum bezel + cream face).
  galvoBody: string;
  galvoBodyEdge: string;
  galvoFace: string;
  galvoFaceEdge: string;
  galvoTick: string;
  galvoNeedle: string;
  galvoRedzone: string;
  galvoSilkscreen: string;
  galvoPivot: string;
  // Phase B — PIR motion detector (Fresnel dome + trigger LED).
  motionDomeBody: string;
  motionDomeEdge: string;
  motionDomeLens: string;
  motionDomeLine: string;
  motionBody: string;
  motionBodyEdge: string;
  motionSilkscreen: string;
  motionLedIdle: string;
  motionLedTrigger: string;
  motionLedGlow: string;
}

/** Hardcoded fallback palette — matches the default `:root` block in tokens.css. */
const METER_TOKEN_FALLBACK: MeterTokens = {
  kiiBody:       "#d4b829",
  kiiBodyEdge:   "#a08a17",
  kiiSilkscreen: "#1a1a1a",
  kiiBezel:      "#0a0a0a",
  kiiLedOff:     "#2a2a2a",
  kiiLedGreen:   "#2eee5e",
  kiiLedYellow:  "#f5d028",
  kiiLedOrange:  "#f78a1c",
  kiiLedRed:     "#ef2e2e",
  kiiLedGlow:    "rgba(255, 255, 255, 0.55)",
  remBody:       "#1a1a1a",
  remBodyEdge:   "#2e2e2e",
  remSilkscreen: "#d8d8d8",
  remAntenna:    "#d4d4d4",
  remLedR:       "#ef2e2e",
  remLedG:       "#2eee5e",
  remLedB:       "#2eb6ef",
  remLedY:       "#f5d028",
  remLedOff:     "#1a1a1a",
  remPulse:      "rgba(46, 182, 239, 0.6)",
  vuBody:        "#2a2a2a",
  vuBodyEdge:    "#444444",
  vuScaleBg:     "#e8d9a8",
  vuScaleEdge:   "#b89e60",
  vuScaleInk:    "#1a1a0a",
  vuNeedle:      "#1a1a1a",
  vuOverload:    "#c41e1e",
  vuSilkscreen:  "#f0e6c8",
  vuGlow:        "rgba(255, 200, 80, 0.35)",
  spiritLcdBezel:       "#050505",
  spiritLcdBg:          "#1a0d00",
  spiritLcdOff:         "#2a1700",
  spiritLcdAmber:       "#ffb020",
  spiritLcdGlow:        "rgba(255, 176, 32, 0.55)",
  spiritLcdSilkscreen:  "#b8b8b8",
  ovilusLcdBezel:       "#1a1a1a",
  ovilusLcdBg:          "#0a1a08",
  ovilusLcdOff:         "#143018",
  ovilusLcdGreen:       "#5cff85",
  ovilusLcdGlow:        "rgba(92, 255, 133, 0.40)",
  ovilusLcdSilkscreen:  "#c8c8c8",
  labPanelBody:        "#1f2326",
  labPanelBodyEdge:    "#0e1012",
  labPanelFaceplate:   "#2a2e32",
  labPanelScrew:       "#6a6f74",
  labPanelScrewSlot:   "#1a1c1e",
  labPanelSilkscreen:  "#c8c8c8",
  labPanelRail:        "#0a0b0c",
  labLcdLabelBg:       "#050a06",
  labLcdLabelOff:      "#0d1f10",
  labLcdLabelOn:       "#4ed876",
  labLcdLabelGlow:     "rgba(78, 216, 118, 0.32)",
  labLcdValueBg:       "#100800",
  labLcdValueOff:      "#1f1300",
  labLcdValueOn:       "#e8a020",
  labLcdValueGlow:     "rgba(232, 160, 32, 0.40)",
  evpPaperBg:          "#d8c89c",
  evpPaperEdge:        "#b09a64",
  evpPaperInk:         "#3a2a16",
  evpPaperStamp:       "#9a3018",
  evpPaperShadow:      "rgba(0, 0, 0, 0.32)",
  // Phase B fallbacks — kept in sync with the :root defaults in tokens.css.
  fullspecBadgeBg:     "rgba(70, 18, 84, 0.78)",
  fullspecBadgeRim:    "#c47ad8",
  fullspecBadgeText:   "#f0e0ff",
  galvoBody:           "#b8bcc0",
  galvoBodyEdge:       "#6a6e72",
  galvoFace:           "#f4f1e8",
  galvoFaceEdge:       "#c8c0a4",
  galvoTick:           "#1a1a1a",
  galvoNeedle:         "#2a2a2a",
  galvoRedzone:        "#c41e1e",
  galvoSilkscreen:     "#2a2a2a",
  galvoPivot:          "#4a4a4a",
  motionDomeBody:      "#e8e4d8",
  motionDomeEdge:      "#b8b4a8",
  motionDomeLens:      "#cac6b8",
  motionDomeLine:      "rgba(46, 46, 50, 0.45)",
  motionBody:          "#2a2a2c",
  motionBodyEdge:      "#0e0e10",
  motionSilkscreen:    "#d8d8d8",
  motionLedIdle:       "#3a0e0e",
  motionLedTrigger:    "#ff3a3a",
  motionLedGlow:       "rgba(255, 58, 58, 0.55)",
};

/**
 * Snapshot the meter palette from `:root` custom properties. Falls back per-
 * token to the default values from tokens.css when `getComputedStyle` returns
 * an empty string — which happens in three real cases:
 *   1. jsdom/happy-dom tests where custom-prop computation isn't wired,
 *   2. SSR where `document` exists but no stylesheet has been applied yet,
 *   3. a future stylesheet split where the theme block hasn't been loaded.
 * In all three the burn-in still renders correct default colours.
 */
function readMeterTokens(): MeterTokens {
  if (typeof document === "undefined" || !document.documentElement) {
    return METER_TOKEN_FALLBACK;
  }
  const cs = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string): string => {
    const v = cs.getPropertyValue(name).trim();
    return v.length > 0 ? v : fallback;
  };
  return {
    kiiBody:       pick("--kii-body",       METER_TOKEN_FALLBACK.kiiBody),
    kiiBodyEdge:   pick("--kii-body-edge",  METER_TOKEN_FALLBACK.kiiBodyEdge),
    kiiSilkscreen: pick("--kii-silkscreen", METER_TOKEN_FALLBACK.kiiSilkscreen),
    kiiBezel:      pick("--kii-bezel",      METER_TOKEN_FALLBACK.kiiBezel),
    kiiLedOff:     pick("--kii-led-off",    METER_TOKEN_FALLBACK.kiiLedOff),
    kiiLedGreen:   pick("--kii-led-green",  METER_TOKEN_FALLBACK.kiiLedGreen),
    kiiLedYellow:  pick("--kii-led-yellow", METER_TOKEN_FALLBACK.kiiLedYellow),
    kiiLedOrange:  pick("--kii-led-orange", METER_TOKEN_FALLBACK.kiiLedOrange),
    kiiLedRed:     pick("--kii-led-red",    METER_TOKEN_FALLBACK.kiiLedRed),
    kiiLedGlow:    pick("--kii-led-glow",   METER_TOKEN_FALLBACK.kiiLedGlow),
    remBody:       pick("--rem-body",       METER_TOKEN_FALLBACK.remBody),
    remBodyEdge:   pick("--rem-body-edge",  METER_TOKEN_FALLBACK.remBodyEdge),
    remSilkscreen: pick("--rem-silkscreen", METER_TOKEN_FALLBACK.remSilkscreen),
    remAntenna:    pick("--rem-antenna",    METER_TOKEN_FALLBACK.remAntenna),
    remLedR:       pick("--rem-led-r",      METER_TOKEN_FALLBACK.remLedR),
    remLedG:       pick("--rem-led-g",      METER_TOKEN_FALLBACK.remLedG),
    remLedB:       pick("--rem-led-b",      METER_TOKEN_FALLBACK.remLedB),
    remLedY:       pick("--rem-led-y",      METER_TOKEN_FALLBACK.remLedY),
    remLedOff:     pick("--rem-led-off",    METER_TOKEN_FALLBACK.remLedOff),
    remPulse:      pick("--rem-pulse",      METER_TOKEN_FALLBACK.remPulse),
    vuBody:        pick("--vu-body",        METER_TOKEN_FALLBACK.vuBody),
    vuBodyEdge:    pick("--vu-body-edge",   METER_TOKEN_FALLBACK.vuBodyEdge),
    vuScaleBg:     pick("--vu-scale-bg",    METER_TOKEN_FALLBACK.vuScaleBg),
    vuScaleEdge:   pick("--vu-scale-edge", METER_TOKEN_FALLBACK.vuScaleEdge),
    vuScaleInk:    pick("--vu-scale-ink",  METER_TOKEN_FALLBACK.vuScaleInk),
    vuNeedle:      pick("--vu-needle",      METER_TOKEN_FALLBACK.vuNeedle),
    vuOverload:    pick("--vu-overload",    METER_TOKEN_FALLBACK.vuOverload),
    vuSilkscreen:  pick("--vu-silkscreen",  METER_TOKEN_FALLBACK.vuSilkscreen),
    vuGlow:        pick("--vu-glow",        METER_TOKEN_FALLBACK.vuGlow),
    spiritLcdBezel:      pick("--spirit-lcd-bezel",      METER_TOKEN_FALLBACK.spiritLcdBezel),
    spiritLcdBg:         pick("--spirit-lcd-bg",         METER_TOKEN_FALLBACK.spiritLcdBg),
    spiritLcdOff:        pick("--spirit-lcd-off",        METER_TOKEN_FALLBACK.spiritLcdOff),
    spiritLcdAmber:      pick("--spirit-lcd-amber",      METER_TOKEN_FALLBACK.spiritLcdAmber),
    spiritLcdGlow:       pick("--spirit-lcd-glow",       METER_TOKEN_FALLBACK.spiritLcdGlow),
    spiritLcdSilkscreen: pick("--spirit-lcd-silkscreen", METER_TOKEN_FALLBACK.spiritLcdSilkscreen),
    ovilusLcdBezel:      pick("--ovilus-lcd-bezel",      METER_TOKEN_FALLBACK.ovilusLcdBezel),
    ovilusLcdBg:         pick("--ovilus-lcd-bg",         METER_TOKEN_FALLBACK.ovilusLcdBg),
    ovilusLcdOff:        pick("--ovilus-lcd-off",        METER_TOKEN_FALLBACK.ovilusLcdOff),
    ovilusLcdGreen:      pick("--ovilus-lcd-green",      METER_TOKEN_FALLBACK.ovilusLcdGreen),
    ovilusLcdGlow:       pick("--ovilus-lcd-glow",       METER_TOKEN_FALLBACK.ovilusLcdGlow),
    ovilusLcdSilkscreen: pick("--ovilus-lcd-silkscreen", METER_TOKEN_FALLBACK.ovilusLcdSilkscreen),
    labPanelBody:        pick("--lab-panel-body",        METER_TOKEN_FALLBACK.labPanelBody),
    labPanelBodyEdge:    pick("--lab-panel-body-edge",   METER_TOKEN_FALLBACK.labPanelBodyEdge),
    labPanelFaceplate:   pick("--lab-panel-faceplate",   METER_TOKEN_FALLBACK.labPanelFaceplate),
    labPanelScrew:       pick("--lab-panel-screw",       METER_TOKEN_FALLBACK.labPanelScrew),
    labPanelScrewSlot:   pick("--lab-panel-screw-slot",  METER_TOKEN_FALLBACK.labPanelScrewSlot),
    labPanelSilkscreen:  pick("--lab-panel-silkscreen",  METER_TOKEN_FALLBACK.labPanelSilkscreen),
    labPanelRail:        pick("--lab-panel-rail",        METER_TOKEN_FALLBACK.labPanelRail),
    labLcdLabelBg:       pick("--lab-lcd-label-bg",      METER_TOKEN_FALLBACK.labLcdLabelBg),
    labLcdLabelOff:      pick("--lab-lcd-label-off",     METER_TOKEN_FALLBACK.labLcdLabelOff),
    labLcdLabelOn:       pick("--lab-lcd-label-on",      METER_TOKEN_FALLBACK.labLcdLabelOn),
    labLcdLabelGlow:     pick("--lab-lcd-label-glow",    METER_TOKEN_FALLBACK.labLcdLabelGlow),
    labLcdValueBg:       pick("--lab-lcd-value-bg",      METER_TOKEN_FALLBACK.labLcdValueBg),
    labLcdValueOff:      pick("--lab-lcd-value-off",     METER_TOKEN_FALLBACK.labLcdValueOff),
    labLcdValueOn:       pick("--lab-lcd-value-on",      METER_TOKEN_FALLBACK.labLcdValueOn),
    labLcdValueGlow:     pick("--lab-lcd-value-glow",    METER_TOKEN_FALLBACK.labLcdValueGlow),
    evpPaperBg:          pick("--evp-paper-bg",          METER_TOKEN_FALLBACK.evpPaperBg),
    evpPaperEdge:        pick("--evp-paper-edge",        METER_TOKEN_FALLBACK.evpPaperEdge),
    evpPaperInk:         pick("--evp-paper-ink",         METER_TOKEN_FALLBACK.evpPaperInk),
    evpPaperStamp:       pick("--evp-paper-stamp",       METER_TOKEN_FALLBACK.evpPaperStamp),
    evpPaperShadow:      pick("--evp-paper-shadow",      METER_TOKEN_FALLBACK.evpPaperShadow),
    // Phase B — Faux-IR full-spectrum + EMF galvanometer + PIR motion detector.
    fullspecBadgeBg:     pick("--fullspec-badge-bg",     METER_TOKEN_FALLBACK.fullspecBadgeBg),
    fullspecBadgeRim:    pick("--fullspec-badge-rim",    METER_TOKEN_FALLBACK.fullspecBadgeRim),
    fullspecBadgeText:   pick("--fullspec-badge-text",   METER_TOKEN_FALLBACK.fullspecBadgeText),
    galvoBody:           pick("--galvo-body",            METER_TOKEN_FALLBACK.galvoBody),
    galvoBodyEdge:       pick("--galvo-body-edge",       METER_TOKEN_FALLBACK.galvoBodyEdge),
    galvoFace:           pick("--galvo-face",            METER_TOKEN_FALLBACK.galvoFace),
    galvoFaceEdge:       pick("--galvo-face-edge",       METER_TOKEN_FALLBACK.galvoFaceEdge),
    galvoTick:           pick("--galvo-tick",            METER_TOKEN_FALLBACK.galvoTick),
    galvoNeedle:         pick("--galvo-needle",          METER_TOKEN_FALLBACK.galvoNeedle),
    galvoRedzone:        pick("--galvo-redzone",         METER_TOKEN_FALLBACK.galvoRedzone),
    galvoSilkscreen:     pick("--galvo-silkscreen",      METER_TOKEN_FALLBACK.galvoSilkscreen),
    galvoPivot:          pick("--galvo-pivot",           METER_TOKEN_FALLBACK.galvoPivot),
    motionDomeBody:      pick("--motion-dome-body",      METER_TOKEN_FALLBACK.motionDomeBody),
    motionDomeEdge:      pick("--motion-dome-edge",      METER_TOKEN_FALLBACK.motionDomeEdge),
    motionDomeLens:      pick("--motion-dome-lens",      METER_TOKEN_FALLBACK.motionDomeLens),
    motionDomeLine:      pick("--motion-dome-line",      METER_TOKEN_FALLBACK.motionDomeLine),
    motionBody:          pick("--motion-body",           METER_TOKEN_FALLBACK.motionBody),
    motionBodyEdge:      pick("--motion-body-edge",      METER_TOKEN_FALLBACK.motionBodyEdge),
    motionSilkscreen:    pick("--motion-silkscreen",     METER_TOKEN_FALLBACK.motionSilkscreen),
    motionLedIdle:       pick("--motion-led-idle",       METER_TOKEN_FALLBACK.motionLedIdle),
    motionLedTrigger:    pick("--motion-led-trigger",    METER_TOKEN_FALLBACK.motionLedTrigger),
    motionLedGlow:       pick("--motion-led-glow",       METER_TOKEN_FALLBACK.motionLedGlow),
  };
}

/**
 * Cache-aware meter-token getter. The `data-theme` + `data-scotopic-level`
 * tuple is the cache key, so flipping scotopic on/off rebuilds the palette
 * exactly once on the next frame.
 */
function getMeterTokens(frame: FrameContext): MeterTokens {
  if (typeof document === "undefined" || !document.documentElement) {
    return frame.meterTokens?.tokens ?? METER_TOKEN_FALLBACK;
  }
  const root = document.documentElement;
  const themeKey = `${root.getAttribute("data-theme") ?? ""}|${root.getAttribute("data-scotopic-level") ?? ""}`;
  if (!frame.meterTokens || frame.meterTokens.themeKey !== themeKey) {
    frame.meterTokens = { themeKey, tokens: readMeterTokens() };
  }
  return frame.meterTokens.tokens;
}

export function createCanvasCompositor(opts: CanvasCompositorOptions): CanvasCompositor {
  const { video, getOverlay, fps = 30 } = opts;
  const canvas = document.createElement("canvas");

  let raf = 0;
  let running = false;
  let lastFrameTs = 0;
  const frameInterval = 1000 / fps;

  // Frame-geometry + gradient caches. Recomputed only when source dimensions
  // change — sizeCanvas reads video.videoWidth every tick (cheap), but the
  // derived scale factor + gradient objects are stable per resolution.
  const frame: FrameContext = {
    W: 0, H: 0, s: 1,
    edgeGlow: null,
    meterTokens: null, kiiSmooth: null, remPulse: null,
    vuNeedleSmooth: null,
    galvoNeedleSmooth: null,
    motionDetector: null,
  };

  // Context handle is also stable — getContext returns a cached instance, but
  // we hoist the call so the hot path doesn't even round-trip through it.
  const ctx = canvas.getContext("2d");

  const sizeCanvas = () => {
    const w = opts.width ?? (video.videoWidth || 1280);
    const h = opts.height ?? (video.videoHeight || 720);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    if (w !== frame.W || h !== frame.H) {
      frame.W = w;
      frame.H = h;
      frame.s = scaleFactor(w, h);
      // Geometry shifted — gradient objects baked against the old coords are
      // now wrong. Drop them so the next frame rebuilds. LED smoothing state
      // is geometry-independent (just a float count) so we keep it across
      // size changes; the pulse animation likewise keeps running.
      frame.edgeGlow = null;
    }
  };

  const draw = (now: number) => {
    if (!running) return;
    if (now - lastFrameTs >= frameInterval) {
      lastFrameTs = now;
      sizeCanvas();
      // Guard: drawImage on readyState < HAVE_CURRENT_DATA throws
      // InvalidStateError on Safari/iOS, which would escape this closure
      // and kill the RAF loop permanently. Skip the frame instead.
      if (ctx && video.readyState >= 2) renderFrame(ctx, video, getOverlay(), frame);
    }
    raf = requestAnimationFrame(draw);
  };

  return {
    canvas,
    start() {
      if (running) return;
      running = true;
      sizeCanvas();
      raf = requestAnimationFrame(draw);
    },
    stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
    captureStream() {
      // captureStream is in the lib.dom typings as canvas.captureStream(frameRate?)
      const captureFn = (canvas as HTMLCanvasElement & { captureStream(fr?: number): MediaStream }).captureStream;
      return captureFn.call(canvas, fps);
    },
  };
}

function renderFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  overlay: OverlayState,
  frame: FrameContext,
): void {
  const { W, H, s } = frame;
  const channels = resolveChannels(overlay);

  // 1. Camera frame (cover-fit). ALWAYS drawn — disabling this would just
  // give the operator a black square and is never what they want.
  //
  // Phase B: when fullSpectrumCam is on we route the drawImage through a
  // canvas filter chain (hue-rotate + saturate + contrast) so the camera
  // frame picks up the false-colour "IR-modified DSLR" look. ctx.filter is
  // applied AT drawImage time, then reset — that way the meter draws
  // downstream aren't affected. Browsers that don't support ctx.filter (very
  // old WebViews) will just see a plain frame, no crash.
  if (channels.fullSpectrumCam) {
    ctx.save();
    ctx.filter = "hue-rotate(-25deg) saturate(1.35) contrast(1.15)";
    ctx.drawImage(video, 0, 0, W, H);
    ctx.restore();
    // Magenta/violet wash on top — completes the look and stays in burn-in.
    applyFullSpectrumTint(ctx, W, H);
  } else {
    ctx.drawImage(video, 0, 0, W, H);
  }

  // 1b. Night-vision filter — applied immediately after the camera frame and
  //     before any overlay is drawn, so the NV colour-grade sits under all
  //     text/widgets. getImageData + putImageData are the expensive path but
  //     run within budget at 30fps on modern mobile GPUs.
  if (channels.nightVision) {
    applyNightVision(ctx, W, H);
  }

  // 1c. "FAUX-IR PROCESSING" badge — small label burned into the corner so
  //     the recording itself proves the false-colour effect is a video filter,
  //     not a real IR sensor. Sits below the night-vision pass so its text
  //     stays at correct hue regardless of whether NV is also enabled.
  if (channels.fullSpectrumCam) {
    drawFullSpectrumBadge(ctx, W, H, s, frame);
  }

  const band = BAND_COLOR[overlay.activityBand] ?? BAND_COLOR.calm;

  // 2. Edge glow tied to posterior + audio RMS. Bucketed by 0.05 alpha steps
  //    so the gradient object is reused across frames where the bucket
  //    doesn't change; full recreation would otherwise burn 30 gradients/sec.
  if (channels.edgeGlow) {
    const edgeAlpha = Math.min(0.5, 0.09 + overlay.posterior * 0.25 + overlay.audioRms * 0.30);
    const bucket = Math.round(edgeAlpha * 20) / 20; // 0.05 increments
    const key = `${band.id}|${bucket}`;
    let entry = frame.edgeGlow;
    if (!entry || entry.key !== key) {
      const grad = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.7);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(1, `rgba(${band.glowRgb}, ${bucket})`);
      entry = { key, grad };
      frame.edgeGlow = entry;
    }
    ctx.fillStyle = entry.grad;
    ctx.fillRect(0, 0, W, H);
  }

  // 2b. Corner viewfinder brackets — broadcast framing cue drawn over
  // the edge glow so they always read against the background image.
  if (channels.cornerBrackets !== false) {
    drawCornerBrackets(ctx, W, H, band);
  }

  // 3. Status pills (REC / LIVE / OFFLINE) — top-left corner.
  if (channels.statusPills) {
    drawStatusPills(ctx, W, H, overlay, s);
  }

  // 3b. Posterior + Activity band pills — top-center, small. Pro/Lab only;
  //     the proOnly gating happens upstream in resolveOverlaysFromScene.
  drawTopCenterPills(ctx, W, H, overlay, band, channels, s);

  // 3c. EVP transcript readout — top-right corner, sepia paper teletype frame.
  //     Spirit Box + Ovilus moved to dedicated LCDs in A.2, so this widget
  //     is EVP-only now. Toggling the `itc` channel still gates it.
  if (channels.itc) {
    drawEvpReadout(ctx, W, H, overlay, band, s, frame);
  }

  // 3d. Sensors lab panel — rack-mount anodized steel faceplate with four
  //     mini-LCD rows, tucked under the EVP block in the top-right column so
  //     the data column stays unified on one edge.
  if (channels.sensors) {
    drawSensorsLabPanel(ctx, W, H, overlay, band, s, frame);
  }

  // 4. Right-edge vertical instrument stack — skeuomorphic gear meters.
  //    K-II EMF (yellow handheld) on top, REM Pod (black tower) below, EMF
  //    galvanometer (analog needle, 1960s field-meter aesthetic) at the
  //    bottom. All three share the same magnetometer signal; the stack
  //    co-locates them so operators get the "wall of EMF kit" reading at a
  //    glance. Top anchor is shared; each meter owns its own height.
  const meterTopY = Math.round(H * 0.30);
  if (channels.kiiMeter) {
    drawKiiMeter(ctx, W, overlay.activityBand, overlay.emfZScore, s, meterTopY, frame);
  }
  if (channels.remPod) {
    drawRemPod(ctx, W, overlay.activityBand, overlay.emfZScore, s, meterTopY, frame);
  }
  if (channels.emfGalvanometer) {
    drawEmfGalvanometer(ctx, W, overlay.emfZScore, s, meterTopY, frame);
  }

  // 5. VU audio meter — left edge, vintage analog look.
  if (channels.audioMeter) {
    drawVuMeter(ctx, W, H, overlay.audioRms, s, frame);
  }

  // 5b. Spirit Box amber LCD — left edge, stacked below the VU meter.
  //     Drawn only when the ITC channel is on and there's a recent emission.
  //     The dedicated Spirit Box LCD (this function) and the EVP readout
  //     (drawEvpReadout, top-right) do not share data sources — Spirit Box
  //     phonemes never appear in the EVP transcript box.
  if (channels.itc) {
    drawSpiritBoxLcd(ctx, H, overlay.itc?.spiritBox, s, frame);
  }

  // 5c. Ovilus green dot-matrix LCD — left edge, stacked below the Spirit Box.
  //     Shows the word-of-the-moment + a magnetometer-seeded entropy bar so
  //     the operator can see the dictionary RNG state visually.
  if (channels.itc) {
    drawOvilusLcd(ctx, H, overlay.itc?.ovilus, overlay.sensors?.magnetometer, s, frame);
  }

  // 6. Direction arrow (only if sector + coherence are valid).
  if (channels.directionArrow && overlay.sector && overlay.coherence >= 0.5) {
    drawDirectionArrow(ctx, W, H, overlay.sector, overlay.coherence, band);
  }

  // 7. Bottom caption strip (AI co-investigator) — above timestamp row.
  if (channels.caption && overlay.caption) {
    drawCaption(ctx, W, H, overlay.caption, s);
  }

  // 8 + 9. Case ID (bottom-left) + Timestamp (bottom-right). Both consume the
  //        same `BroadcastClockSnapshot` so they can't disagree across editing-
  //        room scrutiny — and the same snapshot is what the on-screen
  //        BroadcastTimestamp slate uses, so the operator's chrome and the
  //        burned-in frame always read the same wall-clock moment.
  if (channels.timestamp) {
    // Anchor the snapshot to the overlay's `nowMs` (preferred — set per frame
    // by the caller) or the parsed ISO fallback. Wrapping in a stable `now`
    // function instead of letting the snapshot pull `Date.now()` directly means
    // a single frame's case-ID date never disagrees with its timestamp pill,
    // even if the JS event loop drifts a few ms between the two draw calls.
    const frameNowMs = pickFrameNowMs(overlay);
    const clock = getBroadcastClockSnapshot({
      running: false,        // burn-in doesn't track elapsed — that's the
      startedAtMs: null,     // status pill's job
      now: () => frameNowMs,
    });
    // Case ID drawn first so the bottom-right timestamp can still occlude on
    // overlap if anyone ever cranks the case-id font up — chain-of-custody
    // (the timestamp) is forensic-mandatory and must always read last.
    drawCaseId(ctx, W, H, overlay, clock, s);
    drawTimestamp(ctx, W, H, overlay, clock, s);
  }
}

/**
 * Pick the numeric Unix-ms timestamp for this frame. Prefer the explicit
 * `nowMs` the caller set (skips the ISO round-trip per frame) and fall back to
 * parsing `isoTimestamp` for legacy callers that only supply the string form.
 * Final fallback is 0 (epoch) when neither is present or parseable — drawing
 * "1970-01-01" in the burn-in is a louder signal of a misconfigured overlay
 * than silently skipping the row.
 */
function pickFrameNowMs(overlay: OverlayState): number {
  if (overlay.nowMs !== undefined && Number.isFinite(overlay.nowMs)) {
    return overlay.nowMs;
  }
  const parsed = Date.parse(overlay.isoTimestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

// ─── Top-center pills (Activity + Posterior) ────────────────────────────────

/**
 * Activity band + Posterior pill, mounted top-center. Both are proOnly so they
 * only render in Pro / Lab scenes — the registry guarantees they're off in the
 * default broadcast frame. Trimmed to ~110×28 px so they don't dominate the
 * top edge.
 */
function drawTopCenterPills(
  ctx: CanvasRenderingContext2D,
  W: number,
  _H: number,
  overlay: OverlayState,
  band: { fill: string; stroke: string },
  channels: OverlayChannels,
  s: number,
) {
  // Size constants — kept tight so the pills behave like complications, not banners.
  const pillH = Math.round(28 * s);
  const fontSize = Math.round(13 * s);
  const padX = Math.round(10 * s);
  const gap = Math.round(8 * s);
  const topMargin = Math.round(12 * s);

  ctx.save();
  ctx.font = `700 ${fontSize}px "Space Grotesk", Inter, sans-serif`;
  ctx.textBaseline = "middle";

  type Pill = { text: string; bg: string; stroke: string; fg: string };
  const pills: Pill[] = [];

  if (channels.activityPill) {
    pills.push({
      text: overlay.activityLabel.toUpperCase(),
      bg: "rgba(0,0,0,0.55)",
      stroke: band.stroke,
      fg: "#fff",
    });
  }
  if (channels.posteriorPill) {
    pills.push({
      text: `P=${overlay.posterior.toFixed(2)}`,
      bg: "rgba(0,0,0,0.55)",
      stroke: band.stroke,
      fg: band.fill,
    });
  }

  if (pills.length === 0) {
    ctx.restore();
    return;
  }

  const widths = pills.map((p) => Math.max(Math.round(70 * s), ctx.measureText(p.text).width + padX * 2));
  const totalW = widths.reduce((a, w) => a + w, 0) + gap * Math.max(0, pills.length - 1);
  let x = Math.round((W - totalW) / 2);
  const y = topMargin;

  for (let i = 0; i < pills.length; i++) {
    const p = pills[i];
    const w = widths[i];
    drawPill(ctx, x, y, w, pillH, p.bg, p.stroke);
    ctx.fillStyle = p.fg;
    ctx.textAlign = "center";
    ctx.fillText(p.text, x + w / 2, y + pillH / 2);
    x += w + gap;
  }
  ctx.restore();
}

// ─── Sensors lab panel (rack-mount anodized steel + mini LCDs) ──────────────

/**
 * Sensors lab panel body dimensions (logical px @ s=1). Sized to fit four
 * sensor rows (LIGHT / MAG / MOTION / TEMP) below a small silkscreen
 * "FIELD SENSORS" header with a margin of breathing room for the four
 * corner mount screws — the rack-mount aesthetic is what sells the gear feel.
 */
const LAB_PANEL_BODY_W = 184;
const LAB_PANEL_BODY_H = 122;
/** Per-row height inside the LCD strip rail. Four rows × 20 px = 80 px,
 *  which sits comfortably inside the 122 px body once the silkscreen header
 *  + corner-screw margins are subtracted. */
const LAB_PANEL_ROW_H = 20;

/**
 * Skeuomorphic sensors lab panel — rack-mount anodized steel faceplate with
 * four chrome corner screws + per-sensor mini-LCD readouts. Replaces the
 * flat `drawSensorReadout` text block. Sits on the right edge, below the
 * EVP readout, so the right column stays unified.
 *
 * Anatomy (logical px @ s=1, 184 × 122):
 *   ┌─┰──────────────────────────────────────────────┰─┐
 *   │ ⊕                FIELD SENSORS                  ⊕ │  ← screws + silkscreen
 *   │  ╔═══════════════════════════════════════════╗  │
 *   │  ║ [LIGHT  ]  ┃ ┃ ┃ ┃ . ┃   lux              ║  │  row 1
 *   │  ║ [MAG    ]  ┃ ┃ ┃ . ┃    µT                ║  │  row 2
 *   │  ║ [MOTION ]  ┃ . ┃ ┃ ┃   m/s²               ║  │  row 3
 *   │  ║ [TEMP   ]  ┃ ┃ . ┃ ┃    °C                ║  │  row 4
 *   │  ╚═══════════════════════════════════════════╝  │
 *   │ ⊕                                                ⊕ │
 *   └─┸──────────────────────────────────────────────┸─┘
 *
 * Each row pairs a small green dot-matrix label LCD (reusing
 * `drawDotMatrixGlyph` from the Ovilus block) with a small amber 7-segment
 * value LCD (reusing `drawSevenSegmentGlyph` from the Spirit Box block),
 * followed by a unit silkscreen. The mini-LCDs use dimmer hues than the
 * dedicated ITC widgets so the panel doesn't outshine them.
 *
 * Honest copy — silkscreen reads "FIELD SENSORS" + literal sensor labels
 * (LIGHT / MAG / MOTION / TEMP). No anomaly claims.
 */
function drawSensorsLabPanel(
  ctx: CanvasRenderingContext2D,
  W: number,
  _H: number,
  overlay: OverlayState,
  _band: { stroke: string },
  s: number,
  frame: FrameContext,
): void {
  const sensors = overlay.sensors;
  if (!sensors) return;

  type Row = { label: string; value: string; unit: string };
  const rows: Row[] = [];
  if (typeof sensors.light === "number" && Number.isFinite(sensors.light)) {
    // LIGHT can range 0..100000+; clamp to 4 digits so it fits the LCD strip.
    const v = Math.min(9999, Math.max(0, Math.round(sensors.light)));
    rows.push({ label: "LIGHT", value: v.toString(), unit: "lux" });
  }
  if (typeof sensors.magnetometer === "number" && Number.isFinite(sensors.magnetometer)) {
    rows.push({ label: "MAG", value: sensors.magnetometer.toFixed(1), unit: "uT" });
  }
  if (typeof sensors.motion === "number" && Number.isFinite(sensors.motion)) {
    rows.push({ label: "MOTION", value: sensors.motion.toFixed(2), unit: "m/s2" });
  }
  if (typeof sensors.temperature === "number" && Number.isFinite(sensors.temperature)) {
    rows.push({ label: "TEMP", value: sensors.temperature.toFixed(1), unit: "C" });
  }
  if (rows.length === 0) return;

  const tokens = getMeterTokens(frame);

  // Geometry — anchored to the right edge, below the EVP block. Match the
  // existing layout offset so existing screens don't shift.
  const bodyW = Math.round(LAB_PANEL_BODY_W * s);
  const bodyH = Math.round(LAB_PANEL_BODY_H * s);
  const margin = Math.round(12 * s);
  const itcReserved = Math.round(evpReservedHeight(s));
  const x = W - margin - bodyW;
  const y = margin + itcReserved;
  const radius = Math.round(4 * s);

  ctx.save();

  // 1. Drop shadow under the panel body — soft, offset down so the rack-mount
  //    rectangle lifts off the camera frame.
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
  ctx.shadowBlur = 6 * s;
  ctx.shadowOffsetY = 3 * s;
  ctx.fillStyle = "rgba(0, 0, 0, 0.01)";
  roundedRectPath(ctx, x, y, bodyW, bodyH, radius);
  ctx.fill();
  ctx.restore();

  // 2. Body — anodized dark-steel vertical gradient (edge → body → edge).
  //    Reads as a moulded faceplate, not flat fill. The horizontal flat
  //    "rack" lines come from the recessed LCD rail in step 5.
  const bodyGrad = ctx.createLinearGradient(0, y, 0, y + bodyH);
  bodyGrad.addColorStop(0,    tokens.labPanelBodyEdge);
  bodyGrad.addColorStop(0.15, tokens.labPanelFaceplate);
  bodyGrad.addColorStop(0.85, tokens.labPanelBody);
  bodyGrad.addColorStop(1,    tokens.labPanelBodyEdge);
  roundedRectPath(ctx, x, y, bodyW, bodyH, radius);
  ctx.fillStyle = bodyGrad;
  ctx.fill();

  // 2b. Body outline.
  ctx.strokeStyle = tokens.labPanelBodyEdge;
  ctx.lineWidth = 1.5;
  roundedRectPath(ctx, x, y, bodyW, bodyH, radius);
  ctx.stroke();

  // 3. Four corner screws — small chrome circles with a darker phillips slot.
  //    Sized at ~5 px logical so they read as gear hardware without dominating
  //    the panel. Inset by 8 px from each corner.
  const screwInset = Math.round(7 * s);
  const screwR = Math.max(2, Math.round(3 * s));
  const screwPositions: Array<[number, number]> = [
    [x + screwInset,            y + screwInset],
    [x + bodyW - screwInset,    y + screwInset],
    [x + screwInset,            y + bodyH - screwInset],
    [x + bodyW - screwInset,    y + bodyH - screwInset],
  ];
  for (const [cx, cy] of screwPositions) {
    // Drop-in chrome head with a soft highlight at the top-left to fake the
    // metal sheen — same trick the VU meter pivot cap uses.
    ctx.beginPath();
    ctx.arc(cx, cy, screwR, 0, Math.PI * 2);
    ctx.fillStyle = tokens.labPanelScrew;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx - screwR * 0.3, cy - screwR * 0.3, screwR * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
    ctx.fill();
    // Phillips slot — single thin line through the centre. (Real phillips
    // screws have a cross; one stroke reads the same at this size.)
    ctx.strokeStyle = tokens.labPanelScrewSlot;
    ctx.lineWidth = Math.max(0.75, screwR * 0.28);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx - screwR * 0.65, cy);
    ctx.lineTo(cx + screwR * 0.65, cy);
    ctx.stroke();
  }

  // 4. "FIELD SENSORS" silkscreen header — small bold uppercase, centred
  //    between the top corner screws.
  const headerPx = Math.max(8, Math.round(9 * s));
  ctx.font = `700 ${headerPx}px "Inter", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = tokens.labPanelSilkscreen;
  ctx.fillText("FIELD SENSORS", x + bodyW / 2, y + Math.round(11 * s));

  // 5. Recessed LCD rail — dark inset rectangle that holds the four mini-LCDs.
  //    Inset so the rack-mount frame around it reads as proper faceplate
  //    real estate rather than the rail being flush with the body edge.
  const railInsetX = Math.round(14 * s);
  const railTopY   = Math.round(18 * s);
  const railBottomMargin = Math.round(12 * s);
  const railX = x + railInsetX;
  const railY = y + railTopY;
  const railW = bodyW - railInsetX * 2;
  const railH = bodyH - railTopY - railBottomMargin;
  const railR = Math.round(3 * s);
  roundedRectPath(ctx, railX, railY, railW, railH, railR);
  ctx.fillStyle = tokens.labPanelRail;
  ctx.fill();
  // Subtle inner-shadow rim so the rail reads as inset into the faceplate.
  ctx.save();
  ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
  ctx.lineWidth = 1;
  roundedRectPath(ctx, railX + 0.5, railY + 0.5, railW - 1, railH - 1, railR);
  ctx.stroke();
  ctx.restore();

  // 6. Per-sensor rows — each row gets a dot-matrix label + 7-seg value +
  //    unit silkscreen. We pack into the rail height so the rows are
  //    proportional whether 1 or 4 sensors are reporting (most sessions
  //    show all 4 but stale-sensor sessions show fewer).
  const rowH = Math.min(Math.round(LAB_PANEL_ROW_H * s), Math.floor((railH - Math.round(6 * s)) / rows.length));
  const rowGap = Math.max(1, Math.round(2 * s));
  const labelChars = 6;          // "MOTION" is the widest label (6 chars)
  const valueChars = 5;          // "9999" + 1 dot + 1 digit = 5 cells max
  const dotPad = Math.round(4 * s);
  // Dot-matrix label dimensions — same 5×7 grid the Ovilus uses but smaller.
  const labelDotSize = Math.max(1, Math.floor((rowH - dotPad * 2) / 9));
  const labelGlyphW = 5 * labelDotSize;
  const labelGlyphGap = 1 * labelDotSize;
  const labelW = labelChars * (labelGlyphW + labelGlyphGap) - labelGlyphGap;
  // 7-segment value cell dimensions — sized to match the dot-matrix height.
  const segH = labelDotSize * 7;
  const segW = Math.max(3, Math.floor(segH * 0.55));
  const segGap = Math.max(1, Math.round(1 * s));
  const segPx = Math.max(1, Math.floor(labelDotSize * 0.9));
  const valueBlockW = valueChars * (segW + segGap) - segGap;
  // Unit silkscreen — small fixed-width text right of the value.
  const unitPx = Math.max(7, Math.round(8 * s));
  const labelColX = railX + Math.round(6 * s);
  const valueColX = labelColX + labelW + Math.round(8 * s);
  const unitColX = valueColX + valueBlockW + Math.round(6 * s);

  let cursorY = railY + Math.round(4 * s);
  for (const r of rows) {
    const labelTop = cursorY + Math.round((rowH - segH) / 2);

    // 6a. Label LCD — render each char of the (padded) label as a dot-matrix
    //     glyph using the existing 5×7 font + dim green palette.
    const labelText = r.label.padEnd(labelChars, " ").slice(0, labelChars);
    ctx.save();
    ctx.shadowColor = tokens.labLcdLabelGlow;
    ctx.shadowBlur = Math.max(1, Math.round(1.5 * s));
    let lgx = labelColX;
    for (const ch of labelText) {
      drawDotMatrixGlyph(ctx, ch, lgx, labelTop, labelDotSize, tokens.labLcdLabelOn, tokens.labLcdLabelOff);
      lgx += labelGlyphW + labelGlyphGap;
    }
    ctx.restore();

    // 6b. Value LCD — split the value string into glyphs (digits + optional
    //     dot). Render right-aligned inside the valueBlockW so different
    //     value widths still line up vertically across rows.
    const cells = expandSevenSegValue(r.value, valueChars);
    // Right-align: shift starting x by the number of leading spaces' widths.
    ctx.save();
    ctx.shadowColor = tokens.labLcdValueGlow;
    ctx.shadowBlur = Math.max(1, Math.round(2 * s));
    let vgx = valueColX;
    for (const cell of cells) {
      drawSevenSegmentGlyph(
        ctx, cell.glyph,
        vgx, labelTop, segW, segH, segPx,
        tokens.labLcdValueOn, tokens.labLcdValueOff,
      );
      if (cell.dot) {
        // Decimal point — small filled square just below the right edge of
        // the cell, same trick the Spirit Box LCD uses.
        const dotR = Math.max(1, segPx * 0.85);
        ctx.beginPath();
        ctx.arc(vgx + segW + segGap * 0.5, labelTop + segH - dotR, dotR, 0, Math.PI * 2);
        ctx.fillStyle = tokens.labLcdValueOn;
        ctx.fill();
      }
      vgx += segW + segGap + (cell.dot ? Math.round(2 * s) : 0);
    }
    ctx.restore();

    // 6c. Unit silkscreen — small monospace text right of the value cells.
    ctx.font = `600 ${unitPx}px "JetBrains Mono", monospace`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = tokens.labPanelSilkscreen;
    ctx.fillText(r.unit, unitColX, labelTop + segH / 2);

    cursorY += rowH + rowGap;
  }

  ctx.restore();
}

/**
 * Expand a sensor value string ("27.3", "-2.31", "9999") into right-aligned
 * 7-segment cells, padding the left with blank cells so all rows visually
 * line up. Returns at most `maxCells` entries; each entry carries the glyph
 * for `drawSevenSegmentGlyph` plus a `dot` flag for the decimal point that
 * follows it (rendered as a small filled circle, not a 7-seg segment).
 *
 * Examples (maxCells=5):
 *   "27.3"  → [' ', '2', '7'·dot, '3', ' ']  (we trim trailing blanks)
 *   "-2.31" → ['-', '2'·dot, '3', '1', ' ']
 *   "9999"  → [' ', '9', '9', '9', '9']
 */
function expandSevenSegValue(value: string, maxCells: number): Array<{ glyph: string; dot: boolean }> {
  // Split into digit chars (+ optional dot suffix). The dash is its own cell.
  const cells: Array<{ glyph: string; dot: boolean }> = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === ".") {
      // Dot attaches to the previous cell; if there's no previous cell, drop it.
      if (cells.length > 0) cells[cells.length - 1].dot = true;
      continue;
    }
    cells.push({ glyph: ch, dot: false });
  }
  // Left-pad with blank cells so values right-align (cap to maxCells).
  while (cells.length < maxCells) cells.unshift({ glyph: " ", dot: false });
  if (cells.length > maxCells) cells.splice(0, cells.length - maxCells);
  return cells;
}

/**
 * Approximate vertical space reserved for the EVP block at the top-right so
 * the sensor stack can sit immediately below it. Returns 0 when EVP is hidden;
 * the actual EVP draw call decides whether to render and uses identical numbers.
 */
function evpReservedHeight(s: number): number {
  // Max block height = padY*2 + rowH * 2 (2 lines max) + outer margin gap.
  const padY = Math.round(7 * s);
  const rowH = Math.round(20 * s);
  return padY * 2 + rowH * 2 + Math.round(8 * s);
}

// ─── EVP readout (top-right, paper teletype frame) ──────────────────────────

/**
 * EVP transcript readout, top-right corner. Renders the most recent 1–2 EVP
 * captures from `overlay.itc.evp` inside a sepia paper-teletype frame so the
 * transcript reads as a printed evidence slip rather than a generic dark box.
 * Spirit Box + Ovilus moved to their own dedicated LCD widgets in Phase A.2,
 * so this function is now EVP-only — previously named `drawItcReadout`.
 *
 * Anatomy (logical px @ s=1, ~180 × variable):
 *   ┌─────────────────────────────────────────┐
 *   │ ┌─[ EVP CAPTURE ]──────────────┐        │  ← red rubber stamp
 *   │ │  "....transcript text...."   │ <- now │  ← sepia ink on cream paper
 *   │ │  "....more transcript...."   │ <- 12s │
 *   │ └────────────[ ON-DEVICE ]─────┘        │  ← bottom-right stamp
 *   └─────────────────────────────────────────┘
 *
 * The paper-teletype frame uses the `--evp-paper-*` token palette so the
 * scotopic theme can collapse the cream + sepia into the red band without
 * touching draw code. Stamps are gear labels ("EVP CAPTURE" / "ON-DEVICE"),
 * NOT anomaly claims — the transcript itself is the operator's curated
 * EVP entry, never an inferred ghost voice.
 *
 * Sizes (spec): label font 10px, text font 13px (slightly tighter than the
 * old all-channel readout because EVP-only ships fewer rows), padding 9×12px.
 */
function drawEvpReadout(
  ctx: CanvasRenderingContext2D,
  W: number,
  _H: number,
  overlay: OverlayState,
  _band: { stroke: string; fill: string; glow: string },
  s: number,
  frame: FrameContext,
): void {
  const itc = overlay.itc;
  if (!itc) return;

  type Row = { text: string; age: string; ageMs: number };
  const rows: Row[] = [];
  if (itc.evp && itc.evp.ageMs <= ITC_EVP_MAX_AGE_MS) {
    rows.push({
      text: truncateForOverlay(itc.evp.text),
      age: formatAge(itc.evp.ageMs),
      ageMs: itc.evp.ageMs,
    });
  }
  if (rows.length === 0) return;

  const tokens = getMeterTokens(frame);

  // Keep the freshest two so the block stays max 2 lines (currently the
  // OverlayState only carries one EVP view at a time; this future-proofs the
  // layout against a queued-EVP carousel landing later).
  rows.sort((a, b) => a.ageMs - b.ageMs);
  const visible = rows.slice(0, 2);

  // Size constants
  const textFontPx = Math.round(13 * s);
  const ageFontPx = Math.round(9 * s);
  const stampPx = Math.round(8 * s);
  const padX = Math.round(12 * s);
  const padTop = Math.round(15 * s);     // extra room for the top stamp
  const padBottom = Math.round(13 * s);  // extra room for the bottom stamp
  const rowH = Math.round(20 * s);
  const ageGap = Math.round(8 * s);
  const margin = Math.round(12 * s);
  const maxBlockW = Math.round(190 * s);

  ctx.save();

  const measureText = (str: string) => {
    ctx.font = `500 ${textFontPx}px "Georgia", "Times New Roman", serif`;
    return ctx.measureText(str).width;
  };

  // 1. Measure each row to determine the actual width (capped at maxBlockW).
  let widest = 0;
  for (const r of visible) {
    const tw = measureText(r.text);
    ctx.font = `500 ${ageFontPx}px "JetBrains Mono", monospace`;
    const aw = ctx.measureText(r.age).width;
    const w = padX * 2 + tw + ageGap + aw;
    if (w > widest) widest = w;
  }
  // Also account for the top stamp width so the slip never crops the stamp.
  ctx.font = `700 ${stampPx}px "Inter", system-ui, sans-serif`;
  const stampW = ctx.measureText("EVP CAPTURE").width + Math.round(12 * s);
  widest = Math.max(widest, padX * 2 + stampW);

  const blockW = Math.min(maxBlockW, widest);
  const blockH = padTop + visible.length * rowH + padBottom;
  const blockX = W - margin - blockW;
  const blockY = margin;
  const radius = Math.round(2 * s);

  // 2. Drop shadow under the slip so it lifts off the camera frame.
  ctx.save();
  ctx.shadowColor = tokens.evpPaperShadow;
  ctx.shadowBlur = 5 * s;
  ctx.shadowOffsetY = 2 * s;
  ctx.fillStyle = "rgba(0, 0, 0, 0.01)";
  roundedRectPath(ctx, blockX, blockY, blockW, blockH, radius);
  ctx.fill();
  ctx.restore();

  // 3. Paper body — warm cream fill with a darker rim shadow at the bottom
  //    so the slip reads as a slightly worn evidence print.
  const paperGrad = ctx.createLinearGradient(0, blockY, 0, blockY + blockH);
  paperGrad.addColorStop(0,    tokens.evpPaperBg);
  paperGrad.addColorStop(0.85, tokens.evpPaperBg);
  paperGrad.addColorStop(1,    tokens.evpPaperEdge);
  roundedRectPath(ctx, blockX, blockY, blockW, blockH, radius);
  ctx.fillStyle = paperGrad;
  ctx.fill();
  // Thin paper edge outline.
  ctx.strokeStyle = tokens.evpPaperEdge;
  ctx.lineWidth = 1;
  roundedRectPath(ctx, blockX, blockY, blockW, blockH, radius);
  ctx.stroke();

  // 4. Top-left rubber stamp — "EVP CAPTURE" in red on a thin red rectangle
  //    border. Slightly rotated to fake the imperfect angle of a real stamp.
  ctx.save();
  const stampInset = Math.round(8 * s);
  const stampTopY = blockY + Math.round(4 * s);
  const stampH = Math.round(12 * s);
  // Compute stamp box dimensions for centring the text.
  ctx.font = `700 ${stampPx}px "Inter", system-ui, sans-serif`;
  const captureW = ctx.measureText("EVP CAPTURE").width + Math.round(8 * s);
  const stampX = blockX + stampInset;
  // Rotate a hair so it reads as imperfect rubber.
  ctx.translate(stampX + captureW / 2, stampTopY + stampH / 2);
  ctx.rotate(-0.04);
  ctx.translate(-(stampX + captureW / 2), -(stampTopY + stampH / 2));
  ctx.strokeStyle = tokens.evpPaperStamp;
  ctx.lineWidth = Math.max(1, 1.2 * s);
  ctx.strokeRect(stampX, stampTopY, captureW, stampH);
  ctx.fillStyle = tokens.evpPaperStamp;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("EVP CAPTURE", stampX + captureW / 2, stampTopY + stampH / 2);
  ctx.restore();

  // 5. Transcript rows — sepia serif text, age stamp on the right.
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  let y = blockY + padTop + rowH / 2;
  for (const r of visible) {
    // Right-anchor age first so the transcript text can flex to the remaining width.
    ctx.font = `500 ${ageFontPx}px "JetBrains Mono", monospace`;
    const ageW = ctx.measureText(r.age).width;
    const ageX = blockX + blockW - padX - ageW;
    ctx.fillStyle = tokens.evpPaperInk;
    ctx.globalAlpha = 0.6;
    ctx.fillText(r.age, ageX, y);
    ctx.globalAlpha = 1;

    // Transcript — sepia serif ink, clipped to the remaining width.
    const textX = blockX + padX;
    const textMaxW = ageX - ageGap - textX;
    const clippedText = truncateToWidth(ctx, r.text, textMaxW, `500 ${textFontPx}px "Georgia", "Times New Roman", serif`);
    ctx.font = `500 ${textFontPx}px "Georgia", "Times New Roman", serif`;
    ctx.fillStyle = tokens.evpPaperInk;
    ctx.fillText(clippedText, textX, y);

    y += rowH;
  }

  // 6. Bottom-right stamp — "ON-DEVICE" in red, smaller / no border so it
  //    reads as a secondary classification mark beside the primary capture
  //    stamp at the top.
  ctx.save();
  ctx.font = `700 ${stampPx}px "Inter", system-ui, sans-serif`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillStyle = tokens.evpPaperStamp;
  ctx.fillText("ON-DEVICE", blockX + blockW - Math.round(8 * s), blockY + blockH - Math.round(7 * s));
  ctx.restore();

  ctx.restore();
}

/** Truncate `text` to fit within `maxWidth` using ellipsis when needed. */
function truncateToWidth(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  font: string,
): string {
  ctx.save();
  ctx.font = font;
  if (ctx.measureText(text).width <= maxWidth) {
    ctx.restore();
    return text;
  }
  // Trim from the end with an ellipsis until it fits.
  const ellipsis = "…";
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const candidate = text.slice(0, mid) + ellipsis;
    if (ctx.measureText(candidate).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  ctx.restore();
  return lo > 0 ? text.slice(0, lo) + ellipsis : "";
}

/** Format an age in ms as a compact "now" / "12s" / "3m" / "1h" string. */
function formatAge(ms: number): string {
  if (ms < 1000) return "now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

/** Truncate ITC text to a length that won't blow the overlay width. */
function truncateForOverlay(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= 28) return t;
  return t.slice(0, 27) + "…";
}

// ─── Soft rounded-rect background (the new minimal overlay container) ───────

/**
 * Lightweight rounded-rect with optional thin border. Used by all the new
 * complication-style overlays — no inner shimmer, no outer glow. Cheaper to
 * draw than `drawPill` and visually quieter, which is what the "small,
 * transparent, corner-mounted" brief calls for.
 *
 * @param strokeAlpha Stroke alpha multiplier applied to `stroke` (0=no border).
 */
function drawSoftBox(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  stroke: string,
  strokeAlpha: number,
) {
  const r = Math.min(8, h / 2);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();

  ctx.fillStyle = fill;
  ctx.fill();

  if (strokeAlpha > 0) {
    ctx.globalAlpha = strokeAlpha;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Glass-style pill used by select overlays (caption, direction-arrow label).
 * Keeps the polished depth gradient + shimmer + glow for the elements that
 * still need to feel premium. New corner complications use drawSoftBox instead.
 */
function drawPill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  stroke: string,
) {
  const r = h / 2;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();

  ctx.shadowColor = stroke;
  ctx.shadowBlur = 10;
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.shadowBlur = 0;

  const depth = ctx.createLinearGradient(x, y, x, y + h);
  depth.addColorStop(0, "rgba(255,255,255,0.05)");
  depth.addColorStop(0.45, "rgba(0,0,0,0)");
  depth.addColorStop(1, "rgba(0,0,0,0.10)");
  ctx.fillStyle = depth;
  ctx.fill();

  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.restore();
}

// ─── Virtual instrument widgets ─────────────────────────────────────────────

/** Maps activityBand → number of K-II LEDs lit (1–5). Fallback when no z-score. */
const KII_LIT: Record<OverlayState["activityBand"], number> = {
  calm: 1, light: 2, possible: 3, notable: 4, strong: 5,
};

/**
 * Maps raw EMF z-score to LED count via a thresholds table. Used by both the
 * K-II (1–5 LEDs) and REM Pod (0–6 LEDs) virtual instruments. The first
 * matching `[minZ, leds]` pair from highest-z down is used; the floor (the
 * last entry, used when nothing matches) becomes the resting state.
 */
function zScoreToLeds(z: number, table: ReadonlyArray<readonly [number, number]>): number {
  for (let i = 0; i < table.length - 1; i++) {
    if (z >= table[i][0]) return table[i][1];
  }
  return table[table.length - 1][1];
}

/**
 * Format an elapsed duration in milliseconds as broadcast-style `HH:MM:SS`.
 * Always hour-padded so the pill width stays constant during the first hour
 * of a recording — no layout jitter when the timer rolls past 1:00:00.
 */
function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h  = Math.floor(totalSec / 3600);
  const m  = Math.floor((totalSec % 3600) / 60);
  const s  = totalSec % 60;
  const pad2 = (n: number) => n < 10 ? `0${n}` : `${n}`;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

// K-II: 1 LED resting (calm), 5 LEDs at extreme spike (≥5σ).
const KII_Z_TABLE: ReadonlyArray<readonly [number, number]> = [
  [5.0, 5], [3.5, 4], [2.5, 3], [1.5, 2], [0, 1],
];
// REM Pod: 0 LEDs resting (truly idle), 6 LEDs at extreme spike (≥5σ).
const REM_Z_TABLE: ReadonlyArray<readonly [number, number]> = [
  [5.0, 6], [3.5, 5], [2.5, 4], [2.0, 3], [1.5, 2], [1.0, 1], [0, 0],
];

/** K-II body dimensions (logical px @ s=1). Wider than tall — it's a handheld. */
const KII_BODY_W = 96;
const KII_BODY_H = 40;
/** Skeuomorphic K-II LED palette indexed bottom→top of bar: 2× green, yellow, orange, red. */
type KiiLedSlot = "green" | "yellow" | "orange" | "red";
const KII_LED_RAMP: readonly KiiLedSlot[] = ["green", "green", "yellow", "orange", "red"];

/**
 * Skeuomorphic K-II EMF Meter — yellow handheld, drawn at the right edge.
 *
 * Anatomy (logical px, s scales everything):
 *   ┌────────────────────────────┐  ← 96 × 40
 *   │  ▮  K-II EMF METER         │  antenna nub + black silkscreen
 *   │  ╔══════════════════════╗  │  recessed black bezel
 *   │  ║  ●  ●  ●  ●  ●       ║  │  5 LEDs (g g y o r) — first N lit
 *   │  ╚══════════════════════╝  │
 *   └────────────────────────────┘
 *
 * LED count is driven by `emfZScore` (z ≥ 5σ → 5 LEDs; z < 0σ → 1 LED resting)
 * with `activityBand` as the fallback when the sensor isn't reporting. The
 * display LED count is smoothed via `frame.kiiSmooth` so a single noisy z-score
 * frame doesn't pop the LEDs on/off — the bar lerps to the target over ~200 ms.
 * All colours resolve through `getMeterTokens(frame)` so the scotopic theme
 * automatically re-skins the meter without touching this draw code.
 */
function drawKiiMeter(
  ctx: CanvasRenderingContext2D,
  W: number,
  band: OverlayState["activityBand"],
  emfZScore: number | undefined,
  s: number,
  topY: number,
  frame: FrameContext,
): void {
  const tokens = getMeterTokens(frame);

  // Target LED count from z-score (preferred) or activityBand (fallback).
  const targetLed = (typeof emfZScore === "number" && Number.isFinite(emfZScore))
    ? zScoreToLeds(Math.abs(emfZScore), KII_Z_TABLE)
    : (KII_LIT[band] ?? 1);

  // Smooth towards the target. ~200 ms time-constant gives a soft glide
  // without smearing real activity spikes longer than ~3 frames at 30fps.
  const nowMs = (typeof performance !== "undefined" && typeof performance.now === "function")
    ? performance.now()
    : Date.now();
  if (!frame.kiiSmooth) {
    // Cold start — pin the smoother at the target so the first frame looks
    // settled instead of lerping in from zero.
    frame.kiiSmooth = { led: targetLed, lastMs: nowMs };
  } else {
    const dtMs = Math.max(0, nowMs - frame.kiiSmooth.lastMs);
    const tau = 200; // ms time-constant
    const alpha = 1 - Math.exp(-dtMs / tau);
    frame.kiiSmooth.led += (targetLed - frame.kiiSmooth.led) * alpha;
    frame.kiiSmooth.lastMs = nowMs;
  }
  // Round to the nearest LED; the smoother already prevents single-frame pops.
  const litCount = Math.max(0, Math.min(5, Math.round(frame.kiiSmooth.led)));

  // Geometry — body anchored against the right edge with a 12 px margin.
  const bodyW = Math.round(KII_BODY_W * s);
  const bodyH = Math.round(KII_BODY_H * s);
  const margin = Math.round(12 * s);
  const x = W - margin - bodyW;
  const y = topY;
  const radius = Math.round(6 * s);

  ctx.save();

  // 1. Drop shadow — soft, offset down so the body looks lifted off the frame.
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
  ctx.shadowBlur = 6 * s;
  ctx.shadowOffsetY = 3 * s;
  ctx.fillStyle = "rgba(0, 0, 0, 0.01)"; // shadow caster (alpha 0 wouldn't cast)
  roundedRectPath(ctx, x, y, bodyW, bodyH, radius);
  ctx.fill();
  ctx.restore();

  // 2. Body fill — vertical gradient (edge → body → edge) to fake plastic curvature.
  const bodyGrad = ctx.createLinearGradient(0, y, 0, y + bodyH);
  bodyGrad.addColorStop(0,    tokens.kiiBodyEdge);
  bodyGrad.addColorStop(0.5,  tokens.kiiBody);
  bodyGrad.addColorStop(1,    tokens.kiiBodyEdge);
  roundedRectPath(ctx, x, y, bodyW, bodyH, radius);
  ctx.fillStyle = bodyGrad;
  ctx.fill();

  // 3. Outline — darker rim picks out the body edge.
  ctx.strokeStyle = tokens.kiiBodyEdge;
  ctx.lineWidth = 1.5;
  roundedRectPath(ctx, x, y, bodyW, bodyH, radius);
  ctx.stroke();

  // 4. Antenna nub — tiny black rectangle at the top centre.
  const antennaW = Math.round(8 * s);
  const antennaH = Math.round(6 * s);
  const antennaX = x + (bodyW - antennaW) / 2;
  const antennaY = y - antennaH + 1;
  const antennaGrad = ctx.createLinearGradient(0, antennaY, 0, antennaY + antennaH);
  antennaGrad.addColorStop(0, "#202020");
  antennaGrad.addColorStop(1, "#080808");
  ctx.fillStyle = antennaGrad;
  ctx.fillRect(antennaX, antennaY, antennaW, antennaH);

  // 5. "K-II EMF METER" silkscreen — black text, top-centred just below the
  //    antenna. Uppercase / small-caps reads as moulded into the plastic.
  const silkPx = Math.max(8, Math.round(9 * s));
  ctx.font = `700 ${silkPx}px "Inter", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = tokens.kiiSilkscreen;
  ctx.fillText("K-II EMF METER", x + bodyW / 2, y + Math.round(4 * s));

  // 6. Recessed LED bezel — dark inset rounded rectangle near the bottom.
  const bezelW = Math.round(80 * s);
  const bezelH = Math.round(16 * s);
  const bezelX = x + (bodyW - bezelW) / 2;
  const bezelY = y + bodyH - bezelH - Math.round(4 * s);
  const bezelR = Math.round(4 * s);
  roundedRectPath(ctx, bezelX, bezelY, bezelW, bezelH, bezelR);
  ctx.fillStyle = tokens.kiiBezel;
  ctx.fill();

  // 7. 5 LEDs evenly spaced horizontally inside the bezel.
  const ledCount = 5;
  const ledPadX = Math.round(6 * s);
  const ledTrackW = bezelW - ledPadX * 2;
  const ledStride = ledTrackW / ledCount;
  const ledR = Math.min(ledStride * 0.40, bezelH * 0.40);
  const ledCy = bezelY + bezelH / 2;
  for (let i = 0; i < ledCount; i++) {
    const lit = i < litCount;
    const slot = KII_LED_RAMP[i];
    const litColor =
      slot === "green"  ? tokens.kiiLedGreen :
      slot === "yellow" ? tokens.kiiLedYellow :
      slot === "orange" ? tokens.kiiLedOrange :
                          tokens.kiiLedRed;
    const cx = bezelX + ledPadX + ledStride * (i + 0.5);

    if (lit) {
      // Soft white halo behind lit LEDs — fakes the glow leaking past the
      // plastic dome without needing a real bloom pass.
      ctx.save();
      const haloGrad = ctx.createRadialGradient(cx, ledCy, 0, cx, ledCy, ledR * 2.2);
      haloGrad.addColorStop(0, tokens.kiiLedGlow);
      haloGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = haloGrad;
      ctx.beginPath();
      ctx.arc(cx, ledCy, ledR * 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(cx, ledCy, ledR, 0, Math.PI * 2);
      ctx.fillStyle = litColor;
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(cx, ledCy, ledR, 0, Math.PI * 2);
      ctx.fillStyle = tokens.kiiLedOff;
      ctx.fill();
    }
  }

  ctx.restore();
}

/**
 * Trace a rounded-rectangle path. Used by the skeuomorphic meters where we
 * need to fill, stroke, and shadow the same shape multiple times without
 * re-listing the moveTo/arcTo sequence. Radius is clamped to half the smaller
 * dimension so tiny boxes still produce a sensible shape.
 */
function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/** Maps activityBand → number of REM pod LEDs lit (0–6). Fallback when no z-score. */
const REM_LIT_BY_BAND: Record<OverlayState["activityBand"], number> = {
  calm: 0, light: 1, possible: 2, notable: 4, strong: 6,
};

/** REM Pod body dimensions (logical px @ s=1). Tower form: tall and narrow. */
const REM_BODY_W = 64;
const REM_BODY_H = 88;
/** Z-score threshold above which the REM Pod fires an outward pulse animation. */
const REM_PULSE_TRIGGER_Z = 2.5;
/** Pulse animation length in ms — ring fades from REM_PULSE_R0 to REM_PULSE_R1. */
const REM_PULSE_MS = 600;

/**
 * Skeuomorphic REM Pod — black tower with chrome antenna and a 4-LED ring
 * around the base. Sits directly below the K-II on the right edge.
 *
 * Anatomy (logical px, s scales everything):
 *                   ●  ← chrome ball cap
 *                   │
 *                   │  ← chrome antenna (~32 px tall)
 *                   │
 *   ┌────────────────────┐  ← black tower body, 64 × 88
 *   │                    │     vertical gradient (edge → body → edge)
 *   │                    │
 *   │       REM POD      │  ← white silkscreen, lower-third
 *   │      ●    ●        │  ← 4-LED ring around the base
 *   │     (R, G, B, Y at top/right/bottom/left)
 *   └────────────────────┘
 *
 * Lit LED count is driven by emfZScore (preferred) or activityBand (fallback);
 * LEDs light sequentially clockwise as the z-score climbs. When the z-score
 * crosses REM_PULSE_TRIGGER_Z (2.5σ) an outward ring pulse emits from the
 * base and expands over ~600 ms — `frame.remPulse` carries the pulse start
 * time across frames so the ring animates without re-triggering each frame.
 * All colours resolve through `getMeterTokens(frame)` so scotopic re-skins
 * the tower without touching draw code.
 */
function drawRemPod(
  ctx: CanvasRenderingContext2D,
  W: number,
  activityBand: OverlayState["activityBand"],
  emfZScore: number | undefined,
  s: number,
  topY: number,
  frame: FrameContext,
): void {
  const tokens = getMeterTokens(frame);

  const hasZ = typeof emfZScore === "number" && Number.isFinite(emfZScore);
  const zAbs = hasZ ? Math.abs(emfZScore as number) : 0;
  // Use the same z-table as the K-II for consistency, but the REM ring only
  // has 4 LEDs so clamp the lit count to 0-4. Above ~1.5σ at least one LED
  // is lit; the ring fills clockwise as the magnetometer climbs.
  const bandLeds = REM_LIT_BY_BAND[activityBand] ?? 0;
  const zLeds = hasZ ? zScoreToLeds(zAbs, REM_Z_TABLE) : bandLeds;
  const litLeds = Math.min(4, Math.max(0, hasZ ? zLeds : bandLeds));

  // Detect pulse trigger — rising edge above the 2.5σ threshold. Compare
  // against the last z-score the pulse state saw, not just "is z high right
  // now", so a sustained high z doesn't keep re-starting the ring every
  // frame (would look like a strobe). A new pulse is allowed once the
  // previous one has finished its 600 ms window.
  const nowMs = (typeof performance !== "undefined" && typeof performance.now === "function")
    ? performance.now()
    : Date.now();
  if (hasZ && zAbs >= REM_PULSE_TRIGGER_Z) {
    const prev = frame.remPulse;
    const finished = !prev || (nowMs - prev.startedAtMs) >= REM_PULSE_MS;
    const risingEdge = !prev || prev.lastZ < REM_PULSE_TRIGGER_Z;
    if (finished || risingEdge) {
      frame.remPulse = { startedAtMs: nowMs, lastZ: zAbs };
    } else if (prev) {
      prev.lastZ = zAbs;
    }
  } else if (frame.remPulse) {
    // Keep the in-flight pulse animating; just update lastZ so the next
    // rising edge is detected correctly when it crosses 2.5σ again.
    frame.remPulse.lastZ = zAbs;
  }

  // Geometry — body anchored to the right edge, 12 px margin. Stacks under
  // the K-II (whose height is KII_BODY_H scaled) with an 8 px gap.
  const bodyW = Math.round(REM_BODY_W * s);
  const bodyH = Math.round(REM_BODY_H * s);
  const margin = Math.round(12 * s);
  const x = W - margin - bodyW;
  const kiiBottom = topY + Math.round(KII_BODY_H * s);
  const y = kiiBottom + Math.round(8 * s);
  const radius = Math.round(4 * s);

  ctx.save();

  // 1. Drop shadow under the tower.
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
  ctx.shadowBlur = 6 * s;
  ctx.shadowOffsetY = 3 * s;
  ctx.fillStyle = "rgba(0, 0, 0, 0.01)";
  roundedRectPath(ctx, x, y, bodyW, bodyH, radius);
  ctx.fill();
  ctx.restore();

  // 2. Antenna — chrome line rising from the top centre of the body. Drawn
  //    BEFORE the body so the body edge cleanly overlaps the antenna base.
  const antennaH = Math.round(32 * s);
  const antennaW = Math.max(2, Math.round(3 * s));
  const antennaX = x + (bodyW - antennaW) / 2;
  const antennaTopY = y - antennaH;
  const antennaGrad = ctx.createLinearGradient(antennaX, 0, antennaX + antennaW, 0);
  antennaGrad.addColorStop(0,    "#888888");
  antennaGrad.addColorStop(0.5,  tokens.remAntenna);
  antennaGrad.addColorStop(1,    "#888888");
  ctx.fillStyle = antennaGrad;
  ctx.fillRect(antennaX, antennaTopY, antennaW, antennaH);

  // 2b. Antenna ball cap — small chrome circle at the top, with a tiny
  //     highlight for the "metal" sheen.
  const ballR = Math.max(2, Math.round(2.5 * s));
  ctx.beginPath();
  ctx.arc(antennaX + antennaW / 2, antennaTopY, ballR, 0, Math.PI * 2);
  ctx.fillStyle = tokens.remAntenna;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(antennaX + antennaW / 2 - ballR * 0.3, antennaTopY - ballR * 0.3, ballR * 0.35, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
  ctx.fill();

  // 3. Body fill — vertical edge→body→edge gradient for cylindrical look.
  const bodyGrad = ctx.createLinearGradient(x, 0, x + bodyW, 0);
  bodyGrad.addColorStop(0,    tokens.remBodyEdge);
  bodyGrad.addColorStop(0.5,  tokens.remBody);
  bodyGrad.addColorStop(1,    tokens.remBodyEdge);
  roundedRectPath(ctx, x, y, bodyW, bodyH, radius);
  ctx.fillStyle = bodyGrad;
  ctx.fill();

  // 4. Body outline.
  ctx.strokeStyle = tokens.remBodyEdge;
  ctx.lineWidth = 1.5;
  roundedRectPath(ctx, x, y, bodyW, bodyH, radius);
  ctx.stroke();

  // 5. "REM POD" silkscreen — white text in the lower third, above the LED ring.
  const silkPx = Math.max(7, Math.round(8 * s));
  ctx.font = `700 ${silkPx}px "Inter", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = tokens.remSilkscreen;
  const silkY = y + bodyH * 0.62;
  ctx.fillText("REM POD", x + bodyW / 2, silkY);

  // 6. 4-LED ring around the base — positions are top / right / bottom / left
  //    relative to a ring centred near the lower-mid of the body. Sequential
  //    lighting goes clockwise from the TOP LED so the operator sees the
  //    ring "fill in" as activity climbs.
  const ringCx = x + bodyW / 2;
  const ringCy = y + bodyH * 0.82;
  const ringR = Math.min(bodyW * 0.30, bodyH * 0.18);
  const ledR = Math.max(3, Math.round(4 * s));
  // Order: top, right, bottom, left → angles 270°, 0°, 90°, 180°.
  const ringSlots: ReadonlyArray<{ angle: number; color: string }> = [
    { angle: -Math.PI / 2, color: tokens.remLedR },  // top — red
    { angle: 0,            color: tokens.remLedG },  // right — green
    { angle:  Math.PI / 2, color: tokens.remLedB },  // bottom — blue
    { angle:  Math.PI,     color: tokens.remLedY },  // left — yellow
  ];
  for (let i = 0; i < ringSlots.length; i++) {
    const lit = i < litLeds;
    const slot = ringSlots[i];
    const cx = ringCx + Math.cos(slot.angle) * ringR;
    const cy = ringCy + Math.sin(slot.angle) * ringR;
    ctx.beginPath();
    ctx.arc(cx, cy, ledR, 0, Math.PI * 2);
    ctx.fillStyle = lit ? slot.color : tokens.remLedOff;
    ctx.fill();
    // Subtle highlight on lit LEDs.
    if (lit) {
      ctx.beginPath();
      ctx.arc(cx - ledR * 0.35, cy - ledR * 0.35, ledR * 0.30, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
      ctx.fill();
    }
  }

  // 7. Pulse ring — expands outward from the LED-ring centre over 600 ms.
  //    Drawn LAST so it sits on top of the body when active. Skipped once
  //    the pulse age exceeds the animation window.
  if (frame.remPulse) {
    const age = nowMs - frame.remPulse.startedAtMs;
    if (age >= 0 && age <= REM_PULSE_MS) {
      const t = age / REM_PULSE_MS;
      const r0 = Math.max(bodyW, bodyH) * 0.45;
      const r1 = Math.max(bodyW, bodyH) * 1.0;
      const pulseR = r0 + (r1 - r0) * t;
      const alpha = 1 - t;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = tokens.remPulse;
      ctx.lineWidth = Math.max(1.5, 2 * s);
      ctx.beginPath();
      ctx.arc(ringCx, ringCy, pulseR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  ctx.restore();
}

// ─── Analog EMF galvanometer (right edge, 1960s field-meter aesthetic) ──────

/** Galvo body dimensions (logical px @ s=1). Same width as K-II so the right-
 *  edge stack stays visually aligned; taller because the needle scale needs
 *  the vertical real estate to read at a glance. */
const GALVO_BODY_W = 96;
const GALVO_BODY_H = 78;
/** Needle sweep range — rest at -60°, peak at +60° (120° total sweep). Wider
 *  than the VU meter's 90° because galvanometers historically used the full
 *  semicircle. Centred on vertical-up = 0. */
const GALVO_REST_RAD = -(Math.PI / 3);
const GALVO_PEAK_RAD =  (Math.PI / 3);
/** Z-score that pegs the needle at 80% (top of the red zone). Beyond this
 *  the needle enters overload territory. ~3σ feels right — the K-II's third
 *  LED also lights at 2.5σ, so this aligns the visual cues. */
const GALVO_FULL_SCALE_Z = 5;
const GALVO_REDZONE_FRACTION = 0.8;

/**
 * Skeuomorphic analog EMF galvanometer — brushed-aluminum bezel + cream face
 * + black needle + red-zone past 80%. Reads the SAME magnetometer z-score the
 * K-II uses; this is gear-archetype diversity, not a second data stream.
 *
 * Anatomy (logical px @ s=1, 96 × 78):
 *   ┌──────────────────────────┐  ← brushed-aluminum bezel
 *   │ ╔══════════════════════╗ │
 *   │ ║   .  .  .  .  ┃┃┃    ║ │   cream scale, ink ticks, red zone
 *   │ ║     ╲      ╱         ║ │   right of 80%.
 *   │ ║       ╲  ╱           ║ │   black needle pivots at the bottom-centre.
 *   │ ╚══════════════════════╝ │
 *   │      EMF FIELD METER     │  silkscreen label on the bezel below
 *   └──────────────────────────┘
 *
 * Needle obeys a 200 ms RC ballistic via `frame.galvoNeedleSmooth` so the
 * sweep glides instead of popping on every magnetometer frame. Without this
 * the needle would look digital not analog.
 *
 * Honest copy — silkscreen says "EMF FIELD METER" / "MAG FLUX". No anomaly
 * claims; this is the same magnetometer signal the K-II processes.
 */
function drawEmfGalvanometer(
  ctx: CanvasRenderingContext2D,
  W: number,
  emfZScore: number | undefined,
  s: number,
  topY: number,
  frame: FrameContext,
): void {
  const tokens = getMeterTokens(frame);

  // Convert z-score → 0..1 needle level. Sign-stripped because the magnitude
  // is what matters for an "is there a field nearby" reading.
  const hasZ = typeof emfZScore === "number" && Number.isFinite(emfZScore);
  const targetLevel = hasZ
    ? Math.min(1, Math.abs(emfZScore as number) / GALVO_FULL_SCALE_Z)
    : 0;

  // RC ballistic — 200 ms time-constant matches the K-II smoother.
  const nowMs = (typeof performance !== "undefined" && typeof performance.now === "function")
    ? performance.now()
    : Date.now();
  if (!frame.galvoNeedleSmooth) {
    frame.galvoNeedleSmooth = { value: targetLevel, lastMs: nowMs };
  } else {
    const dtMs = Math.max(0, nowMs - frame.galvoNeedleSmooth.lastMs);
    const alpha = 1 - Math.exp(-dtMs / 200);
    frame.galvoNeedleSmooth.value += (targetLevel - frame.galvoNeedleSmooth.value) * alpha;
    frame.galvoNeedleSmooth.lastMs = nowMs;
  }
  const needleLevel = Math.max(0, Math.min(1, frame.galvoNeedleSmooth.value));
  const needleAngle = GALVO_REST_RAD + (GALVO_PEAK_RAD - GALVO_REST_RAD) * needleLevel;

  // Geometry — body anchored to the right edge with a 12 px margin. Stacks
  // under the REM Pod (88 px below K-II + 8 px gap below REM Pod = 144 px
  // below the K-II top).
  const bodyW = Math.round(GALVO_BODY_W * s);
  const bodyH = Math.round(GALVO_BODY_H * s);
  const margin = Math.round(12 * s);
  const x = W - margin - bodyW;
  const remBottom = topY + Math.round((KII_BODY_H + 8 + REM_BODY_H) * s);
  const y = remBottom + Math.round(8 * s);
  const radius = Math.round(5 * s);

  ctx.save();

  // 1. Drop shadow under the bezel.
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.42)";
  ctx.shadowBlur = 6 * s;
  ctx.shadowOffsetY = 3 * s;
  ctx.fillStyle = "rgba(0, 0, 0, 0.01)";
  roundedRectPath(ctx, x, y, bodyW, bodyH, radius);
  ctx.fill();
  ctx.restore();

  // 2. Bezel — brushed aluminum vertical gradient (edge → body → edge).
  const bezelGrad = ctx.createLinearGradient(0, y, 0, y + bodyH);
  bezelGrad.addColorStop(0,    tokens.galvoBodyEdge);
  bezelGrad.addColorStop(0.4,  tokens.galvoBody);
  bezelGrad.addColorStop(0.6,  tokens.galvoBody);
  bezelGrad.addColorStop(1,    tokens.galvoBodyEdge);
  roundedRectPath(ctx, x, y, bodyW, bodyH, radius);
  ctx.fillStyle = bezelGrad;
  ctx.fill();
  ctx.strokeStyle = tokens.galvoBodyEdge;
  ctx.lineWidth = 1.5;
  roundedRectPath(ctx, x, y, bodyW, bodyH, radius);
  ctx.stroke();

  // 3. Cream scale face — recessed window inset into the bezel.
  const insetX = Math.round(5 * s);
  const insetTop = Math.round(5 * s);
  const insetBottom = Math.round(16 * s); // reserve space for silkscreen
  const faceX = x + insetX;
  const faceY = y + insetTop;
  const faceW = bodyW - insetX * 2;
  const faceH = bodyH - insetTop - insetBottom;
  const faceR = Math.round(3 * s);
  const faceGrad = ctx.createLinearGradient(0, faceY, 0, faceY + faceH);
  faceGrad.addColorStop(0,    tokens.galvoFace);
  faceGrad.addColorStop(0.7,  tokens.galvoFace);
  faceGrad.addColorStop(1,    tokens.galvoFaceEdge);
  roundedRectPath(ctx, faceX, faceY, faceW, faceH, faceR);
  ctx.fillStyle = faceGrad;
  ctx.fill();

  // 4. Scale arc geometry — needle pivots at the bottom-centre of the face.
  const pivotX = faceX + faceW / 2;
  const pivotY = faceY + faceH + Math.round(1 * s);
  const arcR = Math.min(faceW * 0.50, faceH * 0.95);

  // 4a. Red overload zone — wedge from 80% to 100%.
  const overloadStartAngle = GALVO_REST_RAD
    + (GALVO_PEAK_RAD - GALVO_REST_RAD) * GALVO_REDZONE_FRACTION;
  const overloadEndAngle = GALVO_PEAK_RAD;
  const arcInnerR = arcR * 0.78;
  const arcOuterR = arcR * 1.00;
  ctx.save();
  ctx.beginPath();
  ctx.arc(pivotX, pivotY, arcOuterR,
    overloadStartAngle - Math.PI / 2,
    overloadEndAngle   - Math.PI / 2, false);
  ctx.arc(pivotX, pivotY, arcInnerR,
    overloadEndAngle   - Math.PI / 2,
    overloadStartAngle - Math.PI / 2, true);
  ctx.closePath();
  ctx.fillStyle = tokens.galvoRedzone;
  ctx.globalAlpha = 0.78;
  ctx.fill();
  ctx.restore();

  // 4b. Tick marks — five at 0, 25, 50, 75, 100% of the sweep. Short, inked.
  ctx.save();
  ctx.strokeStyle = tokens.galvoTick;
  ctx.lineWidth = Math.max(1, 1.1 * s);
  ctx.lineCap = "round";
  for (let i = 0; i <= 4; i++) {
    const tickLevel = i / 4;
    const ang = GALVO_REST_RAD + (GALVO_PEAK_RAD - GALVO_REST_RAD) * tickLevel;
    const cosA = Math.sin(ang);
    const sinA = -Math.cos(ang);
    const tickInner = arcR * 0.80;
    const tickOuter = arcR * 1.00;
    ctx.beginPath();
    ctx.moveTo(pivotX + cosA * tickInner, pivotY + sinA * tickInner);
    ctx.lineTo(pivotX + cosA * tickOuter, pivotY + sinA * tickOuter);
    ctx.stroke();
  }
  ctx.restore();

  // 5. Needle — black, pivots at (pivotX, pivotY).
  const needleLen = arcR * 0.92;
  const tipX = pivotX + Math.sin(needleAngle) * needleLen;
  const tipY = pivotY - Math.cos(needleAngle) * needleLen;
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
  ctx.shadowBlur = 2 * s;
  ctx.shadowOffsetX = 1 * s;
  ctx.shadowOffsetY = 1 * s;
  ctx.strokeStyle = tokens.galvoNeedle;
  ctx.lineWidth = Math.max(1.2, 1.6 * s);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(pivotX, pivotY);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();
  ctx.restore();

  // 5b. Pivot cap — small dark grey circle so the analog look reads from
  //     across the room.
  const pivotR = Math.max(1.8, Math.round(2.5 * s));
  ctx.beginPath();
  ctx.arc(pivotX, pivotY, pivotR, 0, Math.PI * 2);
  ctx.fillStyle = tokens.galvoPivot;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(pivotX - pivotR * 0.35, pivotY - pivotR * 0.35, pivotR * 0.35, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
  ctx.fill();

  // 6. Silkscreen label below the scale — "EMF FIELD METER" in dark grey.
  //    Honest gear label, no anomaly claim.
  const silkPx = Math.max(7, Math.round(8 * s));
  ctx.font = `700 ${silkPx}px "Inter", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = tokens.galvoSilkscreen;
  ctx.fillText("EMF FIELD METER", x + bodyW / 2, y + bodyH - Math.round(10 * s));

  ctx.restore();
}

// ─── Vintage VU audio meter (left edge, analog) ─────────────────────────────

/** VU meter body dimensions (logical px @ s=1). Landscape — wider than tall.
 *  140×96 leaves room for a proper 90°-sweep arc with red-zone above 0 VU. */
const VU_BODY_W = 140;
const VU_BODY_H = 96;
/** Needle sweep range in radians. The needle pivots at the bottom-center;
 *  left rest (silence) is at -45° from vertical-up, right peak (overload)
 *  is at +45°. So the full sweep is 90°. */
const VU_NEEDLE_REST_RAD = -Math.PI / 4;
const VU_NEEDLE_PEAK_RAD =  Math.PI / 4;
/** Audio level (0..1) at which the meter reads 0 VU — the boundary of the
 *  red overload zone. -3 dBFS ≈ pow(10, -3/20) ≈ 0.708. Anything above this
 *  swings into the red zone on the scale face. */
const VU_OVERLOAD_LEVEL = 0.708;

/**
 * Skeuomorphic vintage VU audio meter — analog needle on a cardboard-textured
 * scale, with a red overload zone past -3 dB. Replaces the flat gradient bar
 * the old `drawAudioMeter` used. Driven by the same `audioRms` input (we don't
 * touch audio capture — only the draw layer).
 *
 * Anatomy (logical px @ s=1, 140 × 96):
 *   ┌────────────────────────────────────────┐  ← black bezel surround
 *   │ ╔════════════════════════════════════╗ │
 *   │ ║   .  .  .  .  ┃┃┃┃                ║ │   cardboard scale face,
 *   │ ║       ╲      ╱                    ║ │   inked tick marks, red zone
 *   │ ║         ╲   ╱       ━━━━━━━━━     ║ │   right of the 0 VU line.
 *   │ ║          ╲┘╱        VU            ║ │   black needle pivots at the
 *   │ ║           ╳         METER         ║ │   bottom-center, swings -45°
 *   │ ╚════════════════════════════════════╝ │   to +45°.
 *   └────────────────────────────────────────┘
 *
 * The needle obeys a 300 ms RC ballistic — the standard VU integration time
 * — via `frame.vuNeedleSmooth`. Without that the needle pops between every
 * audio frame, which reads digital not analog. dB readout sits below the scale.
 */
function drawVuMeter(
  ctx: CanvasRenderingContext2D,
  _W: number,
  H: number,
  audioRms: number,
  s: number,
  frame: FrameContext,
): void {
  const tokens = getMeterTokens(frame);

  // Clamp + power-curve compression (log-ish feel, same as the old bar) so the
  // needle leaves rest position on quiet rooms but isn't pinned to peak at
  // moderate input. The ballistic below smooths the visual.
  const level = Math.min(1, Math.max(0, audioRms));
  const visualLevel = Math.pow(level, 0.55);

  // VU ballistic — ~300 ms RC integration. lerp the smoother towards the
  // current visualLevel; the time-constant defines how fast the needle
  // settles. Cold start pins to current so the first frame isn't a snap.
  const nowMs = (typeof performance !== "undefined" && typeof performance.now === "function")
    ? performance.now()
    : Date.now();
  if (!frame.vuNeedleSmooth) {
    frame.vuNeedleSmooth = { value: visualLevel, lastMs: nowMs };
  } else {
    const dtMs = Math.max(0, nowMs - frame.vuNeedleSmooth.lastMs);
    const tau = 300; // ms — ANSI/IEC VU integration time
    const alpha = 1 - Math.exp(-dtMs / tau);
    frame.vuNeedleSmooth.value += (visualLevel - frame.vuNeedleSmooth.value) * alpha;
    frame.vuNeedleSmooth.lastMs = nowMs;
  }
  const needleLevel = Math.max(0, Math.min(1, frame.vuNeedleSmooth.value));
  const needleAngle = VU_NEEDLE_REST_RAD + (VU_NEEDLE_PEAK_RAD - VU_NEEDLE_REST_RAD) * needleLevel;

  // Geometry — body anchored to the left edge with a 12 px margin.
  const bodyW = Math.round(VU_BODY_W * s);
  const bodyH = Math.round(VU_BODY_H * s);
  const margin = Math.round(12 * s);
  const x = margin;
  const y = Math.round(H * 0.30);
  const radius = Math.round(6 * s);

  ctx.save();

  // 1. Drop shadow — soft, offset down so the bezel looks lifted off the frame.
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
  ctx.shadowBlur = 6 * s;
  ctx.shadowOffsetY = 3 * s;
  ctx.fillStyle = "rgba(0, 0, 0, 0.01)";
  roundedRectPath(ctx, x, y, bodyW, bodyH, radius);
  ctx.fill();
  ctx.restore();

  // 2. Bezel — dark vertical gradient (edge → body → edge) so the surround
  //    reads as moulded plastic / brushed metal.
  const bezelGrad = ctx.createLinearGradient(0, y, 0, y + bodyH);
  bezelGrad.addColorStop(0,    tokens.vuBodyEdge);
  bezelGrad.addColorStop(0.5,  tokens.vuBody);
  bezelGrad.addColorStop(1,    tokens.vuBodyEdge);
  roundedRectPath(ctx, x, y, bodyW, bodyH, radius);
  ctx.fillStyle = bezelGrad;
  ctx.fill();

  // 3. Bezel outline.
  ctx.strokeStyle = tokens.vuBodyEdge;
  ctx.lineWidth = 1.5;
  roundedRectPath(ctx, x, y, bodyW, bodyH, radius);
  ctx.stroke();

  // 4. Recessed scale window — cardboard face inset into the bezel.
  const insetX = Math.round(6 * s);
  const insetTop = Math.round(6 * s);
  const insetBottom = Math.round(18 * s); // leave space for dB readout
  const scaleX = x + insetX;
  const scaleY = y + insetTop;
  const scaleW = bodyW - insetX * 2;
  const scaleH = bodyH - insetTop - insetBottom;
  const scaleR = Math.round(3 * s);

  // Cardboard fill — slightly off-cream with a subtle vertical shading.
  const scaleGrad = ctx.createLinearGradient(0, scaleY, 0, scaleY + scaleH);
  scaleGrad.addColorStop(0,    tokens.vuScaleBg);
  scaleGrad.addColorStop(0.7,  tokens.vuScaleBg);
  scaleGrad.addColorStop(1,    tokens.vuScaleEdge);
  roundedRectPath(ctx, scaleX, scaleY, scaleW, scaleH, scaleR);
  ctx.fillStyle = scaleGrad;
  ctx.fill();

  // 4b. Warm internal lamp glow — radial gradient near the scale top centre
  //     fakes the look of a single incandescent illuminating the back of the
  //     scale (classic vintage VU meter touch).
  ctx.save();
  roundedRectPath(ctx, scaleX, scaleY, scaleW, scaleH, scaleR);
  ctx.clip();
  const glowCx = scaleX + scaleW / 2;
  const glowCy = scaleY + scaleH * 0.30;
  const glowR = Math.max(scaleW, scaleH) * 0.6;
  const glowGrad = ctx.createRadialGradient(glowCx, glowCy, 0, glowCx, glowCy, glowR);
  glowGrad.addColorStop(0, tokens.vuGlow);
  glowGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = glowGrad;
  ctx.fillRect(scaleX, scaleY, scaleW, scaleH);
  ctx.restore();

  // 5. Scale arc geometry — needle pivots at the bottom-center of the scale
  //    window; the arc sits a bit above the pivot so the tick marks face the
  //    audience like a real VU meter.
  const pivotX = scaleX + scaleW / 2;
  const pivotY = scaleY + scaleH + Math.round(2 * s); // just below the scale
  const arcR = Math.min(scaleW * 0.46, scaleH * 0.95);

  // 5a. Red overload zone — fill the wedge from VU_OVERLOAD_LEVEL to peak.
  //     This is the visual cue that "anything in here is clipping risk."
  const overloadStartAngle = VU_NEEDLE_REST_RAD
    + (VU_NEEDLE_PEAK_RAD - VU_NEEDLE_REST_RAD) * VU_OVERLOAD_LEVEL;
  const overloadEndAngle = VU_NEEDLE_PEAK_RAD;
  const arcInnerR = arcR * 0.82;
  const arcOuterR = arcR * 1.02;
  ctx.save();
  ctx.beginPath();
  // Outer arc (sweep clockwise from overloadStart to overloadEnd; canvas
  // arc() angles are measured clockwise from +X, so we offset by -π/2 to align
  // with "vertical-up = 0" semantics used by needleAngle).
  ctx.arc(pivotX, pivotY, arcOuterR,
    overloadStartAngle - Math.PI / 2,
    overloadEndAngle   - Math.PI / 2, false);
  // Inner arc, reversed direction to close the wedge.
  ctx.arc(pivotX, pivotY, arcInnerR,
    overloadEndAngle   - Math.PI / 2,
    overloadStartAngle - Math.PI / 2, true);
  ctx.closePath();
  ctx.fillStyle = tokens.vuOverload;
  ctx.globalAlpha = 0.78;
  ctx.fill();
  ctx.restore();

  // 5b. Tick marks — short ink-stamped marks at canonical -20, -10, -5, -3, 0,
  //     +3 VU positions. Real VU meters log-scale these; for our skeuomorph we
  //     evenly distribute six ticks across the sweep with the 0 VU tick
  //     emphasised. Ticks below 0 are full-length; ticks in the red zone are
  //     drawn in red ink so the operator can see them through the red wedge.
  ctx.save();
  ctx.strokeStyle = tokens.vuScaleInk;
  ctx.lineWidth = Math.max(1, 1.2 * s);
  ctx.lineCap = "round";
  type Tick = { level: number; label?: string; long: boolean };
  const ticks: Tick[] = [
    { level: 0,    label: "-20", long: true },
    { level: 0.2,  label: "-10", long: true },
    { level: 0.5,  label: "-5",  long: true },
    { level: VU_OVERLOAD_LEVEL, label: "-3", long: true },
    { level: 0.86, label: "0",   long: true },
    { level: 1.0,  label: "+3",  long: true },
  ];
  for (const tick of ticks) {
    const ang = VU_NEEDLE_REST_RAD + (VU_NEEDLE_PEAK_RAD - VU_NEEDLE_REST_RAD) * tick.level;
    const cosA = Math.sin(ang); // sin because needleAngle=0 is straight up
    const sinA = -Math.cos(ang);
    const tickInner = arcR * (tick.long ? 0.78 : 0.86);
    const tickOuter = arcR * 1.00;
    ctx.beginPath();
    ctx.moveTo(pivotX + cosA * tickInner, pivotY + sinA * tickInner);
    ctx.lineTo(pivotX + cosA * tickOuter, pivotY + sinA * tickOuter);
    ctx.stroke();
  }
  ctx.restore();

  // 5c. "VU" silkscreen under the arc — small inked text branded onto the
  //     cardboard scale, classic vintage look.
  const vuLabelPx = Math.max(8, Math.round(10 * s));
  ctx.save();
  ctx.font = `700 ${vuLabelPx}px "Inter", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = tokens.vuScaleInk;
  ctx.fillText("VU", pivotX, pivotY - arcR * 0.42);
  ctx.restore();

  // 6. Needle — pivots at (pivotX, pivotY), length arcInnerR + small overrun.
  //    Drawn AFTER the scale ink so it sits on top.
  const needleLen = arcR * 0.92;
  const tipX = pivotX + Math.sin(needleAngle) * needleLen;
  const tipY = pivotY - Math.cos(needleAngle) * needleLen;
  ctx.save();
  // Subtle drop shadow under the needle for depth.
  ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
  ctx.shadowBlur = 2 * s;
  ctx.shadowOffsetX = 1 * s;
  ctx.shadowOffsetY = 1 * s;
  ctx.strokeStyle = tokens.vuNeedle;
  ctx.lineWidth = Math.max(1.5, 1.8 * s);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(pivotX, pivotY);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();
  ctx.restore();

  // 6b. Pivot cap — small filled circle at the needle base, sells the analog look.
  const pivotR = Math.max(2, Math.round(3 * s));
  ctx.beginPath();
  ctx.arc(pivotX, pivotY, pivotR, 0, Math.PI * 2);
  ctx.fillStyle = tokens.vuNeedle;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(pivotX - pivotR * 0.35, pivotY - pivotR * 0.35, pivotR * 0.35, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
  ctx.fill();

  // 7. "VU METER" silkscreen on the bezel below the scale (gear label, not
  //    an anomaly claim). Sits in the inset-bottom margin reserved earlier.
  const silkPx = Math.max(7, Math.round(8 * s));
  ctx.font = `700 ${silkPx}px "Inter", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = tokens.vuSilkscreen;
  ctx.fillText("VU METER", x + bodyW / 2, y + bodyH - Math.round(11 * s));

  // 8. Numeric dB readout — small mono digit row to the right of the silkscreen.
  //    Keeps the operator value the legacy meter provided ("how loud is it
  //    really") without giving up the analog aesthetic. Clamp to -60 dBFS.
  const dbValue = level > 0.001 ? 20 * Math.log10(level) : -60;
  const dbLabel = `${dbValue >= 0 ? "+" : ""}${dbValue.toFixed(0)} dB`;
  const dbPx = Math.max(7, Math.round(8 * s));
  ctx.save();
  ctx.font = `600 ${dbPx}px "JetBrains Mono", monospace`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillStyle = tokens.vuSilkscreen;
  ctx.fillText(dbLabel, x + bodyW - Math.round(8 * s), y + bodyH - Math.round(11 * s));
  ctx.restore();

  ctx.restore();
}

// ─── Spirit Box amber 7-segment LCD (left edge, below VU) ───────────────────

/**
 * 7-segment digit layout used by the Spirit Box LCD.
 *
 *       a
 *     ┌───┐
 *   f │   │ b
 *     ├─g─┤
 *   e │   │ c
 *     └───┘
 *       d           . dp (decimal point)
 *
 * Each glyph maps to the segments lit by digit (and dot-separator). Capital
 * letters used by the units suffix ("MHz", "PH") are added on top of digits.
 */
const SEVEN_SEG_DIGITS: Record<string, ReadonlyArray<"a" | "b" | "c" | "d" | "e" | "f" | "g">> = {
  "0": ["a", "b", "c", "d", "e", "f"],
  "1": ["b", "c"],
  "2": ["a", "b", "g", "e", "d"],
  "3": ["a", "b", "g", "c", "d"],
  "4": ["f", "g", "b", "c"],
  "5": ["a", "f", "g", "c", "d"],
  "6": ["a", "f", "g", "e", "c", "d"],
  "7": ["a", "b", "c"],
  "8": ["a", "b", "c", "d", "e", "f", "g"],
  "9": ["a", "b", "c", "d", "f", "g"],
  // Letters used by the "MHz" suffix glyphs.
  "H": ["b", "c", "e", "f", "g"],
  "M": ["a", "b", "c", "e", "f"],   // approximate — real M is impossible on 7-seg
  "Z": ["a", "b", "g", "e", "d"],   // same as 2 — accept the visual ambiguity
  // Space / blank.
  " ": [],
  "-": ["g"],
};

/** Spirit Box LCD body dimensions (logical px @ s=1). Landscape, fits two
 *  rows: top = 7-segment freq, bottom = scrolling phoneme text. */
const SPIRIT_LCD_BODY_W = 152;
const SPIRIT_LCD_BODY_H = 70;
/** Cadence of the simulated scanning frequency cycle — wrapping range of
 *  100 MHz worth of phoneme-sweep visualisation in 6 seconds, matching the
 *  spirit-box "you can almost catch a word" feel. The number is presentational
 *  only — no real radio is being tuned. */
const SPIRIT_LCD_SWEEP_MS = 6000;

/**
 * Draw one 7-segment glyph at (x, y) with cell dimensions (cellW, cellH).
 * `segPx` controls segment thickness. Both lit and unlit segments are drawn
 * (unlit very dim) so the audience can see the full character outline — a
 * real LCD ghost-segments the inactive ones at low contrast.
 */
function drawSevenSegmentGlyph(
  ctx: CanvasRenderingContext2D,
  glyph: string,
  x: number,
  y: number,
  cellW: number,
  cellH: number,
  segPx: number,
  litColor: string,
  offColor: string,
): void {
  const lit = new Set<string>(SEVEN_SEG_DIGITS[glyph] ?? []);
  const mid = y + cellH / 2;
  const inset = segPx; // shorten segment ends so corners don't overlap
  type SegPath = { name: "a" | "b" | "c" | "d" | "e" | "f" | "g"; horiz: boolean; x1: number; y1: number; x2: number; y2: number };
  const segs: SegPath[] = [
    { name: "a", horiz: true,  x1: x + inset,        y1: y,                 x2: x + cellW - inset, y2: y },
    { name: "b", horiz: false, x1: x + cellW,         y1: y + inset,         x2: x + cellW,         y2: mid - inset / 2 },
    { name: "c", horiz: false, x1: x + cellW,         y1: mid + inset / 2,   x2: x + cellW,         y2: y + cellH - inset },
    { name: "d", horiz: true,  x1: x + inset,        y1: y + cellH,          x2: x + cellW - inset, y2: y + cellH },
    { name: "e", horiz: false, x1: x,                 y1: mid + inset / 2,   x2: x,                 y2: y + cellH - inset },
    { name: "f", horiz: false, x1: x,                 y1: y + inset,         x2: x,                 y2: mid - inset / 2 },
    { name: "g", horiz: true,  x1: x + inset,        y1: mid,                x2: x + cellW - inset, y2: mid },
  ];
  for (const seg of segs) {
    ctx.strokeStyle = lit.has(seg.name) ? litColor : offColor;
    ctx.lineWidth = segPx;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(seg.x1, seg.y1);
    ctx.lineTo(seg.x2, seg.y2);
    ctx.stroke();
  }
}

/**
 * Skeuomorphic Spirit Box amber LCD — Radio Shack PRO-2055-era 7-segment
 * frequency display + scrolling phoneme text below, all on a black bezel.
 *
 * Anatomy (logical px @ s=1, 152 × 70):
 *   ┌─────────────────────────────────────────────┐  ← black bezel surround
 *   │  ╔═════════════════════════════════════╗   │
 *   │  ║  ┃ ┃ ┃ ┃ . ┃ ┃   MHz                ║   │   amber 7-seg row 1:
 *   │  ║                                      ║   │   "108.0 MHz"
 *   │  ║  PHONEME: aaa eee mmm                ║   │   amber pixel text row 2:
 *   │  ╚═════════════════════════════════════╝   │   scrolling phoneme
 *   │              SPIRIT BOX                     │  ← silkscreen
 *   └─────────────────────────────────────────────┘
 *
 * The frequency is a deterministic LFSR-style cycle through 88.0–108.0 MHz
 * driven by Date.now() — honest UI ("phoneme sweep") because no real radio
 * is being tuned. The phoneme text below is the literal phoneme from the
 * existing useSpiritBox hook (already curated; no real speech).
 *
 * Token-driven palette so scotopic re-skin works without touching draw code.
 */
function drawSpiritBoxLcd(
  ctx: CanvasRenderingContext2D,
  H: number,
  spiritBox: ItcChannelView | undefined,
  s: number,
  frame: FrameContext,
): void {
  const tokens = getMeterTokens(frame);

  // Geometry — anchored to the left edge, stacked below the VU meter.
  const bodyW = Math.round(SPIRIT_LCD_BODY_W * s);
  const bodyH = Math.round(SPIRIT_LCD_BODY_H * s);
  const margin = Math.round(12 * s);
  const x = margin;
  // VU meter sits at H * 0.30, height VU_BODY_H. Stack this 8 px below.
  const vuBottom = Math.round(H * 0.30) + Math.round(VU_BODY_H * s);
  const y = vuBottom + Math.round(8 * s);
  const radius = Math.round(5 * s);

  ctx.save();

  // 1. Drop shadow under the bezel.
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
  ctx.shadowBlur = 6 * s;
  ctx.shadowOffsetY = 3 * s;
  ctx.fillStyle = "rgba(0, 0, 0, 0.01)";
  roundedRectPath(ctx, x, y, bodyW, bodyH, radius);
  ctx.fill();
  ctx.restore();

  // 2. Bezel — deep black with a subtle top highlight so it reads as moulded
  //    plastic, not flat fill. Lit segments on near-black bg gives the LCD
  //    real estate the depth a Radio Shack tuner casing has.
  const bezelGrad = ctx.createLinearGradient(0, y, 0, y + bodyH);
  bezelGrad.addColorStop(0, "#1a1a1a");
  bezelGrad.addColorStop(0.5, tokens.spiritLcdBezel);
  bezelGrad.addColorStop(1, "#1a1a1a");
  roundedRectPath(ctx, x, y, bodyW, bodyH, radius);
  ctx.fillStyle = bezelGrad;
  ctx.fill();
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
  roundedRectPath(ctx, x, y, bodyW, bodyH, radius);
  ctx.stroke();

  // 3. Recessed LCD pane — black inset rounded rect. The amber segments
  //    light up against this near-black backplane.
  const insetX = Math.round(6 * s);
  const insetTopY = Math.round(6 * s);
  const insetBottomMargin = Math.round(13 * s); // leave space for silkscreen
  const lcdX = x + insetX;
  const lcdY = y + insetTopY;
  const lcdW = bodyW - insetX * 2;
  const lcdH = bodyH - insetTopY - insetBottomMargin;
  const lcdR = Math.round(3 * s);
  roundedRectPath(ctx, lcdX, lcdY, lcdW, lcdH, lcdR);
  ctx.fillStyle = tokens.spiritLcdBg;
  ctx.fill();

  // 4. Subtle inner-shadow rim so the LCD reads as inset into the bezel.
  ctx.save();
  ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
  ctx.lineWidth = 1;
  roundedRectPath(ctx, lcdX + 0.5, lcdY + 0.5, lcdW - 1, lcdH - 1, lcdR);
  ctx.stroke();
  ctx.restore();

  // 5. 7-segment frequency row — top half of the LCD pane.
  //    Cycle through 88.0–108.0 MHz over SPIRIT_LCD_SWEEP_MS, deterministic by
  //    wall-clock so the visual ALWAYS animates even if the operator hasn't
  //    actually started the spirit box hook. Real-radio honesty: bezel says
  //    "PHONEME SWEEP" not "RADIO SCAN" — the number is decorative.
  const nowMs = Date.now();
  const sweepT = (nowMs % SPIRIT_LCD_SWEEP_MS) / SPIRIT_LCD_SWEEP_MS;
  const freq = 88.0 + sweepT * 20.0; // MHz
  const freqStr = freq.toFixed(1); // e.g. "97.3" — produces "9","7",".","3"
  // Build padded display "108.0 MHz" — 5 digits + dot + " MHz" suffix label.
  // Mostly 4 char digits split across decimal.
  const intPart = freqStr.split(".")[0].padStart(3, " "); // " 88" or "108"
  const decPart = freqStr.split(".")[1] ?? "0";
  const digitChars: { char: string; dot: boolean }[] = [];
  for (let i = 0; i < intPart.length; i++) {
    const isLast = i === intPart.length - 1;
    digitChars.push({ char: intPart[i], dot: isLast });
  }
  digitChars.push({ char: decPart, dot: false });

  // Digit cell dimensions — fit 4 cells across the LCD with comfortable padding.
  const segRowH = Math.round(lcdH * 0.55);
  const segRowY = lcdY + Math.round(3 * s);
  const segPaddingX = Math.round(6 * s);
  const cellGap = Math.round(2 * s);
  const cellCount = digitChars.length;
  const totalGap = cellGap * (cellCount - 1);
  const cellW = Math.max(4, Math.floor((lcdW - segPaddingX * 2 - totalGap) * 0.62 / cellCount));
  const cellH = segRowH;
  const segPx = Math.max(1.5, Math.round(2 * s));

  // Lay out from left.
  let cx = lcdX + segPaddingX;
  ctx.save();
  // Add a soft amber halo behind the segment row so lit segments bloom — fakes
  // the LCD backlight without a real bloom pass.
  ctx.shadowColor = tokens.spiritLcdGlow;
  ctx.shadowBlur = Math.round(3 * s);
  for (const { char, dot } of digitChars) {
    drawSevenSegmentGlyph(
      ctx, char.trim() === "" ? " " : char,
      cx, segRowY, cellW, cellH, segPx,
      tokens.spiritLcdAmber, tokens.spiritLcdOff,
    );
    if (dot) {
      // Decimal point — small filled square just below the digit's c-segment.
      const dotR = Math.max(1.5, segPx * 0.9);
      ctx.beginPath();
      ctx.arc(cx + cellW + cellGap * 0.5 + dotR * 0.5, segRowY + cellH - dotR, dotR, 0, Math.PI * 2);
      ctx.fillStyle = tokens.spiritLcdAmber;
      ctx.fill();
    }
    cx += cellW + cellGap + (dot ? Math.round(4 * s) : 0);
  }
  ctx.restore();

  // 5b. "MHz" suffix label — small monospace text to the right of the digits,
  //     still amber so it reads as part of the LCD.
  const suffixPx = Math.max(7, Math.round(9 * s));
  ctx.save();
  ctx.shadowColor = tokens.spiritLcdGlow;
  ctx.shadowBlur = Math.round(2 * s);
  ctx.font = `700 ${suffixPx}px "JetBrains Mono", monospace`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = tokens.spiritLcdAmber;
  ctx.fillText("MHz", cx + Math.round(2 * s), segRowY + cellH * 0.55);
  ctx.restore();

  // 6. Phoneme text row — bottom half of the LCD pane.
  //    Shows the curated phoneme from the existing useSpiritBox hook (already
  //    a hand-curated phoneme bank, no real ASR / no audio leakage). The text
  //    scrolls horizontally if it's longer than the LCD width, so longer
  //    phonemes don't truncate the trailing characters.
  const phonemeY = lcdY + Math.round(lcdH * 0.66);
  const phonemeH = lcdH - (phonemeY - lcdY) - Math.round(2 * s);
  const phonemePx = Math.max(8, Math.round(11 * s));
  // Build the readout string — show "PH: <text>" so the operator immediately
  // reads it as "phoneme" not as a word from a ghost. Empty / stale data
  // collapses to the resting "-- --" placeholder so the LCD isn't ever blank.
  const phonemeText = spiritBox && spiritBox.ageMs <= ITC_MAX_AGE_MS && spiritBox.text
    ? spiritBox.text.trim().toUpperCase().slice(0, 22)
    : "-- --";
  ctx.save();
  // Clip to the phoneme strip so any scroll can't bleed past the LCD pane.
  ctx.beginPath();
  ctx.rect(lcdX + Math.round(3 * s), phonemeY, lcdW - Math.round(6 * s), phonemeH);
  ctx.clip();
  ctx.font = `700 ${phonemePx}px "JetBrains Mono", monospace`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.shadowColor = tokens.spiritLcdGlow;
  ctx.shadowBlur = Math.round(3 * s);
  ctx.fillStyle = tokens.spiritLcdAmber;
  const textW = ctx.measureText(phonemeText).width;
  const stripW = lcdW - Math.round(6 * s);
  let textX = lcdX + Math.round(6 * s);
  if (textW > stripW) {
    // Scroll: drift horizontally with a slow loop, 2 px/sec at s=1.
    const cycleMs = 4000;
    const drift = ((Date.now() % cycleMs) / cycleMs) * (textW + Math.round(20 * s));
    textX -= drift;
  }
  ctx.fillText(phonemeText, textX, phonemeY + phonemeH / 2);
  ctx.restore();

  // 7. "SPIRIT BOX" silkscreen on the bezel below the LCD.
  const silkPx = Math.max(7, Math.round(8 * s));
  ctx.save();
  ctx.font = `700 ${silkPx}px "Inter", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = tokens.spiritLcdSilkscreen;
  ctx.fillText("SPIRIT BOX", x + bodyW / 2, y + bodyH - Math.round(7 * s));
  ctx.restore();

  ctx.restore();
}

// ─── Ovilus green dot-matrix LCD (left edge, below Spirit Box) ──────────────

/** Ovilus LCD body dimensions (logical px @ s=1). Matches the Spirit Box
 *  proportions so the two stack with consistent rhythm down the left edge. */
const OVILUS_LCD_BODY_W = 152;
const OVILUS_LCD_BODY_H = 70;
/** Number of cells in the entropy bar. 8 reads as a Game Boy-era byte. */
const OVILUS_ENTROPY_CELL_COUNT = 8;

/**
 * 5×7 pixel-font glyph table for the Ovilus dot-matrix LCD. Each row is a
 * bitmask (low bit = leftmost column) so a glyph is 5×7 = 35 dots laid out
 * top-to-bottom. Renderer interprets bit i of row r as "pixel at column i,
 * row r is on". Only A–Z + space are included — Ovilus words from the
 * dictionary are uppercase, and the curated word list never contains
 * punctuation. Unknown chars fall through to a blank glyph.
 */
const DOT_MATRIX_FONT: Record<string, ReadonlyArray<number>> = {
  // Each row: bits 0..4 (leftmost..rightmost), 7 rows top→bottom.
  "A": [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  "B": [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  "C": [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  "D": [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  "E": [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  "F": [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  "G": [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01110],
  "H": [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  "I": [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  "J": [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
  "K": [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  "L": [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  "M": [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  "N": [0b10001, 0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001],
  "O": [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  "P": [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  "Q": [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  "R": [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  "S": [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  "T": [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  "U": [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  "V": [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  "W": [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
  "X": [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  "Y": [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  "Z": [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  " ": [0, 0, 0, 0, 0, 0, 0],
  "-": [0, 0, 0, 0b11111, 0, 0, 0],
  "?": [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0, 0b00100],
};

/**
 * Draw a 5×7 dot-matrix glyph at (x, y) with each "pixel" rendered as a
 * `dotSize × dotSize` square. Both lit and unlit dots are drawn so the
 * dot-matrix grid is fully visible (the Game Boy LCD look — the off pixels
 * are still faintly visible as the dark green grid).
 */
function drawDotMatrixGlyph(
  ctx: CanvasRenderingContext2D,
  glyph: string,
  x: number,
  y: number,
  dotSize: number,
  litColor: string,
  offColor: string,
): void {
  const rows = DOT_MATRIX_FONT[glyph] ?? DOT_MATRIX_FONT[" "];
  for (let r = 0; r < 7; r++) {
    const rowBits = rows[r];
    for (let c = 0; c < 5; c++) {
      // Bit (4 - c) so the high bit (0b10000) is the leftmost column.
      const lit = (rowBits >> (4 - c)) & 1;
      ctx.fillStyle = lit ? litColor : offColor;
      ctx.fillRect(x + c * dotSize, y + r * dotSize, dotSize - 0.5, dotSize - 0.5);
    }
  }
}

/**
 * Skeuomorphic Ovilus green dot-matrix LCD — Game Boy-era pixel display
 * with a dark green-black backplane + bright green pixel text. Shows the
 * word-of-the-moment from the existing useOvilus hook + an 8-bit entropy
 * bar driven by the live magnetometer reading (so the operator can see
 * the dictionary RNG seed pool's state visually).
 *
 * Anatomy (logical px @ s=1, 152 × 70):
 *   ┌─────────────────────────────────────────────┐  ← dark bezel
 *   │  ╔═════════════════════════════════════╗   │
 *   │  ║                                      ║   │
 *   │  ║   ▓▓▓▓ ▓▓▓ ▓▓▓▓ ▓▓ ▓▓                ║   │   5x7 dot-matrix word
 *   │  ║                                      ║   │
 *   │  ║   █▒▒█▒█▒█▒▒                         ║   │   8-bit entropy bar
 *   │  ╚═════════════════════════════════════╝   │
 *   │               OVILUS                        │  ← silkscreen
 *   └─────────────────────────────────────────────┘
 *
 * Honest copy — silkscreen reads "OVILUS" (gear label). The entropy bar is
 * a visualisation of the magnetometer-seeded RNG pool state, not a "ghost
 * speaks" indicator. When the bar is full of lit cells the entropy pool is
 * high (lots of magnetometer variance recently); empty cells = quiet pool.
 */
function drawOvilusLcd(
  ctx: CanvasRenderingContext2D,
  H: number,
  ovilus: ItcChannelView | undefined,
  magnetometer: number | undefined,
  s: number,
  frame: FrameContext,
): void {
  const tokens = getMeterTokens(frame);

  // Geometry — anchored to the left edge, 8 px below the Spirit Box LCD.
  // Spirit Box is at vuBottom + 8 px with height SPIRIT_LCD_BODY_H.
  const bodyW = Math.round(OVILUS_LCD_BODY_W * s);
  const bodyH = Math.round(OVILUS_LCD_BODY_H * s);
  const margin = Math.round(12 * s);
  const x = margin;
  const vuBottom = Math.round(H * 0.30) + Math.round(VU_BODY_H * s);
  const spiritBottom = vuBottom + Math.round(8 * s) + Math.round(SPIRIT_LCD_BODY_H * s);
  const y = spiritBottom + Math.round(8 * s);
  const radius = Math.round(5 * s);

  ctx.save();

  // 1. Drop shadow under the bezel.
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
  ctx.shadowBlur = 6 * s;
  ctx.shadowOffsetY = 3 * s;
  ctx.fillStyle = "rgba(0, 0, 0, 0.01)";
  roundedRectPath(ctx, x, y, bodyW, bodyH, radius);
  ctx.fill();
  ctx.restore();

  // 2. Bezel — dark grey/black gradient.
  const bezelGrad = ctx.createLinearGradient(0, y, 0, y + bodyH);
  bezelGrad.addColorStop(0, "#2a2a2a");
  bezelGrad.addColorStop(0.5, tokens.ovilusLcdBezel);
  bezelGrad.addColorStop(1, "#2a2a2a");
  roundedRectPath(ctx, x, y, bodyW, bodyH, radius);
  ctx.fillStyle = bezelGrad;
  ctx.fill();
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
  roundedRectPath(ctx, x, y, bodyW, bodyH, radius);
  ctx.stroke();

  // 3. Recessed LCD pane — dark green-black backplane.
  const insetX = Math.round(6 * s);
  const insetTopY = Math.round(6 * s);
  const insetBottomMargin = Math.round(13 * s);
  const lcdX = x + insetX;
  const lcdY = y + insetTopY;
  const lcdW = bodyW - insetX * 2;
  const lcdH = bodyH - insetTopY - insetBottomMargin;
  const lcdR = Math.round(3 * s);
  roundedRectPath(ctx, lcdX, lcdY, lcdW, lcdH, lcdR);
  ctx.fillStyle = tokens.ovilusLcdBg;
  ctx.fill();
  ctx.save();
  ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
  ctx.lineWidth = 1;
  roundedRectPath(ctx, lcdX + 0.5, lcdY + 0.5, lcdW - 1, lcdH - 1, lcdR);
  ctx.stroke();
  ctx.restore();

  // 4. Word display — uppercased text from the Ovilus hook, rendered in the
  //    5×7 dot-matrix font. Centre-aligned in the upper 60% of the LCD pane.
  //    Placeholder "????" when there's no fresh emission so the LCD never
  //    reads blank — looks broken otherwise.
  const word = ovilus && ovilus.ageMs <= ITC_MAX_AGE_MS && ovilus.text
    ? ovilus.text.trim().toUpperCase().slice(0, 10)
    : "????";

  // Pick a dot size that fits the longest plausible word across the width.
  // Each glyph is 5 dots wide + 1 dot gap = 6 dots per char. Max 10 chars
  // → 60 dots wide. Available width = lcdW - 2*padding.
  const wordRowPadX = Math.round(6 * s);
  const wordRowAvailW = lcdW - wordRowPadX * 2;
  const dotSizeFromW = Math.floor(wordRowAvailW / (word.length * 6));
  // Word row uses ~60% of LCD height; 7 dot rows + breathing room.
  const wordRowAvailH = Math.round(lcdH * 0.58);
  const dotSizeFromH = Math.floor(wordRowAvailH / 9); // 7 rows + 2 dot pad
  const dotSize = Math.max(1.5, Math.min(dotSizeFromW, dotSizeFromH));
  const glyphW = 5 * dotSize;
  const glyphGap = 1 * dotSize;
  const wordW = word.length * (glyphW + glyphGap) - glyphGap;
  const wordX = lcdX + (lcdW - wordW) / 2;
  const wordY = lcdY + Math.round(4 * s);

  ctx.save();
  // Add a soft glow behind lit dots — fakes LCD backlight diffusion.
  ctx.shadowColor = tokens.ovilusLcdGlow;
  ctx.shadowBlur = Math.round(2.5 * s);
  let gx = wordX;
  for (const ch of word) {
    drawDotMatrixGlyph(ctx, ch, gx, wordY, dotSize, tokens.ovilusLcdGreen, tokens.ovilusLcdOff);
    gx += glyphW + glyphGap;
  }
  ctx.restore();

  // 5. Entropy bar — 8-cell horizontal bar driven by the magnetometer
  //    reading. Maps the magnitude into a 0..8 lit-cell count. Sits in the
  //    lower 30% of the LCD pane. Honest copy — bezel says this is the
  //    RNG pool state, not "spirit speaks".
  //
  //    Mapping: magnetometer in µT, plausible range 25–80 µT (Earth field +
  //    indoor noise). Anything >55 µT lights all 8 cells; <25 µT shows just 1.
  //    Outside that window the cell count clamps to 0..8.
  const mag = typeof magnetometer === "number" && Number.isFinite(magnetometer)
    ? magnetometer
    : 35;  // default to a typical indoor reading so the bar isn't dead
  const magNorm = Math.min(1, Math.max(0, (mag - 25) / 30));
  const litCells = Math.round(magNorm * OVILUS_ENTROPY_CELL_COUNT);

  const barPadX = Math.round(6 * s);
  const barY = lcdY + lcdH - Math.round(11 * s);
  const barH = Math.round(7 * s);
  const barAvailW = lcdW - barPadX * 2;
  const cellGap = Math.round(2 * s);
  const cellW = Math.max(3, Math.floor((barAvailW - cellGap * (OVILUS_ENTROPY_CELL_COUNT - 1)) / OVILUS_ENTROPY_CELL_COUNT));

  ctx.save();
  ctx.shadowColor = tokens.ovilusLcdGlow;
  ctx.shadowBlur = Math.round(2 * s);
  for (let i = 0; i < OVILUS_ENTROPY_CELL_COUNT; i++) {
    const cx = lcdX + barPadX + i * (cellW + cellGap);
    const lit = i < litCells;
    ctx.fillStyle = lit ? tokens.ovilusLcdGreen : tokens.ovilusLcdOff;
    ctx.fillRect(cx, barY, cellW, barH);
  }
  ctx.restore();

  // 6. "OVILUS" silkscreen on the bezel below the LCD.
  const silkPx = Math.max(7, Math.round(8 * s));
  ctx.save();
  ctx.font = `700 ${silkPx}px "Inter", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = tokens.ovilusLcdSilkscreen;
  ctx.fillText("OVILUS", x + bodyW / 2, y + bodyH - Math.round(7 * s));
  ctx.restore();

  ctx.restore();
}

// ─── Status pills (top-left) ────────────────────────────────────────────────

/**
 * REC / LIVE / OFFLINE status pills, mounted in the TOP-LEFT corner.
 *
 * Layout (spec):
 *   each pill ~24px tall, font 13px
 *   red dot for REC, blue dot for LIVE — both 8px diameter
 *   background rgba(0,0,0,0.5)
 *   elapsed time HH:MM:SS appended (recordingStartedAt / liveStartedAt)
 */
function drawStatusPills(
  ctx: CanvasRenderingContext2D,
  // top-left anchored — W/H not needed but kept in the signature so all draw
  // functions share the same shape and can be swapped in/out of the dispatch.
  _W: number,
  _H: number,
  overlay: OverlayState,
  s: number,
): void {
  const showOffline = overlay.recording && overlay.online === false;
  if (!overlay.recording && !overlay.liveStreaming && !showOffline) return;

  // Size constants
  const pillH = Math.round(24 * s);
  const fontSize = Math.round(13 * s);
  const dotR = Math.round(4 * s);       // 8px diameter
  const padX = Math.round(8 * s);
  const dotGap = Math.round(6 * s);
  const rowGap = Math.round(6 * s);
  const margin = Math.round(12 * s);

  ctx.save();
  ctx.font = `700 ${fontSize}px "JetBrains Mono", monospace`;
  ctx.textBaseline = "middle";

  type Pill = { label: string; dot: string; fg: string; elapsedMs?: number };
  const pills: Pill[] = [];
  const now = Date.now();
  if (overlay.recording) {
    pills.push({
      label: "REC",
      dot: "#FF4A4A",
      fg: "#FFE6E6",
      elapsedMs: overlay.recordingStartedAt != null ? now - overlay.recordingStartedAt : undefined,
    });
  }
  if (overlay.liveStreaming) {
    pills.push({
      label: "LIVE",
      dot: "#4FB4FF", // Blue dot per spec (was cyan).
      fg: "#E6F4FF",
      elapsedMs: overlay.liveStartedAt != null ? now - overlay.liveStartedAt : undefined,
    });
  }
  if (showOffline) {
    pills.push({ label: "OFFLINE", dot: "#FFC850", fg: "#FFE6B0" });
  }

  let y = margin;
  const x = margin;
  for (const p of pills) {
    const elapsed = p.elapsedMs != null ? `  ${formatElapsed(p.elapsedMs)}` : "";
    const text = `${p.label}${elapsed}`;
    const textW = ctx.measureText(text).width;
    const pillW = padX + dotR * 2 + dotGap + textW + padX;

    drawSoftBox(ctx, x, y, pillW, pillH, "rgba(0,0,0,0.5)", "rgba(255,255,255,0.14)", 0.6);

    // Dot.
    const dotCX = x + padX + dotR;
    const dotCY = y + pillH / 2;
    ctx.beginPath();
    ctx.arc(dotCX, dotCY, dotR, 0, Math.PI * 2);
    ctx.shadowColor = p.dot;
    ctx.shadowBlur = dotR * 2;
    ctx.fillStyle = p.dot;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Label + elapsed.
    ctx.textAlign = "left";
    ctx.fillStyle = p.fg;
    ctx.fillText(text, dotCX + dotR + dotGap, dotCY);

    y += pillH + rowGap;
  }
  ctx.restore();
}

// ─── Case ID (bottom-left) ──────────────────────────────────────────────────

/**
 * Case ID + date readout — bottom-left corner.
 *
 * Format (spec): `CASE 0A7B1C · 2026-05-22` — the case slug paired with the
 * UTC calendar date in one block so a video editor can match a recorded clip
 * to an investigation record without cross-referencing the bottom-right
 * timestamp. The date comes from the shared `BroadcastClockSnapshot` so it
 * can't drift relative to the timestamp pill drawn alongside.
 *
 * Layout (spec):
 *   font 12px
 *   background rgba(0,0,0,0.4) rounded box, padding 4×8px
 *   caseId truncated to last 8 chars when longer than 8
 *   sits to the LEFT of the timestamp (which is bottom-right) so they don't collide
 */
function drawCaseId(
  ctx: CanvasRenderingContext2D,
  // bottom-left anchored — width isn't needed for positioning, but kept in
  // the signature so all draw functions share the same shape.
  _W: number,
  H: number,
  overlay: OverlayState,
  clock: BroadcastClockSnapshot,
  s: number,
): void {
  const caseId = overlay.caseId;
  // No case → render "NO CASE" so the operator immediately sees the chain
  // hasn't been initialised. Still small, still corner-mounted.
  const caseText = caseId
    ? `CASE ${(caseId.length > 8 ? caseId.slice(-8) : caseId).toUpperCase()}`
    : "NO CASE";
  // Append the UTC calendar date — production editors at YEP-style outfits
  // need to match clips to investigation records by date, not just by ID.
  // U+00B7 (middle dot) is the canonical separator on broadcast slates.
  const text = `${caseText} · ${clock.utcDateText}`;

  // Size constants
  const fontSize = Math.round(12 * s);
  const padX = Math.round(8 * s);
  const padY = Math.round(4 * s);
  const boxH = fontSize + padY * 2;
  const margin = Math.round(12 * s);

  ctx.save();
  ctx.font = `600 ${fontSize}px "JetBrains Mono", monospace`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const textW = ctx.measureText(text).width;
  const boxW = textW + padX * 2;
  const x = margin;
  const y = H - margin - boxH;

  drawSoftBox(ctx, x, y, boxW, boxH, "rgba(0,0,0,0.4)", "rgba(255,255,255,0.16)", 0.5);

  ctx.fillStyle = "#fff";
  ctx.fillText(text, x + padX, y + boxH / 2);
  ctx.restore();
}

// ─── Timestamp (bottom-right) ───────────────────────────────────────────────

/**
 * Forensic timestamp — bottom-right corner. ISO 8601 with a frame counter
 * suffix (HH:MM:SS:FF) for editing-room frame-accurate referencing.
 *
 * Layout (spec):
 *   font 15px
 *   background rgba(0,0,0,0.45) rounded box, padding 6×10px
 *   sits to the RIGHT of the case ID so the two never collide
 */
function drawTimestamp(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  _overlay: OverlayState,
  clock: BroadcastClockSnapshot,
  s: number,
): void {
  // Size constants
  const fontSize = Math.round(15 * s);
  const padX = Math.round(10 * s);
  const padY = Math.round(6 * s);
  const boxH = fontSize + padY * 2;
  const margin = Math.round(12 * s);

  // Build the SMPTE-style HH:MM:SS:FF stamp off the SHARED clock snapshot.
  // The HH:MM:SS comes straight from `clock.utcText` (UTC-anchored to match
  // the forensic chain), and we append a 30fps frame counter computed from
  // the same sub-second remainder — that frame counter never escapes the
  // snapshot's numeric `utc` field so the timestamp pill can't drift from
  // the case-ID's date for the same frame.
  const now = clock.utc;
  const ff = String(Math.min(29, Math.floor((now % 1000) / (1000 / 30)))).padStart(2, "0");
  const text = `${clock.utcText}:${ff}`;

  ctx.save();
  ctx.font = `600 ${fontSize}px "JetBrains Mono", monospace`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  const textW = ctx.measureText(text).width;
  const boxW = textW + padX * 2;
  const x = W - margin - boxW;
  const y = H - margin - boxH;

  drawSoftBox(ctx, x, y, boxW, boxH, "rgba(0,0,0,0.45)", "rgba(255,255,255,0.18)", 0.55);

  ctx.fillStyle = "#fff";
  ctx.fillText(text, x + boxW - padX, y + boxH / 2);
  ctx.restore();
}

// ─── Caption (bottom-center) ────────────────────────────────────────────────

/**
 * AI narrator caption — bottom-center, ABOVE the timestamp/case-id row.
 *
 * Layout (spec):
 *   max width 80% of frame width
 *   font 17px white, with drop shadow for legibility
 *   background rgba(0,0,0,0.65), padding 8×14px
 *   positioned ~60px above the bottom margin so it never collides with the
 *   bottom-right timestamp or bottom-left case ID
 */
function drawCaption(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  caption: string,
  s: number,
): void {
  // Size constants
  const fontSize = Math.round(17 * s);
  const padX = Math.round(14 * s);
  const padY = Math.round(8 * s);
  const lineHeight = Math.round(fontSize * 1.3);
  const margin = Math.round(12 * s);
  const bottomReserved = Math.round(48 * s); // space for the case-id/timestamp row
  const maxWidth = Math.round(W * 0.8);

  ctx.save();
  ctx.font = `500 ${fontSize}px Inter, sans-serif`;
  const lines = wrapText(ctx, caption, maxWidth - padX * 2);
  const boxH = lines.length * lineHeight + padY * 2;
  // Self-size width to the widest line so the caption hugs the text.
  let widestLine = 0;
  for (const line of lines) widestLine = Math.max(widestLine, ctx.measureText(line).width);
  const boxW = Math.min(maxWidth, widestLine + padX * 2);
  const x = Math.round((W - boxW) / 2);
  const y = H - margin - bottomReserved - boxH;

  drawSoftBox(ctx, x, y, boxW, boxH, "rgba(0,0,0,0.65)", "rgba(255,255,255,0.12)", 0.4);

  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.shadowColor = "rgba(0,0,0,0.85)";
  ctx.shadowBlur = Math.round(3 * s);
  ctx.shadowOffsetY = 1;
  let cy = y + padY + lineHeight / 2;
  for (const line of lines) {
    ctx.fillText(line, x + boxW / 2, cy);
    cy += lineHeight;
  }
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.restore();
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  // Cap at 2 lines — keeps the caption tight at the bottom.
  if (lines.length > 2) {
    return [lines[0], lines.slice(1).join(" ")];
  }
  return lines;
}

// ─── Night-vision filter ────────────────────────────────────────────────────

/**
 * Night-vision filter — applied BEFORE overlays are drawn over the camera
 * frame. Boosts the green channel and applies a dark-scene contrast lift so
 * under-lit footage looks like classic IR/NV footage. Not real infrared —
 * it's a colour-grade applied to the existing pixels.
 *
 * Performance: getImageData/putImageData is the expensive path. At 1920×1080
 * this touches ~8M values per frame. On modern mobile (V8 JIT, typed arrays)
 * it runs in ~4–8ms — within a 33ms budget. At 720p it's ~2–3ms.
 */
function applyNightVision(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
): void {
  const imageData = ctx.getImageData(0, 0, W, H);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const luma = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    const boosted = Math.min(255, luma * 2.1 + 12);
    d[i]     = Math.round(boosted * 0.06); // R — near zero
    d[i + 1] = Math.round(boosted);         // G — full signal
    d[i + 2] = Math.round(boosted * 0.06); // B — near zero
  }
  ctx.putImageData(imageData, 0, 0);
}

// ─── Faux-IR "full-spectrum" wash + badge ───────────────────────────────────

/**
 * Translucent magenta/violet rectangle painted over the (already filtered)
 * camera frame. Completes the IR-modified-DSLR look — a real full-spectrum
 * conversion shifts neutral whites toward pink/magenta in the highlights.
 * Uses `globalCompositeOperation = "overlay"` so the wash multiplies into
 * mid-tones without crushing pure black or pure white. Drawn before any
 * overlay text/widgets so the chrome sits on top of the tinted feed.
 *
 * Honest framing: this is a video tint, not real IR sensitivity. Phone
 * cameras have a hardware IR-cut filter we cannot remove in software. The
 * `drawFullSpectrumBadge` call downstream burns "FAUX-IR PROCESSING" into
 * the frame so the recording itself proves the effect is a filter.
 */
function applyFullSpectrumTint(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
): void {
  ctx.save();
  ctx.globalCompositeOperation = "overlay";
  ctx.fillStyle = "rgba(186, 120, 220, 0.18)";
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

/**
 * Burns a small "FAUX-IR PROCESSING" pill into the top-right of the frame
 * (just below the EVP block) so the recorded / streamed output proves the
 * false-colour effect is a filter, not a real IR sensor. Honest copy is a
 * hard constraint per Phase B brief — operators must not be able to pass
 * off this filter as "real infrared" footage.
 */
function drawFullSpectrumBadge(
  ctx: CanvasRenderingContext2D,
  _W: number,
  _H: number,
  s: number,
  frame: FrameContext,
): void {
  const tokens = getMeterTokens(frame);
  const labelText = "FAUX-IR PROCESSING";
  const pillH = Math.round(20 * s);
  const fontSize = Math.max(9, Math.round(10 * s));
  const padX = Math.round(10 * s);
  const margin = Math.round(12 * s);

  ctx.save();
  ctx.font = `700 ${fontSize}px "Inter", system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const w = Math.round(ctx.measureText(labelText).width + padX * 2);
  // Top-left — tucked under the REC/LIVE pills which centre on top; the
  // badge sits at the same y-band so it reads as a status row, not as
  // chrome that overlaps the camera subject.
  const x = margin;
  const y = margin + Math.round(36 * s); // 36 px below top so STATUS PILLS stay clear
  drawPill(ctx, x, y, w, pillH, tokens.fullspecBadgeBg, tokens.fullspecBadgeRim);
  ctx.fillStyle = tokens.fullspecBadgeText;
  ctx.fillText(labelText, x + w / 2, y + pillH / 2);
  ctx.restore();
}

// ─── Corner brackets ────────────────────────────────────────────────────────

/**
 * Camera-viewfinder corner brackets — four L-shaped tick marks in the
 * band colour. Drawn over the edge glow so they always read against the
 * background image.
 */
function drawCornerBrackets(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  band: { fill: string; glow: string },
) {
  const arm = Math.round(Math.min(W, H) * 0.045);
  const mg  = Math.round(Math.min(W, H) * 0.020);
  const lw  = Math.max(2, Math.round(Math.min(W, H) * 0.0024));

  ctx.save();
  ctx.strokeStyle = band.fill;
  ctx.lineWidth   = lw;
  ctx.shadowColor = band.glow;
  ctx.shadowBlur  = 7;
  ctx.globalAlpha = 0.55;
  ctx.lineCap     = "square";

  const corners: [number, number, 1 | -1, 1 | -1][] = [
    [mg,        mg,        1,  1],
    [W - mg,    mg,       -1,  1],
    [mg,        H - mg,    1, -1],
    [W - mg,    H - mg,   -1, -1],
  ];

  for (const [cx, cy, dx, dy] of corners) {
    ctx.beginPath();
    ctx.moveTo(cx + dx * arm, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + dy * arm);
    ctx.stroke();
  }

  ctx.restore();
}

// ─── Direction arrow ────────────────────────────────────────────────────────

function drawDirectionArrow(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  sector: string,
  coherence: number,
  band: { fill: string; glow: string; stroke: string },
) {
  const angleDeg = SECTOR_DEG[sector];
  if (angleDeg == null) return;
  const cx = W / 2;
  const cy = H / 2;
  const orbitR = Math.min(W, H) * 0.30;
  const angleRad = (angleDeg - 90) * Math.PI / 180;
  const ax = cx + orbitR * Math.cos(angleRad);
  const ay = cy + orbitR * Math.sin(angleRad);

  ctx.save();
  ctx.strokeStyle = band.fill;
  ctx.lineWidth   = 1;
  ctx.globalAlpha = 0.14;
  ctx.setLineDash([4, 10]);
  ctx.beginPath();
  ctx.arc(cx, cy, orbitR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  ctx.save();
  ctx.translate(ax, ay);
  ctx.rotate(angleRad + Math.PI / 2);

  const arrowH = Math.min(W, H) * 0.055;
  const arrowW = arrowH * 0.6;
  ctx.shadowColor = band.glow;
  ctx.shadowBlur = arrowH * 0.5;
  ctx.fillStyle = band.fill;
  ctx.globalAlpha = 0.55 + coherence * 0.35;

  ctx.beginPath();
  ctx.moveTo(0, -arrowH * 0.5);
  ctx.lineTo(arrowW * 0.5, arrowH * 0.1);
  ctx.lineTo(arrowW * 0.18, arrowH * 0.05);
  ctx.lineTo(arrowW * 0.18, arrowH * 0.5);
  ctx.lineTo(-arrowW * 0.18, arrowH * 0.5);
  ctx.lineTo(-arrowW * 0.18, arrowH * 0.05);
  ctx.lineTo(-arrowW * 0.5, arrowH * 0.1);
  ctx.closePath();
  ctx.fill();

  ctx.rotate(-(angleRad + Math.PI / 2));
  ctx.shadowBlur = 0;
  ctx.font = `700 ${Math.max(10, H * 0.012)}px "JetBrains Mono", monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  const labelText = sector.replace("-", " ");
  const labW = ctx.measureText(labelText).width + 12;
  const labH = Math.max(16, H * 0.020);
  const labY = arrowH * 0.7;
  drawPill(ctx, -labW / 2, labY, labW, labH, "rgba(0,0,0,0.65)", band.stroke);
  ctx.fillStyle = "#fff";
  ctx.fillText(labelText, 0, labY + labH / 2);

  ctx.restore();
}
