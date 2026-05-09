/**
 * Cloudflare Pages Function — POST /api/live/fb/connect
 *
 * Auto-provisions a Cloudflare Stream Live Input + a Facebook Live RTMP
 * output in one call, returning a ready-to-use WHIP URL the browser can
 * push to. Removes the manual two-tab dance through facebook.com/live/producer
 * + Cloudflare dashboard for every session.
 *
 * Honest constraint: browsers cannot speak RTMP, and Facebook Live only
 * accepts RTMP. So this function builds the relay path: browser → WHIP →
 * Cloudflare → RTMP → Facebook. We don't invent a "browser-direct FB Live"
 * because no such thing exists.
 *
 * One-time operator setup (Cloudflare Pages → southern-signal → Settings →
 * Environment variables):
 *   CF_ACCOUNT_ID         — your Cloudflare account ID
 *   CF_STREAM_API_TOKEN   — API token with Stream:Edit permission
 *   FB_CONNECT_TOKEN      — bearer token clients pass to call this endpoint
 *                           (any string you choose; share with the device)
 *
 * The operator's Cloudflare Stream subscription is what carries the cost
 * ($5/month base + per-min charges). Without an active Stream subscription
 * the underlying API call will 4xx and we surface the message verbatim.
 *
 * Per-call body:
 *   { fb_stream_key: string,
 *     fb_rtmp_url?: string,   // defaults to Facebook's RTMPS ingest
 *     name?: string }         // optional human label on the CF Live Input
 *
 * Response on success:
 *   { whip_url, input_uid, output_uid, fb_rtmp_url }
 */

interface Env {
  CF_ACCOUNT_ID?: string;
  CF_STREAM_API_TOKEN?: string;
  FB_CONNECT_TOKEN?: string;
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

interface ConnectBody {
  fb_stream_key?: string;
  fb_rtmp_url?: string;
  name?: string;
}

interface ConnectResponse {
  whip_url: string;
  input_uid: string;
  output_uid: string;
  fb_rtmp_url: string;
}

const DEFAULT_FB_RTMP = "rtmps://live-api-s.facebook.com:443/rtmp/";
const CF_API = "https://api.cloudflare.com/client/v4";
const MAX_BODY_BYTES = 4_000;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

export const onRequestOptions: PagesFn<Env> = async () => new Response(null, {
  status: 204,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  },
});

export const onRequestPost: PagesFn<Env> = async ({ request, env }) => {
  if (!env.FB_CONNECT_TOKEN || !env.CF_ACCOUNT_ID || !env.CF_STREAM_API_TOKEN) {
    return jsonResponse({
      error: "Facebook Live connector isn't configured on this deployment. Add CF_ACCOUNT_ID, CF_STREAM_API_TOKEN (Stream:Edit), and FB_CONNECT_TOKEN to Cloudflare Pages → southern-signal → Settings → Environment variables.",
    }, 503);
  }

  const auth = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match || match[1].trim() !== env.FB_CONNECT_TOKEN) {
    return jsonResponse({ error: "Unauthorized — bearer token does not match FB_CONNECT_TOKEN." }, 401);
  }

  const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: "Body too large." }, 413);
  }

  let body: ConnectBody;
  try { body = await request.json() as ConnectBody; } catch { return jsonResponse({ error: "Invalid JSON body." }, 400); }
  const fbStreamKey = body.fb_stream_key?.trim();
  if (!fbStreamKey) return jsonResponse({ error: "fb_stream_key is required." }, 400);
  if (fbStreamKey.length > 200) return jsonResponse({ error: "fb_stream_key looks too long." }, 400);
  const fbRtmpUrl = (body.fb_rtmp_url?.trim() || DEFAULT_FB_RTMP);
  if (!fbRtmpUrl.startsWith("rtmp://") && !fbRtmpUrl.startsWith("rtmps://")) {
    return jsonResponse({ error: "fb_rtmp_url must start with rtmp:// or rtmps://." }, 400);
  }
  const name = (body.name?.trim() || `Southern Signal — FB Live ${new Date().toISOString()}`).slice(0, 120);

  const cfHeaders: Record<string, string> = {
    "Authorization": `Bearer ${env.CF_STREAM_API_TOKEN}`,
    "Content-Type": "application/json",
  };

  // 1. Create the Live Input.
  const inputResp = await fetch(`${CF_API}/accounts/${env.CF_ACCOUNT_ID}/stream/live_inputs`, {
    method: "POST",
    headers: cfHeaders,
    body: JSON.stringify({
      meta: { name },
      recording: { mode: "off" },
    }),
  });
  if (!inputResp.ok) {
    const detail = await inputResp.text().catch(() => "");
    return jsonResponse({
      error: `Cloudflare rejected live_inputs create (${inputResp.status}). Likely causes: API token lacks Stream:Edit, account has no Stream subscription, or wrong CF_ACCOUNT_ID.`,
      cf_status: inputResp.status,
      cf_detail: detail.slice(0, 600),
    }, 502);
  }
  const inputJson = await inputResp.json() as { result?: { uid?: string; webRTC?: { url?: string } } };
  const inputUid = inputJson.result?.uid;
  const whipUrl = inputJson.result?.webRTC?.url;
  if (!inputUid || !whipUrl) {
    return jsonResponse({ error: "Cloudflare returned no input UID or WebRTC URL.", cf_response: inputJson }, 502);
  }

  // 2. Add Facebook as an RTMP output on the input.
  const outputResp = await fetch(`${CF_API}/accounts/${env.CF_ACCOUNT_ID}/stream/live_inputs/${inputUid}/outputs`, {
    method: "POST",
    headers: cfHeaders,
    body: JSON.stringify({
      url: fbRtmpUrl,
      streamKey: fbStreamKey,
      enabled: true,
    }),
  });
  if (!outputResp.ok) {
    const detail = await outputResp.text().catch(() => "");
    // Best-effort cleanup: delete the input we just made so the operator
    // doesn't accumulate orphaned inputs on their account.
    void fetch(`${CF_API}/accounts/${env.CF_ACCOUNT_ID}/stream/live_inputs/${inputUid}`, {
      method: "DELETE",
      headers: cfHeaders,
    }).catch(() => { /* swallow */ });
    return jsonResponse({
      error: `Cloudflare rejected outputs create (${outputResp.status}). Live Input rolled back. Check that the Facebook stream key + URL are valid.`,
      cf_status: outputResp.status,
      cf_detail: detail.slice(0, 600),
    }, 502);
  }
  const outputJson = await outputResp.json() as { result?: { uid?: string } };
  const outputUid = outputJson.result?.uid ?? "unknown";

  const responseBody: ConnectResponse = {
    whip_url: whipUrl,
    input_uid: inputUid,
    output_uid: outputUid,
    fb_rtmp_url: fbRtmpUrl,
  };
  return jsonResponse(responseBody, 200);
};
