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

import { useEffect, useRef, useState } from "react";
import s from "./EvidenceLedger.module.css";

/**
 * Theme-derived colours read from CSS custom properties on <html>.
 * Canvas can't dereference `var(...)` directly, so we resolve them once
 * at mount and on every theme change (MutationObserver on data-theme).
 */
interface CanvasTheme {
  bg: string;
  grid: string;
  rowSep: string;
  label: string;
  breath: string;
  cursor: string;
}

function readCanvasTheme(): CanvasTheme {
  const cs = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => {
    const v = cs.getPropertyValue(name).trim();
    return v || fallback;
  };
  // Canvas bg matches --bg-inset (the wrapper's bg) so the seam is invisible.
  const bg = get("--bg-inset", "#0A0E14");
  const border = get("--border-default", "#262E3A");
  const muted = get("--text-muted", "#5C6677");
  const signal = get("--signal", "#5DF2C7");
  return {
    bg,
    grid: withAlpha(border, 0.5),
    rowSep: withAlpha(border, 0.4),
    label: withAlpha(muted, 0.85),
    breath: withAlpha(signal, 0.18),
    cursor: withAlpha(signal, 0.5),
  };
}

/**
 * Apply alpha to a colour string. Handles `#RGB`, `#RRGGBB`, and `rgb(...)`.
 * Falls back to the original colour on parse failure.
 */
function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  if (c.startsWith("#")) {
    let r: number;
    let g: number;
    let b: number;
    if (c.length === 4) {
      r = parseInt(c[1] + c[1], 16);
      g = parseInt(c[2] + c[2], 16);
      b = parseInt(c[3] + c[3], 16);
    } else if (c.length === 7) {
      r = parseInt(c.slice(1, 3), 16);
      g = parseInt(c.slice(3, 5), 16);
      b = parseInt(c.slice(5, 7), 16);
    } else {
      return c;
    }
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return c;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const m = c.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
  return c;
}

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
  const [theme, setTheme] = useState<CanvasTheme | null>(null);

  // Resolve CSS variables on mount, then refresh whenever the theme attribute
  // on <html> flips (phosphor / scotopic / daylight).
  useEffect(() => {
    setTheme(readCanvasTheme());
    const target = document.documentElement;
    const obs = new MutationObserver(() => setTheme(readCanvasTheme()));
    obs.observe(target, { attributes: true, attributeFilter: ["data-theme", "data-scotopic-level"] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!theme) return;
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

      // Background — pulled from --bg-inset so the canvas matches its
      // wrapper across phosphor / scotopic / daylight themes.
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, w, h);

      // Subtle grid: vertical 1s lines.
      ctx.strokeStyle = theme.grid;
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
        ctx.strokeStyle = theme.rowSep;
        ctx.beginPath();
        ctx.moveTo(0, yMid + ROW_HEIGHT / 2 + 2);
        ctx.lineTo(w, yMid + ROW_HEIGHT / 2 + 2);
        ctx.stroke();
        // Label on the left (canvas can't use var(...), so the colour is
        // resolved from --text-muted via theme).
        ctx.font = "9px ui-monospace, SFMono-Regular, monospace";
        ctx.fillStyle = theme.label;
        ctx.fillText(stream.label, 4, yMid - 4);

        // Breath-line: gentle sinusoid at 0.5 Hz, amplitude scaled by noiseFloor
        ctx.strokeStyle = theme.breath;
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
      ctx.strokeStyle = theme.cursor;
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
  }, [streams, pixelsPerSecond, columnMs, noiseFloor, theme]);

  const height = TOP_PAD * 2 + streams.length * (ROW_HEIGHT + 6);

  return (
    <div className={s.wrap} style={{ height }}>
      <canvas ref={canvasRef} className={s.canvas} />
    </div>
  );
}
