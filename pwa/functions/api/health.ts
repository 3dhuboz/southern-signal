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
 *       ai_research: { configured: boolean, has_model_key: boolean, model: string, rate_limit_kv: boolean },
 *       ai_transcribe: { configured: boolean, provider: "groq" | "openai" | "workers-ai" | "openrouter" | "none", openrouter_audio_allowed: boolean },
 *       sync: { configured: boolean, has_kv_token: boolean, has_d1: boolean, has_r2: boolean, signed_auth_kv: boolean },
 *       radio_proxy: { ok: true },
 *       live_relay: { configured: boolean, direct_whip_configured: boolean, cloudflare_rtmp_configured: boolean },
 *       fb_connector: { configured: boolean, has_token: boolean, has_account: boolean, has_stream_token: boolean, has_state_d1: boolean },
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
  GROQ_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ALLOW_OPENROUTER_AUDIO?: string;
  AI?: unknown;                    // Workers AI binding
  // Sync
  SYNC_TOKEN?: string;
  SYNC_DB?: unknown;             // D1Database
  MEDIA_BUCKET?: unknown;        // R2Bucket
  // Live relay
  WHIP_RELAY_TOKEN?: string;
  WHIP_RELAY_ENDPOINT?: string;
  // Facebook Live connector
  FB_CONNECT_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_STREAM_API_TOKEN?: string;
  FB_CONNECT_STATE?: unknown;    // D1Database
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

type TranscribeProvider = "groq" | "openai" | "workers-ai" | "openrouter" | "none";

function flagEnabled(value: string | undefined): boolean {
  return /^(1|true|yes)$/i.test(value ?? "");
}

function transcribeProvider(env: Env): TranscribeProvider {
  if (env.GROQ_API_KEY) return "groq";
  if (env.OPENAI_API_KEY) return "openai";
  if (env.AI) return "workers-ai";
  if (env.OPENROUTER_API_KEY && flagEnabled(env.ALLOW_OPENROUTER_AUDIO)) return "openrouter";
  return "none";
}

export const onRequestOptions: PagesFn<Env> = async () => new Response(null, {
  status: 204,
  headers: { ...corsHeaders(), "Access-Control-Max-Age": "86400" },
});

export const onRequestGet: PagesFn<Env> = async ({ env }) => {
  const provider = transcribeProvider(env);
  const hasAiModelKey = !!env.OPENROUTER_API_KEY;
  const hasRateLimitKv = !!env.AI_RATE_LIMIT;
  const hasFbToken = !!env.FB_CONNECT_TOKEN;
  const hasFbAccount = !!env.CF_ACCOUNT_ID;
  const hasFbStreamToken = !!env.CF_STREAM_API_TOKEN;
  const hasFbStateD1 = !!env.FB_CONNECT_STATE;

  const body = {
    ok: true,
    timestamp: new Date().toISOString(),
    features: {
      ai_research: {
        configured: hasAiModelKey && hasRateLimitKv,
        has_model_key: hasAiModelKey,
        model: env.OPENROUTER_RESEARCH_MODEL || "perplexity/sonar",
        rate_limit_kv: hasRateLimitKv,
      },
      ai_transcribe: {
        configured: provider !== "none",
        provider,
        openrouter_audio_allowed: !!env.OPENROUTER_API_KEY && flagEnabled(env.ALLOW_OPENROUTER_AUDIO),
      },
      sync: {
        configured: !!(env.SYNC_TOKEN && env.SYNC_DB && env.MEDIA_BUCKET && hasRateLimitKv),
        has_kv_token: !!env.SYNC_TOKEN,
        has_d1: !!env.SYNC_DB,
        has_r2: !!env.MEDIA_BUCKET,
        signed_auth_kv: hasRateLimitKv,
      },
      radio_proxy: { ok: true },
      live_relay: {
        configured: !!(env.WHIP_RELAY_TOKEN && env.WHIP_RELAY_ENDPOINT) || (hasFbToken && hasFbAccount && hasFbStreamToken && hasFbStateD1),
        direct_whip_configured: !!(env.WHIP_RELAY_TOKEN && env.WHIP_RELAY_ENDPOINT),
        cloudflare_rtmp_configured: hasFbToken && hasFbAccount && hasFbStreamToken && hasFbStateD1,
      },
      fb_connector: {
        configured: hasFbToken && hasFbAccount && hasFbStreamToken && hasFbStateD1,
        has_token: hasFbToken,
        has_account: hasFbAccount,
        has_stream_token: hasFbStreamToken,
        has_state_d1: hasFbStateD1,
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
