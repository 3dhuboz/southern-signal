/**
 * Pre-air readiness — aggregates the methodology gates that have to be
 * green before a TV-grade premiere. Pure function over already-loaded
 * state so the UI can render synchronously and the unit tests don't
 * need to mock the DB or preferences.
 *
 * The README commits to: "before any TV-grade premiere using this tool,
 * an external Bayesian and an external acoustician will sign off on the
 * methodology." This module turns that commitment into a verifiable
 * checklist.
 *
 * Checks (each is either a hard block, a soft warning, or info):
 *
 *   1. Acknowledgement of Country — hard block. The ethical floor.
 *   2. External Bayesian sign-off — hard block.
 *   3. External acoustician sign-off — hard block.
 *   4. Audit chain integrity — hard block.
 *   5. Reviewer sign-offs cover the current app version — soft warning.
 *
 * Overall status:
 *   - "ready"   = every hard block passes; no soft warnings
 *   - "caveats" = every hard block passes; ≥1 soft warning
 *   - "blocked" = ≥1 hard block fails
 */

import type { ReviewerSignoffRow } from "../db/schema";

export type CheckSeverity = "block" | "warn" | "info";
export type CheckStatus = "pass" | "fail";

export interface ReadinessCheck {
  id: string;
  /** Short human-readable label, suitable for a single-line list item. */
  label: string;
  /** Longer detail string — empty when the check passed cleanly. */
  detail: string;
  severity: CheckSeverity;
  status: CheckStatus;
}

export type OverallStatus = "ready" | "caveats" | "blocked";

export interface ReadinessReport {
  overall: OverallStatus;
  /** Short one-line summary the UI can render in a banner. */
  summary: string;
  checks: ReadinessCheck[];
  /** Counts surfaced so the UI doesn't have to recompute. */
  counts: { signoffs: number; bayesian: number; acoustician: number; cultural: number; other: number };
}

export interface ReadinessInput {
  aocAccepted: boolean;
  appVersion: string;
  signoffs: ReviewerSignoffRow[];
  /** From `verifyAuditChain()`. */
  chain: { ok: true } | { ok: false; brokenAtSeq: number; reason: string };
}

function countByDiscipline(rows: ReviewerSignoffRow[]): ReadinessReport["counts"] {
  let bayesian = 0, acoustician = 0, cultural = 0, other = 0;
  for (const r of rows) {
    if (r.discipline === "bayesian") bayesian += 1;
    else if (r.discipline === "acoustician") acoustician += 1;
    else if (r.discipline === "cultural") cultural += 1;
    else other += 1;
  }
  return { signoffs: rows.length, bayesian, acoustician, cultural, other };
}

/**
 * Compose the report. Pure — no DB / no preferences access. The caller
 * resolves all the inputs first.
 */
export function computeReadiness(input: ReadinessInput): ReadinessReport {
  const counts = countByDiscipline(input.signoffs);
  const checks: ReadinessCheck[] = [];

  // 1. Acknowledgement of Country — hard block.
  checks.push({
    id: "aoc",
    label: "Acknowledgement of Country",
    detail: input.aocAccepted
      ? ""
      : "First-launch acknowledgement required before any broadcast. Visit Setup → Acknowledgement of Country.",
    severity: "block",
    status: input.aocAccepted ? "pass" : "fail",
  });

  // 2. Bayesian sign-off — hard block.
  checks.push({
    id: "signoff-bayesian",
    label: "External Bayesian sign-off",
    detail: counts.bayesian === 0
      ? "No Bayesian reviewer recorded. Add one in Setup → External reviewer sign-off."
      : counts.bayesian === 1
      ? "1 reviewer recorded."
      : `${counts.bayesian} reviewers recorded.`,
    severity: "block",
    status: counts.bayesian >= 1 ? "pass" : "fail",
  });

  // 3. Acoustician sign-off — hard block.
  checks.push({
    id: "signoff-acoustician",
    label: "External acoustician sign-off",
    detail: counts.acoustician === 0
      ? "No acoustician reviewer recorded. Add one in Setup → External reviewer sign-off."
      : counts.acoustician === 1
      ? "1 reviewer recorded."
      : `${counts.acoustician} reviewers recorded.`,
    severity: "block",
    status: counts.acoustician >= 1 ? "pass" : "fail",
  });

  // 4. Audit chain integrity — hard block.
  checks.push({
    id: "chain",
    label: "Audit chain integrity",
    detail: input.chain.ok
      ? ""
      : `Chain broken at seq ${input.chain.brokenAtSeq}: ${input.chain.reason}. Open the Audit log inspector for details.`,
    severity: "block",
    status: input.chain.ok ? "pass" : "fail",
  });

  // 5. Reviewer sign-offs cover the current app version — soft warning.
  // Only check when at least one of the required disciplines is present;
  // if both are missing, the hard blocks above already cover it.
  const requiredDisciplines: Array<"bayesian" | "acoustician"> = [];
  if (counts.bayesian > 0) requiredDisciplines.push("bayesian");
  if (counts.acoustician > 0) requiredDisciplines.push("acoustician");
  const versionGaps = requiredDisciplines.filter((d) => {
    const matches = input.signoffs.some((r) => r.discipline === d && r.app_version === input.appVersion);
    return !matches;
  });
  if (versionGaps.length > 0) {
    checks.push({
      id: "version-coverage",
      label: "Reviewers sign-off on current app version",
      detail: `Current build is v${input.appVersion}. Missing for: ${versionGaps.join(", ")}. Consider asking each reviewer to confirm against the current release.`,
      severity: "warn",
      status: "fail",
    });
  } else if (requiredDisciplines.length > 0) {
    checks.push({
      id: "version-coverage",
      label: "Reviewers sign-off on current app version",
      detail: "",
      severity: "warn",
      status: "pass",
    });
  }

  const blockFailures = checks.filter((c) => c.severity === "block" && c.status === "fail");
  const warnFailures = checks.filter((c) => c.severity === "warn" && c.status === "fail");
  const overall: OverallStatus = blockFailures.length > 0
    ? "blocked"
    : warnFailures.length > 0
    ? "caveats"
    : "ready";

  let summary: string;
  if (overall === "ready") {
    summary = "Ready for premiere — all methodology gates green.";
  } else if (overall === "caveats") {
    summary = `Ready with caveats — ${warnFailures.length} soft warning${warnFailures.length === 1 ? "" : "s"}.`;
  } else {
    summary = `Blocked — ${blockFailures.length} required check${blockFailures.length === 1 ? "" : "s"} failing.`;
  }

  return { overall, summary, checks, counts };
}
