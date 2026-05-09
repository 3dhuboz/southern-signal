/**
 * Cloudflare Pages Function — ephemeral SDP signaling for the Estes
 * dual-phone mode.
 *
 *   POST /api/estes/signal     { code, role, sdp, candidates? }
 *      role: "offer" | "answer"
 *      stores the payload under the 6-digit code with ~120s TTL
 *
 *   GET  /api/estes/signal?code=123456&role=offer
 *      returns the most recent payload for that role+code, or 404
 *
 * Backed by `caches.default` (Cloudflare's edge cache) — no KV / D1
 * binding required, no operator setup. Codes self-expire at TTL.
 *
 * NB: this only carries the SDP / ICE handshake. Once the peers are
 * connected, all media + datachannel traffic flows P2P (or via STUN)
 * and never touches our server.
 */

interface PagesContext<E = unknown> {
  request: Request;
  env: E;
  params: Record<string, string | string[]>;
  data: Record<string, unknown>;
  next: (input?: Request | string) => Promise<Response>;
  waitUntil: (promise: Promise<unknown>) => void;
}

type PagesFn<E = unknown> = (ctx: PagesContext<E>) => Response | Promise<Response>;

const TTL_SECONDS = 120;
const ALLOWED_ORIGIN_DEFAULT = "*";
const MAX_BODY_BYTES = 64_000;

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN_DEFAULT,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function isValidCode(code: unknown): code is string {
  return typeof code === "string" && /^[0-9]{6}$/.test(code);
}

function isValidRole(role: unknown): role is "offer" | "answer" {
  return role === "offer" || role === "answer";
}

function cacheKey(code: string, role: string, request: Request): Request {
  // Use a synthetic absolute URL on the request's origin so caches.default
  // can key it. Cache cares about the URL string, not whether it routes.
  const base = new URL(request.url).origin;
  return new Request(`${base}/__estes/${code}/${role}`, { method: "GET" });
}

export const onRequestOptions: PagesFn = async () => {
  return new Response(null, {
    status: 204,
    headers: { ...corsHeaders(), "Access-Control-Max-Age": "86400" },
  });
};

export const onRequestPost: PagesFn = async ({ request }) => {
  const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: "Payload too large." }, 413);
  }
  let body: { code?: string; role?: string; sdp?: unknown; candidates?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }
  if (!isValidCode(body.code)) return jsonResponse({ error: "Code must be 6 digits." }, 400);
  if (!isValidRole(body.role)) return jsonResponse({ error: "Role must be 'offer' or 'answer'." }, 400);
  if (!body.sdp) return jsonResponse({ error: "Missing sdp." }, 400);

  const payload = {
    role: body.role,
    sdp: body.sdp,
    candidates: body.candidates ?? [],
    stored_at: new Date().toISOString(),
    ttl_seconds: TTL_SECONDS,
  };

  const stored = new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${TTL_SECONDS}`,
    },
  });
  const cache = (caches as { default: Cache }).default;
  await cache.put(cacheKey(body.code, body.role, request), stored);

  return jsonResponse({ ok: true, ttl_seconds: TTL_SECONDS }, 200);
};

export const onRequestGet: PagesFn = async ({ request }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const role = url.searchParams.get("role");
  if (!isValidCode(code)) return jsonResponse({ error: "Code must be 6 digits." }, 400);
  if (!isValidRole(role)) return jsonResponse({ error: "Role must be 'offer' or 'answer'." }, 400);
  const cache = (caches as { default: Cache }).default;
  const cached = await cache.match(cacheKey(code, role, request));
  if (!cached) return jsonResponse({ error: "Not found or expired." }, 404);
  const text = await cached.text();
  return new Response(text, { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders() } });
};
