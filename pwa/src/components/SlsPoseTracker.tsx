/**
 * SlsPoseTracker — phone-camera "structured-light-style" figure tracker.
 *
 * The real-deal SLS (Structured Light Sensor) tools on the paranormal-app
 * market (Twin Paranormal et al.) pair an IR projector + depth camera and
 * paint a skeleton onto bodies. We can't access depth on iOS Safari, and
 * a heavy ML pose model (MediaPipe / TF.js MoveNet) is a 5-10 MB bundle
 * tax — too much for a phone PWA that already loads sqlite-wasm + Whisper.
 *
 * Instead this is honest motion-shape detection:
 *
 *   1. Sample the back camera at low res (320×240, throttled to ~10 fps).
 *   2. Maintain a running-mean "background" frame; diff current frame
 *      against it to flag pixels that moved.
 *   3. Connected-component label the moving regions (4-connectivity, two
 *      passes on a 80×60 mask — cheap).
 *   4. Filter: keep regions whose aspect ratio (h/w) is 1.8-5.5 AND whose
 *      pixel area is within a person-shaped window. These are the
 *      "human-shaped" candidates.
 *   5. Draw a stick figure overlay (head + spine + 4 limb stubs) at the
 *      blob centroid, sized to the bounding box. SLS visual signature.
 *   6. Audit-chain a `sls.figure_detected` event on the rising edge of
 *      a confident new figure (debounced ≥ 3 s).
 *
 * The honest framing — "motion-shape" not "skeleton" — is documented in
 * the visible caption and in the audit entry metadata so reviewers can't
 * be misled. The bounding-box shows underneath the stick figure as a
 * thin debug rectangle when Pro mode is on.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { appendAuditEntry } from "../lib/db/auditLog";
import { recordEvent } from "../lib/db/repo";
import s from "./SlsPoseTracker.module.css";

interface Props {
  investigationId: string | null;
  /** When false the camera is released. */
  running: boolean;
  /** When true (Pro mode) the visible preview shows the underlying motion
   * mask and bounding boxes alongside the stick figures. */
  showDebug?: boolean;
}

/** Detection: a human-shape candidate this frame. */
interface Figure {
  /** Stable id across frames (nearest centroid match). */
  id: number;
  /** Centroid in source-image pixels. */
  cx: number;
  cy: number;
  /** Bounding box in source-image pixels. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Mass = count of motion pixels inside the box. Drives confidence. */
  mass: number;
  /** Aspect ratio h / w. */
  aspect: number;
  /** Confidence 0..1: how well the blob matches person geometry. */
  confidence: number;
  /** Frames seen consecutively — used to filter flickers. */
  trackedFrames: number;
}

/** Internal: a tracked blob between frames so we can assign stable ids. */
interface Track {
  id: number;
  cx: number;
  cy: number;
  framesSeen: number;
  lastFrame: number;
  lastAuditedAt: number;
}

// Source camera resolution (asked of getUserMedia — actual may differ).
const SRC_W = 320;
const SRC_H = 240;
// Down-sampled mask resolution — compute lives at this size.
const MASK_W = 80;
const MASK_H = 60;
// Frame-rate target for the detector loop. Camera tracks at higher fps;
// we just sample a frame every PERIOD_MS.
const PERIOD_MS = 100; // 10 fps

// Background EMA — smaller value = slower background adaptation, bigger
// = faster (subjects bleed into background quicker).
const BG_ALPHA = 0.04;
// Per-channel diff threshold (0..255). A pixel is "motion" if any channel
// differs from the background by more than this.
const DIFF_THRESH = 22;
// Minimum blob mass at MASK resolution.
const MIN_MASS = 18;
// Maximum blob mass — anything more is probably the whole frame
// (operator walked in front of the lens).
const MAX_MASS = 1400;
// Aspect-ratio gate (height/width). Wider window than the textbook person
// (1.8-5.5) covers crouching, kneeling, sitting figures.
const MIN_ASPECT = 1.6;
const MAX_ASPECT = 5.8;
// Track continuity: a figure must persist this many consecutive detection
// frames before we draw it (kills 1-frame noise spikes).
const TRACK_MIN_FRAMES = 3;
// Audit-chain debounce per track id (ms).
const AUDIT_DEBOUNCE_MS = 3000;
// Max blobs we'll consider per frame — guard against pathological scenes.
const MAX_BLOBS_PER_FRAME = 8;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Connected-component label a binary mask with 4-connectivity. Two-pass
 *  union-find — cheap at MASK_W × MASK_H. Returns label-per-pixel + bbox
 *  + area for each label. */
function labelComponents(mask: Uint8Array, w: number, h: number): {
  labels: Int32Array;
  blobs: { area: number; x0: number; y0: number; x1: number; y1: number }[];
} {
  const labels = new Int32Array(w * h);
  const parent: number[] = [0]; // 0 = background
  // Union-find helpers — flat arrays, no objects.
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  // First pass.
  let nextLabel = 1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (mask[i] === 0) continue;
      const left = x > 0 ? labels[i - 1] : 0;
      const up = y > 0 ? labels[i - w] : 0;
      if (left === 0 && up === 0) {
        labels[i] = nextLabel;
        parent[nextLabel] = nextLabel;
        nextLabel += 1;
      } else if (left !== 0 && up === 0) {
        labels[i] = left;
      } else if (left === 0 && up !== 0) {
        labels[i] = up;
      } else {
        labels[i] = Math.min(left, up);
        if (left !== up) union(left, up);
      }
    }
  }

  // Second pass — replace with root labels and accumulate stats.
  const stats = new Map<number, { area: number; x0: number; y0: number; x1: number; y1: number }>();
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (labels[i] === 0) continue;
      const root = find(labels[i]);
      labels[i] = root;
      const cur = stats.get(root);
      if (!cur) {
        stats.set(root, { area: 1, x0: x, y0: y, x1: x, y1: y });
      } else {
        cur.area += 1;
        if (x < cur.x0) cur.x0 = x;
        if (y < cur.y0) cur.y0 = y;
        if (x > cur.x1) cur.x1 = x;
        if (y > cur.y1) cur.y1 = y;
      }
    }
  }

  return { labels, blobs: Array.from(stats.values()) };
}

export function SlsPoseTracker({ investigationId, running, showDebug = false }: Props) {
  // Hidden source video — receives the raw camera MediaStream.
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Hidden frame-grab canvas — reads pixels from the video each tick.
  const grabCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Hidden mask canvas — drawn-to only when showDebug is true.
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Overlay SVG container size (matches the visible preview).
  const overlayRef = useRef<SVGSVGElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Running background frame at MASK resolution (1 byte per channel, RGB).
  const bgRef = useRef<Float32Array | null>(null);
  const tickHandleRef = useRef<number | null>(null);
  const tracksRef = useRef<Map<number, Track>>(new Map());
  const nextTrackIdRef = useRef(1);
  const frameCountRef = useRef(0);

  const [phase, setPhase] = useState<"idle" | "armed" | "error">("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [figures, setFigures] = useState<Figure[]>([]);
  const [detectionsThisSession, setDetectionsThisSession] = useState(0);

  // Stop everything cleanly.
  const stopAll = useCallback(() => {
    if (tickHandleRef.current != null) {
      window.clearInterval(tickHandleRef.current);
      tickHandleRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    bgRef.current = null;
    tracksRef.current.clear();
    setFigures([]);
  }, []);

  // Audit-chain a new figure detection. Debounced per track id.
  const auditFigure = useCallback(async (fig: Figure, track: Track) => {
    if (!investigationId) return;
    const now = Date.now();
    if (now - track.lastAuditedAt < AUDIT_DEBOUNCE_MS) return;
    track.lastAuditedAt = now;
    setDetectionsThisSession((n) => n + 1);
    const payload = {
      investigation_id: investigationId,
      track_id: track.id,
      mass: fig.mass,
      aspect: Number(fig.aspect.toFixed(2)),
      confidence: Number(fig.confidence.toFixed(2)),
      bbox: { x0: fig.x0, y0: fig.y0, x1: fig.x1, y1: fig.y1 },
      method: "motion-shape-heuristic-v1",
    };
    try {
      await recordEvent({
        investigation_id: investigationId,
        source: "user",
        event_type: "sls.figure_detected",
        title: "Stick-figure motion match",
        description: `Confidence ${Math.round(fig.confidence * 100)}% · aspect ${fig.aspect.toFixed(1)}× · mass ${fig.mass}px (method: motion-shape heuristic, not LiDAR)`,
        metadata: payload,
      });
      await appendAuditEntry({
        actor: "user",
        kind: "sls.figure_detected",
        payload,
      });
    } catch (err) {
      console.warn("[sls] audit failed", err);
    }
  }, [investigationId]);

  // The detection tick.
  const tick = useCallback(() => {
    const v = videoRef.current;
    const grab = grabCanvasRef.current;
    if (!v || !grab) return;
    if (v.readyState < 2 || v.videoWidth === 0) return; // not ready yet
    const ctx = grab.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    // Draw the video into the MASK-sized buffer for cheap pixel ops.
    ctx.drawImage(v, 0, 0, MASK_W, MASK_H);
    const frame = ctx.getImageData(0, 0, MASK_W, MASK_H);
    const data = frame.data;

    // Initialise the background on first frame.
    if (!bgRef.current) {
      bgRef.current = new Float32Array(MASK_W * MASK_H * 3);
      for (let i = 0; i < MASK_W * MASK_H; i += 1) {
        bgRef.current[i * 3 + 0] = data[i * 4 + 0];
        bgRef.current[i * 3 + 1] = data[i * 4 + 1];
        bgRef.current[i * 3 + 2] = data[i * 4 + 2];
      }
      return; // skip detection on the very first frame
    }
    const bg = bgRef.current;
    const mask = new Uint8Array(MASK_W * MASK_H);

    // Diff + EMA update.
    for (let i = 0; i < MASK_W * MASK_H; i += 1) {
      const r = data[i * 4 + 0];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      const dr = r - bg[i * 3 + 0];
      const dg = g - bg[i * 3 + 1];
      const db = b - bg[i * 3 + 2];
      const motion =
        Math.abs(dr) > DIFF_THRESH ||
        Math.abs(dg) > DIFF_THRESH ||
        Math.abs(db) > DIFF_THRESH;
      mask[i] = motion ? 1 : 0;
      bg[i * 3 + 0] += BG_ALPHA * dr;
      bg[i * 3 + 1] += BG_ALPHA * dg;
      bg[i * 3 + 2] += BG_ALPHA * db;
    }

    // Label + bbox.
    const { blobs } = labelComponents(mask, MASK_W, MASK_H);

    // Score and filter.
    const candidates: Figure[] = [];
    for (const blob of blobs) {
      if (blob.area < MIN_MASS || blob.area > MAX_MASS) continue;
      const bw = blob.x1 - blob.x0 + 1;
      const bh = blob.y1 - blob.y0 + 1;
      if (bw <= 0 || bh <= 0) continue;
      const aspect = bh / bw;
      if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) continue;
      // Confidence: aspect closeness to person-like 2.5, mass in mid-range,
      // density (area / bbox area) — real people fill most of the box.
      const density = blob.area / (bw * bh);
      const idealAspect = 2.5;
      const aspectFit = clamp(1 - Math.abs(aspect - idealAspect) / 2.5, 0, 1);
      const massFit = clamp((blob.area - MIN_MASS) / 200, 0, 1);
      const densityFit = clamp((density - 0.25) / 0.55, 0, 1);
      const confidence = clamp(0.4 * aspectFit + 0.3 * massFit + 0.3 * densityFit, 0, 1);
      candidates.push({
        id: 0, // assigned below by track matching
        cx: (blob.x0 + blob.x1) / 2,
        cy: (blob.y0 + blob.y1) / 2,
        x0: blob.x0,
        y0: blob.y0,
        x1: blob.x1,
        y1: blob.y1,
        mass: blob.area,
        aspect,
        confidence,
        trackedFrames: 0,
      });
    }
    candidates.sort((a, b) => b.confidence - a.confidence);
    candidates.length = Math.min(candidates.length, MAX_BLOBS_PER_FRAME);

    // Assign ids by nearest-centroid match to existing tracks.
    const frameNo = ++frameCountRef.current;
    const tracks = tracksRef.current;
    const unmatched = new Set<number>(tracks.keys());
    for (const c of candidates) {
      let bestId = 0;
      let bestDist = Infinity;
      for (const [tid, t] of tracks) {
        const dx = c.cx - t.cx;
        const dy = c.cy - t.cy;
        const d = dx * dx + dy * dy;
        if (d < bestDist && d < 12 * 12) { // 12-px (mask space) neighbourhood
          bestDist = d;
          bestId = tid;
        }
      }
      if (bestId !== 0) {
        const t = tracks.get(bestId)!;
        t.cx = c.cx;
        t.cy = c.cy;
        t.framesSeen += 1;
        t.lastFrame = frameNo;
        c.id = bestId;
        c.trackedFrames = t.framesSeen;
        unmatched.delete(bestId);
      } else {
        const id = nextTrackIdRef.current++;
        tracks.set(id, { id, cx: c.cx, cy: c.cy, framesSeen: 1, lastFrame: frameNo, lastAuditedAt: 0 });
        c.id = id;
        c.trackedFrames = 1;
      }
    }
    // Expire tracks not seen for 5+ frames.
    for (const tid of unmatched) {
      const t = tracks.get(tid);
      if (t && frameNo - t.lastFrame > 5) tracks.delete(tid);
    }

    // Render only stable, confident figures.
    const visible = candidates.filter((c) => c.trackedFrames >= TRACK_MIN_FRAMES && c.confidence >= 0.45);
    setFigures(visible);

    // Audit-chain rising edges.
    for (const c of visible) {
      const t = tracks.get(c.id);
      if (t && c.confidence >= 0.55) {
        void auditFigure(c, t);
      }
    }

    // Debug: paint mask + boxes to the visible canvas.
    if (showDebug) {
      const mc = maskCanvasRef.current;
      if (mc) {
        const mctx = mc.getContext("2d");
        if (mctx) {
          const img = mctx.createImageData(MASK_W, MASK_H);
          for (let i = 0; i < mask.length; i += 1) {
            const v = mask[i] === 1 ? 90 : 0;
            img.data[i * 4 + 0] = 0;
            img.data[i * 4 + 1] = v;
            img.data[i * 4 + 2] = 0;
            img.data[i * 4 + 3] = mask[i] === 1 ? 110 : 0;
          }
          mctx.putImageData(img, 0, 0);
        }
      }
    }
  }, [auditFigure, showDebug]);

  // Arm — open camera, start the loop.
  const arm = useCallback(async () => {
    setErrMsg(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setErrMsg("Camera API unavailable in this browser.");
      setPhase("error");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: SRC_W }, height: { ideal: SRC_H } },
        audio: false,
      });
      streamRef.current = stream;
      const v = videoRef.current;
      if (v) {
        v.srcObject = stream;
        await v.play().catch(() => { /* iOS may need a tap */ });
      }
      // Set up grab canvas now we know native dims (the canvas itself is
      // sized to MASK_W/H; we just confirm video is ready).
      bgRef.current = null;
      tracksRef.current.clear();
      frameCountRef.current = 0;
      tickHandleRef.current = window.setInterval(tick, PERIOD_MS);
      setPhase("armed");
    } catch (e) {
      const name = (e as Error & { name?: string }).name;
      setErrMsg(
        name === "NotAllowedError" ? "Camera permission denied. Allow it in site settings."
        : name === "NotFoundError" ? "No back camera found."
        : name === "NotReadableError" ? "Camera is busy in another app."
        : (e as Error).message || "Could not access camera.",
      );
      setPhase("error");
    }
  }, [tick]);

  // Stop when session stops or component unmounts.
  useEffect(() => {
    if (!running && phase === "armed") {
      stopAll();
      setPhase("idle");
    }
  }, [running, phase, stopAll]);

  useEffect(() => () => stopAll(), [stopAll]);

  // Render the SVG stick figures over the (visible) preview video. The
  // preview shows the raw camera at its rendered size — SVG uses a
  // viewBox at MASK resolution so figure coords map cleanly.
  return (
    <section className={s.wrap} aria-label="SLS stick-figure tracker">
      <header className={s.head}>
        <span className={s.eyebrow}>SLS · MOTION-SHAPE</span>
        <span className={s.sub}>
          Honest stick-figure overlay: matches person-shaped motion, not a depth-sensor skeleton.
        </span>
      </header>

      <div className={s.previewBox}>
        <video
          ref={videoRef}
          className={s.preview}
          playsInline
          muted
          aria-hidden={phase !== "armed"}
        />
        {/* Hidden frame-grab buffer — MASK resolution, off-screen. */}
        <canvas
          ref={grabCanvasRef}
          width={MASK_W}
          height={MASK_H}
          className={s.grab}
          aria-hidden="true"
        />
        {/* Debug motion mask painted over the preview when Pro mode is on. */}
        {showDebug && (
          <canvas
            ref={maskCanvasRef}
            width={MASK_W}
            height={MASK_H}
            className={s.maskOverlay}
            aria-hidden="true"
          />
        )}
        {/* Stick figures + bounding boxes, scaled to the box via viewBox. */}
        <svg
          ref={overlayRef}
          className={s.figureLayer}
          viewBox={`0 0 ${MASK_W} ${MASK_H}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {figures.map((fig) => {
            const bw = fig.x1 - fig.x0 + 1;
            const bh = fig.y1 - fig.y0 + 1;
            const headR = Math.max(1.2, bw * 0.18);
            const headCy = fig.y0 + headR + 0.5;
            const spineTopY = headCy + headR;
            const spineBotY = fig.y1 - 0.5;
            const shoulderY = spineTopY + bh * 0.18;
            const hipY = spineTopY + bh * 0.55;
            const armSpan = bw * 0.42;
            const legSpan = bw * 0.32;
            const elbowDrop = bh * 0.13;
            const kneeDrop = bh * 0.14;
            const stroke = fig.confidence >= 0.7 ? "#9CFFB1" : fig.confidence >= 0.55 ? "#FFE08A" : "#FF9E84";
            return (
              <g key={fig.id} className={s.figure}>
                {showDebug && (
                  <rect
                    x={fig.x0}
                    y={fig.y0}
                    width={bw}
                    height={bh}
                    className={s.bbox}
                  />
                )}
                <circle cx={fig.cx} cy={headCy} r={headR} fill="none" stroke={stroke} strokeWidth={0.6} />
                <line x1={fig.cx} y1={spineTopY} x2={fig.cx} y2={spineBotY} stroke={stroke} strokeWidth={0.7} />
                <line x1={fig.cx - armSpan} y1={shoulderY + elbowDrop} x2={fig.cx} y2={shoulderY} stroke={stroke} strokeWidth={0.6} />
                <line x1={fig.cx + armSpan} y1={shoulderY + elbowDrop} x2={fig.cx} y2={shoulderY} stroke={stroke} strokeWidth={0.6} />
                <line x1={fig.cx - legSpan} y1={hipY + kneeDrop + bh * 0.2} x2={fig.cx} y2={hipY} stroke={stroke} strokeWidth={0.6} />
                <line x1={fig.cx + legSpan} y1={hipY + kneeDrop + bh * 0.2} x2={fig.cx} y2={hipY} stroke={stroke} strokeWidth={0.6} />
                <text x={fig.cx} y={Math.max(2, fig.y0 - 0.5)} className={s.figureLabel}>
                  {`#${fig.id} · ${Math.round(fig.confidence * 100)}%`}
                </text>
              </g>
            );
          })}
        </svg>
        {phase !== "armed" && (
          <div className={s.previewIdle}>
            {phase === "error"
              ? "Camera unavailable"
              : running
              ? "Tap arm to start motion-shape tracking."
              : "Begin a session to enable the SLS."}
          </div>
        )}
      </div>

      <div className={s.statRow}>
        <span className={s.statChip}>
          {phase === "armed" ? `${figures.length} figure${figures.length === 1 ? "" : "s"} visible` : "Idle"}
        </span>
        <span className={s.statChip}>
          {detectionsThisSession} audited this session
        </span>
      </div>

      <div className={s.actions}>
        {phase !== "armed" && (
          <button
            type="button"
            className={`btn btn-primary ${s.btn}`}
            disabled={!investigationId || !running}
            onClick={arm}
          >
            {!investigationId || !running ? "Begin a session first" : "Arm SLS (open back camera)"}
          </button>
        )}
        {phase === "armed" && (
          <button
            type="button"
            className={`btn btn-ghost ${s.btnGhost}`}
            onClick={() => { stopAll(); setPhase("idle"); }}
          >
            Release camera
          </button>
        )}
      </div>

      {errMsg && <p className={s.error}>{errMsg}</p>}

      <p className={s.disclaimer}>
        Not a true SLS. Phone hardware lacks the IR depth projector real
        Kinect/Structure rigs use. This is a motion-shape heuristic — when a
        moving region matches person geometry (aspect, mass, density) a
        stick figure is drawn at the centroid. Confidence ≥ 55% is audit-
        chained for review. Reflections, curtains, and small animals can
        and do trip false positives.
      </p>
    </section>
  );
}
