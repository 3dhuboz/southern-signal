import { describe, expect, it } from "vitest";
// Import the Pages Function handler directly. The path is unusual but
// vitest resolves it the same way Cloudflare's bundler does at deploy
// time, so the test runs against the same module the platform will run.
// eslint-disable-next-line import/no-relative-packages
import { onRequestGet, onRequestOptions } from "../../functions/api/health";

interface Env {
  OPENROUTER_API_KEY?: string;
  OPENROUTER_RESEARCH_MODEL?: string;
  AI_RATE_LIMIT?: unknown;
  OPENAI_API_KEY?: string;
  SYNC_TOKEN?: string;
  SYNC_DB?: unknown;
  MEDIA_BUCKET?: unknown;
  WHIP_RELAY_TOKEN?: string;
  WHIP_RELAY_ENDPOINT?: string;
}

function mkCtx(env: Env): { request: Request; env: Env } {
  return { request: new Request("https://example.test/api/health"), env };
}

describe("GET /api/health", () => {
  it("reports all features OFF when no env is set", async () => {
    const res = await onRequestGet(mkCtx({}));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; features: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.features).toMatchObject({
      ai_research: { configured: false, rate_limit_kv: false },
      ai_transcribe: { configured: false },
      sync: { configured: false, has_kv_token: false, has_d1: false, has_r2: false },
      radio_proxy: { ok: true },
      live_relay: { configured: false },
    });
  });

  it("reports AI Investigator configured when OPENROUTER_API_KEY is set", async () => {
    const res = await onRequestGet(mkCtx({ OPENROUTER_API_KEY: "sk-xxx" }));
    const body = await res.json() as { features: { ai_research: { configured: boolean; model: string } } };
    expect(body.features.ai_research.configured).toBe(true);
    // Default model when OPENROUTER_RESEARCH_MODEL not set.
    expect(body.features.ai_research.model).toBe("perplexity/sonar");
  });

  it("reports a custom OPENROUTER_RESEARCH_MODEL when set", async () => {
    const res = await onRequestGet(mkCtx({
      OPENROUTER_API_KEY: "sk-xxx",
      OPENROUTER_RESEARCH_MODEL: "perplexity/sonar-pro",
    }));
    const body = await res.json() as { features: { ai_research: { model: string } } };
    expect(body.features.ai_research.model).toBe("perplexity/sonar-pro");
  });

  it("reports rate_limit_kv true when AI_RATE_LIMIT binding is present", async () => {
    const res = await onRequestGet(mkCtx({
      OPENROUTER_API_KEY: "sk-xxx",
      AI_RATE_LIMIT: { get: () => null, put: async () => undefined },
    }));
    const body = await res.json() as { features: { ai_research: { rate_limit_kv: boolean } } };
    expect(body.features.ai_research.rate_limit_kv).toBe(true);
  });

  it("reports sync configured ONLY when all three bindings (token + D1 + R2) are present", async () => {
    // Just the token isn't enough.
    let res = await onRequestGet(mkCtx({ SYNC_TOKEN: "secret" }));
    let body = await res.json() as { features: { sync: { configured: boolean; has_kv_token: boolean; has_d1: boolean; has_r2: boolean } } };
    expect(body.features.sync.configured).toBe(false);
    expect(body.features.sync.has_kv_token).toBe(true);
    expect(body.features.sync.has_d1).toBe(false);

    // All three present.
    res = await onRequestGet(mkCtx({
      SYNC_TOKEN: "secret",
      SYNC_DB: { prepare: () => null },
      MEDIA_BUCKET: { put: async () => undefined },
    }));
    body = await res.json() as { features: { sync: { configured: boolean; has_kv_token: boolean; has_d1: boolean; has_r2: boolean } } };
    expect(body.features.sync.configured).toBe(true);
  });

  it("reports live_relay configured ONLY when both token and endpoint are set", async () => {
    let res = await onRequestGet(mkCtx({ WHIP_RELAY_TOKEN: "x" }));
    let body = await res.json() as { features: { live_relay: { configured: boolean } } };
    expect(body.features.live_relay.configured).toBe(false);

    res = await onRequestGet(mkCtx({ WHIP_RELAY_TOKEN: "x", WHIP_RELAY_ENDPOINT: "https://relay" }));
    body = await res.json() as { features: { live_relay: { configured: boolean } } };
    expect(body.features.live_relay.configured).toBe(true);
  });

  it("never leaks credential values in the response", async () => {
    const res = await onRequestGet(mkCtx({
      OPENROUTER_API_KEY: "sk-secret-do-not-leak",
      OPENAI_API_KEY: "sk-also-secret",
      SYNC_TOKEN: "bearer-secret",
      WHIP_RELAY_TOKEN: "relay-secret",
      WHIP_RELAY_ENDPOINT: "https://relay",
    }));
    const text = await res.text();
    expect(text).not.toContain("sk-secret-do-not-leak");
    expect(text).not.toContain("sk-also-secret");
    expect(text).not.toContain("bearer-secret");
    expect(text).not.toContain("relay-secret");
    // The endpoint URL is not a credential, so we don't filter it.
  });

  it("sets Cache-Control: no-store and CORS headers", async () => {
    const res = await onRequestGet(mkCtx({}));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("returns a stable ISO timestamp", async () => {
    const res = await onRequestGet(mkCtx({}));
    const body = await res.json() as { timestamp: string };
    expect(new Date(body.timestamp).toString()).not.toBe("Invalid Date");
  });
});

describe("OPTIONS /api/health (preflight)", () => {
  it("responds 204 with CORS headers", async () => {
    const res = await onRequestOptions(mkCtx({}));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });
});
