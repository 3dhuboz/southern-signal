/**
 * POST /api/ai/research/stream — streaming SSE variant of /api/ai/research.
 *
 * Why synthetic stages: Perplexity Sonar streams the chat completion
 * but doesn't emit per-source progress events. We map elapsed-time
 * milestones to the source layers the system prompt asks for so the
 * client can show "we're in heritage now → court records now →
 * synthesising" progress instead of a fake rotating label.
 *
 * Rate limit recorded only on successful completion (final event).
 * Validation, prompts, IP hash, and KV gating come from
 * ../_research-shared so the one-shot and streaming endpoints stay
 * in lockstep — drifting one without the other would break the
 * "both paths return the same shape" guarantee.
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
  readRateLimit,
  recordRateLimitRun,
  type ResearchRequestBody,
  type SharedEnv,
  type SSEEvent,
  validateAndCleanFindings,
} from "../_research-shared";
import { authenticate, recordRequest, type AuthEnv } from "../_auth";
import { readLimitedBytes } from "../../_body";

type Env = SharedEnv & AuthEnv;

interface PagesContext<E = unknown> {
  request: Request;
  env: E;
}

type PagesFn<E = unknown> = (ctx: PagesContext<E>) => Response | Promise<Response>;

function jsonError(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

export const onRequestOptions: PagesFn<Env> = async () => new Response(null, {
  status: 204,
  headers: { ...corsHeaders(), "Access-Control-Max-Age": "86400" },
});

function sseEncode(payload: SSEEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

export const onRequestPost: PagesFn<Env> = async ({ request, env }) => {
  if (!env.OPENROUTER_API_KEY) {
    return jsonError({ error: "AI Investigator not configured." }, 503);
  }

  // Consume body bytes once for signature verification.
  const bodyResult = await readLimitedBytes(request, MAX_BODY_BYTES);
  if (!bodyResult.ok) return jsonError({ error: bodyResult.error }, bodyResult.status);
  const bodyBytes = bodyResult.bytes;
  const auth = await authenticate(request, env, { bodyBytes });
  if (!auth.ok) {
    return jsonError({ error: auth.error, detail: auth.detail }, auth.status);
  }

  let body: ResearchRequestBody;
  try { body = JSON.parse(new TextDecoder().decode(bodyBytes)) as ResearchRequestBody; }
  catch { return jsonError({ error: "Invalid JSON." }, 400); }

  const venueName = (body.venueName ?? "").trim();
  if (!venueName || venueName.length < 2 || venueName.length > 200) {
    return jsonError({ error: "venueName required (2-200 chars)." }, 400);
  }

  if (body.culturallySensitive === true) {
    return jsonError({
      error: "AI Investigator is hard-blocked on culturally-sensitive sites.",
      detail: "Contact the relevant Local Aboriginal Land Council before researching this venue.",
    }, 403);
  }

  const salt = env.AI_RATE_LIMIT_SALT || "ss-research-v1";
  const ipHash = await hashIp(callerIp(request), salt);
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
  const userPrompt = buildUserPrompt({ venueName, locationHint: body.locationHint, region, followup: body.followup });

  // Stage labels keyed to elapsed-time milestones — illustrative
  // but tied to the source ordering the system prompt asks for.
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
      const send = (payload: SSEEvent) => controller.enqueue(sseEncode(payload));
      let stageIndex = 0;

      // Stage emissions are 2-3s apart, so a 1s tick lands each label
      // within an imperceptible window of its target without wasting
      // wakeups. Cleared in the outer finally so all error paths
      // converge.
      const stageTimer = setInterval(() => {
        const elapsed = Date.now() - startMs;
        while (stageIndex < stages.length && stages[stageIndex].atMs <= elapsed) {
          send({ type: "stage", label: stages[stageIndex].label, elapsed_ms: elapsed });
          stageIndex += 1;
        }
      }, 1000);
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
            // Perplexity Sonar via OpenRouter only accepts `text` or
            // `json_schema` for response_format — `json_object` (the
            // OpenAI dialect) trips a 400 at the provider. The system
            // prompt already constrains output to JSON, and the SSE
            // parser tolerates code-fenced wrappers.
            stream: true,
          }),
        });

        if (!upstream.ok || !upstream.body) {
          const text = await upstream.text().catch(() => "");
          send({ type: "error", message: `Upstream ${upstream.status}`, detail: text.slice(0, 400) });
          controller.close();
          return;
        }

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let acc = "";
        const citations: string[] = [];
        let chunkCount = 0;

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
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
                // Emit a counter every ~5 deltas — keeps the client's
                // progress meter live without flooding it.
                if (chunkCount % 5 === 0) {
                  send({ type: "chunk", chunks: chunkCount, chars: acc.length });
                }
              }
              if (Array.isArray(obj.citations)) {
                for (const c of obj.citations) {
                  if (typeof c === "string" && !citations.includes(c)) citations.push(c);
                }
              }
            } catch { /* skip malformed chunk */ }
          }
        }

        const stripped = acc.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
        let parsed: { findings?: unknown; suggestions?: unknown; search_terms_used?: unknown };
        try { parsed = JSON.parse(stripped); }
        catch {
          send({ type: "error", message: "Streamed output did not parse as JSON.", detail: stripped.slice(0, 400) });
          controller.close();
          return;
        }
        const { findings, suggestions, search_terms_used, warnings } = validateAndCleanFindings(parsed);

        const payloadBytes = new TextEncoder().encode(JSON.stringify({ findings, suggestions, search_terms_used, citations })).length;
        appendSizeWarning(warnings, payloadBytes);

        send({
          type: "final",
          payload: {
            findings,
            suggestions,
            search_terms_used,
            citations_raw: citations,
            model,
            warnings,
          },
          elapsed_ms: Date.now() - startMs,
        });

        try { await recordRateLimitRun(env.AI_RATE_LIMIT, rate); } catch { /* */ }
        if (auth.signed && auth.pubkeyHex) {
          try { await recordRequest(env, auth.pubkeyHex); } catch { /* */ }
        }
        controller.close();
      } catch (err) {
        send({ type: "error", message: (err as Error).message ?? "Stream failed" });
        controller.close();
      } finally {
        clearInterval(stageTimer);
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
