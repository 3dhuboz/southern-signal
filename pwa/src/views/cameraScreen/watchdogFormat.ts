/**
 * Watchdog formatters — pure helpers extracted from CameraScreen.tsx.
 *
 * All four helpers are stateless string-builders fed by the watchdog tick.
 * They lived inline in the 1600-line view file; moving them here lets the
 * tick effect read like business logic ("did severity escalate? OK — surface
 * the toast") without inlined `Math.round` and `slice(0)` bookkeeping.
 *
 * `mergeWatchdogReports` USED to live here too, kept around to merge worst-
 * severity-per-id across reports. It's been deleted: each preflight is a full
 * snapshot, so the new report always carries current state for every active
 * check. Merging just stalled recovered checks at their stale warn level.
 *
 * If a future contributor reintroduces a partial-report concept (e.g. a
 * sensor-only re-check that doesn't carry battery/storage), reintroduce
 * the merge — but make it explicit rather than the historical "in case".
 */

import type { PreflightCheck, PreflightLevel, PreflightReport } from "../../lib/system/preflight";

/**
 * Format the failing preflight checks for the watchdog toast. Prefers the
 * numeric `data` snapshot (e.g. "Battery 18%", "212 MB free") over the prose
 * `message` field — a glance-readable number sells the warning's urgency
 * better than a sentence the operator has to parse mid-hunt.
 */
export function formatWatchdogChecks(checks: readonly PreflightCheck[]): string {
  const parts: string[] = [];
  for (const c of checks) {
    if (c.level === "ok") continue;
    if (c.id === "battery" && c.data?.batteryLevel != null) {
      const pct = Math.round(c.data.batteryLevel * 100);
      parts.push(`Battery ${pct}%${c.data.batteryCharging ? " ⚡" : ""}`);
    } else if (c.id === "storage" && c.data?.storageFreeBytes != null) {
      const mb = Math.round(c.data.storageFreeBytes / (1024 * 1024));
      parts.push(`${mb} MB free`);
    } else if (c.id === "camera" || c.id === "mic") {
      parts.push(`${c.id} ${c.data?.permission ?? "issue"}`);
    } else {
      parts.push(c.message);
    }
  }
  return parts.join(" · ");
}

/** True when any failing check is the storage one — drives the install CTA. */
export function watchdogStorageWarn(report: PreflightReport): boolean {
  return report.checks.some((c) => c.id === "storage" && c.level !== "ok");
}

/**
 * Filter suppressed-by-pref checks out of a watchdog report and recompute
 * the overall severity from what remains. Pre-start preflight never goes
 * through this — the operator's "stop nagging me" pref intentionally only
 * applies mid-session so they can't accidentally hide a battery failure at
 * the moment of starting a session.
 */
export function applyWatchdogSuppression(
  report: PreflightReport,
  suppress: { battery: boolean; storage: boolean },
): PreflightReport {
  if (!suppress.battery && !suppress.storage) return report;
  const checks = report.checks.filter((c) =>
    !((suppress.battery && c.id === "battery") || (suppress.storage && c.id === "storage")),
  );
  const overall: PreflightLevel = checks.some((c) => c.level === "block")
    ? "block"
    : checks.some((c) => c.level === "warn") ? "warn" : "ok";
  return { overall, checks };
}

/** Ordinal formatter for the "Nth warning" counter — short forms that read
 *  cleanly inline. Used by the watchdog toast superscript chip. */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const mod10 = n % 10;
  return `${n}${mod10 === 1 ? "st" : mod10 === 2 ? "nd" : mod10 === 3 ? "rd" : "th"}`;
}
