/**
 * Trust-boundary tests for /api/ai/* auth.
 *
 * The relay is tied to real-money credit accounts; anyone who can POST
 * unauthenticated is burning Steve's API budget. These tests pin the
 * contract that signed requests verify, unsigned requests are accepted
 * only in permissive mode, and Origin/Referer is always enforced.
 *
 * Default mode (2026-05-19 panel P0): STRICT / fail-closed. Unsigned
 * POSTs return 401 unless AI_RELAY_ALLOW_UNSIGNED=1 (or legacy
 * AI_RELAY_REQUIRE_SIGNED=0) is explicitly set.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { webcrypto } from "node:crypto";
import { authenticate, type AuthEnv, type AuthKVNamespace } from "./_auth";

// Node's webcrypto exposes Ed25519 since v20.
// Vitest already polyfills globalThis.crypto from node:crypto in modern
// versions, but the explicit assignment guards against running on
// older Node.
if (typeof (globalThis as { crypto?: Crypto }).crypto === "undefined") {
  (globalThis as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
}

const TEST_ORIGIN = "https://southern-signal.pages.dev";
const TEST_URL = `${TEST_ORIGIN}/api/ai/chat`;

class MemKV implements AuthKVNamespace {
  store = new Map<string, string>();
  async get(key: string) { return this.store.get(key) ?? null; }
  async put(key: string, value: string) { this.store.set(key, value); }
}

async function genKey(): Promise<{
  pubHex: string;
  signCanonical: (canonical: string) => Promise<string>;
}> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pubRaw = await crypto.subtle.exportKey("raw", pair.publicKey);
  const pubHex = Array.from(new Uint8Array(pubRaw)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return {
    pubHex,
    async signCanonical(canonical: string) {
      const sig = await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(canonical));
      const bytes = new Uint8Array(sig);
      let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin);
    },
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function makeReq(opts: {
  body?: Uint8Array;
  headers?: Record<string, string>;
  method?: string;
  url?: string;
}): Request {
  const headers = new Headers({ Origin: TEST_ORIGIN, ...(opts.headers ?? {}) });
  return new Request(opts.url ?? TEST_URL, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body ?? new Uint8Array(0),
  });
}

let kv: MemKV;
const env = (): AuthEnv => ({ AI_RATE_LIMIT: kv, AI_RATE_LIMIT_SALT: "test-salt" });

beforeEach(() => { kv = new MemKV(); });

describe("authenticate — Origin / Referer enforcement", () => {
  it("refuses requests with missing Origin AND Referer", async () => {
    const req = new Request(TEST_URL, { method: "POST" });
    const out = await authenticate(req, env(), { bodyBytes: new Uint8Array(0) });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(403);
  });

  it("refuses Origin that isn't the request's own origin", async () => {
    const req = makeReq({ headers: { Origin: "https://evil.example" } });
    const out = await authenticate(req, env(), { bodyBytes: new Uint8Array(0) });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(403);
  });

  it("accepts same-origin Origin header in PERMISSIVE mode (AI_RELAY_ALLOW_UNSIGNED=1)", async () => {
    // Permissive mode is no longer the default — it has to be opted into.
    const req = makeReq({});
    const out = await authenticate(req, { ...env(), AI_RELAY_ALLOW_UNSIGNED: "1" }, { bodyBytes: new Uint8Array(0) });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.signed).toBe(false);
  });

  it("accepts a Referer when Origin is absent (permissive mode)", async () => {
    const req = new Request(TEST_URL, {
      method: "POST",
      headers: new Headers({ Referer: `${TEST_ORIGIN}/some/page` }),
    });
    const out = await authenticate(req, { ...env(), AI_RELAY_ALLOW_UNSIGNED: "1" }, { bodyBytes: new Uint8Array(0) });
    expect(out.ok).toBe(true);
  });
});

describe("authenticate — fail-closed default (2026-05-19 panel P0)", () => {
  it("refuses unsigned requests in the DEFAULT (no env var set) mode", async () => {
    // The headline regression-blocker: a leaked /api/ai/* URL POSTed from
    // anywhere with a same-origin spoof would burn the operator's budget
    // before this commit. Default behaviour must now be a 401.
    const req = makeReq({});
    const out = await authenticate(req, env(), { bodyBytes: new Uint8Array(0) });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(401);
      expect(out.error.toLowerCase()).toContain("signed");
    }
  });

  it("LEGACY: AI_RELAY_REQUIRE_SIGNED=1 is a no-op (same as default)", async () => {
    // Backward compat — operators who set this var explicitly during the
    // earlier rollout should see the same strict behaviour.
    const req = makeReq({});
    const out = await authenticate(
      req,
      { ...env(), AI_RELAY_REQUIRE_SIGNED: "1" },
      { bodyBytes: new Uint8Array(0) },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(401);
  });

  it("LEGACY: AI_RELAY_REQUIRE_SIGNED=0 still flips to permissive (rollout safety)", async () => {
    // A Cloudflare Pages env that still has the old var set to "0" must
    // keep behaving permissively so existing deploys don't 401 the
    // moment this commit lands — operators need an explicit migration
    // window to remove the variable. The console.warn surfaces the
    // slip-up.
    const req = makeReq({});
    const out = await authenticate(
      req,
      { ...env(), AI_RELAY_REQUIRE_SIGNED: "0" },
      { bodyBytes: new Uint8Array(0) },
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.signed).toBe(false);
  });

  it("AI_RELAY_ALLOW_UNSIGNED=1 explicit opt-in: unsigned POST accepted (dev/migration mode)", async () => {
    // The supported way to keep accepting unsigned requests during a
    // rollout window.
    const req = makeReq({});
    const out = await authenticate(
      req,
      { ...env(), AI_RELAY_ALLOW_UNSIGNED: "1" },
      { bodyBytes: new Uint8Array(0) },
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.signed).toBe(false);
  });

  it("accepts signed requests in strict (default) mode", async () => {
    const { pubHex, signCanonical } = await genKey();
    const body = new TextEncoder().encode(JSON.stringify({ hello: "world" }));
    const timestamp = Date.now();
    const bodyHashHex = await sha256Hex(body);
    const canonical = `${pubHex}\nPOST\n/api/ai/chat\n${timestamp}\n${bodyHashHex}`;
    const sig = await signCanonical(canonical);
    const req = makeReq({
      body,
      headers: {
        "X-SS-Pubkey": pubHex,
        "X-SS-Timestamp": String(timestamp),
        "X-SS-Signature": sig,
      },
    });
    const out = await authenticate(req, env(), { bodyBytes: body });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.signed).toBe(true);
      if (out.signed) expect(out.pubkeyHex).toBe(pubHex);
    }
  });
});

describe("authenticate — signature verification", () => {
  it("rejects mismatched body (replay with mutated payload)", async () => {
    const { pubHex, signCanonical } = await genKey();
    const originalBody = new TextEncoder().encode(JSON.stringify({ hello: "world" }));
    const tamperedBody = new TextEncoder().encode(JSON.stringify({ hello: "evil" }));
    const timestamp = Date.now();
    const bodyHashHex = await sha256Hex(originalBody);
    const canonical = `${pubHex}\nPOST\n/api/ai/chat\n${timestamp}\n${bodyHashHex}`;
    const sig = await signCanonical(canonical);
    const req = makeReq({
      body: tamperedBody,
      headers: { "X-SS-Pubkey": pubHex, "X-SS-Timestamp": String(timestamp), "X-SS-Signature": sig },
    });
    const out = await authenticate(req, env(), { bodyBytes: tamperedBody });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(401);
  });

  it("rejects expired timestamp (out of 5min skew)", async () => {
    const { pubHex, signCanonical } = await genKey();
    const body = new TextEncoder().encode("{}");
    const staleTimestamp = Date.now() - 10 * 60_000; // 10 min ago
    const bodyHashHex = await sha256Hex(body);
    const canonical = `${pubHex}\nPOST\n/api/ai/chat\n${staleTimestamp}\n${bodyHashHex}`;
    const sig = await signCanonical(canonical);
    const req = makeReq({
      body,
      headers: { "X-SS-Pubkey": pubHex, "X-SS-Timestamp": String(staleTimestamp), "X-SS-Signature": sig },
    });
    const out = await authenticate(req, env(), { bodyBytes: body });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(401);
  });

  it("rejects wrong pubkey (signature from different key)", async () => {
    const { signCanonical } = await genKey();
    const { pubHex: pubHexB } = await genKey(); // different key
    const body = new TextEncoder().encode("{}");
    const timestamp = Date.now();
    const bodyHashHex = await sha256Hex(body);
    // Sign with A but claim pubkey B.
    const canonical = `${pubHexB}\nPOST\n/api/ai/chat\n${timestamp}\n${bodyHashHex}`;
    const sig = await signCanonical(canonical);
    const req = makeReq({
      body,
      headers: { "X-SS-Pubkey": pubHexB, "X-SS-Timestamp": String(timestamp), "X-SS-Signature": sig },
    });
    const out = await authenticate(req, env(), { bodyBytes: body });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(401);
  });

  it("rejects malformed pubkey hex", async () => {
    const req = makeReq({
      headers: {
        "X-SS-Pubkey": "not-hex",
        "X-SS-Timestamp": String(Date.now()),
        "X-SS-Signature": "AAAA",
      },
    });
    const out = await authenticate(req, env(), { bodyBytes: new Uint8Array(0) });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(401);
  });

  it("rejects partial signing headers (only some present)", async () => {
    const req = makeReq({
      headers: { "X-SS-Pubkey": "00".repeat(32) },
    });
    const out = await authenticate(req, env(), { bodyBytes: new Uint8Array(0) });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(401);
  });
});

describe("authenticate — per-device rate limiting", () => {
  it("returns 429 once the daily cap is reached", async () => {
    const { pubHex, signCanonical } = await genKey();
    // Pre-fill the day bucket past the cap.
    const dayBucket = Math.floor(Date.now() / 86_400_000);
    await kv.put(`dev:${pubHex}:d:${dayBucket}`, "9999");
    // Also pre-mark TOFU so registration doesn't trip first.
    await kv.put(`dev-seen:${pubHex}`, JSON.stringify({ firstSeen: new Date().toISOString() }));

    const body = new TextEncoder().encode("{}");
    const timestamp = Date.now();
    const bodyHashHex = await sha256Hex(body);
    const canonical = `${pubHex}\nPOST\n/api/ai/chat\n${timestamp}\n${bodyHashHex}`;
    const sig = await signCanonical(canonical);
    const req = makeReq({
      body,
      headers: { "X-SS-Pubkey": pubHex, "X-SS-Timestamp": String(timestamp), "X-SS-Signature": sig },
    });
    const out = await authenticate(req, env(), { bodyBytes: body });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(429);
  });
});
