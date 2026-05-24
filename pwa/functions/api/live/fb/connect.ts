/**
 * Cloudflare Pages Function — POST /api/live/fb/connect
 *
 * Auto-provisions a Cloudflare Stream Live Input + a Facebook Live RTMP
 * output in one call, returning a ready-to-use WHIP URL the browser can
 * push to. Removes the manual two-tab dance through facebook.com/live/producer
 * + Cloudflare dashboard for every session.
 *
 * Honest constraint: browsers cannot speak RTMP, and Facebook Live only
 * accepts RTMP. So this function builds the relay path: browser → WHIP →
 * Cloudflare → RTMP → Facebook. We don't invent a "browser-direct FB Live"
 * because no such thing exists.
 *
 * One-time operator setup (Cloudflare Pages → southern-signal → Settings →
 * Environment variables):
 *   CF_ACCOUNT_ID         — your Cloudflare account ID
 *   CF_STREAM_API_TOKEN   — API token with Stream:Edit permission
 *   FB_CONNECT_TOKEN      — bearer token clients pass to call this endpoint
 *                           (any string you choose; share with the device)
 *   FB_CONNECT_STATE      - D1 binding for idempotency rows (required)
 *   AI_RATE_LIMIT         - optional KV binding for 3/day/IP connector cap
 *
 * The operator's Cloudflare Stream subscription is what carries the cost
 * ($5/month base + per-min charges). Without an active Stream subscription
 * the underlying API call will 4xx and we surface the message verbatim.
 *
 * Per-call body:
 *   { fb_stream_key: string,
 *     fb_rtmp_url?: string,   // defaults to Facebook's RTMPS ingest
 *     name?: string }         // optional human label on the CF Live Input
 * Required header:
 *   Idempotency-Key: 16-128 chars, stable for retries of the same request
 *
 * Response on success:
 *   { whip_url, input_uid, output_uid, fb_rtmp_url }
 */

import { readLimitedJson } from "../../_body";

interface Env {
  CF_ACCOUNT_ID?: string;
  CF_STREAM_API_TOKEN?: string;
  FB_CONNECT_TOKEN?: string;
  FB_CONNECT_STATE?: D1Database;
  AI_RATE_LIMIT?: KVNamespace;
  AI_RATE_LIMIT_SALT?: string;
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

interface ConnectBody {
  stream_key?: string;
  fb_stream_key?: string;
  fb_rtmp_url?: string;
  platform?: string;
  name?: string;
}

interface ConnectResponse {
  whip_url: string;
  input_uid: string;
  output_uid: string;
  fb_rtmp_url: string;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface D1Database {
  exec(query: string): Promise<unknown>;
  prepare(query: string): D1PreparedStatement;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<{ success: boolean; error?: string; meta?: { changes?: number } }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

interface RateState {
  used: number;
  cap: number;
  resetMs: number;
  key: string | null;
}

interface IdempotencyRow {
  idempotency_key: string;
  request_hash: string;
  status: "in_progress" | "succeeded" | "failed";
  response_json: string | null;
  error_json: string | null;
}

const DEFAULT_FB_RTMP = "rtmps://live-api-s.facebook.com:443/rtmp/";
const CF_API = "https://api.cloudflare.com/client/v4";
const MAX_BODY_BYTES = 4_000;
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const FB_CONNECT_RATE_LIMIT_CAP = 3;
const FB_CONNECT_RATE_LIMIT_WINDOW_HOURS = 24;

function jsonResponse(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key",
      ...extraHeaders,
    },
  });
}

function callerIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP")
    ?? request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim()
    ?? "unknown";
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashIp(ip: string, salt: string): Promise<string> {
  return (await sha256Hex(`${salt}:${ip}`)).slice(0, 24);
}

async function readRateLimit(kv: KVNamespace | undefined, ipHash: string): Promise<RateState> {
  const now = Date.now();
  const bucket = Math.floor(now / (FB_CONNECT_RATE_LIMIT_WINDOW_HOURS * 3_600_000));
  const nextBucketMs = (bucket + 1) * FB_CONNECT_RATE_LIMIT_WINDOW_HOURS * 3_600_000;
  const resetMs = Math.max(0, nextBucketMs - now);
  if (!kv) return { used: 0, cap: FB_CONNECT_RATE_LIMIT_CAP, resetMs, key: null };
  const key = `fb-connect:${ipHash}:${bucket}`;
  const raw = await kv.get(key);
  const used = raw == null ? 0 : Number.parseInt(raw, 10) || 0;
  return { used, cap: FB_CONNECT_RATE_LIMIT_CAP, resetMs, key };
}

async function recordRateLimitRun(kv: KVNamespace | undefined, state: RateState): Promise<void> {
  if (!kv || !state.key) return;
  await kv.put(state.key, String(state.used + 1), { expirationTtl: FB_CONNECT_RATE_LIMIT_WINDOW_HOURS * 3600 + 3600 });
}

function rateLimitHeaders(state: RateState): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(state.cap),
    "X-RateLimit-Remaining": String(Math.max(0, state.cap - state.used)),
    "X-RateLimit-Reset-Seconds": String(Math.round(state.resetMs / 1000)),
  };
}

function normaliseIdempotencyKey(request: Request): string | null {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key || key.length < 16 || key.length > 128) return null;
  return /^[A-Za-z0-9._:-]+$/.test(key) ? key : null;
}

async function ensureFbConnectSchema(db: D1Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS fb_live_connect_requests (
      idempotency_key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      response_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `.replace(/\n\s+/g, " "));
  await db.exec("CREATE INDEX IF NOT EXISTS idx_fb_live_connect_expires ON fb_live_connect_requests(expires_at);");
}

async function deleteExpiredIdempotencyRows(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM fb_live_connect_requests WHERE expires_at < ?").bind(new Date().toISOString()).run();
}

async function readIdempotencyRow(db: D1Database, key: string): Promise<IdempotencyRow | null> {
  return db.prepare(
    `SELECT idempotency_key, request_hash, status, response_json, error_json
     FROM fb_live_connect_requests WHERE idempotency_key = ?`,
  ).bind(key).first<IdempotencyRow>();
}

async function reserveIdempotencyKey(db: D1Database, key: string, requestHash: string): Promise<boolean> {
  const now = new Date();
  const expires = new Date(now.getTime() + IDEMPOTENCY_TTL_SECONDS * 1000);
  const result = await db.prepare(
    `INSERT INTO fb_live_connect_requests (idempotency_key, request_hash, status, created_at, updated_at, expires_at)
     VALUES (?, ?, 'in_progress', ?, ?, ?)
     ON CONFLICT(idempotency_key) DO UPDATE SET
       status = 'in_progress',
       error_json = NULL,
       updated_at = excluded.updated_at,
       expires_at = excluded.expires_at
     WHERE fb_live_connect_requests.status = 'failed'
       AND fb_live_connect_requests.request_hash = excluded.request_hash`,
  ).bind(key, requestHash, now.toISOString(), now.toISOString(), expires.toISOString()).run();
  if (typeof result.meta?.changes === "number") return result.meta.changes > 0;
  return true;
}

async function markIdempotencySucceeded(db: D1Database, key: string, response: ConnectResponse): Promise<void> {
  await db.prepare(
    `UPDATE fb_live_connect_requests
     SET status = 'succeeded', response_json = ?, error_json = NULL, updated_at = ?
     WHERE idempotency_key = ?`,
  ).bind(JSON.stringify(response), new Date().toISOString(), key).run();
}

async function markIdempotencyFailed(db: D1Database, key: string, error: unknown): Promise<void> {
  await db.prepare(
    `UPDATE fb_live_connect_requests
     SET status = 'failed', error_json = ?, updated_at = ?
     WHERE idempotency_key = ?`,
  ).bind(JSON.stringify(error).slice(0, 800), new Date().toISOString(), key).run();
}

export const onRequestOptions: PagesFn<Env> = async () => new Response(null, {
  status: 204,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key",
    "Access-Control-Max-Age": "86400",
  },
});

export const onRequestPost: PagesFn<Env> = async ({ request, env }) => {
  if (!env.FB_CONNECT_TOKEN || !env.CF_ACCOUNT_ID || !env.CF_STREAM_API_TOKEN) {
    return jsonResponse({
      error: "Cloudflare RTMP connector isn't configured on this deployment. Add CF_ACCOUNT_ID, CF_STREAM_API_TOKEN (Stream:Edit), and FB_CONNECT_TOKEN to Cloudflare Pages settings.",
    }, 503);
  }

  const auth = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match || match[1].trim() !== env.FB_CONNECT_TOKEN) {
    return jsonResponse({ error: "Unauthorized — bearer token does not match FB_CONNECT_TOKEN." }, 401);
  }

  if (!env.FB_CONNECT_STATE) {
    return jsonResponse({
      error: "Cloudflare RTMP connector requires the FB_CONNECT_STATE D1 binding so repeated calls cannot create duplicate paid Stream resources.",
    }, 503);
  }

  const bodyResult = await readLimitedJson<ConnectBody>(request, MAX_BODY_BYTES);
  if (!bodyResult.ok) return jsonResponse({ error: bodyResult.status === 413 ? "Body too large." : bodyResult.error }, bodyResult.status);
  const body = bodyResult.value;
  const fbStreamKey = (body.stream_key?.trim() || body.fb_stream_key?.trim() || "");
  if (!fbStreamKey) return jsonResponse({ error: "stream_key is required." }, 400);
  if (fbStreamKey.length > 200) return jsonResponse({ error: "stream_key looks too long." }, 400);
  const fbRtmpUrl = (body.fb_rtmp_url?.trim() || DEFAULT_FB_RTMP);
  if (!fbRtmpUrl.startsWith("rtmp://") && !fbRtmpUrl.startsWith("rtmps://")) {
    return jsonResponse({ error: "fb_rtmp_url must start with rtmp:// or rtmps://." }, 400);
  }
  const platform = (body.platform?.trim() || (fbRtmpUrl.includes("youtube") ? "YouTube Live" : "Facebook Live")).slice(0, 40);
  const name = (body.name?.trim() || `Southern Signal - ${platform} ${new Date().toISOString()}`).slice(0, 120);

  const idempotencyKey = normaliseIdempotencyKey(request);
  if (!idempotencyKey) {
    return jsonResponse({ error: "Idempotency-Key header is required (16-128 chars: letters, numbers, dot, underscore, colon, hyphen)." }, 400);
  }

  const stateDb = env.FB_CONNECT_STATE;
  await ensureFbConnectSchema(stateDb);
  await deleteExpiredIdempotencyRows(stateDb).catch(() => { /* best effort */ });

  const requestHash = await sha256Hex(JSON.stringify({
    fb_stream_key: fbStreamKey,
    fb_rtmp_url: fbRtmpUrl,
    platform,
    name: body.name?.trim() ?? "",
  }));
  const existing = await readIdempotencyRow(stateDb, idempotencyKey);
  if (existing) {
    if (existing.request_hash !== requestHash) {
      return jsonResponse({ error: "Idempotency-Key was reused with a different Facebook connector payload." }, 409);
    }
    if (existing.status === "succeeded" && existing.response_json) {
      return jsonResponse(JSON.parse(existing.response_json) as ConnectResponse, 200, { "Idempotency-Replayed": "true" });
    }
    if (existing.status === "in_progress") {
      return jsonResponse({ error: "A Facebook connector request with this Idempotency-Key is already in progress." }, 409, { "Retry-After": "10" });
    }
  }

  const salt = env.AI_RATE_LIMIT_SALT || "ss-fb-connect-v1";
  const ipHash = await hashIp(callerIp(request), salt);
  const rate = await readRateLimit(env.AI_RATE_LIMIT, ipHash);
  if (rate.used >= rate.cap) {
    return jsonResponse(
      { error: "Cloudflare RTMP connector rate limit reached.", retry_after_seconds: Math.round(rate.resetMs / 1000) },
      429,
      { "Retry-After": String(Math.round(rate.resetMs / 1000)), ...rateLimitHeaders(rate) },
    );
  }
  const reserved = await reserveIdempotencyKey(stateDb, idempotencyKey, requestHash);
  if (!reserved) {
    const current = await readIdempotencyRow(stateDb, idempotencyKey);
    if (current?.request_hash !== requestHash) {
      return jsonResponse({ error: "Idempotency-Key was reused with a different Facebook connector payload." }, 409);
    }
    if (current.status === "succeeded" && current.response_json) {
      return jsonResponse(JSON.parse(current.response_json) as ConnectResponse, 200, { "Idempotency-Replayed": "true" });
    }
    if (current.status === "in_progress") {
      return jsonResponse({ error: "A Facebook connector request with this Idempotency-Key is already in progress." }, 409, { "Retry-After": "10" });
    }
    return jsonResponse({ error: "A Facebook connector request with this Idempotency-Key could not be reserved." }, 409);
  }
  const consumedRate = { ...rate, used: rate.used + 1 };
  await recordRateLimitRun(env.AI_RATE_LIMIT, rate).catch(() => { /* best effort */ });

  const cfHeaders: Record<string, string> = {
    "Authorization": `Bearer ${env.CF_STREAM_API_TOKEN}`,
    "Content-Type": "application/json",
  };

  // 1. Create the Live Input.
  const inputResp = await fetch(`${CF_API}/accounts/${env.CF_ACCOUNT_ID}/stream/live_inputs`, {
    method: "POST",
    headers: cfHeaders,
    body: JSON.stringify({
      meta: { name },
      recording: { mode: "off" },
    }),
  });
  if (!inputResp.ok) {
    await markIdempotencyFailed(stateDb, idempotencyKey, { step: "live_inputs", status: inputResp.status }).catch(() => { /* ignore */ });
    return jsonResponse({
      error: `Cloudflare rejected live_inputs create (${inputResp.status}). Likely causes: API token lacks Stream:Edit, account has no Stream subscription, or wrong CF_ACCOUNT_ID.`,
      cf_status: inputResp.status,
      step: "live_inputs",
    }, 502);
  }
  const inputJson = await inputResp.json() as { result?: { uid?: string; webRTC?: { url?: string } } };
  const inputUid = inputJson.result?.uid;
  const whipUrl = inputJson.result?.webRTC?.url;
  if (!inputUid || !whipUrl) {
    await markIdempotencyFailed(stateDb, idempotencyKey, { step: "live_inputs_parse", response: inputJson }).catch(() => { /* ignore */ });
    return jsonResponse({ error: "Cloudflare returned no input UID or WebRTC URL.", cf_response: inputJson }, 502);
  }

  // 2. Add the platform as an RTMP output on the input.
  const outputResp = await fetch(`${CF_API}/accounts/${env.CF_ACCOUNT_ID}/stream/live_inputs/${inputUid}/outputs`, {
    method: "POST",
    headers: cfHeaders,
    body: JSON.stringify({
      url: fbRtmpUrl,
      streamKey: fbStreamKey,
      enabled: true,
    }),
  });
  if (!outputResp.ok) {
    // Best-effort cleanup: delete the input we just made so the operator
    // doesn't accumulate orphaned inputs on their account.
    void fetch(`${CF_API}/accounts/${env.CF_ACCOUNT_ID}/stream/live_inputs/${inputUid}`, {
      method: "DELETE",
      headers: cfHeaders,
    }).catch(() => { /* swallow */ });
    await markIdempotencyFailed(stateDb, idempotencyKey, { step: "outputs", status: outputResp.status }).catch(() => { /* ignore */ });
    return jsonResponse({
      error: `Cloudflare rejected outputs create (${outputResp.status}). Live Input rolled back. Check that the ${platform} stream key + RTMP URL are valid.`,
      cf_status: outputResp.status,
      step: "outputs",
    }, 502);
  }
  const outputJson = await outputResp.json() as { result?: { uid?: string } };
  const outputUid = outputJson.result?.uid ?? "unknown";

  const responseBody: ConnectResponse = {
    whip_url: whipUrl,
    input_uid: inputUid,
    output_uid: outputUid,
    fb_rtmp_url: fbRtmpUrl,
  };
  await markIdempotencySucceeded(stateDb, idempotencyKey, responseBody);
  return jsonResponse(responseBody, 200, rateLimitHeaders(consumedRate));
};
