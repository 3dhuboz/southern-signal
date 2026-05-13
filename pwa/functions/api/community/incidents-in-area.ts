/**
 * Cloudflare Pages Function — POST /api/community/incidents-in-area
 *
 *   Body: { bbox: { minLat, minLon, maxLat, maxLon }, region: "AU" | "GLOBAL" }
 *
 * Returns AI-surfaced DOCUMENTED INCIDENTS — deaths, fatal fires, court
 * records, coroner's inquests, heritage-listed disasters — inside the
 * given bounding box, with cited sources and approximate lat/lon for
 * each. Results are cached server-side in D1 keyed by a coarse cell so
 * two operators looking at the same region share the cache.
 *
 * Cache lifecycle:
 *   - Rolled-up cell key = `${region}:${roundedBbox}` at 0.1° precision
 *   - 30-day TTL — incidents don't move; this trades freshness for cost
 *   - Cache hits skip Sonar entirely (no rate-limit increment)
 *
 * Sonar prompt is incident-focused (NOT heritage). Each finding includes
 * lat/lon so the client can plot it; if lat/lon is missing the pin just
 * doesn't render — never plot a bad coordinate.
 *
 * 503 when OPENROUTER_API_KEY or COMMUNITY_DB are missing — the map UI
 * surfaces this as "Area incident search not configured on this
 * deployment" rather than failing opaque.
 */

import {
  AREA_CACHE_TTL_MS,
  bboxCellKey,
  callerIp,
  corsHeaders,
  ensureCommunitySchema,
  hashIp,
  jsonResponse,
  type CommunityEnv,
  type D1Database,
  type PagesFn,
  rateLimitHeaders,
  readRateLimit,
  recordRateLimitRun,
} from "./_shared";

interface Env extends CommunityEnv {
  OPENROUTER_API_KEY?: string;
  OPENROUTER_RESEARCH_MODEL?: string;
}

interface BBox { minLat: number; minLon: number; maxLat: number; maxLon: number }

interface IncidentSource { label: string; url: string }
interface Incident {
  title: string;
  body: string;
  severity: "fatal" | "serious" | "minor" | "unknown";
  year: number | null;
  lat: number;
  lon: number;
  sources: IncidentSource[];
}

interface AreaResult {
  incidents: Incident[];
  search_terms_used: string[];
  notes: string;
  model: string;
}

const DEFAULT_MODEL = "perplexity/sonar";
const MAX_BBOX_DEG = 2.0; // Reject giant bboxes — a continent-wide search wastes the quota.

function isValidBBox(b: unknown): b is BBox {
  if (!b || typeof b !== "object") return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o.minLat === "number" && typeof o.minLon === "number" &&
    typeof o.maxLat === "number" && typeof o.maxLon === "number" &&
    Number.isFinite(o.minLat) && Number.isFinite(o.minLon) &&
    Number.isFinite(o.maxLat) && Number.isFinite(o.maxLon) &&
    Math.abs(o.minLat) <= 90 && Math.abs(o.maxLat) <= 90 &&
    Math.abs(o.minLon) <= 180 && Math.abs(o.maxLon) <= 180 &&
    o.minLat < o.maxLat && o.minLon < o.maxLon
  );
}

function bboxSpan(b: BBox): number {
  return Math.max(b.maxLat - b.minLat, b.maxLon - b.minLon);
}

function buildSystemPrompt(region: "AU" | "GLOBAL"): string {
  const sourcesBlock = region === "AU" ? `
PREFERRED SOURCES (Australia, in order):
  1. Trove — National Library newspaper / document archive
  2. AustLII — court records and case law
  3. State coroner reports (Qld, NSW, Vic, SA, WA, Tas, NT, ACT)
  4. State BDM registers (deaths)
  5. Regional Australian newspapers — Courier-Mail, ABC News, news.com.au,
     The Morning Bulletin (Central Qld), Cairns Post, Townsville Bulletin,
     NT News, Mercury (Tas), Advertiser (SA), West Australian.
  6. State heritage registers (only for incidents on heritage-listed sites)` : `
PREFERRED SOURCES (global):
  1. Government coroner / court records
  2. Major newspaper archives (Newspapers.com, archive.org, JSTOR)
  3. Regional news outlets for the country in scope
  4. National heritage registers (only for incidents on listed sites)`;

  return `You are a forensic news researcher. Find DOCUMENTED INCIDENTS — deaths, murders, fatal fires, fatal accidents, serious court cases, coroner's inquests, mass-casualty events — within a geographic bounding box. Every claim must cite a real source you accessed during the search.

HARD RULES:
1. ONLY return events you can cite from a real source. If you cannot find a citable source for an event, do NOT include it. Folklore / ghost-tour claims are out of scope.
2. Each incident MUST include an approximate latitude/longitude inside or very near the bounding box. If you can't determine coordinates from the source's address, infer them from the named suburb/town and round to ~3 decimals — but do NOT include the incident if you can't put it on the map.
3. Be terse: 1-3 sentence body per incident. Operators read these on a phone in the field.
4. SEARCH BROADLY: run queries against the suburb/town and against major streets within the bbox; include terms like "death", "murder", "fatal", "fire", "inquest", "coroner", "court", "missing person".
5. Skip living people's privacy: never include private contact info; victim names from published news are OK to repeat (they're already public record).

${sourcesBlock}

OUTPUT FORMAT — strict JSON. No markdown fences, no commentary outside the JSON object:
{
  "incidents": [
    {
      "title": "Short title (≤ 80 chars)",
      "body": "1-3 sentence factual paragraph with year + location.",
      "severity": "fatal" | "serious" | "minor" | "unknown",
      "year": 2017,
      "lat": -23.412,
      "lon": 150.523,
      "sources": [{ "label": "Human-readable name", "url": "https://..." }]
    }
  ],
  "search_terms_used": ["string", "string"],
  "notes": "1-2 sentence summary of what you searched and any caveats."
}

If you find nothing supportable in this bounding box, return incidents: [] with notes explaining what searches you ran.`;
}

function buildUserPrompt(bbox: BBox, region: "AU" | "GLOBAL"): string {
  return `Search documented incidents inside this bounding box:
  minLat: ${bbox.minLat.toFixed(4)}
  minLon: ${bbox.minLon.toFixed(4)}
  maxLat: ${bbox.maxLat.toFixed(4)}
  maxLon: ${bbox.maxLon.toFixed(4)}

Region: ${region}

Identify the major towns/suburbs/streets inside this box first, then run incident-news queries against them. Plot each finding with approximate lat/lon. Return JSON per the system-prompt schema.`;
}

function pickIncidentNumber(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

function pickSeverity(v: unknown): Incident["severity"] {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  if (s === "fatal" || s === "serious" || s === "minor" || s === "unknown") return s;
  return "unknown";
}

function validateIncident(raw: unknown, bbox: BBox): Incident | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === "string" ? o.title.slice(0, 120) : "";
  const body = typeof o.body === "string" ? o.body.slice(0, 1200) : "";
  const lat = pickIncidentNumber(o.lat);
  const lon = pickIncidentNumber(o.lon);
  if (!title || !body || lat == null || lon == null) return null;
  // Reject pins more than 0.5° outside the bbox — Sonar sometimes wanders.
  const pad = 0.5;
  if (lat < bbox.minLat - pad || lat > bbox.maxLat + pad) return null;
  if (lon < bbox.minLon - pad || lon > bbox.maxLon + pad) return null;
  const year = pickIncidentNumber(o.year);
  const sources: IncidentSource[] = [];
  if (Array.isArray(o.sources)) {
    for (const s of o.sources) {
      if (!s || typeof s !== "object") continue;
      const sr = s as Record<string, unknown>;
      const url = typeof sr.url === "string" ? sr.url.trim() : "";
      const label = typeof sr.label === "string" ? sr.label.trim() : "";
      if (!url) continue;
      try {
        const u = new URL(url);
        if (u.protocol !== "http:" && u.protocol !== "https:") continue;
        sources.push({ label: label || u.hostname, url });
      } catch { /* malformed url — skip */ }
    }
  }
  // No source = synthesis, not a documented incident. Drop it.
  if (sources.length === 0) return null;
  return { title, body, severity: pickSeverity(o.severity), year: year != null ? Math.round(year) : null, lat, lon, sources };
}

async function callSonar(env: Env, bbox: BBox, region: "AU" | "GLOBAL"): Promise<{ result: AreaResult } | { error: string }> {
  const model = env.OPENROUTER_RESEARCH_MODEL || DEFAULT_MODEL;
  const body = {
    model,
    messages: [
      { role: "system", content: buildSystemPrompt(region) },
      { role: "user", content: buildUserPrompt(bbox, region) },
    ],
    temperature: 0.1,
    max_tokens: 2200,
  };
  let resp: Response;
  try {
    resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "X-Title": "Southern Signal · Area Incidents",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { error: `Network error contacting OpenRouter: ${(err as Error).message.slice(0, 160)}` };
  }
  if (!resp.ok) {
    let detail = "";
    try { detail = (await resp.text()).slice(0, 240); } catch { /* */ }
    return { error: `OpenRouter HTTP ${resp.status}${detail ? ` — ${detail}` : ""}` };
  }
  let payload: { choices?: { message?: { content?: string } }[] };
  try { payload = await resp.json() as typeof payload; } catch (err) { return { error: `Bad JSON from OpenRouter: ${(err as Error).message.slice(0, 160)}` }; }
  const content = payload.choices?.[0]?.message?.content ?? "";
  if (!content) return { error: "Sonar returned an empty completion." };
  // Sonar sometimes wraps in markdown — strip ```json fences if present.
  const stripped = content.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  let parsed: { incidents?: unknown; search_terms_used?: unknown; notes?: unknown };
  try { parsed = JSON.parse(stripped) as typeof parsed; } catch (err) {
    return { error: `Sonar returned non-JSON content: ${(err as Error).message.slice(0, 160)}` };
  }
  const incidents: Incident[] = [];
  if (Array.isArray(parsed.incidents)) {
    for (const raw of parsed.incidents) {
      const inc = validateIncident(raw, bbox);
      if (inc) incidents.push(inc);
    }
  }
  const search_terms_used = Array.isArray(parsed.search_terms_used)
    ? (parsed.search_terms_used as unknown[]).filter((s): s is string => typeof s === "string").slice(0, 24)
    : [];
  const notes = typeof parsed.notes === "string" ? parsed.notes.slice(0, 480) : "";
  return { result: { incidents, search_terms_used, notes, model } };
}

async function readCache(db: D1Database, cellKey: string): Promise<{ result: AreaResult; created_at: string } | null> {
  try {
    const row = await db.prepare(
      `SELECT payload_json, model, created_at, expires_at FROM area_incident_cache WHERE cell_key = ?`,
    ).bind(cellKey).first<{ payload_json: string; model: string; created_at: string; expires_at: string }>();
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) return null;
    const parsed = JSON.parse(row.payload_json) as Omit<AreaResult, "model">;
    return { result: { ...parsed, model: row.model }, created_at: row.created_at };
  } catch {
    return null;
  }
}

async function writeCache(db: D1Database, cellKey: string, region: string, bbox: BBox, result: AreaResult): Promise<void> {
  const now = Date.now();
  const created = new Date(now).toISOString();
  const expires = new Date(now + AREA_CACHE_TTL_MS).toISOString();
  const payload = { incidents: result.incidents, search_terms_used: result.search_terms_used, notes: result.notes };
  try {
    await db.prepare(
      `INSERT INTO area_incident_cache (cell_key, region, bbox_min_lat, bbox_min_lon, bbox_max_lat, bbox_max_lon, payload_json, model, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cell_key) DO UPDATE SET
         payload_json = excluded.payload_json,
         model = excluded.model,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at`,
    ).bind(cellKey, region, bbox.minLat, bbox.minLon, bbox.maxLat, bbox.maxLon, JSON.stringify(payload), result.model, created, expires).run();
  } catch (err) {
    // Cache miss-write is non-fatal — the operator still gets the result.
    console.warn("[area-incidents] cache write failed", err);
  }
}

export const onRequestOptions: PagesFn<Env> = async () => new Response(null, {
  status: 204,
  headers: { ...corsHeaders(), "Access-Control-Max-Age": "86400" },
});

export const onRequestPost: PagesFn<Env> = async ({ request, env }) => {
  if (!env.COMMUNITY_DB) return jsonResponse({ error: "Area incident search is not configured on this deployment (COMMUNITY_DB binding missing)." }, 503);
  if (!env.OPENROUTER_API_KEY) return jsonResponse({ error: "Area incident search is not configured on this deployment (OPENROUTER_API_KEY missing)." }, 503);

  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return jsonResponse({ error: "Invalid JSON body." }, 400); }
  const bbox = body.bbox;
  const region = body.region === "GLOBAL" ? "GLOBAL" : "AU";
  if (!isValidBBox(bbox)) return jsonResponse({ error: "bbox must be {minLat, minLon, maxLat, maxLon} with finite values and min < max." }, 400);
  if (bboxSpan(bbox) > MAX_BBOX_DEG) return jsonResponse({ error: `Bounding box too large (${bboxSpan(bbox).toFixed(2)}°). Zoom in to ≤ ${MAX_BBOX_DEG}° span.` }, 400);

  await ensureCommunitySchema(env.COMMUNITY_DB);
  const cellKey = bboxCellKey(region, bbox);

  // Cache hit — skip Sonar entirely.
  const cached = await readCache(env.COMMUNITY_DB, cellKey);
  if (cached) {
    const ageMs = Date.now() - new Date(cached.created_at).getTime();
    return jsonResponse({
      incidents: cached.result.incidents,
      search_terms_used: cached.result.search_terms_used,
      notes: cached.result.notes,
      model: cached.result.model,
      cached: true,
      cache_age_seconds: Math.round(ageMs / 1000),
      cell_key: cellKey,
    });
  }

  // Rate-limit cache misses. Reuses the AI rate-limit KV for parity with
  // the venue-level investigator — they share the operator's daily quota.
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

  const ai = await callSonar(env, bbox, region);
  if ("error" in ai) return jsonResponse({ error: ai.error }, 502);
  await writeCache(env.COMMUNITY_DB, cellKey, region, bbox, ai.result);
  await recordRateLimitRun(env.AI_RATE_LIMIT, rl);

  return jsonResponse({
    incidents: ai.result.incidents,
    search_terms_used: ai.result.search_terms_used,
    notes: ai.result.notes,
    model: ai.result.model,
    cached: false,
    cache_age_seconds: 0,
    cell_key: cellKey,
  }, 200, rateLimitHeaders(rl));
};
