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
  audioBar: { key: string; grad: CanvasGradient } | null;
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
    edgeGlow: null, audioBar: null,
    meterTokens: null, kiiSmooth: null, remPulse: null,
    vuNeedleSmooth: null,
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
      frame.audioBar = null;
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
  ctx.drawImage(video, 0, 0, W, H);

  // 1b. Night-vision filter — applied immediately after the camera frame and
  //     before any overlay is drawn, so the NV colour-grade sits under all
  //     text/widgets. getImageData + putImageData are the expensive path but
  //     run within budget at 30fps on modern mobile GPUs.
  if (channels.nightVision) {
    applyNightVision(ctx, W, H);
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

  // 3c. ITC readout — top-right corner, max 2 lines.
  if (channels.itc) {
    drawItcReadout(ctx, W, H, overlay, band, s);
  }

  // 3d. Sensor mini-readout — tucked under the ITC block in the top-right
  //     column so the data column stays unified on one edge.
  if (channels.sensors) {
    drawSensorReadout(ctx, W, H, overlay, band, s);
  }

  // 4. Right-edge vertical instrument stack — skeuomorphic gear meters.
  //    K-II EMF (yellow handheld) on top, REM Pod (black tower) below.
  //    Top anchor is shared so the two meters always line up; each meter
  //    function owns its own height + 8 px gap to the next.
  const meterTopY = Math.round(H * 0.30);
  if (channels.kiiMeter) {
    drawKiiMeter(ctx, W, overlay.activityBand, overlay.emfZScore, s, meterTopY, frame);
  }
  if (channels.remPod) {
    drawRemPod(ctx, W, overlay.activityBand, overlay.emfZScore, s, meterTopY, frame);
  }

  // 5. VU audio meter — left edge, vintage analog look.
  if (channels.audioMeter) {
    drawVuMeter(ctx, W, H, overlay.audioRms, s, frame);
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

// ─── Sensor readout ─────────────────────────────────────────────────────────

/**
 * Sensor readout — small column of LIGHT / MAG / MOTION / TEMP values
 * stacked under the ITC readout on the right edge. Bumps down to clear the
 * ITC block when present.
 *
 * Sizes (spec): row height ~18px, value font 12px, label font 9px, width ~150px.
 */
function drawSensorReadout(
  ctx: CanvasRenderingContext2D,
  W: number,
  _H: number,
  overlay: OverlayState,
  band: { stroke: string },
  s: number,
): void {
  const sensors = overlay.sensors;
  if (!sensors) return;

  type Row = { label: string; value: string; unit: string };
  const rows: Row[] = [];
  if (typeof sensors.light === "number" && Number.isFinite(sensors.light)) {
    rows.push({ label: "LIGHT", value: Math.round(sensors.light).toString(), unit: "lux" });
  }
  if (typeof sensors.magnetometer === "number" && Number.isFinite(sensors.magnetometer)) {
    rows.push({ label: "MAG", value: sensors.magnetometer.toFixed(1), unit: "µT" });
  }
  if (typeof sensors.motion === "number" && Number.isFinite(sensors.motion)) {
    rows.push({ label: "MOTION", value: sensors.motion.toFixed(2), unit: "m/s²" });
  }
  if (typeof sensors.temperature === "number" && Number.isFinite(sensors.temperature)) {
    rows.push({ label: "TEMP", value: sensors.temperature.toFixed(1), unit: "°C" });
  }
  if (rows.length === 0) return;

  // Size constants
  const labelFontPx = Math.round(9 * s);
  const valueFontPx = Math.round(12 * s);
  const rowH = Math.round(16 * s);
  const padX = Math.round(8 * s);
  const padY = Math.round(6 * s);
  const colGap = Math.round(6 * s);
  const margin = Math.round(12 * s);

  ctx.save();

  const measureLabel = (str: string) => {
    ctx.font = `700 ${labelFontPx}px "Space Grotesk", Inter, sans-serif`;
    return ctx.measureText(str).width;
  };
  const measureValue = (str: string) => {
    ctx.font = `700 ${valueFontPx}px "JetBrains Mono", monospace`;
    return ctx.measureText(str).width;
  };
  const measureUnit = (str: string) => {
    ctx.font = `500 ${labelFontPx}px "Space Grotesk", Inter, sans-serif`;
    return ctx.measureText(str).width;
  };

  let maxLabelW = 0, maxValueW = 0, maxUnitW = 0;
  for (const r of rows) {
    maxLabelW = Math.max(maxLabelW, measureLabel(r.label));
    maxValueW = Math.max(maxValueW, measureValue(r.value));
    maxUnitW = Math.max(maxUnitW, measureUnit(r.unit));
  }

  const blockW = padX * 2 + maxLabelW + colGap + maxValueW + colGap + maxUnitW;
  const blockH = padY * 2 + rows.length * rowH;
  // Right-side column, anchored below the ITC area.
  const itcReserved = Math.round(itcReservedHeight(s));
  const blockX = W - margin - blockW;
  const blockY = margin + itcReserved;

  drawSoftBox(ctx, blockX, blockY, blockW, blockH, "rgba(0,0,0,0.4)", band.stroke, 0.5);

  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  let y = blockY + padY + rowH / 2;
  for (const r of rows) {
    ctx.font = `700 ${labelFontPx}px "Space Grotesk", Inter, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.62)";
    ctx.fillText(r.label, blockX + padX, y);

    const valX = blockX + padX + maxLabelW + colGap;
    ctx.font = `700 ${valueFontPx}px "JetBrains Mono", monospace`;
    ctx.fillStyle = "#fff";
    ctx.fillText(r.value, valX, y);

    const unitX = valX + maxValueW + colGap;
    ctx.font = `500 ${labelFontPx}px "Space Grotesk", Inter, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText(r.unit, unitX, y);

    y += rowH;
  }
  ctx.restore();
}

/**
 * Approximate vertical space reserved for the ITC block at the top-right so
 * the sensor stack can sit immediately below it. Returns 0 when ITC is hidden;
 * the actual ITC draw call decides whether to render and uses identical numbers.
 */
function itcReservedHeight(s: number): number {
  // Max block height = padY*2 + rowH * 2 (2 lines max) + outer margin gap.
  const padY = Math.round(7 * s);
  const rowH = Math.round(20 * s);
  return padY * 2 + rowH * 2 + Math.round(8 * s);
}

// ─── ITC readout (top-right) ────────────────────────────────────────────────

/**
 * ITC channels readout. Max 2 lines tall and ~180px wide, mounted in the
 * top-right corner. Each visible channel collapses to "LABEL · text · age"
 * on its own line; if more than 2 channels are fresh we keep the two newest.
 *
 * Sizes (spec): font 14-15px bold, age font 10px dim, width <=180px,
 * padding 6×10px, background rgba(0,0,0,0.55).
 */
function drawItcReadout(
  ctx: CanvasRenderingContext2D,
  W: number,
  _H: number,
  overlay: OverlayState,
  band: { stroke: string; fill: string; glow: string },
  s: number,
): void {
  const itc = overlay.itc;
  if (!itc) return;

  type Row = { label: string; text: string; age: string; ageMs: number };
  const rows: Row[] = [];
  const pushIfFresh = (label: string, view: ItcChannelView | undefined, maxAge: number) => {
    if (!view) return;
    if (view.ageMs > maxAge) return;
    rows.push({ label, text: truncateForOverlay(view.text), age: formatAge(view.ageMs), ageMs: view.ageMs });
  };
  pushIfFresh("SB",  itc.spiritBox, ITC_MAX_AGE_MS);
  pushIfFresh("OV",  itc.ovilus,    ITC_MAX_AGE_MS);
  pushIfFresh("EVP", itc.evp,       ITC_EVP_MAX_AGE_MS);
  if (rows.length === 0) return;

  // Keep the freshest two so the block stays max 2 lines.
  rows.sort((a, b) => a.ageMs - b.ageMs);
  const visible = rows.slice(0, 2);

  // Size constants
  const labelFontPx = Math.round(10 * s);
  const textFontPx = Math.round(14 * s);
  const ageFontPx = Math.round(10 * s);
  const padX = Math.round(10 * s);
  const padY = Math.round(7 * s);
  const rowH = Math.round(20 * s);
  const labelGap = Math.round(6 * s);
  const ageGap = Math.round(6 * s);
  const margin = Math.round(12 * s);
  const maxBlockW = Math.round(180 * s);

  ctx.save();

  // Measure each row to determine the actual width (capped at maxBlockW).
  const measureText = (str: string) => {
    ctx.font = `700 ${textFontPx}px "JetBrains Mono", monospace`;
    return ctx.measureText(str).width;
  };

  let widest = 0;
  for (const r of visible) {
    ctx.font = `700 ${labelFontPx}px "Space Grotesk", Inter, sans-serif`;
    const lw = ctx.measureText(r.label).width;
    const tw = measureText(r.text);
    ctx.font = `500 ${ageFontPx}px "Space Grotesk", Inter, sans-serif`;
    const aw = ctx.measureText(r.age).width;
    const w = padX * 2 + lw + labelGap + tw + ageGap + aw;
    if (w > widest) widest = w;
  }
  const blockW = Math.min(maxBlockW, widest);
  const blockH = padY * 2 + visible.length * rowH;
  const blockX = W - margin - blockW;
  const blockY = margin;

  drawSoftBox(ctx, blockX, blockY, blockW, blockH, "rgba(0,0,0,0.55)", band.stroke, 0.6);

  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  let y = blockY + padY + rowH / 2;
  for (const r of visible) {
    // Label tag.
    ctx.font = `700 ${labelFontPx}px "Space Grotesk", Inter, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.62)";
    ctx.fillText(r.label, blockX + padX, y);
    const labelW = ctx.measureText(r.label).width;

    // Right-anchor age so the text in the middle can flex.
    ctx.font = `500 ${ageFontPx}px "Space Grotesk", Inter, sans-serif`;
    const ageW = ctx.measureText(r.age).width;
    const ageX = blockX + blockW - padX - ageW;
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText(r.age, ageX, y);

    // Emission text — clipped to the remaining width.
    const textX = blockX + padX + labelW + labelGap;
    const textMaxW = ageX - ageGap - textX;
    const clippedText = truncateToWidth(ctx, r.text, textMaxW, `700 ${textFontPx}px "JetBrains Mono", monospace`);
    ctx.font = `700 ${textFontPx}px "JetBrains Mono", monospace`;
    ctx.shadowColor = band.glow;
    ctx.shadowBlur = Math.round(textFontPx * 0.45);
    ctx.fillStyle = band.fill;
    ctx.fillText(clippedText, textX, y);
    ctx.shadowBlur = 0;

    y += rowH;
  }
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
