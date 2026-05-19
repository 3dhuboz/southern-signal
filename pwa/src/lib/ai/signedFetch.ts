/**
 * Ed25519-signed fetch for the /api/ai/* relay.
 *
 * Pairs with `pwa/functions/api/ai/_auth.ts`. The relay accepts requests
 * with three headers — X-SS-Pubkey, X-SS-Timestamp, X-SS-Signature —
 * derived from the device's existing forensic signing keypair. Signing
 * proves the request came from this device's IndexedDB-stored private
 * key and lets the server apply per-device rate limits instead of
 * per-IP (which is fairer for shared networks).
 *
 * Same key the forensic export pipeline uses (signingKeyStore.ts). No
 * separate identity to manage; first /api/ai/* call triggers generation
 * if the key isn't already in IndexedDB.
 *
 * Canonical signing string (must match _auth.ts exactly):
 *
 *   <pubkey-hex>\n<METHOD>\n<path>\n<timestamp-ms>\n<sha256-of-body-hex>
 *
 * Body bytes: for JSON we sign the UTF-8 bytes of the serialised
 * body. For multipart/FormData we extract the raw bytes via Blob, then
 * Request body uses those exact bytes (we don't trust the browser to
 * re-serialise the FormData byte-identically on the network).
 */

import { getOrCreateSigningKey, signBytes } from "../forensic/signingKeyStore";

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 1) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Sign + fetch an /api/ai/* endpoint. Same surface as `fetch(path, init)`
 * with two important differences:
 *
 *   1. `init.body` must be a Uint8Array (NOT FormData / Blob / string).
 *      Callers that work with JSON should serialise + encode upstream.
 *      Callers that work with multipart should construct the multipart
 *      payload + boundary themselves and pass bytes through. This makes
 *      the wire-format the client signs match what reaches the server
 *      byte-for-byte — no browser re-encoding shenanigans.
 *
 *   2. The Content-Type header MUST be provided by the caller so the
 *      bytes the caller signed are interpreted the same way on the
 *      server. We don't infer it; that's the caller's responsibility.
 *
 * Returns the raw Response.
 */
export async function signedFetch(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: Uint8Array | null } = {},
): Promise<Response> {
  const method = (init.method ?? "POST").toUpperCase();
  const body = init.body ?? new Uint8Array(0);
  const timestamp = Date.now();

  // Build canonical envelope and sign.
  const { publicKeyHex } = await getOrCreateSigningKey();
  const bodyHashHex = await sha256Hex(body);
  // Compute the path the server will see. We accept a relative path
  // (typical: "/api/ai/chat") and skip URL parsing so dev / prod
  // behaviour is identical.
  const canonical = `${publicKeyHex.toLowerCase()}\n${method}\n${path}\n${timestamp}\n${bodyHashHex}`;
  const sigBytes = await signBytes(new TextEncoder().encode(canonical));
  const signatureB64 = bytesToBase64(sigBytes);

  const headers: Record<string, string> = {
    ...(init.headers ?? {}),
    "X-SS-Pubkey": publicKeyHex,
    "X-SS-Timestamp": String(timestamp),
    "X-SS-Signature": signatureB64,
  };

  return fetch(path, { method, headers, body: body.byteLength > 0 ? (body as BodyInit) : undefined });
}

/** Convenience: JSON-body POST. Serialises + signs in one call. */
export async function signedJson<TReq>(path: string, body: TReq, opts?: { headers?: Record<string, string> }): Promise<Response> {
  const json = JSON.stringify(body);
  const bytes = new TextEncoder().encode(json);
  return signedFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
    body: bytes,
  });
}
