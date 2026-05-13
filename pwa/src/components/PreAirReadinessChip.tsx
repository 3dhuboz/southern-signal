/**
 * PreAirReadinessChip — pro-mode status chip on MissionControl that
 * surfaces the methodology gate state at a glance. Click jumps to
 * Setup → Pre-air readiness so the operator can fix anything blocking.
 *
 * Hidden until the first computation finishes so the header doesn't
 * flash a "blocked" state before signoffs have been loaded.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { verifyAuditChain } from "../lib/db/auditLog";
import { listSignoffs } from "../lib/db/repo";
import { usePreferences } from "../lib/preferences";
import { computeReadiness, type OverallStatus } from "../lib/forensic/preAirReadiness";
import s from "./PreAirReadinessChip.module.css";

const APP_VERSION = "0.1.0";

function chipLabel(overall: OverallStatus): { mark: string; text: string } {
  if (overall === "ready")   return { mark: "✓", text: "GATES · OK" };
  if (overall === "caveats") return { mark: "⚠", text: "GATES · CAVEATS" };
  return { mark: "✗", text: "GATES · BLOCKED" };
}

function chipTooltip(overall: OverallStatus): string {
  if (overall === "ready")
    return "All methodology gates green. Tap to review.";
  if (overall === "caveats")
    return "Methodology gates pass with caveats — tap to review.";
  return "Methodology gates failing — tap to fix.";
}

export function PreAirReadinessChip() {
  const [prefs] = usePreferences();
  const [overall, setOverall] = useState<OverallStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [signoffs, chain] = await Promise.all([
          listSignoffs(),
          verifyAuditChain(),
        ]);
        if (cancelled) return;
        const report = computeReadiness({
          aocAccepted: prefs.acknowledgementOfCountry.accepted,
          appVersion: APP_VERSION,
          signoffs,
          chain,
        });
        setOverall(report.overall);
      } catch {
        // Pre-v6 schema or DB hiccup — don't surface a chip if we can't
        // compute. The Setup panel will still expose the same data.
      }
    })();
    return () => { cancelled = true; };
  }, [prefs.acknowledgementOfCountry.accepted]);

  if (overall === null) return null;
  const { mark, text } = chipLabel(overall);
  return (
    <Link
      to="/setup#pre-air-readiness"
      className={s.chip}
      data-status={overall}
      title={chipTooltip(overall)}
    >
      <span className={s.mark} aria-hidden="true">{mark}</span>
      <span className={s.text}>{text}</span>
    </Link>
  );
}
