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
 * Use:
 *   const compositor = createCanvasCompositor({ video, getOverlay, fps: 30 });
 *   compositor.start();
 *   const stream = compositor.captureStream();   // composited stream
 *   ...
 *   compositor.stop();
 */

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
  isoTimestamp: string;
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

/** Internal helper — fall back to all-on if the caller didn't supply channels. */
function resolveChannels(overlay: OverlayState): OverlayChannels {
  return overlay.channels ?? DEFAULT_OVERLAY_CHANNELS;
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

const BAND_COLOR: Record<OverlayState["activityBand"], { stroke: string; glow: string; fill: string }> = {
  calm:     { stroke: "rgba(93, 242, 199, 0.55)",  glow: "rgba(93, 242, 199, 0.35)",  fill: "#5DF2C7" },
  light:    { stroke: "rgba(127, 252, 215, 0.70)", glow: "rgba(127, 252, 215, 0.45)", fill: "#7FFCD7" },
  possible: { stroke: "rgba(242, 185, 93, 0.85)",  glow: "rgba(242, 185, 93, 0.50)",  fill: "#F2B95D" },
  notable:  { stroke: "rgba(255, 122, 122, 0.95)", glow: "rgba(255, 122, 122, 0.60)", fill: "#FF7A7A" },
  strong:   { stroke: "rgba(255, 90, 90, 1.0)",    glow: "rgba(255, 90, 90, 0.75)",   fill: "#FF4A4A" },
};

export function createCanvasCompositor(opts: CanvasCompositorOptions): CanvasCompositor {
  const { video, getOverlay, fps = 30 } = opts;
  const canvas = document.createElement("canvas");

  let raf = 0;
  let running = false;
  let lastFrameTs = 0;
  const frameInterval = 1000 / fps;

  const sizeCanvas = () => {
    const w = opts.width ?? (video.videoWidth || 1280);
    const h = opts.height ?? (video.videoHeight || 720);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  };

  const draw = (now: number) => {
    if (!running) return;
    if (now - lastFrameTs >= frameInterval) {
      lastFrameTs = now;
      sizeCanvas();
      const ctx = canvas.getContext("2d");
      // Guard: drawImage on readyState < HAVE_CURRENT_DATA throws
      // InvalidStateError on Safari/iOS, which would escape this closure
      // and kill the RAF loop permanently. Skip the frame instead.
      if (ctx && video.readyState >= 2) renderFrame(ctx, canvas, video, getOverlay());
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
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  overlay: OverlayState,
): void {
  const W = canvas.width;
  const H = canvas.height;
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

  // 2. Edge glow tied to posterior + audio RMS.
  if (channels.edgeGlow) {
    const edgeAlpha = Math.min(1, 0.18 + overlay.posterior * 0.5 + overlay.audioRms * 0.6);
    const grad = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.7);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(1, band.glow.replace(/[\d.]+\)$/, `${edgeAlpha})`));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  // 2b. Corner viewfinder brackets — broadcast framing cue drawn over
  // the edge glow so they always read against the background image.
  if (channels.cornerBrackets !== false) {
    drawCornerBrackets(ctx, W, H, band);
  }

  // 3. Top HUD strip (Activity + Posterior pills). Each pill is gated
  // individually inside drawTopHud so the operator can hide one without
  // the other.
  drawTopHud(ctx, W, H, overlay, band, channels);

  // 3b. Sensor mini-readout under the Activity pill (top-left).
  // Y-offset depends on whether the Activity pill is drawn; pass the
  // current top occupancy so the readout doesn't collide.
  const topPillBottom = channels.activityPill ? sensorReadoutTopOffset(W, H) : Math.round(W * 0.018);
  let leftStackY = topPillBottom;
  if (channels.sensors) {
    leftStackY = drawSensorReadout(ctx, W, H, overlay, band, leftStackY);
  }

  // 3c. ITC channels readout (Spirit Box / Ovilus / EVP) — stacks below
  // the sensor block on the same left column.
  if (channels.itc) {
    drawItcReadout(ctx, W, H, overlay, band, leftStackY);
  }

  // 3d. Virtual instrument widgets — K-II EMF meter (bottom-left) and
  //     REM pod (bottom-right). Positioned to sit above the caption/timestamp
  //     zone and well clear of the sensor/ITC stack.
  if (channels.kiiMeter) {
    drawKiiMeter(ctx, W, H, overlay.activityBand, overlay.emfZScore);
  }
  if (channels.remPod) {
    drawRemPod(ctx, W, H, overlay.activityBand, band, overlay.emfZScore);
  }

  // 4. Direction arrow (only if sector + coherence are valid).
  if (channels.directionArrow && overlay.sector && overlay.coherence >= 0.5) {
    drawDirectionArrow(ctx, W, H, overlay.sector, overlay.coherence, band);
  }

  // 5. Bottom caption strip (AI co-investigator).
  if (channels.caption && overlay.caption) {
    drawCaption(ctx, W, H, overlay.caption, band);
  }

  // 6. Bottom-right metadata block: timestamp + case ID.
  if (channels.timestamp) {
    drawMetadataStamp(ctx, W, H, overlay);
  }

  // 7. Recording / live indicators.
  if (channels.statusPills) {
    drawStatusPills(ctx, W, H, overlay);
  }

  // 8. Audio level meter — drawn beneath the status pills row so the
  //    REC/LIVE indicators and the mic-level bar feel like a unified
  //    broadcast status bar.
  if (channels.audioMeter) {
    drawAudioMeter(ctx, W, H, overlay.audioRms);
  }
}

/** Pixel-Y where the sensor block should start (matches drawTopHud math). */
function sensorReadoutTopOffset(W: number, H: number): number {
  const padding = Math.round(W * 0.018);
  const pillH = Math.max(36, Math.round(H * 0.05));
  return padding + pillH + 8;
}

function drawTopHud(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  overlay: OverlayState,
  band: { fill: string; stroke: string },
  channels: OverlayChannels,
) {
  const padding = Math.round(W * 0.018);
  const pillH = Math.max(36, Math.round(H * 0.05));
  const fontSize = Math.max(14, Math.round(H * 0.02));

  ctx.save();
  ctx.font = `700 ${fontSize}px "Space Grotesk", Inter, sans-serif`;
  ctx.textBaseline = "middle";

  // Activity label pill (left)
  if (channels.activityPill) {
    const label = overlay.activityLabel.toUpperCase();
    const lblWidth = ctx.measureText(label).width + padding * 2;
    drawPill(ctx, padding, padding, lblWidth, pillH, "rgba(0,0,0,0.55)", band.stroke);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, padding + padding, padding + pillH / 2);
  }

  // Posterior pill (right)
  if (channels.posteriorPill) {
    const pPct = `P ${(overlay.posterior * 100).toFixed(0)}%`;
    const pWidth = ctx.measureText(pPct).width + padding * 2;
    drawPill(ctx, W - padding - pWidth, padding, pWidth, pillH, "rgba(0,0,0,0.55)", band.stroke);
    ctx.fillStyle = band.fill;
    ctx.fillText(pPct, W - padding - pWidth + padding, padding + pillH / 2);
  }

  ctx.restore();
}

/**
 * Draws the sensor readout block. Returns the Y coordinate immediately
 * below the rendered block so subsequent blocks (ITC channels) can stack
 * vertically on the same left column. Returns the input `blockY` if no
 * rows render (e.g. all sensor values are stale/undefined).
 */
function drawSensorReadout(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  overlay: OverlayState,
  band: { stroke: string; fill: string },
  blockY: number,
): number {
  const sensors = overlay.sensors;
  if (!sensors) return blockY;

  // Build the row list — only entries with finite numeric values.
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
  if (rows.length === 0) return blockY;

  // Geometry — left column matches drawTopHud's padding so the block
  // sits cleanly below the Activity pill (or wherever the caller stacked us).
  const padding = Math.round(W * 0.018);
  const blockX = padding;

  const labelFontPx = Math.max(9, Math.round(H * 0.012));
  const valueFontPx = Math.max(14, Math.round(H * 0.019));
  const unitFontPx = Math.max(10, Math.round(H * 0.013));
  const rowH = Math.max(valueFontPx + 6, Math.round(H * 0.032));
  const innerPadX = Math.round(padding * 0.9);
  const innerPadY = Math.round(padding * 0.5);
  const labelGap = Math.round(padding * 0.45);
  const unitGap = Math.round(padding * 0.25);
  const letterSpacingPx = 1.4;

  ctx.save();

  // Measure widths for each row to size the block.
  const measureLabel = (s: string) => {
    ctx.font = `700 ${labelFontPx}px "Space Grotesk", Inter, sans-serif`;
    // letter-spacing adds (n - 1) * spacing across n characters.
    return ctx.measureText(s).width + Math.max(0, s.length - 1) * letterSpacingPx;
  };
  const measureValue = (s: string) => {
    ctx.font = `700 ${valueFontPx}px "JetBrains Mono", monospace`;
    return ctx.measureText(s).width;
  };
  const measureUnit = (s: string) => {
    ctx.font = `500 ${unitFontPx}px "Space Grotesk", Inter, sans-serif`;
    return ctx.measureText(s).width;
  };

  let maxLabelW = 0;
  let maxValueW = 0;
  let maxUnitW = 0;
  for (const r of rows) {
    maxLabelW = Math.max(maxLabelW, measureLabel(r.label));
    maxValueW = Math.max(maxValueW, measureValue(r.value));
    maxUnitW = Math.max(maxUnitW, measureUnit(r.unit));
  }
  const blockW = innerPadX * 2 + maxLabelW + labelGap + maxValueW + unitGap + maxUnitW;
  const blockH = innerPadY * 2 + rows.length * rowH;

  // Background pill — match Activity pill style.
  drawPill(ctx, blockX, blockY, blockW, blockH, "rgba(0,0,0,0.55)", band.stroke);

  // Render each row.
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  let y = blockY + innerPadY + rowH / 2;
  for (const r of rows) {
    // Label: small mono-style caps with letter-spacing — drawn char-by-char
    // since canvas has no native letter-spacing in 2D context.
    ctx.font = `700 ${labelFontPx}px "Space Grotesk", Inter, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.62)";
    let lx = blockX + innerPadX;
    for (let i = 0; i < r.label.length; i++) {
      const ch = r.label[i];
      ctx.fillText(ch, lx, y);
      lx += ctx.measureText(ch).width + (i < r.label.length - 1 ? letterSpacingPx : 0);
    }

    // Value: bold mono.
    const valX = blockX + innerPadX + maxLabelW + labelGap;
    ctx.font = `700 ${valueFontPx}px "JetBrains Mono", monospace`;
    ctx.fillStyle = "#fff";
    ctx.fillText(r.value, valX, y);

    // Unit: muted small.
    const unitX = valX + maxValueW + unitGap;
    ctx.font = `500 ${unitFontPx}px "Space Grotesk", Inter, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText(r.unit, unitX, y);

    y += rowH;
  }

  ctx.restore();
  return blockY + blockH + 8;
}

/**
 * ITC channels readout (Spirit Box / Ovilus / EVP). Stacks below the
 * sensor block on the left column. Each channel is age-faded: when its
 * emission gets stale enough (`ITC_MAX_AGE_MS`, longer for EVP) the row
 * drops out entirely so the operator isn't staring at a phantom from 30
 * minutes ago.
 *
 * Visual treatment differs from the sensor readout deliberately:
 *   • Sensors are NUMBERS that update continuously — the operator scans
 *     the column for the next value.
 *   • ITC channels are WORDS that fire occasionally — readability of the
 *     word itself matters more than aligned columns, so the word stretches
 *     across the row and the age stamp tucks in beside it.
 */
function drawItcReadout(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  overlay: OverlayState,
  band: { stroke: string; fill: string },
  blockY: number,
): number {
  const itc = overlay.itc;
  if (!itc) return blockY;

  type Row = { label: string; text: string; age: string };
  const rows: Row[] = [];
  const pushIfFresh = (label: string, view: ItcChannelView | undefined, maxAge: number) => {
    if (!view) return;
    if (view.ageMs > maxAge) return;
    rows.push({ label, text: truncateForOverlay(view.text), age: formatAge(view.ageMs) });
  };
  pushIfFresh("SPIRIT BOX", itc.spiritBox, ITC_MAX_AGE_MS);
  pushIfFresh("OVILUS", itc.ovilus, ITC_MAX_AGE_MS);
  pushIfFresh("EVP", itc.evp, ITC_EVP_MAX_AGE_MS);
  if (rows.length === 0) return blockY;

  const padding = Math.round(W * 0.018);
  const blockX = padding;

  const labelFontPx = Math.max(9, Math.round(H * 0.012));
  const textFontPx = Math.max(15, Math.round(H * 0.022));
  const ageFontPx = Math.max(10, Math.round(H * 0.013));
  const rowH = Math.max(textFontPx + 14, Math.round(H * 0.05));
  const innerPadX = Math.round(padding * 0.9);
  const innerPadY = Math.round(padding * 0.6);
  const labelGap = Math.round(padding * 0.6);
  const ageGap = Math.round(padding * 0.6);
  const letterSpacingPx = 1.4;

  ctx.save();

  // Measure widths so the block self-sizes to its widest row.
  const measureLabel = (s: string) => {
    ctx.font = `700 ${labelFontPx}px "Space Grotesk", Inter, sans-serif`;
    return ctx.measureText(s).width + Math.max(0, s.length - 1) * letterSpacingPx;
  };
  const measureText = (s: string) => {
    ctx.font = `700 ${textFontPx}px "JetBrains Mono", monospace`;
    return ctx.measureText(s).width;
  };
  const measureAge = (s: string) => {
    ctx.font = `500 ${ageFontPx}px "Space Grotesk", Inter, sans-serif`;
    return ctx.measureText(s).width;
  };

  let maxLabelW = 0;
  let maxTextW = 0;
  let maxAgeW = 0;
  for (const r of rows) {
    maxLabelW = Math.max(maxLabelW, measureLabel(r.label));
    maxTextW = Math.max(maxTextW, measureText(r.text));
    maxAgeW = Math.max(maxAgeW, measureAge(r.age));
  }
  const blockW = innerPadX * 2 + maxLabelW + labelGap + maxTextW + ageGap + maxAgeW;
  const blockH = innerPadY * 2 + rows.length * rowH;

  drawPill(ctx, blockX, blockY, blockW, blockH, "rgba(0,0,0,0.55)", band.stroke);

  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  let y = blockY + innerPadY + rowH / 2;
  for (const r of rows) {
    // Label column — small caps with letter-spacing.
    ctx.font = `700 ${labelFontPx}px "Space Grotesk", Inter, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.62)";
    let lx = blockX + innerPadX;
    for (let i = 0; i < r.label.length; i++) {
      const ch = r.label[i];
      ctx.fillText(ch, lx, y);
      lx += ctx.measureText(ch).width + (i < r.label.length - 1 ? letterSpacingPx : 0);
    }

    // Emission text — bold mono, band-tinted + glow so the word pops.
    const textX = blockX + innerPadX + maxLabelW + labelGap;
    ctx.font = `700 ${textFontPx}px "JetBrains Mono", monospace`;
    ctx.shadowColor = band.glow;
    ctx.shadowBlur  = Math.round(textFontPx * 0.55);
    ctx.fillStyle   = band.fill;
    ctx.fillText(r.text, textX, y);
    ctx.shadowBlur  = 0;

    // Age stamp — muted small.
    const ageX = textX + maxTextW + ageGap;
    ctx.font = `500 ${ageFontPx}px "Space Grotesk", Inter, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText(r.age, ageX, y);

    y += rowH;
  }

  ctx.restore();
  return blockY + blockH + 8;
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
  if (t.length <= 32) return t;
  return t.slice(0, 31) + "…";
}

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

  // Build the rounded-rect path ONCE. Canvas retains the current path across
  // fill()/stroke() calls — only beginPath() clears it. Calling all four
  // passes from the same path avoids 3x redundant path reconstruction at 30fps.
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

  // Pass 1 — flat fill + outer glow (shadowBlur expands outward).
  ctx.shadowColor = stroke;
  ctx.shadowBlur = 12;
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.shadowBlur = 0;

  // Pass 2 — depth gradient overlay (top-highlight → bottom-darken).
  const depth = ctx.createLinearGradient(x, y, x, y + h);
  depth.addColorStop(0, "rgba(255,255,255,0.07)");
  depth.addColorStop(0.45, "rgba(0,0,0,0)");
  depth.addColorStop(1, "rgba(0,0,0,0.14)");
  ctx.fillStyle = depth;
  ctx.fill();

  // Pass 3 — inner top-edge shimmer (glass reflection).
  const shimmer = ctx.createLinearGradient(x, y, x, y + h * 0.38);
  shimmer.addColorStop(0, "rgba(255,255,255,0.18)");
  shimmer.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = shimmer;
  ctx.fill();

  // Pass 4 — colored border (2 px for crispness on high-DPI output).
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.restore();
}

// ─── Virtual instrument widgets ───────────────────────────────────────────────

/** Maps activityBand → number of K-II LEDs lit (1–5). Fallback when no z-score. */
const KII_LIT: Record<OverlayState["activityBand"], number> = {
  calm: 1, light: 2, possible: 3, notable: 4, strong: 5,
};

/**
 * Maps raw EMF z-score to LED count via a thresholds table. Used by both the
 * K-II (1–5 LEDs) and REM Pod (0–6 LEDs) virtual instruments. The first
 * matching `[minZ, leds]` pair from highest-z down is used; the floor (the
 * last entry, used when nothing matches) becomes the resting state.
 *
 * Thresholds align with statistical significance bands so the same z=2.5
 * (≈2σ) means "anomaly" everywhere in the app.
 */
function zScoreToLeds(z: number, table: ReadonlyArray<readonly [number, number]>): number {
  for (let i = 0; i < table.length - 1; i++) {
    if (z >= table[i][0]) return table[i][1];
  }
  return table[table.length - 1][1];
}

/**
 * Format an elapsed duration in milliseconds as broadcast-style `MM:SS` or
 * `H:MM:SS` once it crosses an hour. Used by the REC / LIVE status pills so
 * the burnt-in timer matches what editors expect on professional cameras.
 */
function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h  = Math.floor(totalSec / 3600);
  const m  = Math.floor((totalSec % 3600) / 60);
  const s  = totalSec % 60;
  const pad2 = (n: number) => n < 10 ? `0${n}` : `${n}`;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
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
 * Virtual K-II EMF Meter — the five-LED bar that paranormal investigators
 * carry. Rendered bottom-left.
 *
 * Primary input:  `emfZScore` — raw magnetometer z-score when available.
 *                 Reacts instantly to EMF spikes without Bayesian smoothing lag.
 * Fallback input: `activityBand` — used when no z-score is present
 *                 (e.g. compass-only iOS or Pi data).
 *
 * LED colour map (left → right): G G Y O R — exactly the physical device.
 */
function drawKiiMeter(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  band: OverlayState["activityBand"],
  emfZScore?: number,
): void {
  const litCount = (typeof emfZScore === "number" && Number.isFinite(emfZScore))
    ? zScoreToLeds(Math.abs(emfZScore), KII_Z_TABLE)
    : (KII_LIT[band] ?? 1);
  const pad        = Math.round(W * 0.018);
  const ledR       = Math.max(7,  Math.round(H * 0.011));
  const ledGap     = ledR * 2.7;
  const labelFontPx = Math.max(9, Math.round(H * 0.013));
  const innerPadX  = Math.round(pad * 0.9);
  const innerPadY  = Math.round(pad * 0.55);
  // "K·II" label occupies ~4.5 chars of the monospaced font
  const labelW     = Math.round(labelFontPx * 4.5);
  const widgetW    = innerPadX * 2 + labelW + Math.round(pad * 0.6) + 5 * ledGap;
  const widgetH    = innerPadY * 2 + ledR * 3;
  const x          = pad;
  // Sit 25% up from the bottom — above caption/timestamp but well below the
  // sensor stack which stops at roughly 30% from the top.
  const y          = H - Math.round(H * 0.25) - widgetH;

  drawPill(ctx, x, y, widgetW, widgetH, "rgba(0,0,0,0.72)", "rgba(200,200,200,0.22)");

  ctx.save();
  ctx.textBaseline = "middle";
  ctx.textAlign    = "left";
  ctx.font         = `700 ${labelFontPx}px "JetBrains Mono", monospace`;
  ctx.fillStyle    = "rgba(255,255,255,0.78)";
  ctx.fillText("K·II", x + innerPadX, y + widgetH / 2);

  const LED_COLORS = ["#33EE55", "#33EE55", "#FFDD00", "#FF8800", "#FF2222"] as const;
  const ledsStartX = x + innerPadX + labelW + Math.round(pad * 0.6) + ledR;
  const ledCY      = y + widgetH / 2;

  for (let i = 0; i < 5; i++) {
    const cx   = ledsStartX + i * ledGap;
    const lit  = i < litCount;
    const col  = LED_COLORS[i];
    ctx.beginPath();
    ctx.arc(cx, ledCY, ledR, 0, Math.PI * 2);
    if (lit) {
      ctx.shadowColor = col;
      ctx.shadowBlur  = ledR * 2.5;
      ctx.fillStyle   = col;
    } else {
      ctx.shadowBlur  = 0;
      ctx.fillStyle   = "rgba(25,25,25,0.9)";
    }
    ctx.fill();
    ctx.strokeStyle = lit ? col : "rgba(70,70,70,0.6)";
    ctx.lineWidth   = 1.4;
    ctx.stroke();
    ctx.shadowBlur  = 0;
  }
  ctx.restore();
}

/** Maps activityBand → number of REM pod LEDs lit (0–6). Fallback when no z-score. */
const REM_LIT_BY_BAND: Record<OverlayState["activityBand"], number> = {
  calm: 0, light: 1, possible: 2, notable: 4, strong: 6,
};
/** Activity-band-driven ring pulse intensity. Used when no z-score is available. */
const REM_INTENSITY_BY_BAND: Record<Exclude<OverlayState["activityBand"], "calm">, number> = {
  light: 0.45, possible: 0.65, notable: 0.85, strong: 1.0,
};

/**
 * Virtual REM Pod — the oval EM-detection device with antenna and ring LEDs.
 * The physical REM pod lights up when its radiated EM field is disturbed.
 *
 * Primary input:  `emfZScore` — raw magnetometer z-score. Reacts instantly
 *                 to EMF spikes; intensity ramps with z-score magnitude.
 * Fallback input: `activityBand` — used when no z-score is present
 *                 (e.g. compass-only iOS).
 */
function drawRemPod(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  activityBand: OverlayState["activityBand"],
  band: { fill: string; glow: string; stroke: string },
  emfZScore?: number,
): void {
  const hasZ = typeof emfZScore === "number" && Number.isFinite(emfZScore);
  const zAbs = hasZ ? Math.abs(emfZScore as number) : 0;
  // Active when z-score (if supplied) signals deviation OR activity band escalated.
  const active  = hasZ ? zAbs >= 1.0 : activityBand !== "calm";
  const litLeds = hasZ ? zScoreToLeds(zAbs, REM_Z_TABLE) : (REM_LIT_BY_BAND[activityBand] ?? 0);
  const pad     = Math.round(W * 0.018);
  const podRX   = Math.max(28, Math.round(Math.min(W, H) * 0.042));
  const podRY   = Math.round(podRX * 0.72);
  const cx      = W - pad * 2 - podRX;
  const cy      = H - Math.round(H * 0.27);
  const now     = Date.now();

  ctx.save();

  // Pulsing rings radiate outward from the pod body when active. With z-score
  // the intensity ramps continuously with the spike magnitude; without it we
  // bucket via activityBand.
  if (active) {
    const intensity = hasZ
      ? Math.min(1, zAbs / 5.0)
      : (activityBand === "calm" ? 0.45 : (REM_INTENSITY_BY_BAND[activityBand] ?? 0.45));
    for (let i = 0; i < 3; i++) {
      const phase  = ((now / 1100) + i / 3) % 1;
      const ringRX = podRX * (1 + phase * 2.2);
      const ringRY = podRY * (1 + phase * 2.2);
      const alpha  = intensity * (1 - phase) * 0.55;
      ctx.beginPath();
      ctx.ellipse(cx, cy, ringRX, ringRY, 0, 0, Math.PI * 2);
      ctx.strokeStyle = band.glow.replace(/[\d.]+\)$/, `${alpha})`);
      ctx.lineWidth   = Math.max(1, podRX * 0.06);
      ctx.stroke();
    }
  }

  // Oval body.
  ctx.beginPath();
  ctx.ellipse(cx, cy, podRX, podRY, 0, 0, Math.PI * 2);
  const bodyGrad = ctx.createRadialGradient(cx, cy - podRY * 0.25, podRX * 0.1, cx, cy, podRX);
  bodyGrad.addColorStop(0, active ? "rgba(38,38,38,0.92)" : "rgba(26,26,26,0.88)");
  bodyGrad.addColorStop(1, "rgba(10,10,10,0.95)");
  ctx.fillStyle   = bodyGrad;
  ctx.shadowColor = active ? band.glow : "rgba(0,0,0,0.5)";
  ctx.shadowBlur  = active ? podRX * 0.9 : 4;
  ctx.fill();
  ctx.shadowBlur  = 0;
  ctx.strokeStyle = active ? band.stroke : "rgba(75,75,75,0.55)";
  ctx.lineWidth   = Math.max(1.5, podRX * 0.04);
  ctx.stroke();

  // Antenna — vertical spike above body.
  ctx.strokeStyle  = active ? band.fill : "rgba(110,110,110,0.7)";
  ctx.lineWidth    = Math.max(1.5, podRX * 0.04);
  ctx.beginPath();
  ctx.moveTo(cx, cy - podRY);
  ctx.lineTo(cx, cy - podRY - podRX * 1.1);
  ctx.stroke();
  // Antenna tip dot.
  ctx.fillStyle   = active ? band.fill : "rgba(110,110,110,0.7)";
  ctx.shadowColor = active ? band.glow : "transparent";
  ctx.shadowBlur  = active ? 6 : 0;
  ctx.beginPath();
  ctx.arc(cx, cy - podRY - podRX * 1.1, Math.max(2.5, podRX * 0.07), 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  // Six perimeter LEDs — light up as activity escalates.
  const ledR   = Math.max(2.5, podRX * 0.09);
  const numLeds = 6;
  for (let i = 0; i < numLeds; i++) {
    const angle = (i / numLeds) * Math.PI * 2 - Math.PI / 2;
    const lx    = cx + podRX * 0.84 * Math.cos(angle);
    const ly    = cy + podRY * 0.84 * Math.sin(angle);
    const lit   = i < litLeds;
    ctx.beginPath();
    ctx.arc(lx, ly, ledR, 0, Math.PI * 2);
    ctx.fillStyle   = lit ? band.fill : "rgba(28,28,28,0.9)";
    ctx.shadowColor = lit ? band.glow : "transparent";
    ctx.shadowBlur  = lit ? ledR * 2.5 : 0;
    ctx.fill();
    ctx.shadowBlur  = 0;
  }

  // "REM" label inside the oval.
  const fontSize = Math.max(9, Math.round(podRX * 0.32));
  ctx.font          = `700 ${fontSize}px "JetBrains Mono", monospace`;
  ctx.textAlign     = "center";
  ctx.textBaseline  = "middle";
  ctx.fillStyle     = active ? band.fill : "rgba(160,160,160,0.85)";
  ctx.shadowColor   = active ? band.glow : "transparent";
  ctx.shadowBlur    = active ? fontSize * 0.6 : 0;
  ctx.fillText("REM", cx, cy + podRY * 0.15);
  ctx.shadowBlur    = 0;

  ctx.restore();
}

/**
 * Night-vision filter — applied BEFORE overlays are drawn over the camera
 * frame. Boosts the green channel and applies a dark-scene contrast lift so
 * under-lit footage looks like classic IR/NV footage. Not real infrared —
 * it's a colour-grade applied to the existing pixels.
 *
 * Algorithm:
 *   1. Extract pixel data from the already-drawn camera frame.
 *   2. For each pixel: R *= 0.05, G = clamp(luma * 2.2), B *= 0.05.
 *   3. Put pixels back. Result: monochrome green on the dark regions,
 *      bright green on reflective surfaces — the classic NV look.
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
    // Lift shadows slightly, then map to green channel only.
    const boosted = Math.min(255, luma * 2.1 + 12);
    d[i]     = Math.round(boosted * 0.06); // R — near zero
    d[i + 1] = Math.round(boosted);         // G — full signal
    d[i + 2] = Math.round(boosted * 0.06); // B — near zero
    // Alpha (d[i+3]) unchanged.
  }
  ctx.putImageData(imageData, 0, 0);
}

/**
 * Camera-viewfinder corner brackets — four L-shaped tick marks in the
 * band colour. Classic broadcast / camera-finder framing cue. Drawn
 * last so they read over every other overlay element.
 */
function drawCornerBrackets(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  band: { fill: string; glow: string },
) {
  const arm = Math.round(Math.min(W, H) * 0.055);
  const mg  = Math.round(Math.min(W, H) * 0.022);
  const lw  = Math.max(2, Math.round(Math.min(W, H) * 0.0028));

  ctx.save();
  ctx.strokeStyle = band.fill;
  ctx.lineWidth   = lw;
  ctx.shadowColor = band.glow;
  ctx.shadowBlur  = 9;
  ctx.globalAlpha = 0.72;
  ctx.lineCap     = "square";

  // [corner-x, corner-y, x-direction, y-direction]
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
  const orbitR = Math.min(W, H) * 0.32;
  const angleRad = (angleDeg - 90) * Math.PI / 180;
  const ax = cx + orbitR * Math.cos(angleRad);
  const ay = cy + orbitR * Math.sin(angleRad);

  // Faint dashed orbit ring — gives the arrow a sense of tracking.
  ctx.save();
  ctx.strokeStyle = band.fill;
  ctx.lineWidth   = 1;
  ctx.globalAlpha = 0.17;
  ctx.setLineDash([4, 10]);
  ctx.beginPath();
  ctx.arc(cx, cy, orbitR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  ctx.save();
  ctx.translate(ax, ay);
  ctx.rotate(angleRad + Math.PI / 2);

  const arrowH = Math.min(W, H) * 0.07;
  const arrowW = arrowH * 0.6;
  ctx.shadowColor = band.glow;
  ctx.shadowBlur = arrowH * 0.6;
  ctx.fillStyle = band.fill;
  ctx.globalAlpha = 0.6 + coherence * 0.4;

  // Arrow shape pointing "up" (= outward).
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

  // Counter-rotated label
  ctx.rotate(-(angleRad + Math.PI / 2));
  ctx.shadowBlur = 0;
  ctx.font = `700 ${Math.max(11, H * 0.014)}px "JetBrains Mono", monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  const labelText = sector.replace("-", " ");
  const labW = ctx.measureText(labelText).width + 12;
  const labH = Math.max(18, H * 0.022);
  // Position label below the arrow tip, in the orbital direction.
  const labX = orbitR < Math.min(W, H) * 0.4 ? 0 : 0;
  const labY = arrowH * 0.7;
  drawPill(ctx, labX - labW / 2, labY, labW, labH, "rgba(0,0,0,0.7)", band.stroke);
  ctx.fillStyle = "#fff";
  ctx.fillText(labelText, labX, labY + labH / 2);

  ctx.restore();
}

function drawCaption(ctx: CanvasRenderingContext2D, W: number, H: number, caption: string, band: { stroke: string; fill: string }) {
  const pad = Math.round(W * 0.018);
  const fontSize = Math.max(13, Math.round(H * 0.02));
  ctx.save();
  ctx.font = `500 ${fontSize}px Inter, sans-serif`;
  ctx.textBaseline = "middle";

  // Wrap text to fit width.
  const maxWidth = W - pad * 4;
  const lines = wrapText(ctx, caption, maxWidth);
  const lineH = fontSize * 1.35;
  const boxH = lines.length * lineH + pad * 1.4;
  const boxY = H - pad - boxH;

  drawPill(ctx, pad, boxY, W - pad * 2, boxH, "rgba(0,0,0,0.55)", band.stroke);

  // Cyan dot on the left of the box.
  const dotR = fontSize * 0.45;
  ctx.fillStyle = band.fill;
  ctx.shadowColor = band.fill;
  ctx.shadowBlur = dotR * 2;
  ctx.beginPath();
  ctx.arc(pad + pad, boxY + boxH / 2, dotR, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  // Lines.
  ctx.fillStyle = "#fff";
  let y = boxY + pad * 0.85 + lineH / 2;
  for (const line of lines) {
    ctx.fillText(line, pad + pad * 2 + dotR * 2, y);
    y += lineH;
  }
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
  // Cap at 3 lines.
  if (lines.length > 3) {
    return [...lines.slice(0, 2), lines.slice(2).join(" ")];
  }
  return lines;
}

function drawMetadataStamp(ctx: CanvasRenderingContext2D, W: number, H: number, overlay: OverlayState) {
  // Bottom-right block: ISO timestamp + case.
  // Stack: [HH:MM:SS UTC]
  //        [YYYY-MM-DD]
  //        [CASE 1234ABCD]
  const pad = Math.round(W * 0.018);
  const fontSize = Math.max(11, Math.round(H * 0.014));
  const lineH = fontSize * 1.35;

  const date = new Date(overlay.isoTimestamp);
  const tHHMM = date.toISOString().substring(11, 19) + " UTC";
  const tYYYY = date.toISOString().substring(0, 10);
  const caseShort = overlay.caseId ? `CASE ${overlay.caseId.slice(0, 8).toUpperCase()}` : "NO CASE";

  const lines = [tHHMM, tYYYY, caseShort];
  const boxW = Math.max(...lines.map((l) => measureMono(ctx, l, fontSize))) + pad * 1.6;
  const boxH = lines.length * lineH + pad * 1.2;
  const boxX = W - pad - boxW;
  const boxY = H - pad - boxH - (overlay.caption ? Math.round(H * 0.12) : 0);

  drawPill(ctx, boxX, boxY, boxW, boxH, "rgba(0,0,0,0.65)", "rgba(255,255,255,0.18)");

  ctx.save();
  ctx.font = `600 ${fontSize}px "JetBrains Mono", monospace`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  let y = boxY + pad * 0.7 + lineH / 2;
  for (const line of lines) {
    ctx.fillText(line, boxX + boxW - pad * 0.8, y);
    y += lineH;
  }
  ctx.restore();
}

function measureMono(ctx: CanvasRenderingContext2D, text: string, fontSize: number): number {
  ctx.save();
  ctx.font = `600 ${fontSize}px "JetBrains Mono", monospace`;
  const w = ctx.measureText(text).width;
  ctx.restore();
  return w;
}

function drawStatusPills(ctx: CanvasRenderingContext2D, W: number, H: number, overlay: OverlayState) {
  // Center-top status pills: REC + LIVE + OFFLINE (only when relevant).
  // OFFLINE only shows when recording locally — there's no point telling
  // viewers a defunct LIVE pill is offline (LIVE can't be active without
  // connectivity), but a local recording proves provenance "captured offline".
  const showOffline = overlay.recording && overlay.online === false;
  if (!overlay.recording && !overlay.liveStreaming) return;
  const pad = Math.round(W * 0.018);
  const pillH = Math.max(28, Math.round(H * 0.038));
  const fontSize = Math.max(11, Math.round(H * 0.016));
  const gap = 8;
  ctx.save();
  ctx.font = `700 ${fontSize}px "JetBrains Mono", monospace`;
  ctx.textBaseline = "middle";

  const now = Date.now();
  // Build the pill list first so we can centre the whole row.
  const pills: Array<{ text: string; bg: string; border: string; fg: string }> = [];
  if (overlay.recording) {
    const dur = overlay.recordingStartedAt ? ` ${formatElapsed(now - overlay.recordingStartedAt)}` : "";
    pills.push({ text: `● REC${dur}`, bg: "rgba(50,0,0,0.85)", border: "rgba(255,90,90,0.95)", fg: "#FF4A4A" });
  }
  if (overlay.liveStreaming) {
    const dur = overlay.liveStartedAt ? ` ${formatElapsed(now - overlay.liveStartedAt)}` : "";
    pills.push({ text: `◉ LIVE${dur}`, bg: "rgba(0,30,40,0.85)", border: "rgba(127,252,215,0.95)", fg: "#7FFCD7" });
  }
  if (showOffline) {
    pills.push({ text: "⚠ OFFLINE", bg: "rgba(40,30,0,0.85)", border: "rgba(255,200,80,0.95)", fg: "#FFC850" });
  }

  // Measure total row width including gaps between pills.
  const widths = pills.map((p) => ctx.measureText(p.text).width + pad * 1.4);
  const totalW = widths.reduce((a, w) => a + w, 0) + gap * Math.max(0, pills.length - 1);
  let cursorX = W / 2 - totalW / 2;
  const pillY = pad + pillH + 8;

  for (let i = 0; i < pills.length; i++) {
    const p = pills[i];
    const w = widths[i];
    drawPill(ctx, cursorX, pillY, w, pillH, p.bg, p.border);
    ctx.fillStyle = p.fg;
    ctx.textAlign = "center";
    ctx.fillText(p.text, cursorX + w / 2, pillY + pillH / 2);
    cursorX += w + gap;
  }
  ctx.restore();
}

/**
 * Audio level meter — gradient bar (green→yellow→red) centred below the
 * status pills row. Drives off `audioRms` from the LiveAnalyzer.
 *
 * Layout: centred horizontally, ~22% of frame width, ~14 px tall (scales
 * with H). Tick marks at 70% and 85% mark the safe / loud / clipping zones.
 * No label text — the dock icon identifies the channel; the burnt-in meter
 * stays clean for broadcast.
 */
function drawAudioMeter(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  audioRms: number,
): void {
  const pad      = Math.round(W * 0.018);
  const pillH    = Math.max(28, Math.round(H * 0.038));
  // Sit just below the status-pills row (status pills sit at pad + pillH + 8).
  const y        = pad + pillH + 8 + pillH + 6;
  const meterW   = Math.max(180, Math.round(W * 0.22));
  const meterH   = Math.max(12, Math.round(H * 0.018));
  const x        = Math.round((W - meterW) / 2);
  const radius   = meterH * 0.45;

  // Clamp + ease the level. The Audio RMS is already 0–1 but log-scale feels
  // more like a real VU meter than linear.
  const level = Math.min(1, Math.max(0, audioRms));
  // 0.55 power compresses the low end so quiet audio still shows movement.
  const visualLevel = Math.pow(level, 0.55);

  ctx.save();

  // Background pill.
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + meterW, y, x + meterW, y + radius, radius);
  ctx.arcTo(x + meterW, y + meterH, x + meterW - radius, y + meterH, radius);
  ctx.arcTo(x, y + meterH, x, y + meterH - radius, radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
  ctx.fillStyle = "rgba(0,0,0,0.72)";
  ctx.fill();
  // Subtle border so the meter reads on bright backgrounds.
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Inner fill bar — clipped to the pill shape so the rounded edges follow.
  const innerPad = 2;
  const fillX = x + innerPad;
  const fillY = y + innerPad;
  const fillFullW = meterW - innerPad * 2;
  const fillH = meterH - innerPad * 2;
  const fillW = fillFullW * visualLevel;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + meterW, y, x + meterW, y + radius, radius);
  ctx.arcTo(x + meterW, y + meterH, x + meterW - radius, y + meterH, radius);
  ctx.arcTo(x, y + meterH, x, y + meterH - radius, radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
  ctx.clip();

  if (fillW > 0) {
    const grad = ctx.createLinearGradient(fillX, 0, fillX + fillFullW, 0);
    grad.addColorStop(0,    "#33EE55");
    grad.addColorStop(0.6,  "#9FE83A");
    grad.addColorStop(0.75, "#FFDD00");
    grad.addColorStop(0.88, "#FF8800");
    grad.addColorStop(1,    "#FF2222");
    ctx.fillStyle = grad;
    ctx.fillRect(fillX, fillY, fillW, fillH);
  }
  ctx.restore();

  // Threshold ticks at 70% (loud) and 85% (clipping). Inside the pill so
  // they overlay both the fill and the background.
  ctx.strokeStyle = "rgba(255,255,255,0.32)";
  ctx.lineWidth = 1;
  for (const frac of [0.7, 0.85]) {
    const tx = fillX + fillFullW * frac;
    ctx.beginPath();
    ctx.moveTo(tx, y + 1);
    ctx.lineTo(tx, y + meterH - 1);
    ctx.stroke();
  }

  ctx.restore();
}
