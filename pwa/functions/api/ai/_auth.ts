/**
 * Authentication for /api/ai/* Pages Functions.
 *
 * Threat model (the only reason this file exists):
 *
 *   Without auth, anyone who learns the URL can POST to /api/ai/chat,
 *   /api/ai/transcribe, /api/ai/research, /api/ai/research/stream, or
 *   /api/ai/evp-review and burn the operator's OpenRouter / Groq /
 *   OpenAI budget. The endpoints are tied to real-money credit
 *   accounts. An unauth'd public AI relay is a budget-drain attack
 *   pointed at one person's wallet.
 *
 * Auth scheme — Ed25519 request signing using the device's existing
 * forensic signing keypair (src/lib/forensic/signingKeyStore.ts).
 * Reusing that keypair means:
 *
 *   1. No new device-identity story to ship — the key is already
 *      generated on first run and survives across sessions in
 *      IndexedDB.
 *   2. The same pubkey that signs forensic export manifests now
 *      signs API requests, so the operator's device identity is
 *      consistent across the trust chain.
 *
 * Canonical signing string (newline-delimited, no trailing newline):
 *
 *   <pubkey-hex>\n<METHOD>\n<path>\n<timestamp-ms>\n<sha256-of-body-hex>
 *
 * Headers the client must send:
 *
 *   X-SS-Pubkey      64-char hex Ed25519 public key
 *   X-SS-Timestamp   ms-epoch integer, within ±5 min of server clock
 *   X-SS-Signature   base64 of 64-byte Ed25519 signature
 *
 * The server also checks Origin / Referer against ALLOWED_ORIGINS (env)
 * as defense-in-depth — a stolen pubkey + sig replay still has to come
 * from an expected origin. CORS preflights pass through unauthenticated.
 *
 * Trust-on-first-use (TOFU): unseen pubkeys are registered in KV the
 * first time we verify a valid signature from them. Registration is
 * itself rate-limited by IP (5 first-time devices per IP per day) so a
 * malicious actor can't enumerate the keyspace.
 *
 * Fail-closed contract (panel P0, 2026-05-19): the relay rejects
 * unsigned requests by default. The threat model — a leaked /api/ai/chat
 * URL draining the operator's OpenRouter / Anthropic budget — makes a
 * permissive default a budget-drain attack waiting to happen.
 *
 *   AI_RELAY_ALLOW_UNSIGNED=1  → permissive (dev / migration only). The
 *     server still verifies signatures when present (per-pubkey rate
 *     limits), but accepts unsigned requests too. A console.warn is
 *     emitted on each request so the slip-up is visible in `wrangler
 *     tail`. Use this ONLY when rolling out a new client that hasn't
 *     shipped its signing code yet.
 *   anything else (incl. unset) → strict / fail-closed. Unsigned POSTs
 *     get a 401. This is the production default.
 *
 * Backward compatibility — older deployments set AI_RELAY_REQUIRE_SIGNED
 * to flip the bit; the semantics inverted in this commit. The mapping:
 *
 *   AI_RELAY_REQUIRE_SIGNED=1   → strict (same as default)             — no-op
 *   AI_RELAY_REQUIRE_SIGNED=0   → equivalent to AI_RELAY_ALLOW_UNSIGNED=1
 *
 * The Origin / IP rate-limit defenses stay on regardless of which
 * switch is set. See `wrangler.jsonc` for the operator-facing config
 * documentation.
 */

export interface AuthEnv {
  /**
   * Opt-in to permissive mode (accept unsigned requests). Set to "1" /
   * "true" / "yes" for dev / migration windows only. Default (unset or
   * any other value) is strict / fail-closed: unsigned POSTs → 401.
   *
   * A console.warn is emitted on every authenticated request while this
   * flag is on, so the slip-up is visible in `wrangler tail`.
   */
  AI_RELAY_ALLOW_UNSIGNED?: string;
  /**
   * Legacy switch (kept for backward compatibility through the rollout
   * window). Semantics inverted on 2026-05-19:
   *
   *   "1" / "true" → strict (no-op; same as default).
   *   "0" / "false" → permissive (equivalent to AI_RELAY_ALLOW_UNSIGNED=1).
   *
   * New deployments should set AI_RELAY_ALLOW_UNSIGNED instead. This
   * field is here so an older Cloudflare Pages env that still has
   * AI_RELAY_REQUIRE_SIGNED=0 set doesn't suddenly start rejecting
   * traffic without an operator-visible warning.
   */
  AI_RELAY_REQUIRE_SIGNED?: string;
  /** Comma-separated list of allowed origins. Defaults to the request's own origin (same-origin only). Set to "*" to allow any. */
  AI_RELAY_ALLOWED_ORIGINS?: string;
  /** KV namespace shared with the rate-limit / research counters. */
  AI_RATE_LIMIT?: AuthKVNamespace;
  /** Salt for IP hashing (re-uses the research salt). */
  AI_RATE_LIMIT_SALT?: string;
}

export interface AuthKVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/** Max clock skew between client and server in either direction. 5 minutes
 *  matches what AWS SigV4 + most OAuth implementations use. */
const MAX_SKEW_MS = 5 * 60_000;

/** Per-device caps. These are LOOSER than the per-IP caps in /research
 *  because a device represents a single investigator's pipe, whereas an
 *  IP can be a NAT shared by multiple devices. */
const DEVICE_REQS_PER_HOUR = 30;
const DEVICE_REQS_PER_DAY = 300;

/** First-time-pubkey registrations a single IP can do per day. Limits a
 *  malicious actor's ability to enumerate fake device identities by
 *  pumping fresh keypairs through the door. */
const TOFU_REGISTRATIONS_PER_IP_PER_DAY = 5;

export type AuthOutcome =
  | { ok: true; pubkeyHex: string; signed: true }
  | { ok: true; pubkeyHex: null; signed: false; reason: string }
  | { ok: false; status: number; error: string; detail?: string };

export interface AuthRequestContext {
  /** Raw request body bytes (we may need to hash them again for signature verification). */
  bodyBytes: Uint8Array;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (typeof hex !== "string" || hex.length % 2 !== 0) return null;
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 1) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

function parseAllowedOrigins(env: AuthEnv, requestUrl: string): { wildcard: boolean; origins: Set<string> } {
  const raw = (env.AI_RELAY_ALLOWED_ORIGINS ?? "").trim();
  if (raw === "*") return { wildcard: true, origins: new Set() };
  const origins = new Set<string>();
  if (raw) {
    for (const o of raw.split(",")) {
      const t = o.trim();
      if (t) origins.add(t);
    }
  } else {
    // Default — same-origin only. Derive from the request's own origin so
    // dev (localhost) and prod (southern-signal.pages.dev) both work
    // without further config.
    try { origins.add(new URL(requestUrl).origin); } catch { /* fall through */ }
  }
  return { wildcard: false, origins };
}

function originHeaderOk(request: Request, env: AuthEnv): { ok: true } | { ok: false; reason: string } {
  const origin = request.headers.get("Origin");
  const referer = request.headers.get("Referer");
  const { wildcard, origins } = parseAllowedOrigins(env, request.url);
  if (wildcard) return { ok: true };

  // Browsers don't always send Origin on same-origin requests, but they
  // do send Referer. Accept either.
  let candidate: string | null = null;
  if (origin) candidate = origin;
  else if (referer) {
    try { candidate = new URL(referer).origin; } catch { /* unparseable */ }
  }

  if (!candidate) {
    // No Origin AND no Referer — likely a non-browser client (curl, server).
    // Refuse, since the AI relay is exclusively a browser-PWA endpoint.
    return { ok: false, reason: "Missing Origin/Referer header." };
  }
  if (!origins.has(candidate)) {
    return { ok: false, reason: `Origin '${candidate}' is not allowed.` };
  }
  return { ok: true };
}

async function verifySignature(
  pubkeyHex: string,
  timestampMs: number,
  signatureB64: string,
  request: Request,
  bodyBytes: Uint8Array,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const pubBytes = hexToBytes(pubkeyHex);
  if (!pubBytes || pubBytes.length !== 32) return { ok: false, reason: "Pubkey must be 32 bytes (64 hex chars)." };
  const sigBytes = base64ToBytes(signatureB64);
  if (!sigBytes || sigBytes.length !== 64) return { ok: false, reason: "Signature must be 64 bytes base64." };

  const now = Date.now();
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > MAX_SKEW_MS) {
    return { ok: false, reason: `Timestamp out of skew (${Math.abs(now - timestampMs)}ms vs ${MAX_SKEW_MS}ms cap).` };
  }

  const bodyHashHex = await sha256Hex(bodyBytes);
  const path = (() => { try { return new URL(request.url).pathname; } catch { return request.url; } })();
  const canonical = `${pubkeyHex.toLowerCase()}\n${request.method.toUpperCase()}\n${path}\n${timestampMs}\n${bodyHashHex}`;
  const canonicalBytes = new TextEncoder().encode(canonical);

  let publicKey: CryptoKey;
  try {
    publicKey = await crypto.subtle.importKey(
      "raw",
      pubBytes as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch (err) {
    return { ok: false, reason: `Pubkey import failed: ${(err as Error).message}` };
  }

  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      sigBytes as BufferSource,
      canonicalBytes as BufferSource,
    );
  } catch (err) {
    return { ok: false, reason: `Signature verify threw: ${(err as Error).message}` };
  }
  if (!valid) return { ok: false, reason: "Signature does not verify against canonical envelope." };
  return { ok: true };
}

interface DeviceRateState {
  hour: { used: number; cap: number; resetMs: number; key: string | null };
  day: { used: number; cap: number; resetMs: number; key: string | null };
}

async function readDeviceRate(kv: AuthKVNamespace | undefined, pubkeyHex: string): Promise<DeviceRateState> {
  const now = Date.now();
  const hourBucket = Math.floor(now / 3_600_000);
  const dayBucket = Math.floor(now / 86_400_000);
  const hourReset = (hourBucket + 1) * 3_600_000 - now;
  const dayReset = (dayBucket + 1) * 86_400_000 - now;
  if (!kv) {
    return {
      hour: { used: 0, cap: DEVICE_REQS_PER_HOUR, resetMs: hourReset, key: null },
      day: { used: 0, cap: DEVICE_REQS_PER_DAY, resetMs: dayReset, key: null },
    };
  }
  const hourKey = `dev:${pubkeyHex}:h:${hourBucket}`;
  const dayKey = `dev:${pubkeyHex}:d:${dayBucket}`;
  const [hRaw, dRaw] = await Promise.all([kv.get(hourKey), kv.get(dayKey)]);
  return {
    hour: { used: parseInt(hRaw ?? "0", 10) || 0, cap: DEVICE_REQS_PER_HOUR, resetMs: hourReset, key: hourKey },
    day:  { used: parseInt(dRaw ?? "0", 10) || 0, cap: DEVICE_REQS_PER_DAY,  resetMs: dayReset,  key: dayKey },
  };
}

async function bumpDeviceRate(kv: AuthKVNamespace | undefined, state: DeviceRateState): Promise<void> {
  if (!kv) return;
  const writes: Promise<void>[] = [];
  if (state.hour.key) writes.push(kv.put(state.hour.key, String(state.hour.used + 1), { expirationTtl: 3600 + 60 }));
  if (state.day.key)  writes.push(kv.put(state.day.key,  String(state.day.used + 1),  { expirationTtl: 86400 + 3600 }));
  await Promise.all(writes);
}

async function ipHash(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest)).slice(0, 24);
}

function callerIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP")
    ?? request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim()
    ?? "unknown";
}

async function tofuRegister(
  kv: AuthKVNamespace | undefined,
  env: AuthEnv,
  pubkeyHex: string,
  request: Request,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!kv) return { ok: true }; // No KV = no registry; permit (rate-limit still applies per-IP via /research path).

  const seenKey = `dev-seen:${pubkeyHex}`;
  const already = await kv.get(seenKey);
  if (already) return { ok: true };

  // First-time pubkey from this IP — gate registrations to prevent
  // enumeration by an attacker churning fresh keypairs.
  const ip = callerIp(request);
  const salt = env.AI_RATE_LIMIT_SALT ?? "ss-tofu-v1";
  const hash = await ipHash(ip, salt);
  const now = Date.now();
  const dayBucket = Math.floor(now / 86_400_000);
  const regKey = `tofu:${hash}:${dayBucket}`;
  const used = parseInt((await kv.get(regKey)) ?? "0", 10) || 0;
  if (used >= TOFU_REGISTRATIONS_PER_IP_PER_DAY) {
    return { ok: false, reason: "First-time-device registration limit reached for this network." };
  }
  // Best-effort writes; failure here doesn't block the request.
  try {
    await Promise.all([
      kv.put(seenKey, JSON.stringify({ firstSeen: new Date().toISOString() })),
      kv.put(regKey, String(used + 1), { expirationTtl: 86400 + 3600 }),
    ]);
  } catch { /* swallow — KV transient errors shouldn't kill the request */ }
  return { ok: true };
}

/**
 * Resolve the permissive-mode flag.
 *
 *   - AI_RELAY_ALLOW_UNSIGNED=1 → permissive.
 *   - Legacy: AI_RELAY_REQUIRE_SIGNED=0 → permissive (old name for the
 *     same semantics, kept so a deploy that still has the old var set
 *     to "0" doesn't suddenly start refusing traffic with no migration
 *     notice in the operator's dashboard).
 *   - anything else → strict (fail-closed) — the default.
 *
 * The "1"/"true"/"yes" parsing matches the rest of the codebase (case-
 * insensitive). Any other value, incl. empty string, falls through to
 * strict.
 */
function isPermissiveModeOn(env: AuthEnv): boolean {
  if (/^(1|true|yes)$/i.test(env.AI_RELAY_ALLOW_UNSIGNED ?? "")) return true;
  // Backward compat: AI_RELAY_REQUIRE_SIGNED=0 / =false / =no = permissive.
  if (/^(0|false|no)$/i.test(env.AI_RELAY_REQUIRE_SIGNED ?? "")) return true;
  return false;
}

/**
 * Emit a one-line warning when permissive mode is active. Visible in
 * `wrangler tail` output so operators who forget to remove the
 * dev-rollout opt-in see it on every request, not just at deploy time.
 *
 * Throttled to once-per-minute per worker isolate to avoid log spam
 * under load; the goal is operator-visibility, not per-request paranoia.
 */
let lastPermissiveWarnMs = 0;
function warnPermissiveMode(): void {
  const now = Date.now();
  if (now - lastPermissiveWarnMs < 60_000) return;
  lastPermissiveWarnMs = now;
  try {
    console.warn(
      "[ai-relay] PERMISSIVE MODE ACTIVE — AI_RELAY_ALLOW_UNSIGNED=1 (or legacy AI_RELAY_REQUIRE_SIGNED=0). Unsigned POSTs are being accepted. Unset to restore fail-closed default before public beta.",
    );
  } catch { /* console missing in some test envs — non-fatal */ }
}

/**
 * Run the auth pipeline. Returns:
 *   - { ok: true, signed: true, pubkeyHex } when the request carries a
 *     valid Ed25519 signature (caller can rate-limit per-pubkey).
 *   - { ok: true, signed: false, reason } when permissive mode is ON
 *     and the request lacks signing headers — caller MUST still
 *     rate-limit per-IP via the legacy path.
 *   - { ok: false, status, error } when the request must be REFUSED
 *     (Origin invalid, default strict mode + missing/invalid signature,
 *     timestamp out of skew, etc.). Caller returns the canned response.
 *
 * On `ok: true && signed: true`, the per-device rate-limit counters have
 * NOT been bumped yet — call recordRequest(env, pubkeyHex) after a
 * successful upstream call so only successes count against the cap.
 */
export async function authenticate(
  request: Request,
  env: AuthEnv,
  ctx: AuthRequestContext,
): Promise<AuthOutcome> {
  // 1. Origin / Referer — always enforced.
  const originCheck = originHeaderOk(request, env);
  if (!originCheck.ok) {
    return { ok: false, status: 403, error: "Forbidden origin", detail: originCheck.reason };
  }

  // 2. Signing headers — if any of the three are present, ALL must be
  //    valid. If none are present, behaviour depends on the permissive
  //    opt-in (AI_RELAY_ALLOW_UNSIGNED, with the legacy
  //    AI_RELAY_REQUIRE_SIGNED=0 supported for backward compat).
  const pubkeyHex = request.headers.get("X-SS-Pubkey")?.toLowerCase() ?? null;
  const timestampStr = request.headers.get("X-SS-Timestamp");
  const signatureB64 = request.headers.get("X-SS-Signature");
  const anySigningHeader = !!(pubkeyHex || timestampStr || signatureB64);
  const allSigningHeaders = !!(pubkeyHex && timestampStr && signatureB64);

  const allowUnsigned = isPermissiveModeOn(env);
  if (allowUnsigned) warnPermissiveMode();

  if (!anySigningHeader) {
    if (!allowUnsigned) {
      return {
        ok: false,
        status: 401,
        error: "Signed request required",
        detail: "This deployment requires X-SS-Pubkey, X-SS-Timestamp, and X-SS-Signature headers signed with the device's Ed25519 key. Set AI_RELAY_ALLOW_UNSIGNED=1 in Cloudflare Pages env to temporarily disable (dev / rollout only).",
      };
    }
    return { ok: true, pubkeyHex: null, signed: false, reason: "No signing headers — falling back to IP-based rate limit (permissive mode)." };
  }

  if (!allSigningHeaders) {
    return {
      ok: false,
      status: 401,
      error: "Incomplete signing headers",
      detail: "X-SS-Pubkey, X-SS-Timestamp, and X-SS-Signature must all be present when any are.",
    };
  }

  const timestampMs = parseInt(timestampStr, 10);
  const verifyResult = await verifySignature(pubkeyHex, timestampMs, signatureB64, request, ctx.bodyBytes);
  if (!verifyResult.ok) {
    return { ok: false, status: 401, error: "Invalid signature", detail: verifyResult.reason };
  }

  // 3. TOFU registration check / rate limit on first-time pubkeys.
  const tofu = await tofuRegister(env.AI_RATE_LIMIT, env, pubkeyHex, request);
  if (!tofu.ok) {
    return { ok: false, status: 429, error: "Device registration limit", detail: tofu.reason };
  }

  // 4. Per-device rate limit (counters are read here; caller bumps on
  //    success via recordRequest).
  const rate = await readDeviceRate(env.AI_RATE_LIMIT, pubkeyHex);
  if (rate.hour.used >= rate.hour.cap) {
    return { ok: false, status: 429, error: "Device hourly cap reached", detail: `Resets in ${Math.round(rate.hour.resetMs / 60_000)} min.` };
  }
  if (rate.day.used >= rate.day.cap) {
    return { ok: false, status: 429, error: "Device daily cap reached", detail: `Resets in ${Math.round(rate.day.resetMs / 3_600_000)} h.` };
  }

  return { ok: true, pubkeyHex, signed: true };
}

/**
 * Bump per-device counters. Call this after a 2xx upstream response so
 * failures don't count against the device's budget.
 */
export async function recordRequest(env: AuthEnv, pubkeyHex: string): Promise<void> {
  if (!env.AI_RATE_LIMIT) return;
  const state = await readDeviceRate(env.AI_RATE_LIMIT, pubkeyHex);
  await bumpDeviceRate(env.AI_RATE_LIMIT, state);
}

// Exported for unit tests.
export const _internals = {
  hexToBytes,
  bytesToHex,
  base64ToBytes,
  sha256Hex,
  parseAllowedOrigins,
  originHeaderOk,
  verifySignature,
  isPermissiveModeOn,
  MAX_SKEW_MS,
};
