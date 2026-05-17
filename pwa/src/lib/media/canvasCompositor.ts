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

export const DEFAULT_OVERLAY_CHANNELS: OverlayChannels = {
  activityPill: true,
  posteriorPill: true,
  edgeGlow: true,
  sensors: true,
  itc: true,
  directionArrow: true,
  caption: true,
  timestamp: true,
  statusPills: true,
  cornerBrackets: true,
  kiiMeter: false,
  remPod: false,
  nightVision: false,
  audioMeter: false,
};

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
 */
interface FrameContext {
  W: number;
  H: number;
  s: number;
  edgeGlow: { key: string; grad: CanvasGradient } | null;
  audioBar: { key: string; grad: CanvasGradient } | null;
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
  const frame: FrameContext = { W: 0, H: 0, s: 1, edgeGlow: null, audioBar: null };

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
      // now wrong. Drop them so the next frame rebuilds.
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

  // 4. Right-edge vertical instrument stack — K-II on top, REM Pod below.
  if (channels.kiiMeter) {
    drawKiiMeter(ctx, W, H, overlay.activityBand, overlay.emfZScore, s);
  }
  if (channels.remPod) {
    drawRemPod(ctx, W, H, overlay.activityBand, overlay.emfZScore, s);
  }

  // 5. Audio meter — left edge, vertical bar.
  if (channels.audioMeter) {
    drawAudioMeter(ctx, W, H, overlay.audioRms, s, frame);
  }

  // 6. Direction arrow (only if sector + coherence are valid).
  if (channels.directionArrow && overlay.sector && overlay.coherence >= 0.5) {
    drawDirectionArrow(ctx, W, H, overlay.sector, overlay.coherence, band);
  }

  // 7. Bottom caption strip (AI co-investigator) — above timestamp row.
  if (channels.caption && overlay.caption) {
    drawCaption(ctx, W, H, overlay.caption, s);
  }

  // 8. Case ID — bottom-left.
  if (channels.timestamp) {
    drawCaseId(ctx, W, H, overlay, s);
  }

  // 9. Timestamp — bottom-right (forensic mandatory). Drawn last so nothing
  //    can occlude the chain-of-custody data.
  if (channels.timestamp) {
    drawTimestamp(ctx, W, H, overlay, s);
  }
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

/**
 * Virtual K-II EMF Meter — five-LED stack mounted on the RIGHT EDGE.
 *
 * Layout (spec):
 *   width  ~40px
 *   height ~120px (5 LEDs × ~18px stride + label + padding)
 *   "K-II" label (10px) above the LEDs
 *   background rgba(0,0,0,0.35) rounded box
 *   LED colour ramp: green → green → yellow → orange → red (1=bottom, 5=top)
 *   Lit count driven by emfZScore (primary) or activityBand (fallback)
 */
function drawKiiMeter(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  band: OverlayState["activityBand"],
  emfZScore: number | undefined,
  s: number,
): void {
  const litCount = (typeof emfZScore === "number" && Number.isFinite(emfZScore))
    ? zScoreToLeds(Math.abs(emfZScore), KII_Z_TABLE)
    : (KII_LIT[band] ?? 1);

  // Size constants
  const widgetW = Math.round(40 * s);
  const widgetH = Math.round(120 * s);
  const labelFontPx = Math.round(10 * s);
  const margin = Math.round(12 * s);
  const padY = Math.round(6 * s);
  // Anchored under the data column (sensor block); offset 30% from top to
  // keep both K-II and REM Pod visible while staying clear of the data block.
  const x = W - margin - widgetW;
  const y = Math.round(H * 0.30);

  drawSoftBox(ctx, x, y, widgetW, widgetH, "rgba(0,0,0,0.35)", "rgba(255,255,255,0.18)", 0.5);

  ctx.save();
  // Label
  ctx.font = `700 ${labelFontPx}px "JetBrains Mono", monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(255,255,255,0.78)";
  ctx.fillText("K-II", x + widgetW / 2, y + padY);

  // LEDs — stacked vertically. Bottom LED = LED index 0 (green); top = 4 (red).
  const labelArea = padY + labelFontPx + Math.round(4 * s);
  const ledArea = widgetH - labelArea - padY;
  const ledStride = ledArea / 5;
  const ledR = Math.min(ledStride * 0.35, widgetW * 0.30);
  const LED_COLORS = ["#33EE55", "#33EE55", "#FFDD00", "#FF8800", "#FF2222"] as const;

  for (let i = 0; i < 5; i++) {
    const lit = i < litCount;
    const col = LED_COLORS[i];
    // Stack bottom-up: i=0 is the bottom-most LED.
    const cy = y + labelArea + ledArea - ledStride * (i + 0.5);
    const cx = x + widgetW / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, ledR, 0, Math.PI * 2);
    if (lit) {
      ctx.shadowColor = col;
      ctx.shadowBlur = ledR * 2.2;
      ctx.fillStyle = col;
    } else {
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(25,25,25,0.85)";
    }
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = lit ? col : "rgba(70,70,70,0.6)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();
}

/** Maps activityBand → number of REM pod LEDs lit (0–6). Fallback when no z-score. */
const REM_LIT_BY_BAND: Record<OverlayState["activityBand"], number> = {
  calm: 0, light: 1, possible: 2, notable: 4, strong: 6,
};

/**
 * Virtual REM Pod — six-LED stack mounted on the RIGHT EDGE, BELOW K-II.
 * Same form factor as the K-II so the right edge reads as a unified
 * instrument strip. Distinct cyan/orange theme (vs K-II's green/red) so
 * the operator can pick them apart at a glance.
 *
 * Layout (spec):
 *   width  ~40px
 *   height ~120px
 *   "REM" label (10px) above the LEDs
 *   background rgba(0,0,0,0.35) rounded box
 *   LED colour ramp: cyan(low) → orange(high)
 */
function drawRemPod(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  activityBand: OverlayState["activityBand"],
  emfZScore: number | undefined,
  s: number,
): void {
  const hasZ = typeof emfZScore === "number" && Number.isFinite(emfZScore);
  const zAbs = hasZ ? Math.abs(emfZScore as number) : 0;
  const litLeds = hasZ ? zScoreToLeds(zAbs, REM_Z_TABLE) : (REM_LIT_BY_BAND[activityBand] ?? 0);

  // Size constants — match K-II so the two stacks visually pair.
  const widgetW = Math.round(40 * s);
  const widgetH = Math.round(120 * s);
  const labelFontPx = Math.round(10 * s);
  const margin = Math.round(12 * s);
  const padY = Math.round(6 * s);
  // Sit directly below the K-II meter (which lives at H*0.30) with an 8px gap.
  const kiiBottom = Math.round(H * 0.30) + widgetH;
  const x = W - margin - widgetW;
  const y = kiiBottom + Math.round(8 * s);

  drawSoftBox(ctx, x, y, widgetW, widgetH, "rgba(0,0,0,0.35)", "rgba(255,165,80,0.22)", 0.5);

  ctx.save();
  ctx.font = `700 ${labelFontPx}px "JetBrains Mono", monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(255,200,140,0.85)";
  ctx.fillText("REM", x + widgetW / 2, y + padY);

  const labelArea = padY + labelFontPx + Math.round(4 * s);
  const ledArea = widgetH - labelArea - padY;
  const ledStride = ledArea / 6;
  const ledR = Math.min(ledStride * 0.35, widgetW * 0.30);
  // Cyan-to-orange ramp — distinct from K-II's green-to-red.
  const REM_COLORS = ["#5DF2C7", "#5DF2C7", "#7FCFE8", "#FFC850", "#FFA040", "#FF7028"] as const;

  for (let i = 0; i < 6; i++) {
    const lit = i < litLeds;
    const col = REM_COLORS[i];
    const cy = y + labelArea + ledArea - ledStride * (i + 0.5);
    const cx = x + widgetW / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, ledR, 0, Math.PI * 2);
    if (lit) {
      ctx.shadowColor = col;
      ctx.shadowBlur = ledR * 2.2;
      ctx.fillStyle = col;
    } else {
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(25,25,25,0.85)";
    }
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = lit ? col : "rgba(70,70,70,0.6)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();
}

// ─── Audio meter (left edge, vertical) ──────────────────────────────────────

/**
 * Audio level meter — slim vertical bar mounted on the LEFT EDGE.
 *
 * Layout (spec):
 *   width  ~12px (bar) + frame
 *   height ~140px
 *   Vertical gradient: green at bottom, yellow at 70%, red at peak
 *   Background rgba(0,0,0,0.4) rounded box
 *   Numeric dB indicator below the bar (small, optional read)
 */
function drawAudioMeter(
  ctx: CanvasRenderingContext2D,
  _W: number,
  H: number,
  audioRms: number,
  s: number,
  frame: FrameContext,
): void {
  // Size constants
  const barW = Math.round(12 * s);
  const barH = Math.round(140 * s);
  const frameW = barW + Math.round(14 * s);
  const dbFontPx = Math.round(9 * s);
  const labelGap = Math.round(4 * s);
  const frameH = barH + Math.round(12 * s) + dbFontPx + labelGap;
  const margin = Math.round(12 * s);
  // Align with the right-edge instrument stack so both bracket the camera frame.
  const x = margin;
  const y = Math.round(H * 0.30);

  drawSoftBox(ctx, x, y, frameW, frameH, "rgba(0,0,0,0.4)", "rgba(255,255,255,0.18)", 0.5);

  // Clamp + power-curve compression (log-ish feel without the cost of log).
  const level = Math.min(1, Math.max(0, audioRms));
  const visualLevel = Math.pow(level, 0.55);

  // Bar geometry — centred horizontally in the frame box.
  const barX = x + Math.round((frameW - barW) / 2);
  const barY = y + Math.round(6 * s);

  // Bar background slot.
  ctx.save();
  ctx.fillStyle = "rgba(20,20,20,0.85)";
  ctx.beginPath();
  const r = barW / 2;
  ctx.moveTo(barX + r, barY);
  ctx.arcTo(barX + barW, barY, barX + barW, barY + r, r);
  ctx.lineTo(barX + barW, barY + barH - r);
  ctx.arcTo(barX + barW, barY + barH, barX + barW - r, barY + barH, r);
  ctx.lineTo(barX + r, barY + barH);
  ctx.arcTo(barX, barY + barH, barX, barY + barH - r, r);
  ctx.lineTo(barX, barY + r);
  ctx.arcTo(barX, barY, barX + r, barY, r);
  ctx.closePath();
  ctx.fill();

  // Fill (clipped to slot shape). Gradient depends only on bar geometry, so
  // we cache it on the compositor's FrameContext and reuse across frames.
  ctx.clip();
  if (visualLevel > 0) {
    const fillH = barH * visualLevel;
    const fillTop = barY + barH - fillH;
    const key = `${barY}|${barH}`;
    let entry = frame.audioBar;
    if (!entry || entry.key !== key) {
      const grad = ctx.createLinearGradient(0, barY + barH, 0, barY);
      grad.addColorStop(0,    "#33EE55");
      grad.addColorStop(0.6,  "#9FE83A");
      grad.addColorStop(0.75, "#FFDD00");
      grad.addColorStop(0.88, "#FF8800");
      grad.addColorStop(1,    "#FF2222");
      entry = { key, grad };
      frame.audioBar = entry;
    }
    ctx.fillStyle = entry.grad;
    ctx.fillRect(barX, fillTop, barW, fillH);
  }
  ctx.restore();

  // Threshold ticks at 70% / 85%.
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.lineWidth = 1;
  for (const frac of [0.7, 0.85]) {
    const ty = barY + barH - barH * frac;
    ctx.beginPath();
    ctx.moveTo(barX - 1, ty);
    ctx.lineTo(barX + barW + 1, ty);
    ctx.stroke();
  }
  ctx.restore();

  // Numeric dB readout — convert RMS to dBFS-ish (20·log10), clamp to -60.
  const dbValue = level > 0.001 ? 20 * Math.log10(level) : -60;
  const dbLabel = `${dbValue >= 0 ? "+" : ""}${dbValue.toFixed(0)} dB`;
  ctx.save();
  ctx.font = `600 ${dbFontPx}px "JetBrains Mono", monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(255,255,255,0.78)";
  ctx.fillText(dbLabel, x + frameW / 2, barY + barH + labelGap);
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
 * Case ID readout — bottom-left corner.
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
  s: number,
): void {
  const caseId = overlay.caseId;
  // No case → render "NO CASE" so the operator immediately sees the chain
  // hasn't been initialised. Still small, still corner-mounted.
  const text = caseId
    ? `CASE ${(caseId.length > 8 ? caseId.slice(-8) : caseId).toUpperCase()}`
    : "NO CASE";

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
  overlay: OverlayState,
  s: number,
): void {
  // Size constants
  const fontSize = Math.round(15 * s);
  const padX = Math.round(10 * s);
  const padY = Math.round(6 * s);
  const boxH = fontSize + padY * 2;
  const margin = Math.round(12 * s);

  // Prefer the numeric stamp when supplied — avoids the per-frame Date round-
  // trip (parse ISO → reserialise → substring) the previous revision did. Falls
  // back to parsing isoTimestamp for back-compat with callers that only supply
  // the string form.
  let now = overlay.nowMs;
  if (now === undefined || !Number.isFinite(now)) {
    const parsed = Date.parse(overlay.isoTimestamp);
    now = Number.isNaN(parsed) ? 0 : parsed;
  }
  // ISO 8601 HH:MM:SS plus a 30fps frame counter (FF) — SMPTE non-drop time-
  // code convention that editors expect on burn-in. UTC-anchored to match the
  // forensic chain.
  const totalSec = Math.floor(now / 1000);
  const hh = String(Math.floor(totalSec / 3600) % 24).padStart(2, "0");
  const mm = String(Math.floor(totalSec / 60) % 60).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  const ff = String(Math.min(29, Math.floor((now % 1000) / (1000 / 30)))).padStart(2, "0");
  const text = `${hh}:${mm}:${ss}:${ff}`;

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
