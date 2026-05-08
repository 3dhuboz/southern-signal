/**
 * Acoustic Sector Indicator HUD — top-right corner, 96 px tall.
 *
 * Six 60° sectors arranged around a central pivot. The active sector
 * lights up phosphor cyan when a trustworthy reading fires; otherwise
 * dim grey. NO degree numbers, NO σ — see physics-panel constraint.
 */

import type { Sector, SectorReading } from "../lib/audio/sectorIndicator";
import s from "./AcousticSectorIndicator.module.css";

interface AsiProps {
  reading: SectorReading | null;
  /** True if the calibration ritual passed; if false, render in degraded grey. */
  trustworthy: boolean;
}

const SECTORS: Sector[] = ["FRONT-L", "FRONT-C", "FRONT-R", "REAR-L", "REAR-C", "REAR-R"];

const SECTOR_LAYOUT: Record<NonNullable<Sector>, { x: number; y: number; rotate: number }> = {
  "FRONT-L": { x: 30, y: 22, rotate: -60 },
  "FRONT-C": { x: 50, y: 16, rotate: 0 },
  "FRONT-R": { x: 70, y: 22, rotate: 60 },
  "REAR-L":  { x: 30, y: 72, rotate: -120 },
  "REAR-C":  { x: 50, y: 80, rotate: 180 },
  "REAR-R":  { x: 70, y: 72, rotate: 120 },
};

export function AcousticSectorIndicator({ reading, trustworthy }: AsiProps) {
  const activeSector = reading?.trustworthy ? reading.sector : null;
  const coherenceClass = reading?.trustworthy
    ? reading.coherence >= 0.85
      ? s.dotGreen
      : s.dotAmber
    : s.dotOff;

  return (
    <div className={s.hud} aria-label="Acoustic sector indicator">
      <div className={s.header}>
        <span className={s.eyebrow}>SECTOR</span>
        <span className={`${s.dot} ${coherenceClass}`} aria-hidden="true" />
      </div>
      <svg viewBox="0 0 100 100" className={s.svg} aria-hidden="true">
        <circle cx="50" cy="50" r="38" fill="none" stroke="var(--border-default)" strokeWidth="0.6" />
        <line x1="50" y1="12" x2="50" y2="88" stroke="var(--border-default)" strokeWidth="0.4" />
        <line x1="12" y1="50" x2="88" y2="50" stroke="var(--border-default)" strokeWidth="0.4" />
        {SECTORS.map((sec) => {
          if (!sec) return null;
          const { x, y, rotate } = SECTOR_LAYOUT[sec];
          const isActive = activeSector === sec && trustworthy;
          return (
            <g key={sec} transform={`translate(${x} ${y}) rotate(${rotate})`}>
              <polygon
                points="0,-8 6,4 -6,4"
                fill={isActive ? "var(--signal)" : trustworthy ? "var(--bg-inset)" : "var(--bg-canvas)"}
                stroke={isActive ? "var(--signal-glow)" : "var(--border-subtle)"}
                strokeWidth="0.6"
                style={{ transition: "fill 200ms ease" }}
              />
            </g>
          );
        })}
      </svg>
      <div className={s.label}>
        <span className={s.sector}>
          {trustworthy ? (activeSector ?? "—") : "—"}
        </span>
        <span className={s.itd}>
          {reading && trustworthy ? `${reading.itdMs >= 0 ? "+" : ""}${reading.itdMs.toFixed(2)} ms ITD` : "—"}
        </span>
      </div>
      {!trustworthy && <p className={s.degraded}>DEGRADED — calibrate before trusting</p>}
    </div>
  );
}
