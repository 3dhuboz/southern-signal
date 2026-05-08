/**
 * PosteriorBar — the V1 headline visual.
 *
 * 8px tall horizontal bar showing P(anomalous | evidence). Threshold
 * labels (INCONCLUSIVE / ELEVATED / FLAG) and tick marks are SVG nodes
 * inside the same root, so cropping them off would leave a visibly
 * truncated bar — by-design uncroppable.
 *
 * Color shifts: grey below 0.5, amber 0.5-0.8, orange 0.8-0.95, red ≥0.95.
 * The threshold thresholds and labels read from POSTERIOR_THRESHOLDS so
 * the math and UI cannot drift apart.
 */

import { classifyPosterior, POSTERIOR_THRESHOLDS, type LogIncrement } from "../lib/posterior/posterior";
import s from "./PosteriorBar.module.css";

interface PosteriorBarProps {
  posterior: number;
  recentIncrements: LogIncrement[];
  prior: number;
}

const COLOR_BY_BAND: Record<ReturnType<typeof classifyPosterior>, string> = {
  below: "var(--text-muted)",
  inconclusive: "var(--warning)",
  elevated: "#F29A5D",
  flag: "var(--danger)",
};

export function PosteriorBar({ posterior, recentIncrements, prior }: PosteriorBarProps) {
  const band = classifyPosterior(posterior);
  const fillColor = COLOR_BY_BAND[band];

  const inconclusiveX = POSTERIOR_THRESHOLDS.inconclusive * 100;
  const elevatedX = POSTERIOR_THRESHOLDS.elevated * 100;
  const flagX = POSTERIOR_THRESHOLDS.flag * 100;
  const priorX = prior * 100;
  const fillWidth = Math.max(0, Math.min(100, posterior * 100));

  const lastIncrement = recentIncrements[recentIncrements.length - 1];

  return (
    <div className={s.wrap}>
      {/* Top row: posterior number + band label */}
      <div className={s.label}>
        <span className={s.eyebrow}>SITE POSTERIOR</span>
        <span className={s.value} data-band={band}>
          P = {posterior.toFixed(2)}
        </span>
        <span className={s.bandLabel} data-band={band}>
          {bandLabel(band)}
        </span>
      </div>

      {/* The bar itself, with tick marks burned in as SVG */}
      <svg
        className={s.svg}
        viewBox="0 0 100 24"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Posterior probability ${posterior.toFixed(2)}, ${bandLabel(band)}`}
      >
        {/* Track */}
        <rect x="0" y="8" width="100" height="8" fill="var(--bg-inset)" rx="2" />
        {/* Fill */}
        <rect
          x="0"
          y="8"
          width={fillWidth}
          height="8"
          fill={fillColor}
          rx="2"
          style={{ transition: "width 240ms ease-out" }}
        />
        {/* Prior tick — small grey */}
        <line x1={priorX} x2={priorX} y1="6" y2="18" stroke="var(--text-dim)" strokeWidth="0.6" />
        {/* Threshold ticks burned in */}
        <line x1={inconclusiveX} x2={inconclusiveX} y1="4" y2="20" stroke="var(--warning)" strokeWidth="0.8" />
        <line x1={elevatedX} x2={elevatedX} y1="4" y2="20" stroke="#F29A5D" strokeWidth="0.8" />
        <line x1={flagX} x2={flagX} y1="4" y2="20" stroke="var(--danger)" strokeWidth="0.8" />
      </svg>

      {/* Threshold labels burned in below the bar */}
      <div className={s.thresholdRow}>
        <span style={{ left: `${inconclusiveX}%` }} className={s.thresholdLabel}>0.5 INCONCLUSIVE</span>
        <span style={{ left: `${elevatedX}%` }} className={s.thresholdLabel}>0.8 ELEVATED</span>
        <span style={{ left: `${flagX}%` }} className={s.thresholdLabel}>0.95 FLAG</span>
      </div>

      {/* Last LR annotation */}
      {lastIncrement && (
        <div className={s.lrAnnotation}>
          <span className={s.lrChannel}>{lastIncrement.channel.toUpperCase()}</span>
          <span className={s.lrValue}>
            {lastIncrement.logLr >= 0 ? "+" : ""}{lastIncrement.logLr.toFixed(2)} log LR (LR {Math.exp(Math.abs(lastIncrement.logLr)).toFixed(1)})
          </span>
          <span className={s.lrReason}>{lastIncrement.reason}</span>
        </div>
      )}

      <p className={s.disclaimer}>
        Posterior is a model estimate. It does not measure presence.
      </p>
    </div>
  );
}

function bandLabel(band: ReturnType<typeof classifyPosterior>): string {
  if (band === "flag") return "FLAG";
  if (band === "elevated") return "ELEVATED";
  if (band === "inconclusive") return "INCONCLUSIVE";
  return "BELOW THRESHOLD";
}
