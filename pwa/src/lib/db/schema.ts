/**
 * Database schema for Southern Signal V1.
 *
 * One sqlite-wasm DB per device, persisted in OPFS at /db/southern_signal.sqlite.
 * Pi-hub (the optional accessory) has a parallel SQLite schema; kept compatible
 * via a `source` column so cross-device sync can union rows safely.
 */

export const CURRENT_SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS investigations (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  location_name   TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  ended_at        TEXT,
  status          TEXT NOT NULL DEFAULT 'created',
  disposition     TEXT,
  -- 'null' / 'inconclusive' / 'flagged' / 'confirmed_mundane' (skeptic Tier 1)
  source          TEXT NOT NULL DEFAULT 'pwa'
);

CREATE TABLE IF NOT EXISTS sensor_samples (
  id                TEXT PRIMARY KEY,
  investigation_id  TEXT NOT NULL,
  timestamp         TEXT NOT NULL,
  sensor_type       TEXT NOT NULL,
  value             REAL,
  x                 REAL,
  y                 REAL,
  z                 REAL,
  unit              TEXT,
  metadata_json     TEXT,
  FOREIGN KEY (investigation_id) REFERENCES investigations (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sensor_samples_inv_ts ON sensor_samples (investigation_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_sensor_samples_type    ON sensor_samples (sensor_type);

CREATE TABLE IF NOT EXISTS evidence_events (
  id                TEXT PRIMARY KEY,
  investigation_id  TEXT NOT NULL,
  timestamp         TEXT NOT NULL,
  source            TEXT NOT NULL,
  -- 'user' / 'sensor' / 'ai' / 'system'
  event_type        TEXT NOT NULL,
  -- 'marker' / 'observation' / 'contamination' / 'anomaly' / 'session_start' / 'session_stop' / 'tool_emit'
  title             TEXT,
  description       TEXT,
  metadata_json     TEXT,
  linked_file       TEXT,
  FOREIGN KEY (investigation_id) REFERENCES investigations (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_events_inv_ts  ON evidence_events (investigation_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_type    ON evidence_events (event_type);

CREATE TABLE IF NOT EXISTS media_assets (
  id                TEXT PRIMARY KEY,
  investigation_id  TEXT NOT NULL,
  media_type        TEXT NOT NULL,
  -- 'audio' / 'image' / 'video'
  file_path         TEXT NOT NULL,
  -- relative to /cases/<inv>/media/
  timestamp_start   TEXT NOT NULL,
  timestamp_end     TEXT,
  checksum_sha256   TEXT,
  metadata_json     TEXT,
  FOREIGN KEY (investigation_id) REFERENCES investigations (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_media_inv_ts ON media_assets (investigation_id, timestamp_start);

CREATE TABLE IF NOT EXISTS transcripts (
  id                TEXT PRIMARY KEY,
  media_id          TEXT NOT NULL,
  investigation_id  TEXT NOT NULL,
  segment_start_s   REAL NOT NULL,
  segment_end_s     REAL NOT NULL,
  text              TEXT NOT NULL,
  confidence        REAL,
  engine            TEXT NOT NULL,
  -- 'whisper-base.en' / 'whisper-tiny.en' / 'cloud-whisper' / 'sonnet' / etc.
  metadata_json     TEXT,
  FOREIGN KEY (media_id) REFERENCES media_assets (id) ON DELETE CASCADE,
  FOREIGN KEY (investigation_id) REFERENCES investigations (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_transcripts_media ON transcripts (media_id, segment_start_s);

-- Hash-chained event log (Tier 1 #5 — every state change is appended).
-- 'edits' become new entries; never UPDATE this table.
CREATE TABLE IF NOT EXISTS audit_log (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_utc       TEXT NOT NULL,
  actor        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  prev_hash    TEXT NOT NULL,
  entry_hash   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts_utc);
`;

export interface Investigation {
  id: string;
  title: string;
  location_name: string | null;
  notes: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  status: string;
  disposition: string | null;
  source: string;
}

export interface SensorSample {
  id: string;
  investigation_id: string;
  timestamp: string;
  sensor_type: string;
  value: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  unit: string | null;
  metadata_json: string | null;
}

export interface EvidenceEvent {
  id: string;
  investigation_id: string;
  timestamp: string;
  source: string;
  event_type: string;
  title: string | null;
  description: string | null;
  metadata_json: string | null;
  linked_file: string | null;
}

export interface MediaAsset {
  id: string;
  investigation_id: string;
  media_type: string;
  file_path: string;
  timestamp_start: string;
  timestamp_end: string | null;
  checksum_sha256: string | null;
  metadata_json: string | null;
}

export interface AuditLogEntry {
  seq: number;
  ts_utc: string;
  actor: string;
  kind: string;
  payload_json: string;
  prev_hash: string;
  entry_hash: string;
}
