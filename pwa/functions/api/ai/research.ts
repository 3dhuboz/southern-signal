/**
 * Cloudflare Pages Function — AI Investigator (venue archive researcher).
 *
 *   POST /api/ai/research
 *   {
 *     "venueName": "Old Marrickville Court House",
 *     "locationHint": "Sydney, NSW",            // optional
 *     "region": "AU",                            // "AU" (default) or "GLOBAL"
 *     "culturallySensitive": false               // hard-blocks if true
 *   }
 *
 * Returns:
 *   {
 *     "findings": [{ tier, title, body, sources: [{label, url}] }, ...],
 *     "suggestions": ["...", ...],
 *     "search_terms_used": ["...", ...],
 *     "citations_raw": ["https://...", ...],     // raw citations from the model
 *     "model": "perplexity/...",
 *     "warnings": ["...", ...]
 *   }
 *
 * Forensic guarantees baked in:
 *   - Hard-blocks if culturallySensitive=true (defense-in-depth — the
 *     client also blocks, but the endpoint enforces independently).
 *   - System prompt forbids unsupported "documented" claims; folklore
 *     gets a separate tier; First Nations significance surfaces FIRST.
 *   - Server-side citation validation: findings without sources get
 *     downgraded to SYNTHESIS tier with a warning so the audit chain
 *     records what the model produced unsupported.
 *
 * Region default is AU (Australia) — surfaces Trove / AustLII / state
 * heritage registers / AIATSIS preference in the system prompt. GLOBAL
 * widens to government heritage registers, court records, archive.org,
 * Native-Land.ca for indigenous land context.
 *
 * Provider: OpenRouter with Perplexity Sonar models (built-in citation-
 * backed web search). Chat completions API with response_format=json_object
 * to force structured output. Citations come back in the response's
 * top-level `citations` array.
 */

interface Env {
  OPENROUTER_API_KEY?: string;
  OPENROUTER_RESEARCH_MODEL?: string;
  /** Optional KV binding for server-side rate limiting. Without it, only
   *  the client soft-cap (localStorage, 3/device/24h) applies. */
  AI_RATE_LIMIT?: KVNamespace;
  /** Optional salt for hashing IPs before storing them in KV. Falls back
   *  to a fixed string if absent. */
  AI_RATE_LIMIT_SALT?: string;
}

/** Minimal Cloudflare KV type — Workers types not bundled here. */
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface PagesContext<E = unknown> {
  request: Request;
  env: E;
}

type PagesFn<E = unknown> = (ctx: PagesContext<E>) => Response | Promise<Response>;

/** Server-side rate limit. Slightly more generous than the client soft-cap
 *  (3/device/24h) so a household with multiple devices on the same IP
 *  doesn't accidentally hit the wall, but tight enough that someone
 *  scripting against the endpoint can't burn the cloud-AI budget. */
const RATE_LIMIT_CAP = 5;
const RATE_LIMIT_WINDOW_HOURS = 24;

interface ResearchRequestBody {
  venueName?: string;
  locationHint?: string;
  region?: "AU" | "GLOBAL";
  culturallySensitive?: boolean;
  /** Optional drill-down context. When present, the prompt focuses on
   *  expanding the parent finding with additional cited details rather
   *  than re-opening the venue from scratch. Same tier rules and
   *  source-validation downgrade apply. */
  followup?: {
    parentTitle?: string;
    parentBody?: string;
    parentSources?: Array<{ label?: string; url?: string }>;
    question?: string;
  };
}

type Tier =
  | "HERITAGE"
  | "DOCUMENTED_INCIDENT"
  | "CULTURAL_SIGNIFICANCE"
  | "FOLKLORE"
  | "SYNTHESIS";

interface Source { label: string; url: string }
interface Finding {
  tier: Tier;
  title: string;
  body: string;
  sources: Source[];
}

interface ResearchResponse {
  findings: Finding[];
  suggestions: string[];
  search_terms_used: string[];
  citations_raw: string[];
  model: string;
  warnings: string[];
}

const DEFAULT_MODEL = "perplexity/sonar";
const MAX_BODY_BYTES = 4_000;
const ALLOWED_ORIGIN = "*";

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

/** Hash the caller IP with a per-deployment salt so KV doesn't store raw
 *  IPs. SHA-256 truncated to 24 hex chars is plenty for keyspace hygiene
 *  given the modest QPS we expect on the research endpoint. */
async function hashIp(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

interface RateState {
  used: number;
  cap: number;
  /** ms until the current 24h window rolls over. */
  resetMs: number;
  /** The KV key for this caller this window — only set when KV is bound,
   *  so the increment-on-success branch can find it again. */
  key: string | null;
}

/**
 * Read-only check. Returns the current rate state without incrementing.
 * The actual increment happens in `recordRateLimitRun()` AFTER the
 * upstream call succeeds, so 5xx failures don't burn the user's budget.
 *
 * Race window: between read here and write later, two concurrent
 * requests from the same IP could each see `used < cap` and both go
 * through. That worst-case overshoot is bounded by request concurrency
 * (typically 1 — the client UI disables the button while busy), and
 * we'd rather under-count than block a legitimate run.
 */
async function readRateLimit(kv: KVNamespace | undefined, ipHash: string): Promise<RateState> {
  const now = Date.now();
  const bucket = Math.floor(now / (RATE_LIMIT_WINDOW_HOURS * 3_600_000));
  const nextBucketMs = (bucket + 1) * RATE_LIMIT_WINDOW_HOURS * 3_600_000;
  const resetMs = Math.max(0, nextBucketMs - now);
  if (!kv) {
    // No KV bound — only the client cap applies. Tell the client the
    // server's view is "wide open" so it doesn't double-count.
    return { used: 0, cap: RATE_LIMIT_CAP, resetMs, key: null };
  }
  const key = `research:${ipHash}:${bucket}`;
  const raw = await kv.get(key);
  const used = raw == null ? 0 : parseInt(raw, 10) || 0;
  return { used, cap: RATE_LIMIT_CAP, resetMs, key };
}

async function recordRateLimitRun(kv: KVNamespace | undefined, state: RateState): Promise<void> {
  if (!kv || !state.key) return;
  const next = state.used + 1;
  // TTL: a full window + 1h so the key naturally expires after the
  // bucket rolls over.
  const ttl = RATE_LIMIT_WINDOW_HOURS * 3600 + 3600;
  await kv.put(state.key, String(next), { expirationTtl: ttl });
}

function rateLimitHeaders(state: RateState): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(state.cap),
    "X-RateLimit-Remaining": String(Math.max(0, state.cap - state.used)),
    "X-RateLimit-Reset-Seconds": String(Math.round(state.resetMs / 1000)),
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

export const onRequestOptions: PagesFn<Env> = async () => {
  return new Response(null, {
    status: 204,
    headers: { ...corsHeaders(), "Access-Control-Max-Age": "86400" },
  });
};

function buildSystemPrompt(region: "AU" | "GLOBAL"): string {
  const sourcesBlock = region === "AU" ? `
PREFERRED SOURCES (Australia — prefer in this order):
  1. Trove (https://trove.nla.gov.au) — National Library of Australia
     newspaper and document archive
  2. AustLII (https://www.austlii.edu.au) — court records and case law
  3. State heritage registers (NSW Heritage, VHR Victoria, Qld DEHP,
     SA Heritage, WA Heritage, Tas Heritage, NT, ACT)
  4. AIATSIS (https://aiatsis.gov.au) — First Nations significance and
     Country / language group lookup
  5. State births/deaths/marriages registers
  6. Local council heritage citations (e.g. City of Sydney heritage
     inventory, Brisbane heritage register)
  7. State Library catalogues (SLNSW, SLV, SLQ, SLSA, etc.)

The venue is in AUSTRALIA. Surface FIRST NATIONS COUNTRY information
FIRST under tier CULTURAL_SIGNIFICANCE. Recommend contacting the
relevant Local Aboriginal Land Council before any on-site activity.` : `
PREFERRED SOURCES (global):
  1. Government heritage / historic registers (US NRHP, UK NHLE,
     Canadian Register, etc.)
  2. Court records and primary news archives
  3. Native-Land.ca and equivalent indigenous-land databases for
     traditional country lookup
  4. Newspaper archives (archive.org, Newspapers.com, JSTOR)
  5. State / national library catalogues

Surface INDIGENOUS LAND CONTEXT FIRST where applicable under tier
CULTURAL_SIGNIFICANCE.`;

  return `You are an archive researcher embedded inside a paranormal investigation app. Your job is to find DOCUMENTED FACTS about a specific venue from authoritative sources, citing every claim.

HARD RULES:
1. EVERY factual claim must be supported by a real source you actually accessed during your search. If you cannot verify a claim with a source, say so explicitly in tier SYNTHESIS — do NOT invent or paraphrase claims as "documented".
2. Folklore / ghost-tour / blog claims go in tier FOLKLORE. Never elevate them to HERITAGE or DOCUMENTED_INCIDENT.
3. If the venue has First Nations / Indigenous significance, surface that as the FIRST finding under tier CULTURAL_SIGNIFICANCE.
4. Be terse. 1-3 sentences per body. Operators read these on a phone in the field.

${sourcesBlock}

OUTPUT FORMAT — strict JSON. No markdown fences, no commentary outside the JSON object:
{
  "findings": [
    {
      "tier": "HERITAGE" | "DOCUMENTED_INCIDENT" | "CULTURAL_SIGNIFICANCE" | "FOLKLORE" | "SYNTHESIS",
      "title": "Short title (max 60 chars)",
      "body": "1-3 sentence factual paragraph. May include inline source URLs.",
      "sources": [{ "label": "Human-readable name", "url": "https://..." }]
    }
  ],
  "suggestions": [
    "Investigation angle in one short sentence",
    "Another angle"
  ],
  "search_terms_used": ["string", "string"]
}

TIER GUIDE:
- HERITAGE: government heritage register entries, council citations,
  architectural history, building lifecycle (built/sold/demolished)
- DOCUMENTED_INCIDENT: court records, news reports of deaths/fires/
  accidents, BDM records — factual primary-source events
- CULTURAL_SIGNIFICANCE: First Nations Country, sacred sites, contested
  histories — surface FIRST when present
- FOLKLORE: ghost tours, blogs, "haunted places" lists, anecdotes —
  unverified by primary sources
- SYNTHESIS: your own inference where no primary source could be found
  — flag for human verification

If you find nothing supportable, return findings: [] with a single
suggestion explaining that the venue has no archival footprint you
could access. Do NOT pad with low-quality folklore to fill space.`;
}

function buildUserPrompt(req: Required<Pick<ResearchRequestBody, "venueName">> & ResearchRequestBody): string {
  const parts = [`Venue: ${req.venueName}`];
  if (req.locationHint && req.locationHint.trim()) {
    parts.push(`Location hint: ${req.locationHint.trim()}`);
  }
  parts.push(`Region: ${req.region ?? "AU"}`);
  parts.push("");

  const fu = req.followup;
  if (fu && (fu.question || fu.parentTitle)) {
    // Followup turn: anchor to the parent finding so the model expands
    // it rather than re-researching the venue at the top level.
    parts.push("DRILL-DOWN REQUEST — expand the following finding with more cited detail:");
    if (fu.parentTitle) parts.push(`Parent finding title: ${String(fu.parentTitle).slice(0, 200)}`);
    if (fu.parentBody) parts.push(`Parent finding body: ${String(fu.parentBody).slice(0, 1200)}`);
    if (Array.isArray(fu.parentSources) && fu.parentSources.length > 0) {
      parts.push("Parent sources already cited (avoid duplicating these unless adding new context):");
      for (const s of fu.parentSources.slice(0, 6)) {
        const label = typeof s.label === "string" ? s.label.slice(0, 100) : "";
        const url = typeof s.url === "string" ? s.url.slice(0, 300) : "";
        if (url) parts.push(`  - ${label ? `${label} — ` : ""}${url}`);
      }
    }
    parts.push("");
    if (fu.question && String(fu.question).trim()) {
      parts.push(`Operator's specific question: ${String(fu.question).slice(0, 500)}`);
    } else {
      parts.push("Operator's specific question: what additional documented facts can you find about this?");
    }
    parts.push("");
    parts.push("Return JSON per the system prompt's format. Findings here should EXTEND the parent — new dates, names, court files, news clippings, heritage citations — not restate it. If you find nothing new with sources, return findings: [] with a brief explanatory suggestion.");
    return parts.join("\n");
  }

  parts.push("Research this venue. Return JSON per the system prompt's format.");
  return parts.join("\n");
}

interface OpenRouterChatResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  citations?: string[];
  model?: string;
  error?: { message?: string; code?: number };
}

function validateAndCleanFindings(parsed: { findings?: unknown; suggestions?: unknown; search_terms_used?: unknown }): {
  findings: Finding[];
  suggestions: string[];
  search_terms_used: string[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const findings: Finding[] = [];

  if (!Array.isArray(parsed.findings)) {
    warnings.push("Model output had no `findings` array.");
  } else {
    for (const raw of parsed.findings) {
      if (!raw || typeof raw !== "object") {
        warnings.push("Skipped a malformed finding (non-object).");
        continue;
      }
      const r = raw as Record<string, unknown>;
      const tierRaw = typeof r.tier === "string" ? r.tier.toUpperCase() : "SYNTHESIS";
      const allowed: Tier[] = ["HERITAGE", "DOCUMENTED_INCIDENT", "CULTURAL_SIGNIFICANCE", "FOLKLORE", "SYNTHESIS"];
      const tier: Tier = (allowed as string[]).includes(tierRaw) ? (tierRaw as Tier) : "SYNTHESIS";
      const title = typeof r.title === "string" ? r.title.slice(0, 120) : "Untitled finding";
      const body = typeof r.body === "string" ? r.body : "";
      const sources: Source[] = [];
      if (Array.isArray(r.sources)) {
        for (const s of r.sources) {
          if (!s || typeof s !== "object") continue;
          const sr = s as Record<string, unknown>;
          const url = typeof sr.url === "string" ? sr.url.trim() : "";
          const label = typeof sr.label === "string" ? sr.label.trim() : "";
          if (!url) continue;
          try {
            const u = new URL(url);
            if (u.protocol !== "http:" && u.protocol !== "https:") continue;
            sources.push({ label: label || u.hostname, url });
          } catch {
            // skip malformed url
          }
        }
      }
      // If a finding claims a non-folklore tier but has no sources, downgrade.
      let finalTier = tier;
      if (sources.length === 0 && (tier === "HERITAGE" || tier === "DOCUMENTED_INCIDENT" || tier === "CULTURAL_SIGNIFICANCE")) {
        finalTier = "SYNTHESIS";
        warnings.push(`"${title}" claimed tier ${tier} but had no sources — downgraded to SYNTHESIS.`);
      }
      findings.push({ tier: finalTier, title, body, sources });
    }
  }

  const suggestions: string[] = Array.isArray(parsed.suggestions)
    ? (parsed.suggestions as unknown[]).filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim().slice(0, 240))
    : [];

  const search_terms_used: string[] = Array.isArray(parsed.search_terms_used)
    ? (parsed.search_terms_used as unknown[]).filter((s): s is string => typeof s === "string").map((s) => s.slice(0, 120))
    : [];

  return { findings, suggestions, search_terms_used, warnings };
}

export const onRequestPost: PagesFn<Env> = async ({ request, env }) => {
  if (!env.OPENROUTER_API_KEY) {
    return jsonResponse({
      error: "AI Investigator is not configured on this deployment.",
      detail: "Set OPENROUTER_API_KEY in Cloudflare Pages env to enable the research endpoint.",
    }, 503);
  }

  const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: "Request body too large." }, 413);
  }

  let body: ResearchRequestBody;
  try {
    body = await request.json() as ResearchRequestBody;
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  const venueName = (body.venueName ?? "").trim();
  if (!venueName || venueName.length < 2) {
    return jsonResponse({ error: "venueName is required (min 2 chars)." }, 400);
  }
  if (venueName.length > 200) {
    return jsonResponse({ error: "venueName too long (max 200 chars)." }, 400);
  }

  // Defense-in-depth cultural-sensitivity hard-block. The UI also blocks,
  // but the endpoint refuses independently so a misconfigured client
  // (or an audit reviewer reproducing a request) can't bypass.
  if (body.culturallySensitive === true) {
    return jsonResponse({
      error: "AI Investigator is hard-blocked on culturally-sensitive sites.",
      detail: "Investigations flagged as culturally sensitive cannot route data off-device. Contact the relevant Local Aboriginal Land Council (or equivalent custodial body) for permission before researching this venue.",
    }, 403);
  }

  // Server-side rate limit. The client also self-throttles via
  // localStorage (3/device/24h), but that's bypassable by clearing
  // storage — this gate sits at the budget choke point. Skipped
  // gracefully when AI_RATE_LIMIT KV binding is absent (dev / preview).
  const callerIp = request.headers.get("CF-Connecting-IP")
    ?? request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim()
    ?? "unknown";
  const salt = env.AI_RATE_LIMIT_SALT || "ss-research-v1";
  const ipHash = await hashIp(callerIp, salt);
  const rate = await readRateLimit(env.AI_RATE_LIMIT, ipHash);
  if (rate.used >= rate.cap) {
    return new Response(JSON.stringify({
      error: "Daily research cap reached on this network.",
      detail: `Server cap is ${rate.cap} runs per 24h per network. Resets in ~${Math.round(rate.resetMs / 3_600_000)}h.`,
      retry_after_seconds: Math.round(rate.resetMs / 1000),
    }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(Math.round(rate.resetMs / 1000)),
        ...corsHeaders(),
        ...rateLimitHeaders(rate),
      },
    });
  }

  const region: "AU" | "GLOBAL" = body.region === "GLOBAL" ? "GLOBAL" : "AU";
  const model = env.OPENROUTER_RESEARCH_MODEL || DEFAULT_MODEL;
  const systemPrompt = buildSystemPrompt(region);
  const userPrompt = buildUserPrompt({ venueName, locationHint: body.locationHint, region });

  // OpenRouter chat completions. Perplexity Sonar models return a
  // top-level `citations` array of URLs they consulted; this is in
  // addition to whatever URLs the model embeds in the message body.
  let upstream: Response;
  try {
    upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": (() => { try { return new URL(request.url).origin; } catch { return "https://southern-signal.pages.dev"; } })(),
        "X-Title": "Southern Signal AI Investigator",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 2400,
        response_format: { type: "json_object" },
      }),
    });
  } catch (err) {
    return jsonResponse({ error: "Upstream fetch failed", detail: (err as Error).message }, 502);
  }

  const upstreamText = await upstream.text();
  if (!upstream.ok) {
    return jsonResponse({
      error: `Upstream ${upstream.status}`,
      detail: upstreamText.slice(0, 800),
      model,
    }, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502);
  }

  let upstreamJson: OpenRouterChatResponse;
  try {
    upstreamJson = JSON.parse(upstreamText);
  } catch {
    return jsonResponse({
      error: "Upstream returned non-JSON.",
      detail: upstreamText.slice(0, 200),
    }, 502);
  }

  const content = upstreamJson.choices?.[0]?.message?.content ?? "";
  if (!content) {
    return jsonResponse({ error: "Upstream returned empty content.", detail: upstreamText.slice(0, 200) }, 502);
  }

  // Sonar sometimes wraps JSON in code fences despite response_format. Strip.
  const stripped = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsed: { findings?: unknown; suggestions?: unknown; search_terms_used?: unknown };
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return jsonResponse({
      error: "Research model did not return parseable JSON.",
      detail: stripped.slice(0, 400),
      model,
    }, 502);
  }

  const { findings, suggestions, search_terms_used, warnings } = validateAndCleanFindings(parsed);
  const citations_raw = Array.isArray(upstreamJson.citations) ? upstreamJson.citations.filter((s): s is string => typeof s === "string") : [];

  // Size sanity check. With max_tokens=2400 a normal dossier is well
  // under 30KB. If we see something much bigger the model probably
  // looped or echoed huge source bodies — surface that to the operator
  // so they can decide whether to trust the dossier. The payload still
  // saves; this is a yellow flag, not a block.
  const payloadBytes = new TextEncoder().encode(JSON.stringify({ findings, suggestions, search_terms_used, citations_raw })).length;
  const SIZE_WARN_BYTES = 80_000;
  const SIZE_ALARM_BYTES = 250_000;
  if (payloadBytes >= SIZE_ALARM_BYTES) {
    warnings.push(`Dossier payload is unusually large (${Math.round(payloadBytes / 1024)} KB). Model may have looped or echoed source bodies — review findings carefully before trusting.`);
  } else if (payloadBytes >= SIZE_WARN_BYTES) {
    warnings.push(`Dossier payload is larger than typical (${Math.round(payloadBytes / 1024)} KB).`);
  }

  // Only burn a rate-limit slot on a 2xx. 5xx fails (above) bypass this,
  // matching the client behavior (recordRun() only on 200 OK).
  try { await recordRateLimitRun(env.AI_RATE_LIMIT, rate); } catch (err) {
    // KV write failure shouldn't block the response — it just means the
    // user gets one bonus run. Log for ops visibility.
    console.warn("[research] rate-limit KV write failed", err);
  }
  // Reflect the new state (used+1) back in headers so the client UI can
  // display the server's view alongside its localStorage cap.
  const newRate: RateState = { ...rate, used: rate.used + 1 };

  const response: ResearchResponse = {
    findings,
    suggestions,
    search_terms_used,
    citations_raw,
    model,
    warnings,
  };
  return new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
      ...rateLimitHeaders(newRate),
    },
  });
};
