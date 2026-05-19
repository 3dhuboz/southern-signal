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

import { useState } from "react";
import { classifyPosterior, POSTERIOR_THRESHOLDS, type LogIncrement } from "../lib/posterior/posterior";
import { usePresentationMode } from "../hooks/usePresentationMode";
import s from "./PosteriorBar.module.css";

interface PosteriorBarProps {
  posterior: number;
  recentIncrements: LogIncrement[];
  prior: number;
  /**
   * Force-render the Pro numeric detail (P = X.XX value chip, log LR
   * annotation row). Defaults to the global presentation-mode hook —
   * Simple hides the numbers, Pro shows them. Tests pass an explicit
   * override to assert the visual gating regardless of the persisted
   * preference.
   */
  forceProDetail?: boolean;
}

const COLOR_BY_BAND: Record<ReturnType<typeof classifyPosterior>, string> = {
  below: "var(--text-muted)",
  inconclusive: "var(--warning)",
  // --posterior-elevated is defined on .wrap (orange) with a darker
  // shade under [data-theme="daylight"] so it stays readable on white.
  elevated: "var(--posterior-elevated)",
  flag: "var(--danger)",
};

export function PosteriorBar({ posterior, recentIncrements, prior, forceProDetail }: PosteriorBarProps) {
  const { isPro } = usePresentationMode();
  const showProDetail = forceProDetail ?? isPro;
  // One-time tooltip surfaced from the "View details" link in Simple
  // mode — explains why the math is hidden and where to opt in.
  const [hintOpen, setHintOpen] = useState(false);
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
      {/* Top row: posterior number + band label. The P=X.XX value chip is
          a Pro-only readout; Simple mode keeps the band label so amateurs
          still see INCONCLUSIVE / ELEVATED / FLAG. */}
      <div className={s.label}>
        <span className={s.eyebrow}>SITE POSTERIOR</span>
        {showProDetail && (
          <span className={s.value} data-band={band}>
            P = {posterior.toFixed(2)}
          </span>
        )}
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
        <line x1={elevatedX} x2={elevatedX} y1="4" y2="20" stroke="var(--posterior-elevated)" strokeWidth="0.8" />
        <line x1={flagX} x2={flagX} y1="4" y2="20" stroke="var(--danger)" strokeWidth="0.8" />
      </svg>

      {/* Threshold labels burned in below the bar */}
      <div className={s.thresholdRow}>
        <span style={{ left: `${inconclusiveX}%` }} className={s.thresholdLabel}>0.5 INCONCLUSIVE</span>
        <span style={{ left: `${elevatedX}%` }} className={s.thresholdLabel}>0.8 ELEVATED</span>
        <span style={{ left: `${flagX}%` }} className={s.thresholdLabel}>0.95 FLAG</span>
      </div>

      {/* Last LR annotation — Pro-only. Simple mode hides the log-LR
          math; the bar fill + band label carry the meaning amateurs need. */}
      {showProDetail && lastIncrement && (
        <div className={s.lrAnnotation}>
          <span className={s.lrChannel}>{lastIncrement.channel.toUpperCase()}</span>
          <span className={s.lrValue}>
            {lastIncrement.logLr >= 0 ? "+" : ""}{lastIncrement.logLr.toFixed(2)} log LR (LR {Math.exp(Math.abs(lastIncrement.logLr)).toFixed(1)})
          </span>
          <span className={s.lrReason}>{lastIncrement.reason}</span>
        </div>
      )}

      {/* "View details" affordance in Simple mode — surfaces the
          one-time tooltip explaining that the numerical readouts are
          hidden and where to switch on Pro. Mounted only when the
          numerics are actually being gated; in Pro it's redundant. */}
      {!showProDetail && (
        <div className={s.viewDetailsRow}>
          <button
            type="button"
            className={s.viewDetailsBtn}
            onClick={() => setHintOpen((v) => !v)}
            aria-expanded={hintOpen}
          >
            {hintOpen ? "Hide" : "View details"}
          </button>
          {hintOpen && (
            <p className={s.viewDetailsHint}>
              These statistics are hidden in Simple mode. Switch to Pro in Settings to see them by default.
            </p>
          )}
        </div>
      )}

      <p className={s.disclaimer}>
        Posterior is a model estimate. It does not measure presence. Sectors are 60° quadrants of the live audio field, not direction-of-arrival bearings — ASI estimates which sector the loudest non-baseline transient came from, not where in that sector.
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
