/**
 * Cloudflare Pages Function — /api/community/sites
 *
 *   POST   publish a pin (rate-limited 10/day/IP)
 *   GET    list pins inside a bounding box (paginated, hidden filtered)
 *   DELETE remove a pin matching {id, anonymous_id}
 *
 * Returns 503 if the COMMUNITY_DB binding is missing so the client can
 * surface "Map disabled on this deployment" instead of failing opaque.
 *
 * The "anonymous_id" pattern: the PWA mints a UUID on first publish and
 * stores it in localStorage. Pin ownership is verified by matching that
 * id at delete-time. No accounts, no email. Trade-off: lose your device
 * = lose the ability to delete your own pins.
 *
 * Coordinates are coarsened to ~100 m at write time so houses can't be
 * pin-pointed.
 */

import {
  callerIp,
  coarsenCoord,
  corsHeaders,
  ensureCommunitySchema,
  hashIp,
  isValidLatLon,
  isValidUuid,
  jsonResponse,
  type CommunityEnv,
  type PagesFn,
  MAX_BODY_BYTES,
  rateLimitHeaders,
  readRateLimit,
  recordRateLimitRun,
  sanitiseText,
} from "./_shared";

interface PinRow {
  id: string;
  anonymous_id: string;
  venue_name: string;
  lat: number;
  lon: number;
  region: string | null;
  posterior: number | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  hidden: number;
}

interface PinPublic {
  id: string;
  venue_name: string;
  lat: number;
  lon: number;
  region: string | null;
  posterior: number | null;
  note: string | null;
  created_at: string;
  /** Echo back so the caller can show "yours" UI for pins this device owns. */
  is_yours: boolean;
}

export const onRequestOptions: PagesFn<CommunityEnv> = async () => new Response(null, {
  status: 204,
  headers: { ...corsHeaders(), "Access-Control-Max-Age": "86400" },
});

export const onRequestPost: PagesFn<CommunityEnv> = async ({ request, env }) => {
  if (!env.COMMUNITY_DB) return jsonResponse({ error: "Community map is not configured on this deployment." }, 503);

  const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_BODY_BYTES) return jsonResponse({ error: "Payload too large." }, 413);

  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return jsonResponse({ error: "Invalid JSON body." }, 400); }

  const venue = sanitiseText(body.venue_name, 120);
  const note = sanitiseText(body.note, 280);
  const lat = body.lat;
  const lon = body.lon;
  const region = sanitiseText(body.region, 24);
  const posteriorRaw = body.posterior;
  const anonId = body.anonymous_id;

  if (!venue) return jsonResponse({ error: "venue_name is required." }, 400);
  if (!isValidLatLon(lat, lon)) return jsonResponse({ error: "lat / lon must be finite, within ±90/±180." }, 400);
  if (!isValidUuid(anonId)) return jsonResponse({ error: "anonymous_id must be a UUID." }, 400);
  let posterior: number | null = null;
  if (posteriorRaw != null) {
    if (typeof posteriorRaw !== "number" || !Number.isFinite(posteriorRaw) || posteriorRaw < 0 || posteriorRaw > 1) {
      return jsonResponse({ error: "posterior must be a finite number in [0, 1]." }, 400);
    }
    posterior = posteriorRaw;
  }

  // Rate limit by IP — KV-backed when present, no-op otherwise.
  const ip = callerIp(request);
  const salt = env.AI_RATE_LIMIT_SALT ?? "no-salt";
  const ipHash = await hashIp(ip, salt);
  const rl = await readRateLimit(env.AI_RATE_LIMIT, ipHash);
  if (rl.used >= rl.cap) {
    return jsonResponse(
      { error: `Rate limit reached. Try again in ${Math.ceil(rl.resetMs / 3600000)}h.` },
      429,
      rateLimitHeaders(rl),
    );
  }

  await ensureCommunitySchema(env.COMMUNITY_DB);

  const id = (typeof body.id === "string" && isValidUuid(body.id)) ? body.id : crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const cLat = coarsenCoord(lat as number);
  const cLon = coarsenCoord(lon as number);

  try {
    // Upsert by id — the PWA may republish the same case after edits.
    await env.COMMUNITY_DB.prepare(
      `INSERT INTO community_sites (id, anonymous_id, venue_name, lat, lon, region, posterior, note, created_at, updated_at, hidden)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(id) DO UPDATE SET
         venue_name = excluded.venue_name,
         lat = excluded.lat,
         lon = excluded.lon,
         region = excluded.region,
         posterior = excluded.posterior,
         note = excluded.note,
         updated_at = excluded.updated_at
       WHERE community_sites.anonymous_id = excluded.anonymous_id`,
    ).bind(id, anonId, venue, cLat, cLon, region, posterior, note, nowIso, nowIso).run();
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message.slice(0, 200) : "db write failed" }, 500);
  }

  await recordRateLimitRun(env.AI_RATE_LIMIT, rl);

  const response: { ok: true; id: string; lat: number; lon: number } = { ok: true, id, lat: cLat, lon: cLon };
  return jsonResponse(response, 200, rateLimitHeaders(rl));
};

export const onRequestGet: PagesFn<CommunityEnv> = async ({ request, env }) => {
  if (!env.COMMUNITY_DB) return jsonResponse({ error: "Community map is not configured on this deployment." }, 503);

  const url = new URL(request.url);
  // Optional bbox filter: bbox=minLat,minLon,maxLat,maxLon
  const bboxParam = url.searchParams.get("bbox");
  const limitParam = parseInt(url.searchParams.get("limit") ?? "200", 10);
  const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 200, 1), 500);
  const yourId = url.searchParams.get("anonymous_id");
  const yourIdValid = isValidUuid(yourId);

  await ensureCommunitySchema(env.COMMUNITY_DB);

  let rows: PinRow[];
  try {
    if (bboxParam) {
      const parts = bboxParam.split(",").map(parseFloat);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        return jsonResponse({ error: "bbox must be minLat,minLon,maxLat,maxLon" }, 400);
      }
      const [minLat, minLon, maxLat, maxLon] = parts;
      const r = await env.COMMUNITY_DB.prepare(
        `SELECT * FROM community_sites
         WHERE hidden = 0 AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
         ORDER BY updated_at DESC
         LIMIT ?`,
      ).bind(minLat, maxLat, minLon, maxLon, limit).all<PinRow>();
      rows = r.results;
    } else {
      const r = await env.COMMUNITY_DB.prepare(
        `SELECT * FROM community_sites
         WHERE hidden = 0
         ORDER BY updated_at DESC
         LIMIT ?`,
      ).bind(limit).all<PinRow>();
      rows = r.results;
    }
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message.slice(0, 200) : "db read failed" }, 500);
  }

  const public_rows: PinPublic[] = rows.map((r) => ({
    id: r.id,
    venue_name: r.venue_name,
    lat: r.lat,
    lon: r.lon,
    region: r.region,
    posterior: r.posterior,
    note: r.note,
    created_at: r.created_at,
    is_yours: yourIdValid ? r.anonymous_id === yourId : false,
  }));

  return jsonResponse({ pins: public_rows, count: public_rows.length });
};

export const onRequestDelete: PagesFn<CommunityEnv> = async ({ request, env }) => {
  if (!env.COMMUNITY_DB) return jsonResponse({ error: "Community map is not configured on this deployment." }, 503);

  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return jsonResponse({ error: "Invalid JSON body." }, 400); }

  const id = body.id;
  const anonId = body.anonymous_id;
  if (typeof id !== "string" || !id) return jsonResponse({ error: "id required" }, 400);
  if (!isValidUuid(anonId)) return jsonResponse({ error: "anonymous_id must be a UUID." }, 400);

  await ensureCommunitySchema(env.COMMUNITY_DB);

  try {
    const r = await env.COMMUNITY_DB.prepare(
      `DELETE FROM community_sites WHERE id = ? AND anonymous_id = ?`,
    ).bind(id, anonId).run();
    if (!r.success) return jsonResponse({ error: r.error ?? "delete failed" }, 500);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message.slice(0, 200) : "db delete failed" }, 500);
  }
  return jsonResponse({ ok: true });
};
