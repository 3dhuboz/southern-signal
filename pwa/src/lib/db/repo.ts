/**
 * Repository helpers — typed CRUD for the V1 schema.
 *
 * Every write also appends a hash-chained audit_log entry so the chain
 * stays intact. Reads bypass the audit log.
 */

import { appendAuditEntry } from "./auditLog";
import { exec, query } from "./db";
import type { EvidenceEvent, Investigation, MediaAsset, ResearchDossierRow, ResearchFindingNoteRow, ReviewerDiscipline, ReviewerSignoffRow, SensorSample } from "./schema";
import { clearSensitivityCache, enqueue } from "../sync/queue";
import { sha256Hex } from "../forensic/canonicalJson";

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
  const hex = await sha256Hex(`${finding.tier}|${finding.title}|${finding.body}`);
  return hex.slice(0, 24);
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

// ---------------------- reviewer sign-offs (v6) ----------------------

const REVIEWER_DISCIPLINES = ["bayesian", "acoustician", "cultural", "other"] as const;

export interface SignoffInput {
  reviewer_name: string;
  affiliation?: string | null;
  identifier?: string | null;
  discipline: ReviewerDiscipline;
  signed_at: string;
  app_version: string;
  statement: string;
  source_url?: string | null;
}

/** Strip ASCII control characters that have no business in human-typed
 *  fields (NUL, bell, etc.). Newlines and tabs are kept — they're legal
 *  in `statement`. */
function sanitiseText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
}

function normaliseSignoff(input: SignoffInput): Required<Pick<SignoffInput, "reviewer_name" | "discipline" | "signed_at" | "app_version" | "statement">> & {
  affiliation: string | null;
  identifier: string | null;
  source_url: string | null;
} {
  const name = sanitiseText(input.reviewer_name);
  if (name.length === 0) throw new Error("Reviewer name is required.");
  const statement = sanitiseText(input.statement);
  if (statement.length === 0) throw new Error("Reviewer statement is required.");
  if (statement.length > 4000) throw new Error("Statement exceeds 4 000 characters.");
  if (!REVIEWER_DISCIPLINES.includes(input.discipline)) {
    throw new Error(`Unknown discipline: ${input.discipline}`);
  }
  const signedAt = input.signed_at.trim();
  if (!signedAt) throw new Error("Sign-off date is required.");
  const appVersion = sanitiseText(input.app_version);
  if (!appVersion) throw new Error("App version is required.");
  const affiliation = input.affiliation ? sanitiseText(input.affiliation) || null : null;
  const identifier = input.identifier ? sanitiseText(input.identifier) || null : null;
  // URLs only accept http(s)://. The audit chain is public-facing so we
  // refuse anything weirder (data:, javascript:, file:).
  let sourceUrl: string | null = null;
  if (input.source_url) {
    const trimmed = sanitiseText(input.source_url);
    if (trimmed) {
      if (!/^https?:\/\//i.test(trimmed)) throw new Error("Source URL must start with http:// or https://.");
      sourceUrl = trimmed;
    }
  }
  return {
    reviewer_name: name,
    affiliation,
    identifier,
    discipline: input.discipline,
    signed_at: signedAt,
    app_version: appVersion,
    statement,
    source_url: sourceUrl,
  };
}

export async function createSignoff(input: SignoffInput): Promise<ReviewerSignoffRow> {
  const norm = normaliseSignoff(input);
  const id = uuid();
  const now = nowUtc();
  const row: ReviewerSignoffRow = {
    id,
    reviewer_name: norm.reviewer_name,
    affiliation: norm.affiliation,
    identifier: norm.identifier,
    discipline: norm.discipline,
    signed_at: norm.signed_at,
    app_version: norm.app_version,
    statement: norm.statement,
    source_url: norm.source_url,
    created_at: now,
    updated_at: now,
  };
  await exec(
    `INSERT INTO reviewer_signoffs
       (id, reviewer_name, affiliation, identifier, discipline, signed_at, app_version, statement, source_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.reviewer_name, row.affiliation, row.identifier, row.discipline, row.signed_at, row.app_version, row.statement, row.source_url, row.created_at, row.updated_at],
  );
  await appendAuditEntry({
    actor: ACTOR_DEFAULT,
    kind: "reviewer.signoff.create",
    payload: {
      id,
      reviewer_name: row.reviewer_name,
      discipline: row.discipline,
      signed_at: row.signed_at,
      app_version: row.app_version,
      // The full statement gets hashed into the chain so forgery would
      // visibly break verification, but we don't repeat it in the payload —
      // it's already on the row.
      statement_sha256: await sha256Hex(row.statement),
    },
  });
  return row;
}

export async function updateSignoff(id: string, input: SignoffInput): Promise<ReviewerSignoffRow> {
  const norm = normaliseSignoff(input);
  const existing = await query<ReviewerSignoffRow>(
    "SELECT * FROM reviewer_signoffs WHERE id = ?",
    [id],
  );
  if (!existing[0]) throw new Error(`Sign-off ${id} not found.`);
  const now = nowUtc();
  await exec(
    `UPDATE reviewer_signoffs
       SET reviewer_name = ?, affiliation = ?, identifier = ?, discipline = ?,
           signed_at = ?, app_version = ?, statement = ?, source_url = ?, updated_at = ?
       WHERE id = ?`,
    [norm.reviewer_name, norm.affiliation, norm.identifier, norm.discipline, norm.signed_at, norm.app_version, norm.statement, norm.source_url, now, id],
  );
  await appendAuditEntry({
    actor: ACTOR_DEFAULT,
    kind: "reviewer.signoff.update",
    payload: {
      id,
      reviewer_name: norm.reviewer_name,
      discipline: norm.discipline,
      signed_at: norm.signed_at,
      app_version: norm.app_version,
      statement_sha256: await sha256Hex(norm.statement),
    },
  });
  return {
    id,
    reviewer_name: norm.reviewer_name,
    affiliation: norm.affiliation,
    identifier: norm.identifier,
    discipline: norm.discipline,
    signed_at: norm.signed_at,
    app_version: norm.app_version,
    statement: norm.statement,
    source_url: norm.source_url,
    created_at: existing[0].created_at,
    updated_at: now,
  };
}

export async function deleteSignoff(id: string): Promise<void> {
  const existing = await query<ReviewerSignoffRow>(
    "SELECT * FROM reviewer_signoffs WHERE id = ?",
    [id],
  );
  if (!existing[0]) return;
  await exec("DELETE FROM reviewer_signoffs WHERE id = ?", [id]);
  await appendAuditEntry({
    actor: ACTOR_DEFAULT,
    kind: "reviewer.signoff.delete",
    payload: {
      id,
      reviewer_name: existing[0].reviewer_name,
      discipline: existing[0].discipline,
    },
  });
}

export async function listSignoffs(): Promise<ReviewerSignoffRow[]> {
  try {
    return await query<ReviewerSignoffRow>(
      "SELECT * FROM reviewer_signoffs ORDER BY signed_at DESC, created_at DESC",
    );
  } catch {
    // Pre-v6 schema — table doesn't exist yet.
    return [];
  }
}

// ---------------------- base-rate queries (Tier 1 #3) ----------------------

/** Per-location session statistics. Only completed sessions with a disposition count. */
export interface LocationBaseRate {
  location_name: string;       // "Unknown" if null
  total: number;               // sessions with a disposition
  null_count: number;          // disposition = 'null'
  inconclusive_count: number;
  flagged_count: number;
  confirmed_mundane_count: number;
  null_rate: number;           // 0..1
}

/** Lifetime investigator stats across ALL investigations. */
export interface LifetimeBaseRate {
  total: number;
  null_count: number;
  inconclusive_count: number;
  flagged_count: number;
  confirmed_mundane_count: number;
  null_rate: number;
  flagged_rate: number;
}

interface LocationBaseRateRaw {
  location_name: string;
  total: number;
  null_count: number;
  inconclusive_count: number;
  flagged_count: number;
  confirmed_mundane_count: number;
}

export async function getLocationBaseRates(): Promise<LocationBaseRate[]> {
  const rows = await query<LocationBaseRateRaw>(
    `SELECT
       COALESCE(location_name, 'Unknown') as location_name,
       COUNT(*) as total,
       SUM(CASE WHEN disposition = 'null' THEN 1 ELSE 0 END) as null_count,
       SUM(CASE WHEN disposition = 'inconclusive' THEN 1 ELSE 0 END) as inconclusive_count,
       SUM(CASE WHEN disposition = 'flagged' THEN 1 ELSE 0 END) as flagged_count,
       SUM(CASE WHEN disposition = 'confirmed_mundane' THEN 1 ELSE 0 END) as confirmed_mundane_count
     FROM investigations
     WHERE disposition IS NOT NULL
     GROUP BY COALESCE(location_name, 'Unknown')
     ORDER BY total DESC`,
  );
  return rows.map((r) => ({
    ...r,
    total: Number(r.total),
    null_count: Number(r.null_count),
    inconclusive_count: Number(r.inconclusive_count),
    flagged_count: Number(r.flagged_count),
    confirmed_mundane_count: Number(r.confirmed_mundane_count),
    null_rate: Number(r.total) > 0 ? Number(r.null_count) / Number(r.total) : 0,
  }));
}

export async function getLifetimeBaseRate(): Promise<LifetimeBaseRate> {
  const rows = await query<{
    total: number;
    null_count: number;
    inconclusive_count: number;
    flagged_count: number;
    confirmed_mundane_count: number;
  }>(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN disposition = 'null' THEN 1 ELSE 0 END) as null_count,
       SUM(CASE WHEN disposition = 'inconclusive' THEN 1 ELSE 0 END) as inconclusive_count,
       SUM(CASE WHEN disposition = 'flagged' THEN 1 ELSE 0 END) as flagged_count,
       SUM(CASE WHEN disposition = 'confirmed_mundane' THEN 1 ELSE 0 END) as confirmed_mundane_count
     FROM investigations
     WHERE disposition IS NOT NULL`,
  );
  const r = rows[0] ?? { total: 0, null_count: 0, inconclusive_count: 0, flagged_count: 0, confirmed_mundane_count: 0 };
  const total = Number(r.total);
  const null_count = Number(r.null_count);
  const flagged_count = Number(r.flagged_count);
  const inconclusive_count = Number(r.inconclusive_count);
  const confirmed_mundane_count = Number(r.confirmed_mundane_count);
  return {
    total,
    null_count,
    inconclusive_count,
    flagged_count,
    confirmed_mundane_count,
    null_rate: total > 0 ? null_count / total : 0,
    flagged_rate: total > 0 ? flagged_count / total : 0,
  };
}
