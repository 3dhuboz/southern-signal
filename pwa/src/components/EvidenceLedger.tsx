/**
 * Evidence Ledger — codec-survivable scrolling ribbon.
 *
 * Reframed from the original 60 px/s × 16 ms columns (HCI critique:
 * mosquito-mud at 8 Mbps H.264). New defaults: 24 px/s, 80 ms columns,
 * 64 px sticky base. One row per stream. Time never resets — the
 * ledger IS the session.
 *
 * Adds the breath-line — a 0.5 Hz sinusoidal ghost trace driven by
 * current RMS noise floor — so the screen feels alive in dead air
 * (HCI panel insight).
 */

import { useEffect, useRef } from "react";
import s from "./EvidenceLedger.module.css";

export interface LedgerStreamSample {
  /** Wall-clock ms (used to align columns). */
  ts: number;
  /** Magnitude in [-1, 1]; visualized as bar height. */
  magnitude: number;
}

export interface LedgerStream {
  id: string;
  label: string;
  color: string;
  samples: LedgerStreamSample[];
}

interface EvidenceLedgerProps {
  streams: LedgerStream[];
  /** Pixels per second of horizontal scroll (default 24). */
  pixelsPerSecond?: number;
  /** Width of one column in milliseconds (default 80 ms = 1.92 px @ 24 px/s — quantize to 2 px). */
  columnMs?: number;
  /** Current rms noise floor for breath-line (0..1). */
  noiseFloor?: number;
}

const ROW_HEIGHT = 14;
const TOP_PAD = 4;

export function EvidenceLedger({ streams, pixelsPerSecond = 24, columnMs = 80, noiseFloor = 0.05 }: EvidenceLedgerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const breathPhase = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    let mounted = true;

    const draw = () => {
      if (!mounted) return;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr) {
        canvas.width = Math.max(1, Math.floor(w * dpr));
        canvas.height = Math.max(1, Math.floor(h * dpr));
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) { raf = requestAnimationFrame(draw); return; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Background
      ctx.fillStyle = "#0A0E14";
      ctx.fillRect(0, 0, w, h);

      // Subtle grid: vertical 1s lines.
      ctx.strokeStyle = "rgba(38, 46, 58, 0.5)";
      ctx.lineWidth = 1;
      for (let x = w; x >= 0; x -= pixelsPerSecond) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }

      const now = Date.now();
      const colWidth = Math.max(2, Math.round((columnMs / 1000) * pixelsPerSecond));

      streams.forEach((stream, idx) => {
        const yMid = TOP_PAD + idx * (ROW_HEIGHT + 6) + ROW_HEIGHT / 2;
        // Row separator
        ctx.strokeStyle = "rgba(38, 46, 58, 0.4)";
        ctx.beginPath();
        ctx.moveTo(0, yMid + ROW_HEIGHT / 2 + 2);
        ctx.lineTo(w, yMid + ROW_HEIGHT / 2 + 2);
        ctx.stroke();
        // Label on the left
        ctx.fillStyle = "var(--text-muted) rgb(108, 119, 138)";
        ctx.font = "9px ui-monospace, SFMono-Regular, monospace";
        ctx.fillStyle = "rgba(155, 166, 184, 0.6)";
        ctx.fillText(stream.label, 4, yMid - 4);

        // Breath-line: gentle sinusoid at 0.5 Hz, amplitude scaled by noiseFloor
        ctx.strokeStyle = "rgba(93, 242, 199, 0.10)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 0; x < w; x += 2) {
          const t = (now - x * (1000 / pixelsPerSecond)) / 1000;
          const amp = noiseFloor * (ROW_HEIGHT * 0.4);
          const y = yMid + Math.sin(2 * Math.PI * 0.5 * t + idx * 0.3) * amp;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Plot recent samples as columns from right edge backward
        ctx.fillStyle = stream.color;
        for (const sample of stream.samples) {
          const ageMs = now - sample.ts;
          const x = w - (ageMs / 1000) * pixelsPerSecond;
          if (x < -colWidth) continue;
          if (x > w) continue;
          const halfH = (ROW_HEIGHT / 2) * Math.max(0, Math.min(1, Math.abs(sample.magnitude)));
          ctx.fillRect(Math.round(x) - Math.floor(colWidth / 2), yMid - halfH, colWidth, halfH * 2);
        }
      });

      // "Now" cursor on the right edge
      ctx.strokeStyle = "rgba(93, 242, 199, 0.4)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(w - 1, 0);
      ctx.lineTo(w - 1, h);
      ctx.stroke();

      breathPhase.current = (breathPhase.current + 1) % 1000;
      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      mounted = false;
      cancelAnimationFrame(raf);
    };
  }, [streams, pixelsPerSecond, columnMs, noiseFloor]);

  const height = TOP_PAD * 2 + streams.length * (ROW_HEIGHT + 6);

  return (
    <div className={s.wrap} style={{ height }}>
      <canvas ref={canvasRef} className={s.canvas} />
    </div>
  );
}
