/**
 * Repository helpers — typed CRUD for the V1 schema.
 *
 * Every write also appends a hash-chained audit_log entry so the chain
 * stays intact. Reads bypass the audit log.
 */

import { appendAuditEntry } from "./auditLog";
import { exec, query } from "./db";
import type { EvidenceEvent, Investigation, MediaAsset, SensorSample } from "./schema";
import { enqueue } from "../sync/queue";

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
