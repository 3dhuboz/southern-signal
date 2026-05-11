/**
 * Shared helpers for the AI Investigator endpoints. Both
 * `/api/ai/research` (one-shot) and `/api/ai/research/stream` (SSE)
 * import from here so the rate-limit, IP-hash, system prompt, and
 * validation logic stay in lockstep. The underscore prefix marks this
 * as a non-route module — Cloudflare Pages Functions skip files
 * starting with `_` when building the URL → handler map.
 */

export const DEFAULT_MODEL = "perplexity/sonar";
export const MAX_BODY_BYTES = 4_000;
export const RATE_LIMIT_CAP = 5;
export const RATE_LIMIT_WINDOW_HOURS = 24;

/** Size thresholds that produce warnings in the response. Hard refusal
 *  lives on the client (saveDossier) — these soft levels just tag the
 *  payload so a reviewer sees the model produced an unusual amount. */
export const SIZE_WARN_BYTES = 80_000;
export const SIZE_ALARM_BYTES = 250_000;

export type Tier =
  | "HERITAGE"
  | "DOCUMENTED_INCIDENT"
  | "CULTURAL_SIGNIFICANCE"
  | "FOLKLORE"
  | "SYNTHESIS";

export interface Source { label: string; url: string }
export interface Finding {
  tier: Tier;
  title: string;
  body: string;
  sources: Source[];
}

export interface ResearchRequestBody {
  venueName?: string;
  locationHint?: string;
  region?: "AU" | "GLOBAL";
  culturallySensitive?: boolean;
  followup?: {
    parentTitle?: string;
    parentBody?: string;
    parentSources?: Array<{ label?: string; url?: string }>;
    question?: string;
  };
}

export interface SharedEnv {
  OPENROUTER_API_KEY?: string;
  OPENROUTER_RESEARCH_MODEL?: string;
  AI_RATE_LIMIT?: KVNamespace;
  AI_RATE_LIMIT_SALT?: string;
}

export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export async function hashIp(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

export interface RateState {
  used: number;
  cap: number;
  /** ms until the current 24h window rolls over. */
  resetMs: number;
  /** KV key for this caller this window; null when no KV binding. */
  key: string | null;
}

export async function readRateLimit(kv: KVNamespace | undefined, ipHash: string): Promise<RateState> {
  const now = Date.now();
  const bucket = Math.floor(now / (RATE_LIMIT_WINDOW_HOURS * 3_600_000));
  const nextBucketMs = (bucket + 1) * RATE_LIMIT_WINDOW_HOURS * 3_600_000;
  const resetMs = Math.max(0, nextBucketMs - now);
  if (!kv) return { used: 0, cap: RATE_LIMIT_CAP, resetMs, key: null };
  const key = `research:${ipHash}:${bucket}`;
  const raw = await kv.get(key);
  const used = raw == null ? 0 : parseInt(raw, 10) || 0;
  return { used, cap: RATE_LIMIT_CAP, resetMs, key };
}

export async function recordRateLimitRun(kv: KVNamespace | undefined, state: RateState): Promise<void> {
  if (!kv || !state.key) return;
  const next = state.used + 1;
  const ttl = RATE_LIMIT_WINDOW_HOURS * 3600 + 3600;
  await kv.put(state.key, String(next), { expirationTtl: ttl });
}

export function rateLimitHeaders(state: RateState): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(state.cap),
    "X-RateLimit-Remaining": String(Math.max(0, state.cap - state.used)),
    "X-RateLimit-Reset-Seconds": String(Math.round(state.resetMs / 1000)),
  };
}

export function callerIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP")
    ?? request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim()
    ?? "unknown";
}

export function buildSystemPrompt(region: "AU" | "GLOBAL"): string {
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

export function buildUserPrompt(req: { venueName: string; locationHint?: string; region: "AU" | "GLOBAL"; followup?: ResearchRequestBody["followup"] }): string {
  const parts = [`Venue: ${req.venueName}`];
  if (req.locationHint && req.locationHint.trim()) {
    parts.push(`Location hint: ${req.locationHint.trim()}`);
  }
  parts.push(`Region: ${req.region}`);
  parts.push("");

  const fu = req.followup;
  if (fu && (fu.question || fu.parentTitle)) {
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

export function validateAndCleanFindings(parsed: { findings?: unknown; suggestions?: unknown; search_terms_used?: unknown }): {
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
          } catch { /* skip malformed url */ }
        }
      }
      // No-source claims of primary-source tiers get downgraded — the
      // operator deserves to know we couldn't anchor the assertion.
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

/** Append a size-related warning when the payload exceeds the soft
 *  thresholds. Mutates the warnings array in place. */
export function appendSizeWarning(warnings: string[], payloadBytes: number): void {
  if (payloadBytes >= SIZE_ALARM_BYTES) {
    warnings.push(`Dossier payload is unusually large (${Math.round(payloadBytes / 1024)} KB). Model may have looped or echoed source bodies — review findings carefully before trusting.`);
  } else if (payloadBytes >= SIZE_WARN_BYTES) {
    warnings.push(`Dossier payload is larger than typical (${Math.round(payloadBytes / 1024)} KB).`);
  }
}

/** Shape of the events emitted by the streaming endpoint. Mirrored on
 *  the client wrapper so the consumer's switch is exhaustive. */
export type SSEEvent =
  | { type: "stage"; label: string; elapsed_ms: number }
  | { type: "chunk"; chunks: number; chars: number }
  | { type: "final"; payload: { findings: Finding[]; suggestions: string[]; search_terms_used: string[]; citations_raw: string[]; model: string; warnings: string[] }; elapsed_ms: number }
  | { type: "error"; message: string; detail?: string };
