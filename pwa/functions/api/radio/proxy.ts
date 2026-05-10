/**
 * Cloudflare Pages Function — CORS-proxy a chunk of an internet radio
 * stream for the Spirit Box (Radio Sweep) tool.
 *
 *   GET /api/radio/proxy?url=<stream-url>&ms=<timeout-ms>
 *
 * Returns up to ~MAX_BYTES of audio bytes (capped at MAX_TIMEOUT_MS of
 * wall-clock fetch time) with permissive CORS headers, so the client can
 * AudioContext.decodeAudioData() on the response and play random slices
 * of it through the formant-noise-style synth path.
 *
 * Why proxy at all: internet radio streams (Icecast, SHOUTcast, raw MP3
 * HTTP) almost universally do NOT send Access-Control-Allow-Origin
 * headers, so a browser running on `southern-signal.pages.dev` cannot
 * fetch them directly. The proxy adds the CORS layer.
 *
 * Why a chunk and not a live stream: we want the audio in a decoded
 * AudioBuffer so we can play 200ms slices on demand (real spirit-box
 * scanning behaviour). A bounded chunk fits in memory, decodes once, and
 * keeps the bandwidth predictable.
 *
 * Security:
 *   - Allowlist of host substrings. Refuses URLs that don't match —
 *     prevents using the proxy as an open relay.
 *   - Hard byte cap so a malicious target can't drain bandwidth.
 *   - Hard time cap (5s default) so a slow upstream doesn't pin the
 *     Worker.
 *
 * Bandwidth: ~80 KB per 5-second 128 kbps MP3 chunk. The client refreshes
 * each station every ~60 seconds while sweeping; 6 stations × 60 s
 * intervals = ~8 KB/s average. Within phone-data sanity.
 */

interface Env {
  RADIO_PROXY_ALLOWLIST?: string; // optional comma-separated list to extend defaults
}

interface PagesContext<E = unknown> {
  request: Request;
  env: E;
}

type PagesFn<E = unknown> = (ctx: PagesContext<E>) => Response | Promise<Response>;

const DEFAULT_ALLOWLIST: string[] = [
  // SomaFM — public-radio-style internet stations; CORS-friendly to proxy.
  "somafm.com",
  "ice1.somafm.com",
  "ice2.somafm.com",
  "ice3.somafm.com",
  "ice4.somafm.com",
  "ice5.somafm.com",
  "ice6.somafm.com",
  // BBC public streams
  "bbcmedia.co.uk",
  "stream.live.vc.bbcmedia.co.uk",
  // Radio Paradise
  "radioparadise.com",
  "stream.radioparadise.com",
  // KEXP
  "kexp.org",
  "kexp-mp3-128.streamguys1.com",
  // WFMU
  "wfmu.org",
  "stream0.wfmu.org",
];

const MAX_BYTES = 500_000;          // ~30s of 128 kbps MP3
const MAX_TIMEOUT_MS = 8000;        // upper bound on a single proxy hop
const DEFAULT_TIMEOUT_MS = 5000;

function corsHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Cache-Control": "no-store",
    ...extra,
  };
}

function jsonError(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function isAllowed(target: URL, env: Env): boolean {
  const extra = (env.RADIO_PROXY_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const allow = [...DEFAULT_ALLOWLIST.map((s) => s.toLowerCase()), ...extra];
  const host = target.hostname.toLowerCase();
  return allow.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

export const onRequestOptions: PagesFn<Env> = async () => {
  return new Response(null, {
    status: 204,
    headers: { ...corsHeaders(), "Access-Control-Max-Age": "86400" },
  });
};

export const onRequestGet: PagesFn<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  const timeoutRaw = parseInt(url.searchParams.get("ms") ?? `${DEFAULT_TIMEOUT_MS}`, 10);
  const timeoutMs = Math.max(1000, Math.min(MAX_TIMEOUT_MS, Number.isFinite(timeoutRaw) ? timeoutRaw : DEFAULT_TIMEOUT_MS));

  if (!target) return jsonError({ error: "Missing 'url' query parameter." }, 400);

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return jsonError({ error: "Invalid 'url' — not a parsable URL." }, 400);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return jsonError({ error: "Only http(s) URLs may be proxied." }, 400);
  }
  if (!isAllowed(parsed, env)) {
    return jsonError({
      error: "Host not on radio-proxy allowlist.",
      detail: `Allowed hosts: ${DEFAULT_ALLOWLIST.join(", ")}. Set RADIO_PROXY_ALLOWLIST in Pages env to extend.`,
      host: parsed.hostname,
    }, 403);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let upstream: Response;
  try {
    upstream = await fetch(parsed.toString(), {
      signal: controller.signal,
      // Strip browser-style headers; some streams choke on them.
      headers: { "User-Agent": "southern-signal-radio-proxy/1.0", "Accept": "audio/*, */*" },
      // Pages Functions support cf-options for caching; not used here
      // because radio is by-definition non-cacheable.
      redirect: "follow",
    });
  } catch (err) {
    clearTimeout(timer);
    return jsonError({
      error: "Upstream fetch failed",
      detail: (err as Error).message,
      target: parsed.toString(),
    }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    clearTimeout(timer);
    return jsonError({
      error: `Upstream ${upstream.status}`,
      target: parsed.toString(),
    }, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502);
  }

  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      totalBytes += value.byteLength;
      if (totalBytes >= MAX_BYTES) break;
    }
  } catch {
    // AbortError from the timer falls through here; we keep what we read.
  } finally {
    clearTimeout(timer);
    try { reader.cancel(); } catch { /* ignore */ }
  }

  if (totalBytes === 0) {
    return jsonError({ error: "Upstream returned zero bytes within timeout.", target: parsed.toString() }, 504);
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }

  const contentType = upstream.headers.get("content-type") ?? "audio/mpeg";
  return new Response(merged, {
    headers: {
      "Content-Type": contentType,
      "X-Proxy-Bytes": String(totalBytes),
      "X-Proxy-Target-Host": parsed.hostname,
      ...corsHeaders(),
    },
  });
};
