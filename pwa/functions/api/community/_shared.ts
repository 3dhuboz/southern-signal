/**
 * Shared helpers for the /api/community/* endpoints.
 *
 * Pattern mirrors functions/api/ai/_research-shared.ts — small inline
 * Workers-type subset so the function type-checks without bundling
 * @cloudflare/workers-types into the PWA tsconfig.
 */

export const COMMUNITY_RATE_LIMIT_CAP = 10;
export const COMMUNITY_RATE_LIMIT_WINDOW_HOURS = 24;
export const MAX_BODY_BYTES = 4_000;

export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown>;
  exec(query: string): Promise<unknown>;
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<{ success: boolean; error?: string }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface CommunityEnv {
  COMMUNITY_DB?: D1Database;
  AI_RATE_LIMIT?: KVNamespace; // reuse existing rate-limit KV
  AI_RATE_LIMIT_SALT?: string;
}

export interface PagesContext<E = unknown> {
  request: Request;
  env: E;
  params: Record<string, string | string[]>;
  data: Record<string, unknown>;
  next: (input?: Request | string) => Promise<Response>;
  waitUntil: (promise: Promise<unknown>) => void;
}

export type PagesFn<E = unknown> = (ctx: PagesContext<E>) => Response | Promise<Response>;

export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders },
  });
}

export async function hashIp(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

export function callerIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP")
    ?? request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim()
    ?? "unknown";
}

export interface RateState {
  used: number;
  cap: number;
  resetMs: number;
  key: string | null;
}

export async function readRateLimit(kv: KVNamespace | undefined, ipHash: string): Promise<RateState> {
  const now = Date.now();
  const bucket = Math.floor(now / (COMMUNITY_RATE_LIMIT_WINDOW_HOURS * 3_600_000));
  const nextBucketMs = (bucket + 1) * COMMUNITY_RATE_LIMIT_WINDOW_HOURS * 3_600_000;
  const resetMs = Math.max(0, nextBucketMs - now);
  if (!kv) return { used: 0, cap: COMMUNITY_RATE_LIMIT_CAP, resetMs, key: null };
  const key = `community:${ipHash}:${bucket}`;
  const raw = await kv.get(key);
  const used = raw == null ? 0 : parseInt(raw, 10) || 0;
  return { used, cap: COMMUNITY_RATE_LIMIT_CAP, resetMs, key };
}

export async function recordRateLimitRun(kv: KVNamespace | undefined, state: RateState): Promise<void> {
  if (!kv || !state.key) return;
  const next = state.used + 1;
  const ttl = COMMUNITY_RATE_LIMIT_WINDOW_HOURS * 3600 + 3600;
  await kv.put(state.key, String(next), { expirationTtl: ttl });
}

export function rateLimitHeaders(state: RateState): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(state.cap),
    "X-RateLimit-Remaining": String(Math.max(0, state.cap - state.used)),
    "X-RateLimit-Reset-Seconds": String(Math.round(state.resetMs / 1000)),
  };
}

/** Idempotent — caller is free to invoke per-request. */
export async function ensureCommunitySchema(db: D1Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS community_sites (
      id TEXT PRIMARY KEY,
      anonymous_id TEXT NOT NULL,
      venue_name TEXT NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      region TEXT,
      posterior REAL,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0
    );
  `.replace(/\n\s+/g, " "));
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_community_sites_geo ON community_sites(lat, lon);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_community_sites_anon ON community_sites(anonymous_id);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_community_sites_hidden ON community_sites(hidden);`);

  // Area-incident cache: AI-surfaced documented incidents (deaths, fires,
  // court cases, fatal accidents, coroner's findings) keyed by a coarse
  // bounding-box cell. Sonar is expensive + rate-limited, so we cache for
  // 30 days; the rolled-up cell means two operators panning the same
  // region don't both burn the quota.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS area_incident_cache (
      cell_key TEXT PRIMARY KEY,
      region TEXT NOT NULL,
      bbox_min_lat REAL NOT NULL,
      bbox_min_lon REAL NOT NULL,
      bbox_max_lat REAL NOT NULL,
      bbox_max_lon REAL NOT NULL,
      payload_json TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `.replace(/\n\s+/g, " "));
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_area_cache_expires ON area_incident_cache(expires_at);`);
}

/** Round a bbox to a coarse grid cell so two operators within the same
 *  ~10km region share the cache. 0.1° ≈ 11km at the equator; finer near
 *  the poles, but Australia/the bulk of population stays in usable range. */
export function bboxCellKey(region: string, bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number }): string {
  const r = (v: number): string => (Math.round(v * 10) / 10).toFixed(1);
  return `${region}:${r(bbox.minLat)},${r(bbox.minLon)}:${r(bbox.maxLat)},${r(bbox.maxLon)}`;
}

/** Area cache TTL — 30 days. Documented incidents don't change quickly;
 *  this trades freshness for cost control. */
export const AREA_CACHE_TTL_MS = 30 * 24 * 3600 * 1000;

/** Coarsen coords to ~100 m so houses can't be pin-pointed by browsers. */
export function coarsenCoord(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Sanitise free-text to keep the DB sane and the map UI safe. Returns
 *  null if the result is empty after trim. */
export function sanitiseText(input: unknown, maxLen: number): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.replace(/[\x00-\x1F\x7F]/g, "").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLen);
}

export function isValidLatLon(lat: unknown, lon: unknown): lat is number {
  return typeof lat === "number" && typeof lon === "number"
    && Number.isFinite(lat) && Number.isFinite(lon)
    && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

export function isValidUuid(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
