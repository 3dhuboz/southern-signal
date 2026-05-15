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

    // Emission text — bold mono, band-tinted so the eye lands on the word.
    const textX = blockX + innerPadX + maxLabelW + labelGap;
    ctx.font = `700 ${textFontPx}px "JetBrains Mono", monospace`;
    ctx.fillStyle = band.fill;
    ctx.fillText(r.text, textX, y);

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

function drawPill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string, stroke: string) {
  const r = h / 2;
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
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();
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
  // Center-top status pills: REC + LIVE.
  if (!overlay.recording && !overlay.liveStreaming) return;
  const pad = Math.round(W * 0.018);
  const pillH = Math.max(28, Math.round(H * 0.038));
  const fontSize = Math.max(11, Math.round(H * 0.016));
  ctx.save();
  ctx.font = `700 ${fontSize}px "JetBrains Mono", monospace`;
  ctx.textBaseline = "middle";
  let cursorX = W / 2;
  if (overlay.recording) {
    const text = "● REC";
    const w = ctx.measureText(text).width + pad * 1.4;
    drawPill(ctx, cursorX - w / 2, pad + pillH + 8, w, pillH, "rgba(50,0,0,0.85)", "rgba(255,90,90,0.95)");
    ctx.fillStyle = "#FF4A4A";
    ctx.textAlign = "center";
    ctx.fillText(text, cursorX, pad + pillH + 8 + pillH / 2);
    cursorX += w + 8;
  }
  if (overlay.liveStreaming) {
    const text = "◉ LIVE";
    const w = ctx.measureText(text).width + pad * 1.4;
    drawPill(ctx, cursorX - w / 2, pad + pillH + 8, w, pillH, "rgba(0,30,40,0.85)", "rgba(127,252,215,0.95)");
    ctx.fillStyle = "#7FFCD7";
    ctx.textAlign = "center";
    ctx.fillText(text, cursorX, pad + pillH + 8 + pillH / 2);
  }
  ctx.restore();
}
