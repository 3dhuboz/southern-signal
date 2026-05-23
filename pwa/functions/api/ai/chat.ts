/**
 * Cloudflare Pages Function — server-side AI proxy.
 *
 *   POST /api/ai/chat
 *   {
 *     "system": "...",
 *     "user": "...",
 *     "max_tokens": 768,
 *     "temperature": 0.7,
 *     "model": "anthropic/claude-sonnet-4.6"   // optional, server default applies
 *   }
 *
 * The operator's OpenRouter key is held server-side as a Cloudflare Pages
 * environment secret named OPENROUTER_API_KEY. End users never see it.
 *
 * Optional env:
 *   OPENROUTER_DEFAULT_MODEL  — e.g. "anthropic/claude-sonnet-4.6"
 *
 * To configure (one-time): in the Cloudflare dashboard,
 *   Pages → southern-signal → Settings → Environment variables → Production
 *   add OPENROUTER_API_KEY (encrypted) and optionally OPENROUTER_DEFAULT_MODEL.
 */

import { authenticate, recordRequest, type AuthEnv } from "./_auth";
import { readLimitedBytes } from "../_body";

interface Env extends AuthEnv {
  OPENROUTER_API_KEY?: string;
  OPENROUTER_DEFAULT_MODEL?: string;
}

interface PagesContext<E = unknown> {
  request: Request;
  env: E;
  params: Record<string, string | string[]>;
  data: Record<string, unknown>;
  next: (input?: Request | string) => Promise<Response>;
  waitUntil: (promise: Promise<unknown>) => void;
}

type PagesFn<E = unknown> = (ctx: PagesContext<E>) => Response | Promise<Response>;

interface ChatRequestBody {
  system?: string;
  user?: string;
  max_tokens?: number;
  temperature?: number;
  model?: string;
}

const FALLBACK_MODEL = "anthropic/claude-sonnet-4.6";
const MAX_BODY_BYTES = 16_000;
const ALLOWED_ORIGIN_DEFAULT = "*";

function jsonResponse(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN_DEFAULT,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      ...extraHeaders,
    },
  });
}

export const onRequestOptions: PagesFn<Env> = async () => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN_DEFAULT,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
};

export const onRequestPost: PagesFn<Env> = async ({ request, env }) => {
  if (!env.OPENROUTER_API_KEY) {
    return jsonResponse({ error: "AI is not configured on this deployment." }, 503);
  }

  // Consume body bytes ONCE for signature verification, then re-parse as
  // JSON. Workers Request bodies can only be consumed once.
  const bodyResult = await readLimitedBytes(request, MAX_BODY_BYTES);
  if (!bodyResult.ok) return jsonResponse({ error: bodyResult.error }, bodyResult.status);
  const bodyBytes = bodyResult.bytes;
  const auth = await authenticate(request, env, { bodyBytes });
  if (!auth.ok) {
    return jsonResponse({ error: auth.error, detail: auth.detail }, auth.status);
  }

  let body: ChatRequestBody;
  try {
    body = JSON.parse(new TextDecoder().decode(bodyBytes)) as ChatRequestBody;
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }
  if (!body.system || !body.user) {
    return jsonResponse({ error: "Missing system or user fields." }, 400);
  }

  const origin = (() => {
    try { return new URL(request.url).origin; } catch { return "https://southern-signal.pages.dev"; }
  })();

  const model = body.model || env.OPENROUTER_DEFAULT_MODEL || FALLBACK_MODEL;
  const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": origin,
      "X-Title": "Southern Signal",
    },
    body: JSON.stringify({
      model,
      max_tokens: typeof body.max_tokens === "number" ? Math.min(2048, Math.max(16, body.max_tokens)) : 768,
      temperature: typeof body.temperature === "number" ? body.temperature : 0.7,
      messages: [
        { role: "system", content: body.system },
        { role: "user", content: body.user },
      ],
    }),
  });

  // Pass through OpenRouter's response, normalising to {text} for the client.
  const upstreamText = await upstream.text();
  if (!upstream.ok) {
    return jsonResponse({ error: `Upstream ${upstream.status}`, detail: upstreamText.slice(0, 800) }, upstream.status);
  }

  let parsed: { choices?: { message?: { content?: string } }[] };
  try {
    parsed = JSON.parse(upstreamText);
  } catch {
    return jsonResponse({ error: "Upstream returned non-JSON.", detail: upstreamText.slice(0, 200) }, 502);
  }
  const text = parsed.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    return jsonResponse({ error: "Upstream returned no content." }, 502);
  }

  // Burn the per-device rate-limit slot only on a 2xx response so
  // transient upstream failures don't deplete the operator's budget.
  if (auth.signed && auth.pubkeyHex) {
    try { await recordRequest(env, auth.pubkeyHex); } catch { /* KV write failure shouldn't block response */ }
  }

  return jsonResponse({ text, model }, 200);
};
