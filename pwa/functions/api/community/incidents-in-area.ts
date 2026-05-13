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
  /** Trove API v3 key — free at https://trove.nla.gov.au/about/create-something/using-api/api-keys
   *  Set via `wrangler pages secret put TROVE_API_KEY`. When present,
   *  every AU bbox search hits Trove (digitised newspapers, 1803-2010+)
   *  in parallel with Sonar and merges the results — guarantees real
   *  primary-source citations even when Sonar's web crawl can't reach
   *  paywalled regional outlets. */
  TROVE_API_KEY?: string;
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

// ---------------------- Trove direct-API integration ----------------------
//
// Trove's REST API is the National Library of Australia's interface to its
// fully digitised newspaper archive (~1803 → mid-2010s, depending on title)
// plus government gazettes, books, manuscripts. For our purpose — primary-
// source incident reporting in Australian towns — it is the single most
// reliable substrate. Coverage is especially strong for regional papers
// (Morning Bulletin, Cairns Post, Geraldton Guardian, etc.) that Sonar's
// general web crawl can't paywall-bypass.
//
// Flow:
//   bbox → Nominatim reverse-geocode the bbox centre → town name →
//   Trove keyword query `<town> (murder OR death OR fatal OR ...)`
//   → parse articles → place pins at the bbox centre with a small
//   per-row jitter so they don't stack on the map.
//
// Trove articles don't ship with geocoordinates, so we anchor at the
// bbox centre + jitter. The popup quotes the paper name + date so the
// operator knows the geographic precision is approximate.

interface TroveArticle {
  id?: string;
  heading?: string;
  snippet?: string;
  date?: string;
  troveUrl?: string;
  identifier?: string;
  title?: { id?: number; title?: string };
}

interface TroveResponse {
  category?: Array<{
    code?: string;
    records?: { total?: number; article?: TroveArticle[] };
  }>;
}

interface NominatimResponse {
  address?: { city?: string; town?: string; village?: string; suburb?: string; municipality?: string; state?: string };
}

/** Reverse-geocode the bbox centre via Nominatim (OSM, free, no key).
 *  Returns null if the network call fails — we then skip Trove silently
 *  rather than crashing the whole endpoint. */
async function reverseGeocodeBboxCentre(bbox: BBox): Promise<{ town: string | null; state: string | null }> {
  const lat = (bbox.minLat + bbox.maxLat) / 2;
  const lon = (bbox.minLon + bbox.maxLon) / 2;
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=12&accept-language=en`;
  try {
    const resp = await fetch(url, {
      headers: {
        // Nominatim asks for an identifying UA; their TOS requires it.
        "User-Agent": "southern-signal/1.0 (https://southern-signal.pages.dev)",
      },
      cf: { cacheTtl: 86400 }, // edge-cache the same bbox geocode for a day
    });
    if (!resp.ok) return { town: null, state: null };
    const data = await resp.json() as NominatimResponse;
    const a = data.address ?? {};
    return {
      town: a.city ?? a.town ?? a.municipality ?? a.village ?? a.suburb ?? null,
      state: a.state ?? null,
    };
  } catch {
    return { town: null, state: null };
  }
}

/** Heuristic severity inference from Trove article heading + snippet.
 *  Conservative: matches on explicit fatality words only; everything
 *  else defaults to "unknown" so we don't over-promise. */
function inferTroveSeverity(text: string): Incident["severity"] {
  const t = text.toLowerCase();
  if (/\b(murder|killed|fatal|drowned|deceased|coroner|inquest|stabbed|shot dead|shooting death)\b/.test(t)) return "fatal";
  if (/\b(serious|injured|crash|fire|robbery|assault|hospitalised|gravely)\b/.test(t)) return "serious";
  return "unknown";
}

/** Strip Trove's <font>...</font> highlighting markup from snippets so
 *  the popup body stays plain text. */
function stripMarkup(s: string | undefined): string {
  if (!s) return "";
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

async function searchTrove(env: Env, bbox: BBox, town: string | null, _state: string | null): Promise<{ incidents: Incident[]; queries: string[]; notes: string }> {
  if (!env.TROVE_API_KEY) return { incidents: [], queries: [], notes: "Trove disabled (TROVE_API_KEY not set on this deployment)." };
  if (!town) return { incidents: [], queries: [], notes: "Trove skipped — couldn't reverse-geocode the bbox centre to a town name." };

  // One broad query, scoped to newspapers. Trove's relevance ranking is
  // strong enough that 25 results covers the high-signal hits.
  const incidentTerms = '(murder OR death OR fatal OR fire OR drowned OR coroner OR inquest OR "missing person" OR stabbed OR shooting)';
  const q = `"${town}" ${incidentTerms}`;
  const url = `https://api.trove.nla.gov.au/v3/result?category=newspaper&encoding=json&n=25&q=${encodeURIComponent(q)}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { "X-API-KEY": env.TROVE_API_KEY, "Accept": "application/json" },
    });
  } catch (err) {
    return { incidents: [], queries: [q], notes: `Trove network error: ${(err as Error).message.slice(0, 120)}` };
  }
  if (!resp.ok) {
    return { incidents: [], queries: [q], notes: `Trove HTTP ${resp.status}` };
  }
  let data: TroveResponse;
  try { data = await resp.json() as TroveResponse; } catch (err) {
    return { incidents: [], queries: [q], notes: `Trove returned non-JSON: ${(err as Error).message.slice(0, 120)}` };
  }
  const articles = data.category?.[0]?.records?.article ?? [];

  // Anchor pins at the bbox centre + a small spiral jitter so they
  // don't all stack on top of one another. Jitter is ~50-200 m at
  // mid-latitudes — visibly separable, still inside the bbox.
  const cLat = (bbox.minLat + bbox.maxLat) / 2;
  const cLon = (bbox.minLon + bbox.maxLon) / 2;

  const incidents: Incident[] = [];
  for (let i = 0; i < articles.length; i++) {
    const art = articles[i];
    const heading = stripMarkup(art.heading);
    const snippet = stripMarkup(art.snippet);
    if (!heading && !snippet) continue;
    const year = art.date ? parseInt(art.date.slice(0, 4), 10) || null : null;
    const paperName = art.title?.title ?? "Trove digitised newspapers";
    const sourceUrl = art.troveUrl ?? (art.id ? `https://trove.nla.gov.au/newspaper/article/${art.id}` : "");
    if (!sourceUrl) continue;
    const angle = (i / Math.max(articles.length, 1)) * Math.PI * 2;
    const radius = 0.002 + (i % 4) * 0.0015; // ~200 m + step
    const lat = cLat + Math.sin(angle) * radius;
    const lon = cLon + Math.cos(angle) * radius;
    incidents.push({
      title: (heading || `${paperName} · ${art.date ?? "unknown date"}`).slice(0, 120),
      body: (snippet || `${paperName} · ${art.date ?? "unknown date"}`).slice(0, 320),
      severity: inferTroveSeverity(`${heading} ${snippet}`),
      source_quality: "primary",
      year,
      lat,
      lon,
      sources: [{
        label: `${paperName}${art.date ? ` · ${art.date}` : ""}`,
        url: sourceUrl,
      }],
    });
  }

  return {
    incidents,
    queries: [`Trove: ${q}`],
    notes: incidents.length > 0
      ? `Trove returned ${incidents.length} digitised-newspaper article${incidents.length === 1 ? "" : "s"} for "${town}". Pins anchored at the bbox centre + jitter (Trove articles don't ship street-level coords).`
      : `Trove returned no articles for "${town}" with the incident-term query.`,
  };
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

  // Run Sonar + Trove in parallel. Trove only fires for region=AU and
  // when TROVE_API_KEY is configured; otherwise it returns empty fast.
  // Both can fail independently; we merge whatever succeeded.
  const geocodePromise = region === "AU" ? reverseGeocodeBboxCentre(bbox) : Promise.resolve({ town: null, state: null });
  const [sonar, geo] = await Promise.all([callSonar(env, bbox, region), geocodePromise]);
  const trove = await searchTrove(env, bbox, geo.town, geo.state);

  // Decide what to return. If Sonar errored AND Trove returned zero
  // results, the request is a hard fail — surface the Sonar error.
  // If Sonar errored but Trove found things, return those + a note.
  // If Sonar succeeded, merge.
  let incidents: Incident[] = [];
  const search_terms: string[] = [];
  const notes_parts: string[] = [];
  let model = DEFAULT_MODEL;

  if ("error" in sonar) {
    if (trove.incidents.length === 0) {
      return jsonResponse({ error: `Sonar failed: ${sonar.error}. Trove ${trove.notes}` }, 502);
    }
    notes_parts.push(`Sonar failed (${sonar.error.slice(0, 120)}); results are Trove-only.`);
  } else {
    incidents.push(...sonar.result.incidents);
    search_terms.push(...sonar.result.search_terms_used);
    notes_parts.push(sonar.result.notes);
    model = sonar.result.model;
  }

  incidents.push(...trove.incidents);
  search_terms.push(...trove.queries);
  if (trove.notes) notes_parts.push(trove.notes);

  // Dedupe by URL — Sonar and Trove sometimes both surface the same
  // canonical newspaper article (e.g. when an SMH piece is mirrored on
  // Trove). Trove's URL wins because it's the original digitisation.
  const seen = new Set<string>();
  incidents = incidents.filter((inc) => {
    const key = inc.sources[0]?.url;
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const merged: AreaResult = {
    incidents,
    search_terms_used: search_terms,
    notes: notes_parts.filter(Boolean).join(" · "),
    model: trove.incidents.length > 0 ? `${model} + trove` : model,
  };

  // Don't poison the cache with empty results. Sonar's coverage of
  // regional Australian news is patchy — a "no incidents" return today
  // may become a hit tomorrow as the prompt or model improves. Caching
  // empty responses would lock the operator out of fresh searches for
  // 30 days for no benefit. Only persist findings worth re-serving.
  if (merged.incidents.length > 0) {
    await writeCache(env.COMMUNITY_DB, cellKey, region, bbox, merged);
  }
  await recordRateLimitRun(env.AI_RATE_LIMIT, rl);

  return jsonResponse({
    incidents: merged.incidents,
    search_terms_used: merged.search_terms_used,
    notes: merged.notes,
    model: merged.model,
    cached: false,
    cache_age_seconds: 0,
    cell_key: cellKey,
  }, 200, rateLimitHeaders(rl));
};
