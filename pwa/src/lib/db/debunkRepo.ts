/**
 * Debunking-First Review — query module (Tier 1 #7).
 *
 * One checklist per flagged evidence event. Each of the 12 `DEBUNK_ITEMS`
 * gets a verdict row; each `cannot_rule_out` verdict applies −8 confidence
 * to the posterior in the UI (the penalty computation itself lives in the
 * component — this module is pure persistence + audit).
 *
 * The table uses a composite PRIMARY KEY (investigation_id, event_id, item)
 * which enforces uniqueness and lets us do a plain INSERT OR REPLACE as an
 * upsert — matching the pattern used by research_finding_notes.
 */

import { appendAuditEntry } from "./auditLog";
import { exec, query, withTransaction } from "./db";
import type { DebunkChecklistRow, DebunkItemSlug, DebunkVerdict } from "./schema";

const ACTOR_DEFAULT = "user";

function nowUtc(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// saveDebunkVerdict
// ---------------------------------------------------------------------------

/**
 * Upsert a single item verdict for one event. Calling this multiple times
 * for the same (event_id, item) pair silently overwrites the previous row —
 * the investigator can revise any verdict until the checklist is finalised.
 *
 * Every save appends an audit chain entry with kind "debunk.verdict" so the
 * forensic record shows when and how each explanation was ruled out (or not).
 */
export async function saveDebunkVerdict(row: {
  investigationId: string;
  eventId: string;
  item: DebunkItemSlug;
  verdict: DebunkVerdict;
  notes?: string;
}): Promise<void> {
  const id = crypto.randomUUID();
  const ts = nowUtc();

  // v15: row upsert + audit chain entry commit atomically. INSERT OR REPLACE
  // can now violate a FK (investigation_id / event_id parents are enforced);
  // wrapping in withTransaction means the audit chain doesn't see a save
  // entry for a row that never landed.
  await withTransaction(async () => {
    // INSERT OR REPLACE on the primary-key triple (investigation_id, event_id,
    // item). SQLite replaces the entire row, so we always supply id + logged_at.
    // The id may change across edits — that's fine; we track history via the
    // audit chain, not via row immutability.
    await exec(
      `INSERT OR REPLACE INTO debunk_checklist
         (id, investigation_id, event_id, item, verdict, notes, logged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, row.investigationId, row.eventId, row.item, row.verdict, row.notes?.trim() ?? null, ts],
    );

    await appendAuditEntry({
      actor: ACTOR_DEFAULT,
      kind: "debunk.verdict",
      payload: {
        id,
        investigationId: row.investigationId,
        eventId: row.eventId,
        item: row.item,
        verdict: row.verdict,
        // notes deliberately omitted from the chain payload — free-text fields
        // can contain PII. The row itself is the source of truth; the chain just
        // proves the save happened at this timestamp.
      },
    });
  });
}

// ---------------------------------------------------------------------------
// getDebunkChecklist
// ---------------------------------------------------------------------------

/**
 * Return all verdict rows for a single evidence event, ordered by item slug
 * alphabetically so the UI can always render them in stable order.
 */
export async function getDebunkChecklist(eventId: string): Promise<DebunkChecklistRow[]> {
  try {
    return await query<DebunkChecklistRow>(
      "SELECT * FROM debunk_checklist WHERE event_id = ? ORDER BY item ASC",
      [eventId],
    );
  } catch {
    // Pre-v7 schema — table doesn't exist yet.
    return [];
  }
}

// ---------------------------------------------------------------------------
// countCannotRuleOut
// ---------------------------------------------------------------------------

/**
 * Count the number of `cannot_rule_out` verdicts recorded for an event.
 * Used by the UI to compute the confidence penalty (−8 per item).
 */
export async function countCannotRuleOut(eventId: string): Promise<number> {
  try {
    const rows = await query<{ total: number }>(
      "SELECT COUNT(*) AS total FROM debunk_checklist WHERE event_id = ? AND verdict = 'cannot_rule_out'",
      [eventId],
    );
    return rows[0]?.total ?? 0;
  } catch {
    return 0;
  }
}
