/**
 * Last-export snapshot — small forensic-aid record kept locally so the
 * AuditLogInspector can compare the CURRENT chain against the state at the
 * time of the most recent successful export. Useful when the chain breaks
 * AFTER an export goes out the door: a reviewer asks "did this seq exist at
 * export time, and was its hash the same?", and the operator can answer
 * without opening the exported bundle.
 *
 * Stored in localStorage as JSON. Small enough (entry hashes are 64-char
 * hex, ~100 entries = ~10KB) that we don't bother chunking; if a case grows
 * past 2k entries we'll need to revisit, but that's well outside V1.
 *
 * Privacy: the snapshot is entirely hashes + sequence numbers — no event
 * payloads, no media, no identifiers. Clearing localStorage drops it.
 */

const STORAGE_KEY = "ss-last-export-snapshot-v1";

export interface LastExportSnapshot {
  /** ISO timestamp when the export was built. */
  exportedAt: string;
  /** Total audit-chain length AT export time. */
  chainLength: number;
  /** Merkle root reported by the manifest of the exported bundle. Null when
   *  the chain was empty at export time (no rows = no Merkle tree). */
  merkleRoot: string | null;
  /** Map of seq → entry_hash for every entry in the exported chain. JSON
   *  object (not Map) so the storage round-trip is trivial. */
  hashesBySeq: Record<number, string>;
  /** Filename or schema label of the bundle the snapshot was extracted from
   *  — purely for the UI ("exported as Foo.zip at 12:34"). */
  bundleLabel: string;
}

export function saveLastExportSnapshot(snap: LastExportSnapshot): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snap)); }
  catch { /* swallow — localStorage unavailable or quota exceeded */ }
}

export function loadLastExportSnapshot(): LastExportSnapshot | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LastExportSnapshot;
    if (typeof parsed.exportedAt !== "string") return null;
    if (typeof parsed.chainLength !== "number") return null;
    if (parsed.merkleRoot !== null && typeof parsed.merkleRoot !== "string") return null;
    if (typeof parsed.hashesBySeq !== "object" || parsed.hashesBySeq === null) return null;
    return parsed;
  } catch { return null; }
}

export function clearLastExportSnapshot(): void {
  try { localStorage.removeItem(STORAGE_KEY); }
  catch { /* swallow */ }
}

export interface ChainComparison {
  /** True when every common-seq hash matches. */
  matches: boolean;
  /** First seq where current entry_hash ≠ exported entry_hash. */
  firstDivergenceSeq: number | null;
  /** Count of seq values present in both current chain and snapshot. */
  comparedCount: number;
  /** Count of entries appended AFTER the export (current chain is longer). */
  appendedSinceExport: number;
  /** Count of entries the snapshot has that the current chain is missing
   *  (current chain is SHORTER — implies deletion or corruption). */
  missingFromCurrent: number;
}

/**
 * Compare a snapshot against the current chain. The current chain is passed
 * as a seq→hash map so the caller (typically AuditLogInspector) can populate
 * it from whichever query it already has on hand. Append-only is the normal
 * case: appendedSinceExport > 0 and everything else is zero/matches=true.
 */
export function compareAgainstSnapshot(
  snapshot: LastExportSnapshot,
  currentHashesBySeq: Map<number, string>,
): ChainComparison {
  let firstDivergenceSeq: number | null = null;
  let comparedCount = 0;
  let missingFromCurrent = 0;
  const snapSeqs = Object.keys(snapshot.hashesBySeq).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  for (const seq of snapSeqs) {
    const cur = currentHashesBySeq.get(seq);
    if (cur === undefined) {
      missingFromCurrent += 1;
      continue;
    }
    comparedCount += 1;
    if (cur !== snapshot.hashesBySeq[seq] && firstDivergenceSeq === null) {
      firstDivergenceSeq = seq;
    }
  }
  let appendedSinceExport = 0;
  for (const seq of currentHashesBySeq.keys()) {
    if (seq > snapshot.chainLength) appendedSinceExport += 1;
  }
  return {
    matches: firstDivergenceSeq === null && missingFromCurrent === 0,
    firstDivergenceSeq,
    comparedCount,
    appendedSinceExport,
    missingFromCurrent,
  };
}
