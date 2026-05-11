/**
 * Cloudflare Pages Function — GET /api/health
 *
 * Reports the configuration state of every server-side feature the
 * deployment surfaces, without ever leaking the values themselves.
 * Setup uses this to render an at-a-glance status tile so the operator
 * can tell which features will actually work on this deployment vs.
 * which are stubbed out.
 *
 * Shape (stable):
 *   {
 *     ok: true,
 *     timestamp: "<ISO>",
 *     features: {
 *       ai_research: { configured: boolean, model: string, rate_limit_kv: boolean },
 *       ai_transcribe: { configured: boolean },
 *       sync: { configured: boolean, has_kv_token: boolean, has_d1: boolean, has_r2: boolean },
 *       radio_proxy: { ok: true },
 *       live_relay: { configured: boolean },
 *     }
 *   }
 *
 * No auth — the values exposed here are all booleans + model slugs,
 * never credentials. Safe to surface to the client.
 */

interface Env {
  // AI Investigator
  OPENROUTER_API_KEY?: string;
  OPENROUTER_RESEARCH_MODEL?: string;
  AI_RATE_LIMIT?: unknown;       // KVNamespace
  // Transcribe
  OPENAI_API_KEY?: string;
  // Sync
  SYNC_TOKEN?: string;
  SYNC_DB?: unknown;             // D1Database
  MEDIA_BUCKET?: unknown;        // R2Bucket
  // Live relay
  WHIP_RELAY_TOKEN?: string;
  WHIP_RELAY_ENDPOINT?: string;
}

interface PagesContext<E = unknown> {
  request: Request;
  env: E;
}

type PagesFn<E = unknown> = (ctx: PagesContext<E>) => Response | Promise<Response>;

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export const onRequestOptions: PagesFn<Env> = async () => new Response(null, {
  status: 204,
  headers: { ...corsHeaders(), "Access-Control-Max-Age": "86400" },
});

export const onRequestGet: PagesFn<Env> = async ({ env }) => {
  const body = {
    ok: true,
    timestamp: new Date().toISOString(),
    features: {
      ai_research: {
        configured: !!env.OPENROUTER_API_KEY,
        model: env.OPENROUTER_RESEARCH_MODEL || "perplexity/sonar",
        rate_limit_kv: !!env.AI_RATE_LIMIT,
      },
      ai_transcribe: {
        configured: !!env.OPENAI_API_KEY,
      },
      sync: {
        configured: !!(env.SYNC_TOKEN && env.SYNC_DB && env.MEDIA_BUCKET),
        has_kv_token: !!env.SYNC_TOKEN,
        has_d1: !!env.SYNC_DB,
        has_r2: !!env.MEDIA_BUCKET,
      },
      radio_proxy: { ok: true },
      live_relay: {
        configured: !!(env.WHIP_RELAY_TOKEN && env.WHIP_RELAY_ENDPOINT),
      },
    },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...corsHeaders(),
    },
  });
};
