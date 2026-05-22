/**
 * CameraPreflightBlocker — modal shown when a critical preflight check fails.
 *
 * Extracted from CameraScreen.tsx as part of the 2026-05-22 camera overhaul.
 * The blocker only renders when:
 *   - preflight overall === "block", AND
 *   - the operator hasn't yet dismissed it for this attempt
 *
 * Both predicates live in the parent — this component just renders the
 * card with the failing-checks list whenever it's mounted.
 *
 * A11y: role="alertdialog" so screen readers know it's a hard stop (vs the
 * watchdog toast's role="status"). The Got-it button just acknowledges;
 * the operator still has to actually fix the issue (browser settings, free
 * storage, etc.) before another Begin succeeds.
 *
 * Tokens: --bg-elevated / --border-subtle / --text-primary / --text-secondary
 * (Wave 1A — plus the rgba() warn / block tints are kept inline since
 * they're chrome-specific, not part of the broader palette).
 */
import type { PreflightReport } from "../../lib/system/preflight";
import s from "./CameraPreflightBlocker.module.css";

export interface CameraPreflightBlockerProps {
  report: PreflightReport;
  /** Fires when the Got-it button is clicked. Parent dismisses for this
   *  attempt; a fresh Begin re-runs preflight and may re-surface the modal. */
  onDismiss: () => void;
}

export function CameraPreflightBlocker({ report, onDismiss }: CameraPreflightBlockerProps) {
  return (
    <div className={s.preflightBlocker} role="alertdialog" aria-label="Pre-flight check failed">
      <div className={s.preflightCard}>
        <h2 className={s.preflightTitle}>Can't start session</h2>
        <ul className={s.preflightList}>
          {report.checks.filter((c) => c.level === "block").map((c) => (
            <li key={c.id} className={s.preflightRowBlock}>
              <span className={s.preflightRowLabel}>{c.id}</span>
              <span>{c.message}</span>
            </li>
          ))}
          {report.checks.filter((c) => c.level === "warn").map((c) => (
            <li key={c.id} className={s.preflightRowWarn}>
              <span className={s.preflightRowLabel}>{c.id}</span>
              <span>{c.message}</span>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className={s.preflightDismiss}
          onClick={onDismiss}
        >
          Got it
        </button>
      </div>
    </div>
  );
}
