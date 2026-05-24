import { beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestPost } from "./connect";

type Context = Parameters<typeof onRequestPost>[0];
type Env = Context["env"];

interface Row {
  idempotency_key: string;
  request_hash: string;
  status: "in_progress" | "succeeded" | "failed";
  response_json: string | null;
  error_json: string | null;
  expires_at: string;
}

class MemKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async put(key: string, value: string): Promise<void> { this.store.set(key, value); }
}

class MemD1Statement {
  private values: unknown[] = [];
  constructor(private readonly db: MemD1, private readonly query: string) {}
  bind(...values: unknown[]): MemD1Statement {
    this.values = values;
    return this;
  }
  async run(): Promise<{ success: boolean; meta?: { changes: number } }> {
    if (this.query.startsWith("DELETE FROM fb_live_connect_requests")) {
      return { success: true };
    }
    if (this.query.startsWith("INSERT INTO fb_live_connect_requests")) {
      const [key, requestHash, _createdAt, _updatedAt, expiresAt] = this.values as [string, string, string, string, string];
      const existing = this.db.rows.get(key);
      if (!existing || (existing.status === "failed" && existing.request_hash === requestHash)) {
        this.db.rows.set(key, {
          idempotency_key: key,
          request_hash: requestHash,
          status: "in_progress",
          response_json: null,
          error_json: null,
          expires_at: expiresAt,
        });
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    }
    if (this.query.includes("SET status = 'succeeded'")) {
      const [responseJson, _updatedAt, key] = this.values as [string, string, string];
      const row = this.db.rows.get(key);
      if (row) {
        row.status = "succeeded";
        row.response_json = responseJson;
        row.error_json = null;
      }
      return { success: true };
    }
    if (this.query.includes("SET status = 'failed'")) {
      const [errorJson, _updatedAt, key] = this.values as [string, string, string];
      const row = this.db.rows.get(key);
      if (row) {
        row.status = "failed";
        row.error_json = errorJson;
      }
      return { success: true };
    }
    return { success: true };
  }
  async first<T>(): Promise<T | null> {
    const key = this.values[0] as string;
    return (this.db.rows.get(key) as T | undefined) ?? null;
  }
}

class MemD1 {
  rows = new Map<string, Row>();
  async exec(_query: string): Promise<void> {}
  prepare(query: string): MemD1Statement { return new MemD1Statement(this, query); }
}

function env(): Env {
  return {
    FB_CONNECT_TOKEN: "connect-secret",
    CF_ACCOUNT_ID: "acct",
    CF_STREAM_API_TOKEN: "cf-secret",
    FB_CONNECT_STATE: new MemD1(),
    AI_RATE_LIMIT: new MemKV(),
    AI_RATE_LIMIT_SALT: "test-salt",
  } as Env;
}

function request(body: Record<string, unknown>, idempotencyKey?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": "Bearer connect-secret",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  return new Request("https://southern-signal.pages.dev/api/live/fb/connect", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function ctx(envObj: Env, req: Request): Context {
  return {
    request: req,
    env: envObj,
    params: {},
    data: {},
    next: async () => new Response(null),
    waitUntil: () => {},
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installFetchMock(opts: { inputDelayMs?: number; failInputDetail?: string; failOutputDetail?: string } = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "DELETE") return new Response("{}", { status: 200 });
    if (url.endsWith("/outputs")) {
      if (opts.failOutputDetail) return new Response(opts.failOutputDetail, { status: 403 });
      return Response.json({ result: { uid: "output-1" } });
    }
    if (opts.inputDelayMs) await delay(opts.inputDelayMs);
    if (opts.failInputDetail) return new Response(opts.failInputDetail, { status: 403 });
    return Response.json({ result: { uid: "input-1", webRTC: { url: "https://customer.example/webrtc/publish" } } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("/api/live/fb/connect idempotency", () => {
  it("refuses to create paid Stream resources without an Idempotency-Key", async () => {
    const fetchMock = installFetchMock();
    const response = await onRequestPost(ctx(env(), request({ fb_stream_key: "fb-key" })));
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("replays the cached response for the same key and body without calling Cloudflare again", async () => {
    const fetchMock = installFetchMock();
    const envObj = env();
    const key = "connect-key-123456";

    const first = await onRequestPost(ctx(envObj, request({ fb_stream_key: "fb-key" }, key)));
    const second = await onRequestPost(ctx(envObj, request({ fb_stream_key: "fb-key" }, key)));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(second.json()).resolves.toMatchObject({ input_uid: "input-1", output_uid: "output-1" });
  });

  it("accepts a generic stream_key and custom RTMP target for YouTube relay", async () => {
    const fetchMock = installFetchMock();
    const envObj = env();

    const response = await onRequestPost(ctx(envObj, request({
      stream_key: "youtube-key",
      fb_rtmp_url: "rtmps://a.rtmps.youtube.com/live2",
      platform: "YouTube Live",
    }, "connect-key-youtube-123")));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      fb_rtmp_url: "rtmps://a.rtmps.youtube.com/live2",
    });
    const outputCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/outputs"));
    expect(outputCall).toBeTruthy();
    expect(JSON.parse(String(outputCall?.[1]?.body))).toMatchObject({
      url: "rtmps://a.rtmps.youtube.com/live2",
      streamKey: "youtube-key",
      enabled: true,
    });
  });

  it("rejects the same key with a different stream key", async () => {
    installFetchMock();
    const envObj = env();
    const key = "connect-key-abcdef";

    await onRequestPost(ctx(envObj, request({ fb_stream_key: "fb-key" }, key)));
    const conflict = await onRequestPost(ctx(envObj, request({ fb_stream_key: "other-key" }, key)));

    expect(conflict.status).toBe(409);
  });

  it("does not create duplicate Stream resources for concurrent same-key requests", async () => {
    const fetchMock = installFetchMock({ inputDelayMs: 20 });
    const envObj = env();
    const key = "connect-key-race-123";

    const [first, second] = await Promise.all([
      onRequestPost(ctx(envObj, request({ fb_stream_key: "fb-key" }, key))),
      onRequestPost(ctx(envObj, request({ fb_stream_key: "fb-key" }, key))),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not leak raw Cloudflare error bodies to the browser", async () => {
    installFetchMock({ failInputDetail: "streamKey=fb-secret-do-not-leak" });

    const response = await onRequestPost(ctx(env(), request({ fb_stream_key: "fb-key" }, "connect-key-error-123")));
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(text).toContain("\"step\":\"live_inputs\"");
    expect(text).not.toContain("fb-secret-do-not-leak");
    expect(text).not.toContain("cf_detail");
  });

  it("counts failed Cloudflare create attempts toward the connector rate limit", async () => {
    const fetchMock = installFetchMock({ failInputDetail: "streamKey=fb-secret-do-not-leak" });
    const envObj = env();

    for (const key of ["connect-key-fail-001", "connect-key-fail-002", "connect-key-fail-003"]) {
      const response = await onRequestPost(ctx(envObj, request({ fb_stream_key: "fb-key" }, key)));
      expect(response.status).toBe(502);
    }

    const blocked = await onRequestPost(ctx(envObj, request({ fb_stream_key: "fb-key" }, "connect-key-fail-004")));
    expect(blocked.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
