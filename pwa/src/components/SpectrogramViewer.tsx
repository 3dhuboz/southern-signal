/**
 * SpectrogramViewer — displays a heat-map spectrogram for an EVP recording.
 *
 * Wraps `computeSpectrogram` + `renderSpectrogram` from spectrogram.ts.
 * Runs the (potentially heavy) FFT pass inside a useEffect on a plain
 * setTimeout so it never blocks the React commit phase, then paints via
 * renderSpectrogram. While computing, an overlay is shown.
 *
 * Interaction:
 *   - Click  → onSeek(timeS)
 *   - Long-press / touch > 400ms → onMark(timeS)
 *   - Playhead drag rail beneath the canvas → onSeek(timeS)
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  computeSpectrogram,
  renderSpectrogram,
  type SpectrogramFrame,
  type SpectrogramOptions,
} from "../lib/audio/spectrogram";
import s from "./SpectrogramViewer.module.css";

export interface SpectrogramViewerProps {
  /** Mono Float32 PCM samples at sampleRate. Null → blank canvas. */
  samples: Float32Array | null;
  sampleRate: number;
  /** Called when the user clicks; returns time offset in seconds. */
  onSeek?: (timeS: number) => void;
  /** Called on long-press (> 400 ms). */
  onMark?: (timeS: number) => void;
  /** Overlay existing markers (e.g. contamination tags). */
  markers?: Array<{ timeS: number; label: string; color?: string }>;
  /** Noise floor from computeNoiseFloor — drawn as horizontal reference lines. */
  noiseFloor?: { p50dBFS: number; p95dBFS: number };
  /** Override spectrogram computation options. */
  options?: Partial<SpectrogramOptions>;
  /** Current playhead position in seconds (for the scrolling indicator). */
  playheadS?: number;
}

export function SpectrogramViewer({
  samples,
  sampleRate,
  onSeek,
  onMark,
  markers = [],
  noiseFloor,
  options,
  playheadS = 0,
}: SpectrogramViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const railRef   = useRef<HTMLDivElement>(null);

  const [computing, setComputing] = useState(false);
  const [frames, setFrames]       = useState<SpectrogramFrame[] | null>(null);

  // Merged options — sampleRate is always required; apply defaults.
  const mergedOptions: SpectrogramOptions = {
    sampleRate,
    fftSize: 1024,
    hopFraction: 0.5,
    voiceBand: [300, 3400],
    mainsHumHz: 50,
    ...options,
  };

  // Re-compute spectrogram when samples change.
  useEffect(() => {
    if (!samples || samples.length === 0) {
      setFrames(null);
      return;
    }

    setComputing(true);
    setFrames(null);

    // Run on next tick so the "Computing…" overlay renders first.
    const id = setTimeout(() => {
      try {
        const result = computeSpectrogram(samples, mergedOptions);
        setFrames(result);
      } finally {
        setComputing(false);
      }
    }, 0);

    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples, sampleRate, options?.fftSize, options?.hopFraction]);

  // Paint the canvas whenever frames, dimensions, markers, or noise floor change.
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr  = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.floor(rect.width);
    const cssH = Math.floor(rect.height);

    if (cssW === 0 || cssH === 0) return;

    // Only resize if actually necessary — avoids flicker.
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width  = cssW * dpr;
      canvas.height = cssH * dpr;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    // Dark background while idle.
    ctx.fillStyle = "#04080c";
    ctx.fillRect(0, 0, cssW, cssH);

    if (!frames || frames.length === 0) {
      ctx.restore?.();
      return;
    }

    // Paint spectrogram (includes voice band, hum lines, ticks, freq labels).
    renderSpectrogram(ctx, frames, mergedOptions);

    // --- Noise floor reference lines ----------------------------------------
    if (noiseFloor) {
      const { sampleRate: sr, fftSize = 1024 } = mergedOptions;
      const nyquist = sr / 2;
      const numBins = (fftSize >> 1) + 1;
      const DB_MIN  = -90;
      const DB_RANGE = 90;

      // Convert dBFS → frequency: we map noise floor dB to Y as a
      // horizontal band reference. Since noise floor is a wideband energy
      // stat (not a specific frequency), we draw it as a full-width
      // horizontal line at the Y position that corresponds to a bin whose
      // normalized power equals the noise floor dBFS → 0..1 value.
      // This gives an intuitive "everything below this line is noise floor"
      // reading.
      const toY = (dBFS: number) => {
        const norm = Math.max(0, Math.min(1, (dBFS - DB_MIN) / DB_RANGE));
        // norm=0 → bottom (DC), norm=1 → top (Nyquist)
        return cssH * (1 - norm);
      };

      // p50 — dashed grey
      const y50 = toY(noiseFloor.p50dBFS);
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(160, 160, 160, 0.65)";
      ctx.beginPath(); ctx.moveTo(0, y50); ctx.lineTo(cssW, y50); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(200, 200, 200, 0.75)";
      ctx.font = "bold 8px monospace";
      ctx.textBaseline = "bottom";
      ctx.textAlign = "right";
      ctx.fillText(`p50 ${noiseFloor.p50dBFS.toFixed(1)} dBFS`, cssW - 4, y50 - 1);
      ctx.restore();

      // p95 — dashed amber
      const y95 = toY(noiseFloor.p95dBFS);
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(242, 163, 93, 0.8)";
      ctx.beginPath(); ctx.moveTo(0, y95); ctx.lineTo(cssW, y95); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(242, 163, 93, 0.9)";
      ctx.font = "bold 8px monospace";
      ctx.textBaseline = "bottom";
      ctx.textAlign = "right";
      ctx.fillText(`p95 ${noiseFloor.p95dBFS.toFixed(1)} dBFS`, cssW - 4, y95 - 1);
      ctx.restore();

      // Suppress unused-variable warning — nyquist/numBins only needed if
      // we convert Hz, but we use dB-power approach above.
      void nyquist; void numBins;
    }

    // --- Existing markers (vertical yellow lines) ---------------------------
    const totalDuration = frames.length > 1
      ? frames[frames.length - 1].t + (frames[1].t - frames[0].t)
      : frames[0].t + 0.001;

    for (const marker of markers) {
      if (marker.timeS < 0 || marker.timeS > totalDuration) continue;
      const mx = (marker.timeS / totalDuration) * cssW;
      ctx.save();
      ctx.strokeStyle = marker.color ?? "#FFD700";
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(mx, 0); ctx.lineTo(mx, cssH); ctx.stroke();
      ctx.fillStyle = marker.color ?? "#FFD700";
      ctx.font = "bold 9px monospace";
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      ctx.fillText(marker.label, mx + 2, 2);
      ctx.restore();
    }

    // --- Playhead -----------------------------------------------------------
    if (totalDuration > 0) {
      const px = (playheadS / totalDuration) * cssW;
      ctx.save();
      ctx.strokeStyle = "rgba(255, 90, 90, 0.95)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, cssH); ctx.stroke();
      ctx.restore();
    }

    // Reset transform for next paint.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }, [frames, markers, noiseFloor, playheadS, mergedOptions]);

  useEffect(() => { paint(); }, [paint]);

  // Repaint on window resize.
  useEffect(() => {
    const onResize = () => paint();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [paint]);

  // -------------------------------------------------------------------------
  // Interaction helpers
  // -------------------------------------------------------------------------

  const totalDuration = frames && frames.length > 1
    ? frames[frames.length - 1].t + (frames[1].t - frames[0].t)
    : null;

  const xToTimeS = (clientX: number, rect: DOMRect): number => {
    if (!totalDuration) return 0;
    const ratio = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(totalDuration, ratio * totalDuration));
  };

  // Long-press tracking.
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTimeRef  = useRef<number>(0);

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  // Mouse / pointer events on the canvas.
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const t = xToTimeS(e.clientX, rect);
    longPressTimeRef.current = t;
    clearLongPress();
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      onMark?.(longPressTimeRef.current);
    }, 400);
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const wasLongPress = longPressTimerRef.current === null;
    clearLongPress();
    if (!wasLongPress) {
      // Normal click — seek.
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      onSeek?.(xToTimeS(e.clientX, rect));
    }
  };

  // Touch events.
  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !e.touches[0]) return;
    const rect = canvas.getBoundingClientRect();
    const t = xToTimeS(e.touches[0].clientX, rect);
    longPressTimeRef.current = t;
    clearLongPress();
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      onMark?.(longPressTimeRef.current);
    }, 400);
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLCanvasElement>) => {
    const wasLongPress = longPressTimerRef.current === null;
    clearLongPress();
    if (!wasLongPress) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const touch = e.changedTouches[0];
      if (touch) onSeek?.(xToTimeS(touch.clientX, rect));
    }
  };

  // Playhead drag rail.
  const draggingRailRef = useRef(false);

  const railXToTimeS = (clientX: number): number => {
    const rail = railRef.current;
    if (!rail || !totalDuration) return 0;
    const rect = rail.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(totalDuration, ratio * totalDuration));
  };

  const handleRailPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRailRef.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    onSeek?.(railXToTimeS(e.clientX));
  };

  const handleRailPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRailRef.current) return;
    onSeek?.(railXToTimeS(e.clientX));
  };

  const handleRailPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRailRef.current = false;
    onSeek?.(railXToTimeS(e.clientX));
  };

  // Playhead position as a percentage for the rail thumb.
  const playheadPct = totalDuration && totalDuration > 0
    ? Math.min(100, (playheadS / totalDuration) * 100)
    : 0;

  return (
    <div className={s.wrap}>
      {/* Computing overlay */}
      {computing && (
        <div className={s.overlay}>
          <span className={s.overlayText}>Computing spectrogram…</span>
        </div>
      )}

      {/* Main canvas */}
      <canvas
        ref={canvasRef}
        className={s.canvas}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      />

      {/* Playhead drag rail */}
      <div
        ref={railRef}
        className={s.rail}
        onPointerDown={handleRailPointerDown}
        onPointerMove={handleRailPointerMove}
        onPointerUp={handleRailPointerUp}
        role="slider"
        aria-label="Seek"
        aria-valuenow={Math.round(playheadPct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className={s.railTrack}>
          <div className={s.railFill} style={{ width: `${playheadPct}%` }} />
          <div className={s.railThumb} style={{ left: `${playheadPct}%` }} />
        </div>
      </div>
    </div>
  );
}
