/**
 * Pure helpers used by ResearchSnapshot. Extracted so the data-pick
 * logic is testable without standing up a React tree + DB query.
 */

import type { ResearchFinding } from "../lib/research/api";

export interface SnapshotHeadline {
  tier: string;
  title: string;
  sources: number;
}

/** Display priority — lower index wins. CULTURAL_SIGNIFICANCE leads so
 *  the operator sees sensitivity context before incident details. */
export const HEADLINE_PRIORITY: Record<string, number> = {
  CULTURAL_SIGNIFICANCE: 0,
  DOCUMENTED_INCIDENT: 1,
  HERITAGE: 2,
  FOLKLORE: 3,
  SYNTHESIS: 4,
};

/**
 * Pick a single "best" finding for the snapshot card. Lower tier rank
 * wins; ties break in favour of more citations (more evidence weight).
 * Returns null only when the input array is empty.
 */
export function pickHeadline(findings: ResearchFinding[]): SnapshotHeadline | null {
  if (findings.length === 0) return null;
  let best = findings[0];
  let bestRank = HEADLINE_PRIORITY[best.tier] ?? 99;
  for (let i = 1; i < findings.length; i++) {
    const f = findings[i];
    const rank = HEADLINE_PRIORITY[f.tier] ?? 99;
    if (rank < bestRank || (rank === bestRank && f.sources.length > best.sources.length)) {
      best = f;
      bestRank = rank;
    }
  }
  return { tier: best.tier, title: best.title, sources: best.sources.length };
}

/**
 * Relative-time label scaled to the most useful unit. nowMs override
 * lets tests pin the clock; production callers default to Date.now().
 */
export function ageLabel(iso: string, nowMs: number = Date.now()): string {
  const dt = nowMs - new Date(iso).getTime();
  if (dt < 60_000) return "just now";
  if (dt < 3_600_000) return `${Math.round(dt / 60_000)} min ago`;
  if (dt < 86_400_000) return `${Math.round(dt / 3_600_000)} h ago`;
  return `${Math.round(dt / 86_400_000)} d ago`;
}
