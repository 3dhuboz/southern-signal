/**
 * Marker override loader — folds marker.annotated + marker.dismissed audit
 * rows into a per-marker view of the latest reviewer state. Used by:
 *
 *   - Review.tsx: hide dismissed markers, render the latest note/category.
 *   - exportBundle: emit `marker_overrides.json` + cover.html notes section.
 *   - evidenceBrief: include marker notes in the printable brief.
 *
 * The audit chain is append-only — the original evidence_events row is
 * never mutated. Reviewers compute the "current" marker view by replaying
 * these overrides on top of the original capture, which preserves the
 * forensic record of every state transition (when the marker was dropped,
 * categorised, recategorised, then dismissed — all recoverable from the
 * chain).
 */

import { query } from "./db";

export type MarkerCategory = "sound" | "movement" | "felt" | null;

export interface MarkerAnnotation {
  note: string | null;
  /** undefined means "no override has changed the category"; null means
   *  "an override explicitly set the category to null (Untagged)". */
  category: MarkerCategory | undefined;
}

export interface MarkerOverrides {
  /** Marker ids that have been dismissed (soft-deleted) at any point. */
  dismissed: Set<string>;
  /** Latest annotation per marker id, latest-wins. */
  annotations: Map<string, MarkerAnnotation>;
}

const EMPTY: MarkerOverrides = { dismissed: new Set(), annotations: new Map() };

/**
 * Read every marker.annotated + marker.dismissed audit entry and fold them
 * into a lookup. Rows are processed in seq order so the latest annotation
 * for a given marker overwrites earlier ones; dismissals are absorbing.
 *
 * Returns an empty result when the table doesn't exist (pre-v1 schema) or
 * the query fails — consumers can layer overrides on top of markers
 * unconditionally without a separate "did this succeed" branch.
 */
export async function loadMarkerOverrides(): Promise<MarkerOverrides> {
  let rows: { payload_json: string; kind: string }[];
  try {
    rows = await query<{ payload_json: string; kind: string }>(
      "SELECT payload_json, kind FROM audit_log WHERE kind IN ('marker.annotated', 'marker.dismissed') ORDER BY seq ASC",
    );
  } catch { return EMPTY; }
  return collectMarkerOverrides(rows);
}

/**
 * Pure helper — folds an in-memory list of override rows. Exported so
 * Review.tsx (which already has audit rows loaded for the inspector) can
 * skip a redundant query and just call this with what it has.
 */
export function collectMarkerOverrides(rows: readonly { payload_json: string; kind: string }[]): MarkerOverrides {
  const dismissed = new Set<string>();
  const annotations = new Map<string, MarkerAnnotation>();
  for (const row of rows) {
    let parsed: { marker_id?: unknown; note?: unknown; category?: unknown };
    try { parsed = JSON.parse(row.payload_json); } catch { continue; }
    if (typeof parsed.marker_id !== "string") continue;
    if (row.kind === "marker.dismissed") {
      dismissed.add(parsed.marker_id);
      continue;
    }
    const prev = annotations.get(parsed.marker_id);
    let category: MarkerCategory | undefined = prev?.category;
    if (parsed.category === "sound" || parsed.category === "movement" || parsed.category === "felt" || parsed.category === null) {
      category = parsed.category;
    }
    const note = typeof parsed.note === "string" ? parsed.note : prev?.note ?? null;
    annotations.set(parsed.marker_id, { note, category });
  }
  return { dismissed, annotations };
}
