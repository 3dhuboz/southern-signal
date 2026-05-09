/**
 * Cloudflare Pages Function — POST /api/sync/upload
 *
 * Accepts a multipart form:
 *   items   : JSON-encoded array of UploadItem (kind, ref_id, payload, ...)
 *   file:<ref_id> : zero-or-more binary blobs for media_blob items
 *
 * Auth: Bearer token in Authorization header, compared against env.SYNC_TOKEN.
 * Storage:
 *   - rows  → D1 (env.SYNC_DB), idempotent via INSERT OR IGNORE
 *   - blobs → R2 (env.MEDIA_BUCKET) under key from item.r2_key
 *
 * Returns 503 if bindings are missing so client can stay queued cleanly.
 */

interface Env {
  SYNC_TOKEN?: string;
  SYNC_DB?: D1Database;
  MEDIA_BUCKET?: R2Bucket;
}

interface PagesContext<E = unknown> {
  request: Request;
  env: E;
  params: Record<string, string | string[]>;
  data: Record<string, unknown>;
  next: (input?: Request | string) => Promise<Response>;
  waitUntil: (promise: Promise<unknown>) => void;
}

type PagesFn<E = unknown> = (ctx: PagesContext<E>) => Response | Promise<Response>;

// Minimal Cloudflare R2 / D1 types (Workers types not bundled here).
interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown>;
  exec(query: string): Promise<unknown>;
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<{ success: boolean; error?: string }>;
  all(): Promise<{ results: unknown[] }>;
}
interface R2Bucket {
  put(key: string, value: ArrayBuffer | ReadableStream | string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  head(key: string): Promise<unknown | null>;
}

interface UploadItem {
  kind: string;
  ref_id: string;
  payload: Record<string, unknown>;
  byte_length?: number;
  r2_key?: string;
}

interface UploadResponse {
  accepted: string[];
  rejected: { ref_id: string; reason: string }[];
}

const MAX_BODY_BYTES = 50 * 1024 * 1024; // 50 MB cap per upload

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

export const onRequestOptions: PagesFn<Env> = async () => new Response(null, {
  status: 204,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  },
});

function authCheck(env: Env, request: Request): Response | null {
  if (!env.SYNC_TOKEN) return jsonResponse({ error: "Sync is not configured on this deployment (missing SYNC_TOKEN)." }, 503);
  const auth = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match || match[1].trim() !== env.SYNC_TOKEN) {
    return jsonResponse({ error: "Unauthorized." }, 401);
  }
  return null;
}

function bindingsCheck(env: Env): Response | null {
  if (!env.SYNC_DB) return jsonResponse({ error: "D1 binding SYNC_DB missing." }, 503);
  if (!env.MEDIA_BUCKET) return jsonResponse({ error: "R2 binding MEDIA_BUCKET missing." }, 503);
  return null;
}

async function ensureSchema(db: D1Database): Promise<void> {
  // Mirror tables — idempotent. INSERT OR IGNORE on PKs makes upload idempotent.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS investigations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, location_name TEXT, notes TEXT,
      created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT,
      status TEXT NOT NULL DEFAULT 'created', disposition TEXT, source TEXT NOT NULL DEFAULT 'pwa'
    );
  `.replace(/\n\s+/g, " "));
  await db.exec(`
    CREATE TABLE IF NOT EXISTS evidence_events (
      id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL, timestamp TEXT NOT NULL,
      source TEXT NOT NULL, event_type TEXT NOT NULL, title TEXT, description TEXT,
      metadata_json TEXT, linked_file TEXT
    );
  `.replace(/\n\s+/g, " "));
  await db.exec(`
    CREATE TABLE IF NOT EXISTS media_assets (
      id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL, media_type TEXT NOT NULL,
      file_path TEXT NOT NULL, r2_key TEXT, timestamp_start TEXT NOT NULL, timestamp_end TEXT,
      checksum_sha256 TEXT, byte_length INTEGER, metadata_json TEXT, uploaded_at TEXT
    );
  `.replace(/\n\s+/g, " "));
  await db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      seq INTEGER PRIMARY KEY, ts_utc TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL,
      payload_json TEXT NOT NULL, prev_hash TEXT NOT NULL, entry_hash TEXT NOT NULL
    );
  `.replace(/\n\s+/g, " "));
  await db.exec(`
    CREATE TABLE IF NOT EXISTS transcripts (
      id TEXT PRIMARY KEY, media_id TEXT NOT NULL, investigation_id TEXT NOT NULL,
      segment_start_s REAL NOT NULL, segment_end_s REAL NOT NULL, text TEXT NOT NULL,
      confidence REAL, engine TEXT NOT NULL, metadata_json TEXT
    );
  `.replace(/\n\s+/g, " "));
  // Mirrors local sensor_samples. Client throttles enqueues to ~1/min per
  // (investigation_id, sensor_type), so volume here is bounded.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS sensor_samples (
      id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL, timestamp TEXT NOT NULL,
      sensor_type TEXT NOT NULL, value REAL, x REAL, y REAL, z REAL,
      unit TEXT, metadata_json TEXT
    );
  `.replace(/\n\s+/g, " "));
}

async function persistRow(db: D1Database, item: UploadItem): Promise<{ ok: true } | { ok: false; reason: string }> {
  const p = item.payload;
  try {
    switch (item.kind) {
      case "investigation":
        await db.prepare(
          `INSERT OR IGNORE INTO investigations (id, title, location_name, notes, created_at, started_at, ended_at, status, disposition, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(p.id, p.title, p.location_name ?? null, p.notes ?? null, p.created_at, p.started_at ?? null, p.ended_at ?? null, p.status ?? "created", p.disposition ?? null, p.source ?? "pwa").run();
        return { ok: true };
      case "event":
        await db.prepare(
          `INSERT OR IGNORE INTO evidence_events (id, investigation_id, timestamp, source, event_type, title, description, metadata_json, linked_file)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(p.id, p.investigation_id, p.timestamp, p.source, p.event_type, p.title ?? null, p.description ?? null, p.metadata_json ?? null, p.linked_file ?? null).run();
        return { ok: true };
      case "media_row":
        await db.prepare(
          `INSERT OR IGNORE INTO media_assets (id, investigation_id, media_type, file_path, timestamp_start, timestamp_end, checksum_sha256, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(p.id, p.investigation_id, p.media_type, p.file_path, p.timestamp_start, p.timestamp_end ?? null, p.checksum_sha256 ?? null, p.metadata_json ?? null).run();
        return { ok: true };
      case "audit":
        await db.prepare(
          `INSERT OR IGNORE INTO audit_log (seq, ts_utc, actor, kind, payload_json, prev_hash, entry_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(p.seq, p.ts_utc, p.actor, p.kind, p.payload_json, p.prev_hash, p.entry_hash).run();
        return { ok: true };
      case "transcript":
        await db.prepare(
          `INSERT OR IGNORE INTO transcripts (id, media_id, investigation_id, segment_start_s, segment_end_s, text, confidence, engine, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(p.id, p.media_id, p.investigation_id, p.segment_start_s, p.segment_end_s, p.text, p.confidence ?? null, p.engine, p.metadata_json ?? null).run();
        return { ok: true };
      case "sensor":
        await db.prepare(
          `INSERT OR IGNORE INTO sensor_samples (id, investigation_id, timestamp, sensor_type, value, x, y, z, unit, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(p.id, p.investigation_id, p.timestamp, p.sensor_type, p.value ?? null, p.x ?? null, p.y ?? null, p.z ?? null, p.unit ?? null, p.metadata_json ?? null).run();
        return { ok: true };
      default:
        return { ok: false, reason: `unknown kind: ${item.kind}` };
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : "db error" };
  }
}

async function persistBlob(bucket: R2Bucket, db: D1Database, item: UploadItem, file: File | undefined): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!file) return { ok: false, reason: "no file attached for media_blob" };
  if (!item.r2_key) return { ok: false, reason: "missing r2_key" };
  const inv = String(item.payload.investigation_id ?? "");
  const mediaType = String(item.payload.media_type ?? "");
  const contentType = mediaType === "audio" ? "audio/wav" : mediaType === "image" ? "image/jpeg" : mediaType === "video" ? "video/webm" : "application/octet-stream";
  try {
    const buf = await file.arrayBuffer();
    await bucket.put(item.r2_key, buf, { httpMetadata: { contentType } });
    // Stamp the row with R2 key + uploaded_at + size, if the row exists.
    await db.prepare(
      `UPDATE media_assets SET r2_key = ?, byte_length = ?, uploaded_at = ?
       WHERE id = ? AND investigation_id = ?`,
    ).bind(item.r2_key, buf.byteLength, new Date().toISOString(), item.ref_id, inv).run();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : "r2 error" };
  }
}

export const onRequestPost: PagesFn<Env> = async ({ request, env }) => {
  const authFail = authCheck(env, request);
  if (authFail) return authFail;
  const bindFail = bindingsCheck(env);
  if (bindFail) return bindFail;

  const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: "Upload too large" }, 413);
  }

  let form: FormData;
  try { form = await request.formData(); } catch { return jsonResponse({ error: "Invalid multipart body" }, 400); }
  const itemsRaw = form.get("items");
  if (typeof itemsRaw !== "string") return jsonResponse({ error: "Missing items field" }, 400);
  let items: UploadItem[];
  try { items = JSON.parse(itemsRaw) as UploadItem[]; } catch { return jsonResponse({ error: "items is not valid JSON" }, 400); }
  if (!Array.isArray(items) || items.length === 0) return jsonResponse({ error: "items must be a non-empty array" }, 400);
  if (items.length > 64) return jsonResponse({ error: "too many items in one batch (max 64)" }, 400);

  const db = env.SYNC_DB!;
  const bucket = env.MEDIA_BUCKET!;
  await ensureSchema(db);

  const accepted: string[] = [];
  const rejected: { ref_id: string; reason: string }[] = [];

  for (const item of items) {
    if (!item || typeof item.kind !== "string" || typeof item.ref_id !== "string" || !item.payload) {
      rejected.push({ ref_id: item?.ref_id ?? "?", reason: "malformed item" });
      continue;
    }
    if (item.kind === "media_blob") {
      const file = form.get(`file:${item.ref_id}`);
      const result = await persistBlob(bucket, db, item, file instanceof File ? file : undefined);
      if (result.ok) accepted.push(item.ref_id);
      else rejected.push({ ref_id: item.ref_id, reason: result.reason });
    } else {
      const result = await persistRow(db, item);
      if (result.ok) accepted.push(item.ref_id);
      else rejected.push({ ref_id: item.ref_id, reason: result.reason });
    }
  }

  const body: UploadResponse = { accepted, rejected };
  return jsonResponse(body, 200);
};
