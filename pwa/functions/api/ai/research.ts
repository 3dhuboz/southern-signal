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
}

interface PagesContext<E = unknown> {
  request: Request;
  env: E;
}

type PagesFn<E = unknown> = (ctx: PagesContext<E>) => Response | Promise<Response>;

interface ResearchRequestBody {
  venueName?: string;
  locationHint?: string;
  region?: "AU" | "GLOBAL";
  culturallySensitive?: boolean;
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

  const response: ResearchResponse = {
    findings,
    suggestions,
    search_terms_used,
    citations_raw,
    model,
    warnings,
  };
  return jsonResponse(response, 200);
};
