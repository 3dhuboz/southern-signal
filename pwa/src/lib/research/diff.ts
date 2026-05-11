/**
 * Dossier diff — compares two ResearchResult payloads for the same
 * venue and reports what changed at the *finding* level.
 *
 * Matching is content-anchored via the same finding_key hash the
 * reviewer-notes system uses: SHA-256 prefix over (tier|title|body).
 * Two findings count as "the same finding" iff their finding_keys
 * match — so a wording change registers as one finding disappearing
 * and a different one appearing, not as a mutation.
 *
 * That's the right granularity for forensic comparison: a reviewer
 * looking at "what changed since last time we researched this venue"
 * cares whether the *exact wording* is still in the dossier. If the
 * model rewrote a heritage finding subtly, the diff should surface
 * both versions side-by-side rather than silently merging them.
 */

import type { ResearchFinding, ResearchResult } from "./api";
import { findingKeyFor } from "../db/repo";

export interface DiffEntry {
  /** The finding from the "previous" dossier — undefined for new findings. */
  previous: ResearchFinding | undefined;
  /** The finding from the "current" dossier — undefined for removed findings. */
  current: ResearchFinding | undefined;
  /** Stable content hash of whichever side exists. */
  findingKey: string;
  status: "added" | "removed" | "unchanged";
}

export interface DossierDiff {
  added: ResearchFinding[];
  removed: ResearchFinding[];
  unchanged: ResearchFinding[];
  /** Same data, flat list — useful for rendering in submission order. */
  entries: DiffEntry[];
  /** Quick scalar counts for a header summary. */
  counts: { added: number; removed: number; unchanged: number };
}

export async function diffResearchResults(previous: ResearchResult, current: ResearchResult): Promise<DossierDiff> {
  const prevWithKeys: { f: ResearchFinding; key: string }[] = [];
  for (const f of previous.findings) prevWithKeys.push({ f, key: await findingKeyFor(f) });
  const currWithKeys: { f: ResearchFinding; key: string }[] = [];
  for (const f of current.findings) currWithKeys.push({ f, key: await findingKeyFor(f) });

  const prevByKey = new Map(prevWithKeys.map((p) => [p.key, p.f] as const));
  const currByKey = new Map(currWithKeys.map((c) => [c.key, c.f] as const));

  const added: ResearchFinding[] = [];
  const removed: ResearchFinding[] = [];
  const unchanged: ResearchFinding[] = [];
  const entries: DiffEntry[] = [];

  // Current-first: anything in current is either unchanged (matches a
  // previous key) or added (new key not seen before).
  for (const { f, key } of currWithKeys) {
    if (prevByKey.has(key)) {
      unchanged.push(f);
      entries.push({ previous: prevByKey.get(key), current: f, findingKey: key, status: "unchanged" });
    } else {
      added.push(f);
      entries.push({ previous: undefined, current: f, findingKey: key, status: "added" });
    }
  }
  // Now sweep previous for keys not present in current — those are removed.
  for (const { f, key } of prevWithKeys) {
    if (!currByKey.has(key)) {
      removed.push(f);
      entries.push({ previous: f, current: undefined, findingKey: key, status: "removed" });
    }
  }

  return {
    added,
    removed,
    unchanged,
    entries,
    counts: { added: added.length, removed: removed.length, unchanged: unchanged.length },
  };
}
