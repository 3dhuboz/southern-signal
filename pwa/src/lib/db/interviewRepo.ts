/**
 * Repository helpers for witness interviews (v8 schema, Tier 2 #1).
 *
 * Every mutation is audit-logged with kind "interview.added" or
 * "interview.updated" so the hash chain records the full interview lifecycle.
 * linked_event_ids is stored as JSON.stringify(string[]) — null when empty.
 */

import { appendAuditEntry } from "./auditLog";
import { exec, query } from "./db";
import type { InterviewRow, WitnessRelationship } from "./schema";

const ACTOR = "user";

function uuid(): string {
  return crypto.randomUUID();
}

function nowUtc(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// addInterview
// ---------------------------------------------------------------------------

export async function addInterview(data: {
  investigationId: string;
  witnessName: string;
  relationship?: WitnessRelationship;
  statement: string;
  notableClaims?: string;
  linkedEventIds?: string[];
  occurredAt?: string;
}): Promise<InterviewRow> {
  const id = uuid();
  const now = nowUtc();
  const row: InterviewRow = {
    id,
    investigation_id: data.investigationId,
    witness_name: data.witnessName.trim(),
    relationship: data.relationship ?? null,
    statement: data.statement.trim(),
    notable_claims: data.notableClaims?.trim() || null,
    linked_event_ids:
      data.linkedEventIds && data.linkedEventIds.length > 0
        ? JSON.stringify(data.linkedEventIds)
        : null,
    occurred_at: data.occurredAt ?? null,
    created_at: now,
    updated_at: now,
  };

  await exec(
    `INSERT INTO interviews
       (id, investigation_id, witness_name, relationship, statement,
        notable_claims, linked_event_ids, occurred_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.investigation_id,
      row.witness_name,
      row.relationship,
      row.statement,
      row.notable_claims,
      row.linked_event_ids,
      row.occurred_at,
      row.created_at,
      row.updated_at,
    ],
  );

  await appendAuditEntry({
    actor: ACTOR,
    kind: "interview.added",
    payload: {
      id,
      investigation_id: data.investigationId,
      witness_name: row.witness_name,
      relationship: row.relationship,
    },
  });

  return row;
}

// ---------------------------------------------------------------------------
// listInterviews
// ---------------------------------------------------------------------------

export async function listInterviews(investigationId: string): Promise<InterviewRow[]> {
  try {
    return await query<InterviewRow>(
      "SELECT * FROM interviews WHERE investigation_id = ? ORDER BY created_at DESC",
      [investigationId],
    );
  } catch {
    // Pre-v8 schema — table doesn't exist yet.
    return [];
  }
}

// ---------------------------------------------------------------------------
// updateInterview
// ---------------------------------------------------------------------------

export async function updateInterview(
  id: string,
  patch: Partial<
    Pick<
      InterviewRow,
      | "witness_name"
      | "relationship"
      | "statement"
      | "notable_claims"
      | "linked_event_ids"
      | "occurred_at"
    >
  >,
): Promise<void> {
  const now = nowUtc();

  // Build SET clause dynamically from the provided patch keys.
  const setClauses: string[] = ["updated_at = ?"];
  const binds: (string | null)[] = [now];

  if ("witness_name" in patch) {
    setClauses.push("witness_name = ?");
    binds.push(patch.witness_name?.trim() ?? null);
  }
  if ("relationship" in patch) {
    setClauses.push("relationship = ?");
    binds.push(patch.relationship ?? null);
  }
  if ("statement" in patch) {
    setClauses.push("statement = ?");
    binds.push(patch.statement?.trim() ?? null);
  }
  if ("notable_claims" in patch) {
    setClauses.push("notable_claims = ?");
    binds.push(patch.notable_claims?.trim() || null);
  }
  if ("linked_event_ids" in patch) {
    // Accept either a raw JSON string or null.
    setClauses.push("linked_event_ids = ?");
    binds.push(patch.linked_event_ids ?? null);
  }
  if ("occurred_at" in patch) {
    setClauses.push("occurred_at = ?");
    binds.push(patch.occurred_at ?? null);
  }

  binds.push(id);

  await exec(
    `UPDATE interviews SET ${setClauses.join(", ")} WHERE id = ?`,
    binds,
  );

  await appendAuditEntry({
    actor: ACTOR,
    kind: "interview.updated",
    payload: { id, fields: Object.keys(patch) },
  });
}

// ---------------------------------------------------------------------------
// deleteInterview
// ---------------------------------------------------------------------------

export async function deleteInterview(id: string): Promise<void> {
  await exec("DELETE FROM interviews WHERE id = ?", [id]);
  await appendAuditEntry({
    actor: ACTOR,
    kind: "interview.deleted",
    payload: { id },
  });
}
