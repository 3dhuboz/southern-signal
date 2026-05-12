/**
 * POST /api/ai/research — one-shot AI Investigator. Streaming variant
 * lives in ./research/stream.ts; both endpoints share validation,
 * rate-limit, cultural-block, and prompt logic via ./_research-shared.
 *
 * Provider: OpenRouter with Perplexity Sonar models. JSON output is
 * coerced via the system prompt (Sonar rejects OpenAI's `json_object`
 * response_format); citations come back in the upstream's top-level
 * `citations` array.
 */

import {
  appendSizeWarning,
  buildSystemPrompt,
  buildUserPrompt,
  callerIp,
  corsHeaders,
  DEFAULT_MODEL,
  hashIp,
  MAX_BODY_BYTES,
  rateLimitHeaders,
  readRateLimit,
  recordRateLimitRun,
  type ResearchRequestBody,
  type SharedEnv,
  validateAndCleanFindings,
} from "./_research-shared";

interface PagesContext<E = unknown> {
  request: Request;
  env: E;
}

type PagesFn<E = unknown> = (ctx: PagesContext<E>) => Response | Promise<Response>;

interface OpenRouterChatResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  citations?: string[];
  model?: string;
  error?: { message?: string; code?: number };
}

function jsonResponse(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders },
  });
}

export const onRequestOptions: PagesFn<SharedEnv> = async () => new Response(null, {
  status: 204,
  headers: { ...corsHeaders(), "Access-Control-Max-Age": "86400" },
});

export const onRequestPost: PagesFn<SharedEnv> = async ({ request, env }) => {
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
  try { body = await request.json() as ResearchRequestBody; }
  catch { return jsonResponse({ error: "Invalid JSON body." }, 400); }

  const venueName = (body.venueName ?? "").trim();
  if (!venueName || venueName.length < 2) {
    return jsonResponse({ error: "venueName is required (min 2 chars)." }, 400);
  }
  if (venueName.length > 200) {
    return jsonResponse({ error: "venueName too long (max 200 chars)." }, 400);
  }

  if (body.culturallySensitive === true) {
    return jsonResponse({
      error: "AI Investigator is hard-blocked on culturally-sensitive sites.",
      detail: "Investigations flagged as culturally sensitive cannot route data off-device. Contact the relevant Local Aboriginal Land Council (or equivalent custodial body) for permission before researching this venue.",
    }, 403);
  }

  const salt = env.AI_RATE_LIMIT_SALT || "ss-research-v1";
  const ipHash = await hashIp(callerIp(request), salt);
  const rate = await readRateLimit(env.AI_RATE_LIMIT, ipHash);
  if (rate.used >= rate.cap) {
    return jsonResponse({
      error: "Daily research cap reached on this network.",
      detail: `Server cap is ${rate.cap} runs per 24h per network. Resets in ~${Math.round(rate.resetMs / 3_600_000)}h.`,
      retry_after_seconds: Math.round(rate.resetMs / 1000),
    }, 429, {
      "Retry-After": String(Math.round(rate.resetMs / 1000)),
      ...rateLimitHeaders(rate),
    });
  }

  const region: "AU" | "GLOBAL" = body.region === "GLOBAL" ? "GLOBAL" : "AU";
  const model = env.OPENROUTER_RESEARCH_MODEL || DEFAULT_MODEL;
  const systemPrompt = buildSystemPrompt(region);
  const userPrompt = buildUserPrompt({ venueName, locationHint: body.locationHint, region, followup: body.followup });

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
        // Perplexity Sonar via OpenRouter only accepts `text` or
        // `json_schema` for response_format — sending `json_object` (which
        // is what OpenAI accepts) trips a 400 at the provider. The system
        // prompt already constrains output to JSON, and the strip-fence
        // parser below handles the occasional ```json wrapper, so we
        // leave response_format off and trust the prompt.
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
  try { upstreamJson = JSON.parse(upstreamText); }
  catch {
    return jsonResponse({ error: "Upstream returned non-JSON.", detail: upstreamText.slice(0, 200) }, 502);
  }

  const content = upstreamJson.choices?.[0]?.message?.content ?? "";
  if (!content) {
    return jsonResponse({ error: "Upstream returned empty content.", detail: upstreamText.slice(0, 200) }, 502);
  }

  // Sonar occasionally wraps JSON in code fences despite response_format.
  const stripped = content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  let parsed: { findings?: unknown; suggestions?: unknown; search_terms_used?: unknown };
  try { parsed = JSON.parse(stripped); }
  catch {
    return jsonResponse({
      error: "Research model did not return parseable JSON.",
      detail: stripped.slice(0, 400),
      model,
    }, 502);
  }

  const { findings, suggestions, search_terms_used, warnings } = validateAndCleanFindings(parsed);
  const citations_raw = Array.isArray(upstreamJson.citations) ? upstreamJson.citations.filter((s): s is string => typeof s === "string") : [];

  const payloadBytes = new TextEncoder().encode(JSON.stringify({ findings, suggestions, search_terms_used, citations_raw })).length;
  appendSizeWarning(warnings, payloadBytes);

  // Burn a rate-limit slot only on a 2xx — failures don't count against
  // the user's budget. KV failure here doesn't block the response; the
  // user just gets one bonus run.
  try { await recordRateLimitRun(env.AI_RATE_LIMIT, rate); }
  catch (err) { console.warn("[research] rate-limit KV write failed", err); }

  const newRate = { ...rate, used: rate.used + 1 };
  return jsonResponse({
    findings,
    suggestions,
    search_terms_used,
    citations_raw,
    model,
    warnings,
  }, 200, rateLimitHeaders(newRate));
};
