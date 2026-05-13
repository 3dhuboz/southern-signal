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
type SourceQuality = "primary" | "secondary" | "anecdotal";
interface Incident {
  title: string;
  body: string;
  severity: "fatal" | "serious" | "minor" | "unknown";
  /** How well-cited the incident is.
   *  primary    = court records, coroner reports, named newspaper articles
   *               (Trove, ABC News, regional paper, Courier-Mail, etc.).
   *  secondary  = Wikipedia, heritage register, news.com.au listicle
   *               citing primary sources.
   *  anecdotal  = blog, forum, ghost-tour write-up referencing a real
   *               event without direct primary citation — operator
   *               should verify before quoting on camera. */
  source_quality: SourceQuality;
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

// sonar-pro vs sonar: pro runs deeper web searches and returns more
// citations per finding. For an area-incident sweep across regional
// Australian news (Trove, Courier-Mail, Morning Bulletin paywalls, AustLII
// court records) the basic sonar tier kept returning zero results even
// with aggressive prompting. Costs ~3-5x more per request but server-side
// caching at the 0.1° cell amortises this — pop hotspots only ever cost
// once per 30 days collectively.
const DEFAULT_MODEL = "perplexity/sonar-pro";
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
SOURCE LADDER (Australia — prefer higher tiers but DON'T discard lower tiers, label them with source_quality instead):

  PRIMARY (source_quality: "primary"):
    - Trove — https://trove.nla.gov.au/search/category/newspapers?keyword=...
    - AustLII — https://www.austlii.edu.au + state coroner court databases
    - State coroner / Magistrates' court reports (Qld Courts, NSW Courts, etc.)
    - Named regional Australian newspaper articles — Courier-Mail (qld),
      Brisbane Times, ABC News, The Age, SMH, news.com.au, The Morning
      Bulletin (Central Qld), Cairns Post, Townsville Bulletin, Daily
      Mercury (Mackay), NT News, Mercury (Tas), Advertiser (SA), West
      Australian, Geraldton Guardian, Examiner (Launceston).
    - Trove direct newspaper search even if paywalled (cite the URL).
    - State heritage registers when the incident is part of a listed site.

  SECONDARY (source_quality: "secondary"):
    - Wikipedia articles that cite primary sources (deep-link to the article).
    - Local council heritage citations that mention incidents.
    - True-crime databases / state library catalogues / archive.org
      snapshots of news.

  ANECDOTAL (source_quality: "anecdotal"):
    - "Haunted places" sites, ghost-tour pages, paranormal blogs, Reddit
      posts that reference a real-sounding incident without primary
      citation. Include ONLY when (a) you can't find a primary source
      but the incident is referenced consistently across multiple such
      sites, and (b) you flag it as anecdotal so the operator knows to
      verify before quoting on camera.` : `
SOURCE LADDER (global — prefer higher tiers, label lower with source_quality):

  PRIMARY:    Government coroner / court records, named newspaper articles
              (Newspapers.com, archive.org, JSTOR), national broadcasters.
  SECONDARY:  Wikipedia citing primary sources, heritage registers,
              archive snapshots.
  ANECDOTAL:  Blogs, forums, "haunted places" lists referencing real
              events without primary citation.`;

  return `You are a forensic news researcher. Find DOCUMENTED INCIDENTS — deaths, murders, fatal fires, fatal accidents, serious court cases, coroner's inquests, mass-casualty events, suicides, disappearances, child fatalities, drownings — within a geographic bounding box. Cite every claim.

HARD RULES:
1. EVERY incident MUST cite at least one real source URL you accessed. No sources → drop the incident.
2. Each incident MUST include an approximate latitude/longitude inside or very near the bounding box. If the source gives an address, geocode it (you may estimate from suburb/town if the street isn't specified). Drop incidents you cannot place on the map.
3. Be terse: 1-3 sentence body per incident, with year + suburb + 1-line factual summary.
4. Living-people privacy: don't include private contact details. Victim names already published in mainstream news are public record — repeat them as the source did.

SEARCH AGGRESSIVELY — operators have complained that the model returns empty results for regions they know have documented incidents. Don't give up after one query. Execute AT LEAST 6 distinct searches before returning [], including:

  (a) The TOWN name + each event term separately:
        "<town> murder", "<town> fatal fire", "<town> coroner inquest",
        "<town> drowning", "<town> child death", "<town> missing person"
  (b) Each major SUBURB inside the bbox + the same event terms.
  (c) Trove direct: site:trove.nla.gov.au "<town>" murder OR death
  (d) AustLII direct: site:austlii.edu.au "<town>"
  (e) Newspaper-name-prefixed: site:couriermail.com.au "<suburb>",
      site:abc.net.au "<town>" death, site:themorningbulletin.com.au …
  (f) For pre-2000 events: Trove digitised newspapers — these
      are the richest single source of historical incidents in Australia.

WHAT IF YOU FIND ONLY WEAK SOURCES? Don't drop the lead. Return it with source_quality: "anecdotal" or "secondary" and the citations you have. Operators want to know WHERE to dig further — false-negative is worse than a flagged weak finding.

${sourcesBlock}

OUTPUT FORMAT — strict JSON. No markdown fences, no commentary outside the JSON object:
{
  "incidents": [
    {
      "title": "Short title (≤ 80 chars)",
      "body": "1-3 sentence factual paragraph with year + location.",
      "severity": "fatal" | "serious" | "minor" | "unknown",
      "source_quality": "primary" | "secondary" | "anecdotal",
      "year": 2017,
      "lat": -23.412,
      "lon": 150.523,
      "sources": [{ "label": "Human-readable name", "url": "https://..." }]
    }
  ],
  "search_terms_used": ["query 1", "query 2", ...],
  "notes": "1-2 sentence summary of what you searched and any caveats."
}

If you genuinely find nothing supportable across all 6+ searches, return incidents: [] with notes explaining EXACTLY which searches you ran and what you tried.`;
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

function pickSourceQuality(v: unknown): SourceQuality {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  if (s === "primary" || s === "secondary" || s === "anecdotal") return s;
  // Default to secondary — neither over-promising nor dropping the lead.
  return "secondary";
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
  return {
    title,
    body,
    severity: pickSeverity(o.severity),
    source_quality: pickSourceQuality(o.source_quality),
    year: year != null ? Math.round(year) : null,
    lat,
    lon,
    sources,
  };
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
    max_tokens: 4000,
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
  // Don't poison the cache with empty results. Sonar's coverage of
  // regional Australian news is patchy — a "no incidents" return today
  // may become a hit tomorrow as the prompt or model improves. Caching
  // empty responses would lock the operator out of fresh searches for
  // 30 days for no benefit. Only persist findings worth re-serving.
  if (ai.result.incidents.length > 0) {
    await writeCache(env.COMMUNITY_DB, cellKey, region, bbox, ai.result);
  }
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
