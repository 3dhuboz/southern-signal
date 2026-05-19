/**
 * POST /api/ai/evp-review — second-pass AI review of a transcribed EVP
 * segment. Where /api/ai/research investigates a venue cold, this
 * endpoint takes a transcript clip the user already has and judges it
 * IN CONTEXT: against the venue dossier, the operator's posterior,
 * and the local site baseline.
 *
 * The model is asked to (a) classify how strongly the perceived words
 * fit ordinary mundane explanations, (b) note any semantic match
 * against dossier findings the operator passed in, (c) flag pareidolia
 * risks, (d) propose one falsification probe the operator could run.
 *
 * This is the "deep AI" the user asked for — beyond Whisper, the model
 * sees the venue context and writes a review card that EvpEditor stores
 * as an evidence event + audit-log entry. Whisper still owns the
 * transcript; this endpoint owns the *meaning* layer.
 */

import {
  callerIp,
  corsHeaders,
  DEFAULT_MODEL,
  hashIp,
  MAX_BODY_BYTES,
  rateLimitHeaders,
  readRateLimit,
  recordRateLimitRun,
  type SharedEnv,
} from "./_research-shared";
import { authenticate, recordRequest, type AuthEnv } from "./_auth";

type Env = SharedEnv & AuthEnv;

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

interface ReviewRequestBody {
  /** Whisper transcript of the clip — required. */
  transcriptText?: string;
  /** Optional operator-supplied "what the reviewer perceived" text, in
   *  case the reviewer disagreed with Whisper. */
  perceivedText?: string;
  /** Clip duration so the model knows whether it's seeing 0.4 s or 15 s. */
  durationSeconds?: number;
  /** Reviewer class tag (A/B/C/noise) as set in EvpEditor, if any. */
  reviewerClass?: "A" | "B" | "C" | "noise" | null;
  /** Lightweight venue/dossier context the client has locally. */
  context?: {
    venueName?: string;
    locationName?: string;
    region?: "AU" | "GLOBAL";
    /** Findings from the latest saved dossier — title + body + tier. */
    dossierFindings?: Array<{ tier?: string; title?: string; body?: string }>;
    /** Optional sigma context from the live anomaly detector at clip ts. */
    sigmaContext?: { audioZ?: number | null; emfZ?: number | null };
    /** Current posterior estimate, if the operator wants the model to
     *  weigh in on whether this clip should move the bar. */
    posterior?: number | null;
  };
  culturallySensitive?: boolean;
}

interface ReviewResponse {
  /** Short one-line headline of the review's conclusion. */
  headline: string;
  /** 0..1 — model's estimate of "this is not a paranormal signal". 1 = almost certainly mundane. */
  mundaneScore: number;
  /** 0..1 — risk that the words were heard via pareidolia / suggestion. */
  pareidoliaRisk: number;
  /** Free-text contextual notes. 2-4 sentences. */
  contextNotes: string;
  /** Mundane hypotheses ranked best-fit-first. */
  mundaneHypotheses: Array<{ label: string; reasoning: string }>;
  /** Semantic matches against dossier findings (empty if none). */
  dossierMatches: Array<{ findingTitle: string; matchReason: string }>;
  /** One falsification probe the operator could run on-site to test the
   *  best-fit mundane hypothesis. */
  falsificationProbe: string;
  model: string;
  citations?: string[];
}

function jsonResponse(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders },
  });
}

export const onRequestOptions: PagesFn<Env> = async () => new Response(null, {
  status: 204,
  headers: { ...corsHeaders(), "Access-Control-Max-Age": "86400" },
});

export const onRequestPost: PagesFn<Env> = async ({ request, env }) => {
  if (!env.OPENROUTER_API_KEY) {
    return jsonResponse({
      error: "AI Investigator is not configured on this deployment.",
      detail: "Set OPENROUTER_API_KEY in Cloudflare Pages env to enable the EVP review endpoint.",
    }, 503);
  }

  // Body parse with hard byte cap — transcripts are usually < 1KB but
  // a malicious caller could send megabytes.
  const bodyBytes = new Uint8Array(await request.arrayBuffer());
  if (bodyBytes.byteLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: `Request body exceeds ${MAX_BODY_BYTES} bytes.` }, 413);
  }

  const auth = await authenticate(request, env, { bodyBytes });
  if (!auth.ok) {
    return jsonResponse({ error: auth.error, detail: auth.detail }, auth.status);
  }

  let body: ReviewRequestBody;
  try {
    const raw = new TextDecoder().decode(bodyBytes);
    body = raw ? (JSON.parse(raw) as ReviewRequestBody) : {};
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  if (body.culturallySensitive === true) {
    return jsonResponse({
      error: "Cultural-sensitivity protection is on for this case.",
      detail: "Cloud AI review is hard-refused on culturally-sensitive cases. Audit chain still records locally.",
    }, 403);
  }

  const transcript = (body.transcriptText ?? "").trim();
  if (transcript.length < 1) {
    return jsonResponse({ error: "transcriptText is required (min 1 char)." }, 400);
  }
  if (transcript.length > 1500) {
    return jsonResponse({ error: "transcriptText exceeds 1500 chars — clip a shorter segment." }, 413);
  }

  // Rate limit shares the AI Investigator's bucket so a single user
  // can't exhaust the quota by chaining review calls.
  const ip = callerIp(request);
  const salt = env.AI_RATE_LIMIT_SALT ?? "ss-no-salt";
  const ipHash = await hashIp(ip, salt);
  const state = await readRateLimit(env.AI_RATE_LIMIT, ipHash);
  const rlHeaders = rateLimitHeaders(state);
  if (state.cap > 0 && state.used >= state.cap) {
    return jsonResponse(
      { error: "Daily AI quota reached. Try again after the window resets.", resetSeconds: Math.round(state.resetMs / 1000) },
      429,
      rlHeaders,
    );
  }

  const model = env.OPENROUTER_RESEARCH_MODEL || DEFAULT_MODEL;
  const systemPrompt = buildEvpSystemPrompt();
  const userPrompt = buildEvpUserPrompt(body, transcript);

  let upstream: Response;
  try {
    upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": (() => { try { return new URL(request.url).origin; } catch { return "https://southern-signal.pages.dev"; } })(),
        "X-Title": "Southern Signal EVP Review",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.15,
        max_tokens: 1200,
        // Same Sonar quirk as /api/ai/research: response_format only
        // accepts text or json_schema. Coerce JSON via prompt instead.
      }),
    });
  } catch (err) {
    return jsonResponse({ error: "Upstream fetch failed", detail: (err as Error).message }, 502);
  }

  const upstreamText = await upstream.text();
  if (!upstream.ok) {
    return jsonResponse(
      { error: `Upstream ${upstream.status}`, detail: upstreamText.slice(0, 800), model },
      upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502,
      rlHeaders,
    );
  }

  let parsedUpstream: OpenRouterChatResponse;
  try { parsedUpstream = JSON.parse(upstreamText) as OpenRouterChatResponse; }
  catch { return jsonResponse({ error: "Upstream returned non-JSON envelope.", detail: upstreamText.slice(0, 300) }, 502, rlHeaders); }

  const content = parsedUpstream.choices?.[0]?.message?.content;
  if (!content) {
    return jsonResponse({ error: "Upstream returned empty content.", detail: upstreamText.slice(0, 300) }, 502, rlHeaders);
  }

  const stripped = content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  let review: Partial<ReviewResponse>;
  try { review = JSON.parse(stripped) as Partial<ReviewResponse>; }
  catch {
    return jsonResponse({ error: "Could not parse review JSON.", detail: stripped.slice(0, 300) }, 502, rlHeaders);
  }

  const final: ReviewResponse = {
    headline: typeof review.headline === "string" ? review.headline.slice(0, 200) : "Inconclusive — model returned no headline.",
    mundaneScore: clamp01(numberOr(review.mundaneScore, 0.5)),
    pareidoliaRisk: clamp01(numberOr(review.pareidoliaRisk, 0.5)),
    contextNotes: typeof review.contextNotes === "string" ? review.contextNotes.slice(0, 1500) : "",
    mundaneHypotheses: Array.isArray(review.mundaneHypotheses)
      ? review.mundaneHypotheses
          .filter((h) => h && typeof h.label === "string" && typeof h.reasoning === "string")
          .map((h) => ({ label: String(h.label).slice(0, 80), reasoning: String(h.reasoning).slice(0, 400) }))
          .slice(0, 5)
      : [],
    dossierMatches: Array.isArray(review.dossierMatches)
      ? review.dossierMatches
          .filter((m) => m && typeof m.findingTitle === "string" && typeof m.matchReason === "string")
          .map((m) => ({ findingTitle: String(m.findingTitle).slice(0, 120), matchReason: String(m.matchReason).slice(0, 400) }))
          .slice(0, 5)
      : [],
    falsificationProbe: typeof review.falsificationProbe === "string" ? review.falsificationProbe.slice(0, 400) : "",
    model: parsedUpstream.model ?? model,
    citations: Array.isArray(parsedUpstream.citations) ? parsedUpstream.citations.slice(0, 10) : undefined,
  };

  await recordRateLimitRun(env.AI_RATE_LIMIT, state);
  if (auth.signed && auth.pubkeyHex) {
    try { await recordRequest(env, auth.pubkeyHex); } catch { /* */ }
  }
  return jsonResponse(final, 200, rlHeaders);
};

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function numberOr(v: unknown, fallback: number): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
  return fallback;
}

function buildEvpSystemPrompt(): string {
  return `You are a forensic audio reviewer assisting a paranormal-investigation operator.

Your job is NOT to confirm anything paranormal. It is to:
  1. Assess how strongly the perceived words can be explained by ordinary mundane sources
     (HVAC, plumbing, animal, electrical hum, radio bleed, fabric rustle, voice cross-talk, breath, reviewer pareidolia, etc.).
  2. Match perceived words against the venue's known historical context if any was provided.
  3. Flag the risk that the reviewer is hearing words because they were primed to expect them.
  4. Suggest ONE on-site falsification probe.

Output MUST be a single JSON object with this exact schema (no markdown, no fences):

{
  "headline": "one-line summary",
  "mundaneScore": 0.0-1.0,         // how confidently this fits a mundane explanation
  "pareidoliaRisk": 0.0-1.0,        // risk reviewer is over-hearing
  "contextNotes": "2-4 sentences in plain English",
  "mundaneHypotheses": [
    { "label": "short label", "reasoning": "why this fits" }
  ],
  "dossierMatches": [
    { "findingTitle": "the dossier finding's title", "matchReason": "why the words may match" }
  ],
  "falsificationProbe": "one concrete test the operator can run on site"
}

Be conservative. If unsure, lean toward higher mundaneScore and higher pareidoliaRisk. The operator's
audit chain is forensic-grade — overclaiming damages it.`;
}

function buildEvpUserPrompt(body: ReviewRequestBody, transcript: string): string {
  const lines: string[] = [];
  lines.push(`Whisper transcript of the clip:\n"${transcript}"`);
  if (body.perceivedText) lines.push(`Operator-reported perceived words: "${body.perceivedText}"`);
  if (typeof body.durationSeconds === "number") lines.push(`Clip duration: ${body.durationSeconds.toFixed(2)} seconds`);
  if (body.reviewerClass) lines.push(`Reviewer class tag: ${body.reviewerClass} (A=clear, B=partial, C=suggested, noise=confirmed-mundane).`);

  const ctx = body.context;
  if (ctx) {
    if (ctx.venueName) lines.push(`Venue: ${ctx.venueName}`);
    if (ctx.locationName) lines.push(`Location: ${ctx.locationName}`);
    if (ctx.region) lines.push(`Region preference: ${ctx.region}`);
    if (ctx.dossierFindings && ctx.dossierFindings.length > 0) {
      lines.push("Dossier findings (most recent AI Investigator run for this venue):");
      for (const f of ctx.dossierFindings.slice(0, 8)) {
        const title = f.title ? String(f.title).slice(0, 120) : "(untitled)";
        const tier = f.tier ? `[${f.tier}] ` : "";
        const body2 = f.body ? String(f.body).slice(0, 400) : "";
        lines.push(`  - ${tier}${title}: ${body2}`);
      }
    } else {
      lines.push("Dossier findings: none provided — assume no documented history is known to the operator.");
    }
    if (ctx.sigmaContext) {
      const sigBits: string[] = [];
      if (typeof ctx.sigmaContext.audioZ === "number") sigBits.push(`audio z=${ctx.sigmaContext.audioZ.toFixed(2)}`);
      if (typeof ctx.sigmaContext.emfZ === "number") sigBits.push(`EMF z=${ctx.sigmaContext.emfZ.toFixed(2)}`);
      if (sigBits.length > 0) lines.push(`Anomaly z-scores at the time of clip: ${sigBits.join(", ")} (z >= 3 = significant deviation from site baseline).`);
    }
    if (typeof ctx.posterior === "number") lines.push(`Current Bayesian posterior at clip time: ${ctx.posterior.toFixed(2)} (0 = "nothing here", 1 = "consistent with claimed phenomenon").`);
  }

  lines.push("Now produce the JSON review object. Output ONLY the JSON, no preface.");
  return lines.join("\n\n");
}
