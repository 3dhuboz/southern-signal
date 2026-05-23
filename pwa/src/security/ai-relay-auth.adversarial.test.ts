/**
 * Adversarial regression tests for /api/ai/* request authentication
 * (functions/api/ai/_auth.ts — commit 6fa99b2).
 *
 * Threat model the auth scheme closes:
 *
 *   The /api/ai/* endpoints proxy to OpenRouter / Groq / OpenAI, billed
 *   against the operator's real-money credit accounts. WITHOUT auth, any
 *   attacker who learns the URL can:
 *
 *     1. Send unsigned POSTs from curl / scripts to burn budget.
 *     2. Sign with a fresh keypair they generated to bypass any pubkey
 *        allowlist (forgery via mis-claimed identity).
 *     3. Replay a captured signature against a different body (e.g.
 *        swap a cheap question for an expensive multi-thousand-token
 *        prompt) — signature still looks "valid" if the canonical
 *        envelope doesn't bind the body hash.
 *     4. Submit from any origin (curl/server) — Origin/Referer is the
 *        defence-in-depth that the relay is browser-PWA only.
 *
 *   The auth code MUST reject all four. Specifically:
 *     - Default (strict) mode                   → unsigned = 401.
 *     - Permissive opt-in still has limits      → see explicit opt-in test.
 *     - Wrong-key signature                     → 401 (signature invalid).
 *     - Replayed signature over different body  → 401 (body hash mismatch).
 *     - Bad Origin (cross-site / no header)     → 403 (forbidden origin).
 *
 * The existing _auth.test.ts is the trust-boundary suite. THIS file is
 * the attacker-shaped sibling: each test models a specific bypass attempt
 * and asserts authenticate() refuses with the right status code, so a
 * regression that quietly relaxes one of the four boundaries fails here
 * with a name that points at the attack.
 *
 * We test authenticate() directly with hand-crafted Request objects —
 * the function is pure (no Workers-runtime dependencies beyond the
 * standard `crypto` global, which node:webcrypto provides via Vitest's
 * polyfill).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import {
  authenticate,
  type AuthEnv,
  type AuthKVNamespace,
} from "../../functions/api/ai/_auth";

// Vitest polyfills globalThis.crypto on modern Node, but guard for older.
if (typeof (globalThis as { crypto?: Crypto }).crypto === "undefined") {
  (globalThis as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
}

// ---------------------------------------------------------------------------
// Fixture helpers — minimal KV, keypair generator, signed-Request builder.
// ---------------------------------------------------------------------------

const TEST_ORIGIN = "https://southern-signal.pages.dev";
const TEST_PATH = "/api/ai/chat";
const TEST_URL = `${TEST_ORIGIN}${TEST_PATH}`;

class MemKV implements AuthKVNamespace {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async put(key: string, value: string): Promise<void> { this.store.set(key, value); }
}

let kv: MemKV;
beforeEach(() => { kv = new MemKV(); });
const env = (extra: Partial<AuthEnv> = {}): AuthEnv => ({
  AI_RATE_LIMIT: kv,
  AI_RATE_LIMIT_SALT: "adversarial-test-salt",
  ...extra,
});

interface Keypair {
  pubHex: string;
  signCanonical: (canonical: string) => Promise<string>;
}

async function generateKey(): Promise<Keypair> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pubRaw = await crypto.subtle.exportKey("raw", pair.publicKey);
  const pubHex = Array.from(new Uint8Array(pubRaw))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return {
    pubHex,
    async signCanonical(canonical: string): Promise<string> {
      const sig = await crypto.subtle.sign(
        "Ed25519",
        pair.privateKey,
        new TextEncoder().encode(canonical),
      );
      const bytes = new Uint8Array(sig);
      let bin = "";
      for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    },
  };
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  // Cast required because TS lib.dom types narrowed `BufferSource` to
  // `Uint8Array<ArrayBuffer>` (not the more permissive `ArrayBufferLike`),
  // and the harness's lib resolution sometimes infers Uint8Array<SharedArrayBuffer>.
  // Runtime accepts any TypedArray; cast is purely a type-level concession.
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Build a Request that the relay should accept. Each adversarial test
 * starts from this and mutates exactly one thing — the canonical envelope
 * the signature was over, the pubkey, the body, the Origin, etc.
 */
async function buildSignedRequest(opts: {
  key: Keypair;
  body: Uint8Array;
  method?: string;
  path?: string;
  timestampMs?: number;
  origin?: string | null;
}): Promise<{ request: Request; bodyBytes: Uint8Array }> {
  const method = (opts.method ?? "POST").toUpperCase();
  const path = opts.path ?? TEST_PATH;
  const timestamp = opts.timestampMs ?? Date.now();
  const bodyHashHex = await sha256HexBytes(opts.body);
  const canonical = `${opts.key.pubHex}\n${method}\n${path}\n${timestamp}\n${bodyHashHex}`;
  const sigB64 = await opts.key.signCanonical(canonical);

  const headers = new Headers({
    "X-SS-Pubkey": opts.key.pubHex,
    "X-SS-Timestamp": String(timestamp),
    "X-SS-Signature": sigB64,
  });
  if (opts.origin === undefined) headers.set("Origin", TEST_ORIGIN);
  else if (opts.origin !== null) headers.set("Origin", opts.origin);

  const request = new Request(`${TEST_ORIGIN}${path}`, {
    method,
    headers,
    // Same Uint8Array<ArrayBufferLike> vs BodyInit narrowing as in
    // sha256HexBytes — cast is purely type-level, runtime is correct.
    body: opts.body.byteLength > 0 ? (opts.body as BodyInit) : undefined,
  });
  return { request, bodyBytes: opts.body };
}

// ---------------------------------------------------------------------------
// Adversarial tests
// ---------------------------------------------------------------------------

describe("/api/ai/* auth — adversarial: unsigned POST in default (strict) mode", () => {
  it("attacker: unsigned POST is REFUSED with 401 in the DEFAULT (env unset) mode", async () => {
    // The headline budget-drain attack: curl/script POSTs an unsigned
    // request to /api/ai/chat. Default behaviour (panel P0 fix
    // 2026-05-19) must reject with 401 — no env var needed.
    const req = new Request(TEST_URL, {
      method: "POST",
      headers: new Headers({ Origin: TEST_ORIGIN }),
      body: new Uint8Array(0),
    });
    const out = await authenticate(req, env(), { bodyBytes: new Uint8Array(0) });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(401);
      expect(out.error.toLowerCase()).toContain("signed");
    }
  });

  it("AI_RELAY_ALLOW_UNSIGNED=1 explicit opt-in: unsigned POST accepted (dev/migration mode)", async () => {
    // Permissive mode is no longer the default; it must be explicitly
    // opted into. This test pins that the escape hatch is still wired —
    // accepts the request and reports signed:false so the caller falls
    // back to IP-based rate-limit.
    const req = new Request(TEST_URL, {
      method: "POST",
      headers: new Headers({ Origin: TEST_ORIGIN }),
      body: new Uint8Array(0),
    });
    const out = await authenticate(
      req,
      env({ AI_RELAY_ALLOW_UNSIGNED: "1" }),
      { bodyBytes: new Uint8Array(0) },
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.signed).toBe(false);
      if (!out.signed) expect(out.pubkeyHex).toBeNull();
    }
  });

  it("LEGACY: AI_RELAY_REQUIRE_SIGNED=0 keeps permissive (rollout-window safety)", async () => {
    // Operators who set the OLD env var to "0" during the previous
    // rollout must keep getting the permissive behaviour they configured
    // — otherwise this commit silently 401s existing deploys. Migration
    // is operator-driven: remove the var, then optionally set the new
    // name.
    const req = new Request(TEST_URL, {
      method: "POST",
      headers: new Headers({ Origin: TEST_ORIGIN }),
      body: new Uint8Array(0),
    });
    const out = await authenticate(
      req,
      env({ AI_RELAY_REQUIRE_SIGNED: "0" }),
      { bodyBytes: new Uint8Array(0) },
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.signed).toBe(false);
  });

  it("LEGACY: AI_RELAY_REQUIRE_SIGNED=1 is a no-op vs the new strict default", async () => {
    // An older deploy that explicitly set "1" before the flip should
    // keep rejecting unsigned — same observable behaviour as default.
    const req = new Request(TEST_URL, {
      method: "POST",
      headers: new Headers({ Origin: TEST_ORIGIN }),
      body: new Uint8Array(0),
    });
    const out = await authenticate(
      req,
      env({ AI_RELAY_REQUIRE_SIGNED: "1" }),
      { bodyBytes: new Uint8Array(0) },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(401);
  });

  it("attacker: partial signing headers (Pubkey + Timestamp, no Signature) are REFUSED with 401 even in permissive mode", async () => {
    // Half-baked attempt — attacker grabbed pubkey + timestamp off the
    // wire but couldn't replay a signature. Auth code rejects because
    // ANY signing header present means ALL must be — and this rule
    // applies even when AI_RELAY_ALLOW_UNSIGNED=1.
    const req = new Request(TEST_URL, {
      method: "POST",
      headers: new Headers({
        Origin: TEST_ORIGIN,
        "X-SS-Pubkey": "ab".repeat(32),
        "X-SS-Timestamp": String(Date.now()),
      }),
      body: new Uint8Array(0),
    });
    const out = await authenticate(
      req,
      env({ AI_RELAY_ALLOW_UNSIGNED: "1" }),
      { bodyBytes: new Uint8Array(0) },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(401);
      expect(out.error.toLowerCase()).toContain("incomplete");
    }
  });
});

describe("/api/ai/* auth — adversarial: wrong-key signature", () => {
  it("attacker signs with key-A but claims pubkey-B in the header → 401", async () => {
    // Identity confusion attack: the attacker has their OWN keypair (A)
    // and signs the canonical envelope with it, but stuffs another
    // pubkey (B) — perhaps a target user's leaked pubkey — into the
    // X-SS-Pubkey header. Ed25519.verify against B will fail because
    // the signature is over A's curve.
    const attackerKey = await generateKey();
    const { pubHex: victimPubHex } = await generateKey();
    const body = new TextEncoder().encode(JSON.stringify({ user: "x", system: "y" }));
    const timestamp = Date.now();
    const bodyHashHex = await sha256HexBytes(body);
    // Sign the envelope as if it were from victim.
    const canonical = `${victimPubHex}\nPOST\n${TEST_PATH}\n${timestamp}\n${bodyHashHex}`;
    const sigB64 = await attackerKey.signCanonical(canonical);

    const req = new Request(TEST_URL, {
      method: "POST",
      headers: new Headers({
        Origin: TEST_ORIGIN,
        "X-SS-Pubkey": victimPubHex,
        "X-SS-Timestamp": String(timestamp),
        "X-SS-Signature": sigB64,
      }),
      body,
    });
    const out = await authenticate(req, env(), { bodyBytes: body });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(401);
      expect(out.error.toLowerCase()).toContain("signature");
    }
  });

  it("attacker forges a 32-byte garbage 'signature' over a real pubkey → 401", async () => {
    const { pubHex } = await generateKey();
    const body = new TextEncoder().encode(JSON.stringify({}));
    const timestamp = Date.now();
    // 64-byte garbage signature (valid length, invalid content).
    const garbage = new Uint8Array(64);
    crypto.getRandomValues(garbage);
    let bin = "";
    for (let i = 0; i < garbage.length; i += 1) bin += String.fromCharCode(garbage[i]);
    const sigB64 = btoa(bin);

    const req = new Request(TEST_URL, {
      method: "POST",
      headers: new Headers({
        Origin: TEST_ORIGIN,
        "X-SS-Pubkey": pubHex,
        "X-SS-Timestamp": String(timestamp),
        "X-SS-Signature": sigB64,
      }),
      body,
    });
    const out = await authenticate(req, env(), { bodyBytes: body });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(401);
  });
});

describe("/api/ai/* auth — adversarial: replay with different body", () => {
  it("attacker captures a valid signature, swaps the body, replays → 401 (body hash binding)", async () => {
    // The classic replay: attacker sniffs a legit signed request (e.g.
    // a cheap "hello" question), keeps the headers exactly, and swaps
    // the body for an EXPENSIVE prompt — long context, max tokens —
    // hoping the server validates the signature without re-checking
    // the body's hash. Canonical envelope binds sha256(body) so this
    // must fail.
    const victim = await generateKey();
    const cheapBody = new TextEncoder().encode(JSON.stringify({ system: "hi", user: "ping" }));
    const expensiveBody = new TextEncoder().encode(JSON.stringify({
      system: "Write a 10000-word novel.",
      user: "x".repeat(8000),
      max_tokens: 4096,
    }));
    const { request: validRequest } = await buildSignedRequest({ key: victim, body: cheapBody });

    // Replay: same headers, NEW body.
    const headers = new Headers();
    validRequest.headers.forEach((v, k) => headers.set(k, v));
    const replayRequest = new Request(TEST_URL, {
      method: "POST",
      headers,
      body: expensiveBody,
    });

    const out = await authenticate(replayRequest, env(), { bodyBytes: expensiveBody });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(401);
      expect(out.error.toLowerCase()).toContain("signature");
    }
  });

  it("attacker replays a captured signature against a different path → 401 (path binding)", async () => {
    // Same idea, different axis: signature was for /api/ai/chat; replay
    // it at /api/ai/research/stream (often a more expensive endpoint).
    // The canonical envelope includes the path, so the verifier rejects.
    const victim = await generateKey();
    const body = new TextEncoder().encode("{}");
    const timestamp = Date.now();
    const bodyHashHex = await sha256HexBytes(body);
    // Signed canonical envelope says /api/ai/chat.
    const canonical = `${victim.pubHex}\nPOST\n/api/ai/chat\n${timestamp}\n${bodyHashHex}`;
    const sigB64 = await victim.signCanonical(canonical);
    // Replay at a DIFFERENT URL — verify code rebuilds the canonical
    // string from request.url's path so the hashes won't match.
    const replayUrl = `${TEST_ORIGIN}/api/ai/research/stream`;
    const req = new Request(replayUrl, {
      method: "POST",
      headers: new Headers({
        Origin: TEST_ORIGIN,
        "X-SS-Pubkey": victim.pubHex,
        "X-SS-Timestamp": String(timestamp),
        "X-SS-Signature": sigB64,
      }),
      body,
    });
    const out = await authenticate(req, env(), { bodyBytes: body });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(401);
  });

  it("attacker replays a stale (10-min-old) signature → 401 (timestamp skew)", async () => {
    // Even if the signature, body, and path all match — a 10-minute-old
    // captured request shouldn't be replayable. 5-min max skew.
    const victim = await generateKey();
    const body = new TextEncoder().encode("{}");
    const staleTs = Date.now() - 10 * 60_000;
    const bodyHashHex = await sha256HexBytes(body);
    const canonical = `${victim.pubHex}\nPOST\n${TEST_PATH}\n${staleTs}\n${bodyHashHex}`;
    const sigB64 = await victim.signCanonical(canonical);

    const req = new Request(TEST_URL, {
      method: "POST",
      headers: new Headers({
        Origin: TEST_ORIGIN,
        "X-SS-Pubkey": victim.pubHex,
        "X-SS-Timestamp": String(staleTs),
        "X-SS-Signature": sigB64,
      }),
      body,
    });
    const out = await authenticate(req, env(), { bodyBytes: body });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(401);
      expect((out.detail ?? "").toLowerCase()).toContain("skew");
    }
  });
});

describe("/api/ai/* auth — adversarial: bad Origin", () => {
  it("attacker POSTs from cross-origin with a valid signature → 403", async () => {
    // Even with valid Ed25519, a request from evil.example.com must be
    // refused. Browsers send Origin on cross-origin requests; the relay
    // is exclusively a same-origin browser-PWA endpoint.
    const victim = await generateKey();
    const body = new TextEncoder().encode("{}");
    const { request } = await buildSignedRequest({
      key: victim,
      body,
      origin: "https://evil.example.com",
    });
    const out = await authenticate(request, env(), { bodyBytes: body });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(403);
      expect(out.error.toLowerCase()).toContain("origin");
    }
  });

  it("attacker POSTs from curl/server with NO Origin AND NO Referer → 403", async () => {
    // Non-browser clients (curl, scripts, server-side relays) don't
    // populate Origin and typically don't set Referer either. The relay
    // refuses these outright — even if the signature is valid.
    const victim = await generateKey();
    const body = new TextEncoder().encode("{}");
    const timestamp = Date.now();
    const bodyHashHex = await sha256HexBytes(body);
    const canonical = `${victim.pubHex}\nPOST\n${TEST_PATH}\n${timestamp}\n${bodyHashHex}`;
    const sigB64 = await victim.signCanonical(canonical);
    const req = new Request(TEST_URL, {
      method: "POST",
      headers: new Headers({
        "X-SS-Pubkey": victim.pubHex,
        "X-SS-Timestamp": String(timestamp),
        "X-SS-Signature": sigB64,
        // NB: no Origin, no Referer.
      }),
      body,
    });
    const out = await authenticate(req, env(), { bodyBytes: body });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(403);
      expect(out.error.toLowerCase()).toContain("origin");
    }
  });

  it("attacker spoofs Origin header from non-allowlisted custom AI_RELAY_ALLOWED_ORIGINS → 403", async () => {
    // Operator narrows the allowlist to a single prod origin. A request
    // from anywhere else (incl. the request's own URL host) is refused.
    const victim = await generateKey();
    const body = new TextEncoder().encode("{}");
    const { request } = await buildSignedRequest({
      key: victim,
      body,
      origin: "https://southern-signal.pages.dev", // matches request URL...
    });
    const out = await authenticate(
      request,
      env({ AI_RELAY_ALLOWED_ORIGINS: "https://only-this-one.example" }),
      { bodyBytes: body },
    );
    // ...but operator's allowlist says ONLY only-this-one.example.
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(403);
  });
});

describe("/api/ai/* auth — happy path sanity (proves the rejections above aren't false positives)", () => {
  it("a valid signed POST is REFUSED when the AI_RATE_LIMIT binding is missing", async () => {
    // A source-controlled KV binding now exists, but the runtime should
    // still fail closed if a Pages env ever loses it. Without KV, TOFU
    // registration and per-device counters silently disappear.
    const victim = await generateKey();
    const body = new TextEncoder().encode(JSON.stringify({ system: "s", user: "u" }));
    const { request } = await buildSignedRequest({ key: victim, body });
    const out = await authenticate(
      request,
      { AI_RATE_LIMIT_SALT: "adversarial-test-salt" },
      { bodyBytes: body },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(503);
      expect(out.error.toLowerCase()).toContain("rate-limit");
    }
  });

  it("a fully valid signed POST passes auth in the DEFAULT (strict) mode", async () => {
    // If THIS goes red, every adversarial test above is suspect — they
    // could be rejecting requests for an unrelated reason.
    const victim = await generateKey();
    const body = new TextEncoder().encode(JSON.stringify({ system: "s", user: "u" }));
    const { request } = await buildSignedRequest({ key: victim, body });
    const out = await authenticate(request, env(), { bodyBytes: body });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.signed).toBe(true);
      if (out.signed) expect(out.pubkeyHex).toBe(victim.pubHex);
    }
  });
});
