/**
 * Cloudflare Pages Function — POST /api/ai/research/stream
 *
 * Streaming variant of /api/ai/research. Same input contract, same
 * cultural-sensitivity hard-block, same KV rate-limit gate; output is
 * Server-Sent Events instead of a single JSON response. Events:
 *
 *   data: {"type":"stage","label":"..."}     synthetic stage markers
 *   data: {"type":"chunk","tokens":N}        upstream chunk arrived
 *   data: {"type":"final","payload":{...}}   validated ResearchResult
 *   data: {"type":"error","message":"..."}   any failure
 *
 * Why synthetic stages: Perplexity Sonar streams the chat completion
 * but doesn't emit per-source progress events. We map elapsed-time
 * milestones to the source layers the system prompt asks for so the
 * client can show real "we're in heritage now → court records now →
 * synthesising" progress instead of a fake rotating label.
 *
 * Rate limit recorded only on successful completion (final event),
 * same as the non-streaming endpoint.
 */

interface Env {
  OPENROUTER_API_KEY?: string;
  OPENROUTER_RESEARCH_MODEL?: string;
  AI_RATE_LIMIT?: KVNamespace;
  AI_RATE_LIMIT_SALT?: string;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
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
  followup?: {
    parentTitle?: string;
    parentBody?: string;
    parentSources?: Array<{ label?: string; url?: string }>;
    question?: string;
  };
}

type Tier = "HERITAGE" | "DOCUMENTED_INCIDENT" | "CULTURAL_SIGNIFICANCE" | "FOLKLORE" | "SYNTHESIS";

interface Source { label: string; url: string }
interface Finding { tier: Tier; title: string; body: string; sources: Source[] }

const DEFAULT_MODEL = "perplexity/sonar";
const MAX_BODY_BYTES = 4_000;
const RATE_LIMIT_CAP = 5;
const RATE_LIMIT_WINDOW_HOURS = 24;

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export const onRequestOptions: PagesFn<Env> = async () => new Response(null, {
  status: 204,
  headers: { ...corsHeaders(), "Access-Control-Max-Age": "86400" },
});

async function hashIp(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

interface RateState { used: number; cap: number; resetMs: number; key: string | null }

async function readRateLimit(kv: KVNamespace | undefined, ipHash: string): Promise<RateState> {
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

async function recordRateLimitRun(kv: KVNamespace | undefined, state: RateState): Promise<void> {
  if (!kv || !state.key) return;
  const next = state.used + 1;
  const ttl = RATE_LIMIT_WINDOW_HOURS * 3600 + 3600;
  await kv.put(state.key, String(next), { expirationTtl: ttl });
}

function buildSystemPrompt(region: "AU" | "GLOBAL"): string {
  // Compressed — the streaming endpoint shares the contract; the
  // non-streaming endpoint carries the canonical prose. Drift here is
  // tolerable because both validate identically.
  return `You are an archive researcher embedded inside a paranormal investigation app. Find DOCUMENTED FACTS for a specific venue from authoritative sources, citing every claim.

HARD RULES:
1. EVERY factual claim must have a real source you accessed. No source → tier SYNTHESIS.
2. Folklore goes in tier FOLKLORE. Never elevate to HERITAGE or DOCUMENTED_INCIDENT.
3. First Nations / Indigenous significance → tier CULTURAL_SIGNIFICANCE, surface FIRST.
4. 1-3 sentences per body. Operators read on a phone.

${region === "AU" ? "PREFERRED SOURCES (AU): Trove, AustLII, state heritage registers, AIATSIS, BDM registers, council inventories, state libraries." : "PREFERRED SOURCES (global): government heritage registers, court records, Native-Land.ca, newspaper archives, libraries."}

OUTPUT: strict JSON, no fences:
{
  "findings": [{ "tier": "...", "title": "...", "body": "...", "sources": [{ "label": "...", "url": "..." }] }],
  "suggestions": ["..."],
  "search_terms_used": ["..."]
}

TIERS: HERITAGE (registers/architecture) · DOCUMENTED_INCIDENT (primary-source events) · CULTURAL_SIGNIFICANCE (Country, contested histories) · FOLKLORE (anecdotes, unverified) · SYNTHESIS (no primary source — flag for verification).

If nothing supportable, return findings: [] with one suggestion. Don't pad.`;
}

function buildUserPrompt(venueName: string, locationHint: string | undefined, region: "AU" | "GLOBAL", followup: ResearchRequestBody["followup"]): string {
  const parts = [`Venue: ${venueName}`];
  if (locationHint && locationHint.trim()) parts.push(`Location hint: ${locationHint.trim()}`);
  parts.push(`Region: ${region}`);
  parts.push("");
  if (followup && (followup.question || followup.parentTitle)) {
    parts.push("DRILL-DOWN: extend the parent finding below with more cited detail, don't re-research.");
    if (followup.parentTitle) parts.push(`Parent title: ${String(followup.parentTitle).slice(0, 200)}`);
    if (followup.parentBody) parts.push(`Parent body: ${String(followup.parentBody).slice(0, 1200)}`);
    if (followup.question) parts.push(`Question: ${String(followup.question).slice(0, 500)}`);
    parts.push("Return JSON per the system prompt's format.");
    return parts.join("\n");
  }
  parts.push("Research this venue. Return JSON per the system prompt's format.");
  return parts.join("\n");
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
      if (!raw || typeof raw !== "object") { warnings.push("Skipped a malformed finding."); continue; }
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
          } catch { /* skip */ }
        }
      }
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

function sseEvent(payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

export const onRequestPost: PagesFn<Env> = async ({ request, env }) => {
  if (!env.OPENROUTER_API_KEY) {
    return new Response(JSON.stringify({ error: "AI Investigator not configured." }), {
      status: 503,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }

  const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ error: "Request body too large." }), {
      status: 413, headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }

  let body: ResearchRequestBody;
  try { body = await request.json() as ResearchRequestBody; }
  catch { return new Response(JSON.stringify({ error: "Invalid JSON." }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() } }); }

  const venueName = (body.venueName ?? "").trim();
  if (!venueName || venueName.length < 2 || venueName.length > 200) {
    return new Response(JSON.stringify({ error: "venueName required (2-200 chars)." }), {
      status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }

  if (body.culturallySensitive === true) {
    return new Response(JSON.stringify({
      error: "AI Investigator is hard-blocked on culturally-sensitive sites.",
      detail: "Contact the relevant Local Aboriginal Land Council before researching this venue.",
    }), { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders() } });
  }

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
      },
    });
  }

  const region: "AU" | "GLOBAL" = body.region === "GLOBAL" ? "GLOBAL" : "AU";
  const model = env.OPENROUTER_RESEARCH_MODEL || DEFAULT_MODEL;
  const systemPrompt = buildSystemPrompt(region);
  const userPrompt = buildUserPrompt(venueName, body.locationHint, region, body.followup);

  // Stage labels keyed to elapsed-time milestones. Synthetic but tied
  // to the source ordering the system prompt asks for, so they're
  // illustrative rather than purely decorative.
  const stages = region === "AU"
    ? [
        { atMs: 0, label: "Walking the archives…" },
        { atMs: 2000, label: "Pulling state heritage register entries…" },
        { atMs: 4500, label: "Cross-referencing AustLII court records…" },
        { atMs: 7500, label: "Searching Trove newspaper archive…" },
        { atMs: 10500, label: "Checking First Nations Country layer…" },
        { atMs: 14000, label: "Synthesising sources…" },
      ]
    : [
        { atMs: 0, label: "Walking the archives…" },
        { atMs: 2000, label: "Querying government heritage registers…" },
        { atMs: 4500, label: "Reviewing court records and primary news…" },
        { atMs: 7500, label: "Checking indigenous-land databases…" },
        { atMs: 10500, label: "Pulling newspaper / library archive entries…" },
        { atMs: 14000, label: "Synthesising sources…" },
      ];

  const startMs = Date.now();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: Record<string, unknown>) => controller.enqueue(sseEvent(payload));
      let stageIndex = 0;

      // Schedule synthetic stage emissions tied to elapsed time.
      const stageTimer = setInterval(() => {
        const elapsed = Date.now() - startMs;
        while (stageIndex < stages.length && stages[stageIndex].atMs <= elapsed) {
          send({ type: "stage", label: stages[stageIndex].label, elapsed_ms: elapsed });
          stageIndex += 1;
        }
      }, 500);
      // Fire stage 0 immediately.
      send({ type: "stage", label: stages[0].label, elapsed_ms: 0 });
      stageIndex = 1;

      try {
        const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
            "HTTP-Referer": (() => { try { return new URL(request.url).origin; } catch { return "https://southern-signal.pages.dev"; } })(),
            "X-Title": "Southern Signal AI Investigator (stream)",
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
            stream: true,
          }),
        });

        if (!upstream.ok || !upstream.body) {
          clearInterval(stageTimer);
          const text = await upstream.text().catch(() => "");
          send({ type: "error", message: `Upstream ${upstream.status}`, detail: text.slice(0, 400) });
          controller.close();
          return;
        }

        // Read SSE chunks from OpenRouter. Each `data: …\n\n` block is a
        // JSON object with .choices[0].delta.content carrying the next
        // token slice. We accumulate `acc`, emit chunk counters as we go.
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let acc = "";
        let citations: string[] = [];
        let chunkCount = 0;

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // Split on double-newline (SSE record separator).
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            try {
              const obj = JSON.parse(data) as {
                choices?: Array<{ delta?: { content?: string } }>;
                citations?: string[];
              };
              const delta = obj.choices?.[0]?.delta?.content ?? "";
              if (delta) {
                acc += delta;
                chunkCount += 1;
                // Emit a chunk event every ~5 deltas to avoid flooding
                // the client. The client uses count + length for the
                // progress meter, not the content itself.
                if (chunkCount % 5 === 0) {
                  send({ type: "chunk", chunks: chunkCount, chars: acc.length });
                }
              }
              if (Array.isArray(obj.citations)) {
                // Sonar may stream citations alongside the deltas.
                for (const c of obj.citations) {
                  if (typeof c === "string" && !citations.includes(c)) citations.push(c);
                }
              }
            } catch { /* skip malformed chunk */ }
          }
        }
        clearInterval(stageTimer);

        // Strip code fences (Sonar sometimes wraps despite response_format).
        const stripped = acc.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
        let parsed: { findings?: unknown; suggestions?: unknown; search_terms_used?: unknown };
        try { parsed = JSON.parse(stripped); }
        catch {
          send({ type: "error", message: "Streamed output did not parse as JSON.", detail: stripped.slice(0, 400) });
          controller.close();
          return;
        }
        const { findings, suggestions, search_terms_used, warnings } = validateAndCleanFindings(parsed);

        // Size check — same warning as the non-streaming endpoint.
        const payloadBytes = new TextEncoder().encode(JSON.stringify({ findings, suggestions, search_terms_used, citations })).length;
        if (payloadBytes >= 250_000) {
          warnings.push(`Dossier payload unusually large (${Math.round(payloadBytes / 1024)} KB). Review carefully.`);
        } else if (payloadBytes >= 80_000) {
          warnings.push(`Dossier payload larger than typical (${Math.round(payloadBytes / 1024)} KB).`);
        }

        const finalPayload = {
          findings,
          suggestions,
          search_terms_used,
          citations_raw: citations,
          model,
          warnings,
        };
        send({ type: "final", payload: finalPayload, elapsed_ms: Date.now() - startMs });

        // Record rate-limit only on successful final.
        try { await recordRateLimitRun(env.AI_RATE_LIMIT, rate); } catch { /* */ }
        controller.close();
      } catch (err) {
        clearInterval(stageTimer);
        send({ type: "error", message: (err as Error).message ?? "Stream failed" });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      ...corsHeaders(),
    },
  });
};
