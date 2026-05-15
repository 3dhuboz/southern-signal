/**
 * Repository for Trigger Object Tracker (v11 / Tier 3 #5).
 *
 * Named objects placed in the scene before a session. The investigator
 * photographs them (initial), then logs periodic checks with a displacement
 * verdict. Every write is hash-chained via appendAuditEntry.
 */

import { appendAuditEntry } from "./auditLog";
import { exec, query } from "./db";
import { uuid, nowUtc } from "./repo";
import type { TriggerDisplacement, TriggerObject, TriggerObjectCheck } from "./schema";

const ACTOR_DEFAULT = "user";

// ── Trigger objects ───────────────────────────────────────────────────────────

export async function createTriggerObject(input: {
  investigation_id: string;
  name: string;
  description?: string;
}): Promise<TriggerObject> {
  const id = uuid();
  const ts = nowUtc();
  const obj: TriggerObject = {
    id,
    investigation_id: input.investigation_id,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    initial_image_id: null,
    created_at: ts,
    updated_at: ts,
  };
  await exec(
    `INSERT INTO trigger_objects (id, investigation_id, name, description, initial_image_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [obj.id, obj.investigation_id, obj.name, obj.description, obj.initial_image_id, obj.created_at, obj.updated_at],
  );
  await appendAuditEntry({
    actor: ACTOR_DEFAULT,
    kind: "trigger_object.create",
    payload: { id, investigation_id: input.investigation_id, name: obj.name },
  });
  return obj;
}

export async function listTriggerObjects(investigationId: string): Promise<TriggerObject[]> {
  return query<TriggerObject>(
    "SELECT * FROM trigger_objects WHERE investigation_id = ? ORDER BY created_at ASC",
    [investigationId],
  );
}

export async function setInitialImage(objectId: string, imageId: string): Promise<void> {
  const ts = nowUtc();
  await exec(
    "UPDATE trigger_objects SET initial_image_id = ?, updated_at = ? WHERE id = ?",
    [imageId, ts, objectId],
  );
  await appendAuditEntry({
    actor: ACTOR_DEFAULT,
    kind: "trigger_object.initial_image",
    payload: { object_id: objectId, image_id: imageId },
  });
}

export async function deleteTriggerObject(id: string): Promise<void> {
  await exec("DELETE FROM trigger_objects WHERE id = ?", [id]);
  await appendAuditEntry({
    actor: ACTOR_DEFAULT,
    kind: "trigger_object.delete",
    payload: { id },
  });
}

// ── Trigger object checks ─────────────────────────────────────────────────────

export async function logTriggerCheck(input: {
  trigger_object_id: string;
  investigation_id: string;
  image_id?: string;
  displaced?: boolean;
  displacement_notes?: string;
}): Promise<TriggerObjectCheck> {
  const id = uuid();
  const ts = nowUtc();
  const displaced: TriggerDisplacement =
    input.displaced === undefined ? null : input.displaced ? 1 : 0;
  const check: TriggerObjectCheck = {
    id,
    trigger_object_id: input.trigger_object_id,
    investigation_id: input.investigation_id,
    image_id: input.image_id ?? null,
    displaced,
    displacement_notes: input.displacement_notes?.trim() || null,
    checked_at: ts,
  };
  await exec(
    `INSERT INTO trigger_object_checks
       (id, trigger_object_id, investigation_id, image_id, displaced, displacement_notes, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      check.id,
      check.trigger_object_id,
      check.investigation_id,
      check.image_id,
      check.displaced,
      check.displacement_notes,
      check.checked_at,
    ],
  );
  await appendAuditEntry({
    actor: ACTOR_DEFAULT,
    kind: "trigger_object.check",
    payload: {
      id,
      trigger_object_id: input.trigger_object_id,
      investigation_id: input.investigation_id,
      displaced,
      has_image: !!check.image_id,
    },
  });
  return check;
}

export async function listChecks(triggerObjectId: string): Promise<TriggerObjectCheck[]> {
  return query<TriggerObjectCheck>(
    "SELECT * FROM trigger_object_checks WHERE trigger_object_id = ? ORDER BY checked_at ASC",
    [triggerObjectId],
  );
}
