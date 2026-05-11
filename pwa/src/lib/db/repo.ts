/**
 * Repository helpers — typed CRUD for the V1 schema.
 *
 * Every write also appends a hash-chained audit_log entry so the chain
 * stays intact. Reads bypass the audit log.
 */

import { appendAuditEntry } from "./auditLog";
import { exec, query } from "./db";
import type { EvidenceEvent, Investigation, MediaAsset, ResearchDossierRow, ResearchFindingNoteRow, SensorSample } from "./schema";
import { clearSensitivityCache, enqueue } from "../sync/queue";

async function safeEnqueue(args: Parameters<typeof enqueue>[0]): Promise<void> {
  try { await enqueue(args); } catch (err) { console.warn("[sync] enqueue failed", err); }
}

const ACTOR_DEFAULT = "user";

function uuid(): string {
  return crypto.randomUUID();
}

function nowUtc(): string {
  return new Date().toISOString();
}

// ---------------------- investigations ----------------------

export async function createInvestigation(input: { title: string; location_name?: string; notes?: string }): Promise<Investigation> {
  const id = uuid();
  const ts = nowUtc();
  const investigation: Investigation = {
    id,
    title: input.title.trim(),
    location_name: input.location_name?.trim() || null,
    notes: input.notes?.trim() || null,
    created_at: ts,
    started_at: null,
    ended_at: null,
    status: "created",
    disposition: null,
    source: "pwa",
    culturally_sensitive: 0,
  };
  await exec(
    `INSERT INTO investigations (id, title, location_name, notes, created_at, status, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [investigation.id, investigation.title, investigation.location_name, investigation.notes, investigation.created_at, investigation.status, investigation.source],
  );
  await appendAuditEntry({
    actor: ACTOR_DEFAULT,
    kind: "investigation.create",
    payload: { id, title: investigation.title, location_name: investigation.location_name },
  });
  await safeEnqueue({ kind: "investigation", ref_id: id, payload: investigation as unknown as Record<string, unknown> });
  return investigation;
}

export async function listInvestigations(): Promise<Investigation[]> {
  return query<Investigation>("SELECT * FROM investigations ORDER BY created_at DESC");
}

export async function getInvestigation(id: string): Promise<Investigation | null> {
  const rows = await query<Investigation>("SELECT * FROM investigations WHERE id = ?", [id]);
  return rows[0] ?? null;
}

export async function startInvestigation(id: string): Promise<void> {
  const ts = nowUtc();
  await exec(
    "UPDATE investigations SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?",
    [ts, id],
  );
  await appendAuditEntry({ actor: ACTOR_DEFAULT, kind: "investigation.start", payload: { id, started_at: ts } });
}

export async function stopInvestigation(id: string, disposition?: string): Promise<void> {
  const ts = nowUtc();
  await exec(
    "UPDATE investigations SET status = 'ended', ended_at = ?, disposition = COALESCE(?, disposition) WHERE id = ?",
    [ts, disposition ?? null, id],
  );
  await appendAuditEntry({ actor: ACTOR_DEFAULT, kind: "investigation.stop", payload: { id, ended_at: ts, disposition: disposition ?? null } });
}

export async function setDisposition(id: string, disposition: "null" | "inconclusive" | "flagged" | "confirmed_mundane"): Promise<void> {
  await exec("UPDATE investigations SET disposition = ? WHERE id = ?", [disposition, id]);
  await appendAuditEntry({ actor: ACTOR_DEFAULT, kind: "investigation.disposition", payload: { id, disposition } });
}

/**
 * v3: Toggle the per-case cultural-sensitivity flag.
 *
 * When set, cloud AI is hard-refused for this case AND its rows + media
 * are skipped at sync-enqueue time. Audit chain still records locally —
 * chain integrity matters even when the data never leaves the device.
 */
export async function setCulturallySensitive(id: string, value: boolean): Promise<void> {
  const v = value ? 1 : 0;
  await exec("UPDATE investigations SET culturally_sensitive = ? WHERE id = ?", [v, id]);
  // Invalidate the sync gate's per-case cache so the new value applies on the
  // very next enqueue, rather than waiting for the 30s TTL.
  clearSensitivityCache();
  await appendAuditEntry({
    actor: ACTOR_DEFAULT,
    kind: "investigation.cultural_sensitivity",
    payload: { id, culturally_sensitive: v },
  });
}

// ---------------------- sensor samples ----------------------

export interface SensorSampleInput {
  investigation_id: string;
  sensor_type: string;
  value?: number | null;
  x?: number | null;
  y?: number | null;
  z?: number | null;
  unit?: string | null;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

// Per-(investigation,sensor) last-enqueue timestamps. Bursty IMU readings can
// fire 50+ Hz; we still record every sample locally at full fidelity, but only
// mirror one row per minute per (investigation_id, sensor_type) to the cloud
// queue. This keeps D1/R2 cost bounded without losing on-device detail.
const SENSOR_SYNC_THROTTLE_MS = 60_000;
const lastSensorEnqueueAt = new Map<string, number>();

/** Test/diagnostic helper — wipes the throttle map. */
export function clearSensorEnqueueThrottle(): void {
  lastSensorEnqueueAt.clear();
}

export async function recordSensorSample(input: SensorSampleInput): Promise<SensorSample> {
  const id = uuid();
  const ts = input.timestamp ?? nowUtc();
  const sample: SensorSample = {
    id,
    investigation_id: input.investigation_id,
    timestamp: ts,
    sensor_type: input.sensor_type,
    value: input.value ?? null,
    x: input.x ?? null,
    y: input.y ?? null,
    z: input.z ?? null,
    unit: input.unit ?? null,
    metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
  };
  await exec(
    `INSERT INTO sensor_samples (id, investigation_id, timestamp, sensor_type, value, x, y, z, unit, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sample.id, sample.investigation_id, sample.timestamp, sample.sensor_type, sample.value, sample.x, sample.y, sample.z, sample.unit, sample.metadata_json],
  );
  // Throttled mirror to the sync queue. Local insert above is unconditional.
  const throttleKey = `${sample.investigation_id}|${sample.sensor_type}`;
  const now = Date.now();
  const lastAt = lastSensorEnqueueAt.get(throttleKey) ?? 0;
  if (now - lastAt >= SENSOR_SYNC_THROTTLE_MS) {
    lastSensorEnqueueAt.set(throttleKey, now);
    await safeEnqueue({ kind: "sensor", ref_id: id, payload: sample as unknown as Record<string, unknown> });
  }
  return sample;
}

export async function listRecentSensorSamples(investigationId: string, limit = 200): Promise<SensorSample[]> {
  return query<SensorSample>(
    "SELECT * FROM sensor_samples WHERE investigation_id = ? ORDER BY timestamp DESC LIMIT ?",
    [investigationId, limit],
  );
}

// ---------------------- evidence events ----------------------

export interface EventInput {
  investigation_id: string;
  source: "user" | "sensor" | "ai" | "system";
  event_type: string;
  title?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  linked_file?: string;
  timestamp?: string;
}

export async function recordEvent(input: EventInput): Promise<EvidenceEvent> {
  const id = uuid();
  const ts = input.timestamp ?? nowUtc();
  const event: EvidenceEvent = {
    id,
    investigation_id: input.investigation_id,
    timestamp: ts,
    source: input.source,
    event_type: input.event_type,
    title: input.title ?? null,
    description: input.description ?? null,
    metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
    linked_file: input.linked_file ?? null,
  };
  await exec(
    `INSERT INTO evidence_events (id, investigation_id, timestamp, source, event_type, title, description, metadata_json, linked_file)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [event.id, event.investigation_id, event.timestamp, event.source, event.event_type, event.title, event.description, event.metadata_json, event.linked_file],
  );
  await appendAuditEntry({
    actor: ACTOR_DEFAULT,
    kind: `event.${input.event_type}`,
    payload: { id, investigation_id: input.investigation_id, source: input.source, event_type: input.event_type },
  });
  await safeEnqueue({ kind: "event", ref_id: id, payload: event as unknown as Record<string, unknown> });
  return event;
}

export async function listEvents(investigationId: string, limit = 200): Promise<EvidenceEvent[]> {
  return query<EvidenceEvent>(
    "SELECT * FROM evidence_events WHERE investigation_id = ? ORDER BY timestamp DESC LIMIT ?",
    [investigationId, limit],
  );
}

// ---------------------- media assets ----------------------

export interface MediaInput {
  investigation_id: string;
  media_type: "audio" | "image" | "video";
  file_path: string;
  timestamp_start?: string;
  timestamp_end?: string;
  checksum_sha256?: string;
  metadata?: Record<string, unknown>;
}

export async function registerMedia(input: MediaInput): Promise<MediaAsset> {
  const id = uuid();
  const ts = input.timestamp_start ?? nowUtc();
  const asset: MediaAsset = {
    id,
    investigation_id: input.investigation_id,
    media_type: input.media_type,
    file_path: input.file_path,
    timestamp_start: ts,
    timestamp_end: input.timestamp_end ?? null,
    checksum_sha256: input.checksum_sha256 ?? null,
    metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
  };
  await exec(
    `INSERT INTO media_assets (id, investigation_id, media_type, file_path, timestamp_start, timestamp_end, checksum_sha256, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [asset.id, asset.investigation_id, asset.media_type, asset.file_path, asset.timestamp_start, asset.timestamp_end, asset.checksum_sha256, asset.metadata_json],
  );
  await appendAuditEntry({
    actor: ACTOR_DEFAULT,
    kind: "media.register",
    payload: { id, investigation_id: input.investigation_id, media_type: input.media_type, file_path: input.file_path, sha256: input.checksum_sha256 ?? null },
  });
  await safeEnqueue({ kind: "media_row", ref_id: id, payload: asset as unknown as Record<string, unknown> });
  // The bytes go up separately so a 2GB video doesn't block the row sync.
  await safeEnqueue({
    kind: "media_blob",
    ref_id: id,
    payload: { id, investigation_id: input.investigation_id, file_path: input.file_path, media_type: input.media_type, sha256: input.checksum_sha256 ?? null },
    file_path: input.file_path,
  });
  return asset;
}

export async function listMedia(investigationId: string): Promise<MediaAsset[]> {
  return query<MediaAsset>(
    "SELECT * FROM media_assets WHERE investigation_id = ? ORDER BY timestamp_start ASC",
    [investigationId],
  );
}

// ---------------------- research dossiers (v4) ----------------------

export interface DossierInput {
  investigation_id: string | null;
  venue_name: string;
  location_hint?: string | null;
  region: "AU" | "GLOBAL";
  model: string;
  /** Full ResearchResult — already server-validated for citation tier
   *  downgrades. We stringify on the way in, parse on the way out. */
  result: Record<string, unknown>;
  timestamp?: string;
}

/** Hard ceiling on a dossier's serialized result_json. ~1 MB is well
 *  above anything Perplexity Sonar would legitimately produce inside
 *  max_tokens=2400 — anything bigger is a runaway, and we'd rather
 *  refuse than fill OPFS with a single huge row. */
const DOSSIER_MAX_BYTES = 1_000_000;

export async function saveDossier(input: DossierInput): Promise<ResearchDossierRow> {
  const id = uuid();
  const ts = input.timestamp ?? nowUtc();
  const result_json = JSON.stringify(input.result);
  const byteLen = new TextEncoder().encode(result_json).length;
  if (byteLen > DOSSIER_MAX_BYTES) {
    // Hard refuse — but write the refusal to the audit chain so a
    // reviewer can see why no row exists.
    await appendAuditEntry({
      actor: ACTOR_DEFAULT,
      kind: "research.dossier.save_refused_oversize",
      payload: {
        venue_name: input.venue_name.trim(),
        region: input.region,
        model: input.model,
        bytes: byteLen,
        max_bytes: DOSSIER_MAX_BYTES,
      },
    });
    throw new Error(`Dossier exceeds the ${Math.round(DOSSIER_MAX_BYTES / 1024)} KB on-device cap (${Math.round(byteLen / 1024)} KB). The run wasn't saved; the audit chain recorded the refusal.`);
  }
  const row: ResearchDossierRow = {
    id,
    investigation_id: input.investigation_id,
    venue_name: input.venue_name.trim(),
    location_hint: input.location_hint?.trim() || null,
    region: input.region,
    created_at: ts,
    model: input.model,
    result_json,
  };
  await exec(
    `INSERT INTO research_dossiers
       (id, investigation_id, venue_name, location_hint, region, created_at, model, result_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.investigation_id, row.venue_name, row.location_hint, row.region, row.created_at, row.model, row.result_json],
  );
  // Soft-warn on bigger-than-typical writes so a reviewer's chain
  // shows when the model was generating unusually large payloads even
  // though they were within the hard limit.
  const SOFT_WARN_BYTES = 200_000;
  if (byteLen >= SOFT_WARN_BYTES) {
    await appendAuditEntry({
      actor: ACTOR_DEFAULT,
      kind: "research.dossier.size_warning",
      payload: { id, bytes: byteLen, threshold_bytes: SOFT_WARN_BYTES },
    });
  }
  await appendAuditEntry({
    actor: ACTOR_DEFAULT,
    kind: "research.dossier.save",
    payload: {
      id,
      investigation_id: row.investigation_id,
      venue_name: row.venue_name,
      region: row.region,
      model: row.model,
      // Lean payload — full result is in the row, the audit chain just
      // needs an integrity anchor.
      finding_count: Array.isArray((input.result as { findings?: unknown }).findings)
        ? ((input.result as { findings: unknown[] }).findings.length)
        : 0,
    },
  });
  // Sync queue: standalone dossiers (no investigation_id) still mirror
  // — they're useful pre-visit recon evidence for the cloud roll-up.
  await safeEnqueue({ kind: "dossier", ref_id: id, payload: row as unknown as Record<string, unknown> });
  return row;
}

export async function listDossiers(investigationId: string | null, limit = 20): Promise<ResearchDossierRow[]> {
  if (investigationId == null) {
    return query<ResearchDossierRow>(
      "SELECT * FROM research_dossiers WHERE investigation_id IS NULL ORDER BY created_at DESC LIMIT ?",
      [limit],
    );
  }
  return query<ResearchDossierRow>(
    "SELECT * FROM research_dossiers WHERE investigation_id = ? ORDER BY created_at DESC LIMIT ?",
    [investigationId, limit],
  );
}

export async function getDossier(id: string): Promise<ResearchDossierRow | null> {
  const rows = await query<ResearchDossierRow>("SELECT * FROM research_dossiers WHERE id = ?", [id]);
  return rows[0] ?? null;
}

export async function deleteDossier(id: string): Promise<void> {
  await exec("DELETE FROM research_dossiers WHERE id = ?", [id]);
  await appendAuditEntry({ actor: ACTOR_DEFAULT, kind: "research.dossier.delete", payload: { id } });
}

// ---------------------- research finding notes (v5) ----------------------

/**
 * Compute the stable 24-char SHA-256 prefix key for a finding so notes
 * survive the parent findings array being re-rendered in a different
 * order. Exported so the UI can compute the same key at render time.
 *
 * The key intentionally folds tier, title, and body — if the model
 * generates a slightly different rewording on a re-run, the note will
 * unlink (which is what we want — a note is an annotation on specific
 * wording, not a tag on "the third finding").
 */
export async function findingKeyFor(finding: { tier: string; title: string; body: string }): Promise<string> {
  const data = new TextEncoder().encode(`${finding.tier}|${finding.title}|${finding.body}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

export interface FindingNoteInput {
  dossier_id: string;
  finding_key: string;
  text: string;
}

/**
 * Upsert a reviewer note. INSERT OR REPLACE on (dossier_id, finding_key)
 * — same finding gets one note, overwriting on edit. Empty text is
 * treated as a delete so the operator can clear a note by saving it
 * empty. Audit chain records save / delete separately so the reviewer
 * can see how a note evolved.
 */
export async function saveFindingNote(input: FindingNoteInput): Promise<ResearchFindingNoteRow | null> {
  const text = input.text.trim();
  if (text.length === 0) {
    await deleteFindingNote(input.dossier_id, input.finding_key);
    return null;
  }
  const now = nowUtc();
  // Look up existing so created_at is preserved across edits.
  const existing = await query<ResearchFindingNoteRow>(
    "SELECT * FROM research_finding_notes WHERE dossier_id = ? AND finding_key = ?",
    [input.dossier_id, input.finding_key],
  );
  const id = existing[0]?.id ?? uuid();
  const createdAt = existing[0]?.created_at ?? now;
  await exec(
    `INSERT INTO research_finding_notes (id, dossier_id, finding_key, text, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(dossier_id, finding_key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
    [id, input.dossier_id, input.finding_key, text, createdAt, now],
  );
  await appendAuditEntry({
    actor: ACTOR_DEFAULT,
    kind: existing[0] ? "research.finding_note.update" : "research.finding_note.create",
    payload: { id, dossier_id: input.dossier_id, finding_key: input.finding_key, text_length: text.length },
  });
  return { id, dossier_id: input.dossier_id, finding_key: input.finding_key, text, created_at: createdAt, updated_at: now };
}

export async function deleteFindingNote(dossierId: string, findingKey: string): Promise<void> {
  const existing = await query<ResearchFindingNoteRow>(
    "SELECT * FROM research_finding_notes WHERE dossier_id = ? AND finding_key = ?",
    [dossierId, findingKey],
  );
  if (!existing[0]) return;
  await exec(
    "DELETE FROM research_finding_notes WHERE dossier_id = ? AND finding_key = ?",
    [dossierId, findingKey],
  );
  await appendAuditEntry({
    actor: ACTOR_DEFAULT,
    kind: "research.finding_note.delete",
    payload: { id: existing[0].id, dossier_id: dossierId, finding_key: findingKey },
  });
}

export async function listFindingNotesForDossier(dossierId: string): Promise<ResearchFindingNoteRow[]> {
  try {
    return await query<ResearchFindingNoteRow>(
      "SELECT * FROM research_finding_notes WHERE dossier_id = ? ORDER BY updated_at DESC",
      [dossierId],
    );
  } catch {
    // Pre-v5 schema — table doesn't exist yet.
    return [];
  }
}
