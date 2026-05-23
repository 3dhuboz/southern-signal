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

function canonicalPathForTarget(target: string): string {
  try {
    const base = typeof location !== "undefined" ? location.origin : "https://southern-signal.local";
    return new URL(target, base).pathname;
  } catch {
    return target;
  }
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
  // Compute the path the server will see. AI calls usually pass a relative
  // path, while operator-configured sync endpoints are commonly absolute.
  const canonicalPath = canonicalPathForTarget(path);
  const canonical = `${publicKeyHex.toLowerCase()}\n${method}\n${canonicalPath}\n${timestamp}\n${bodyHashHex}`;
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

/**
 * Multipart-encoded POST that's signed end-to-end.
 *
 * Why this exists (instead of just letting the browser serialise a
 * FormData): the relay verifies the signature against the raw bytes
 * the server receives. Browsers serialise FormData internally — picking
 * a boundary, encoding parts — and the client never sees those bytes,
 * so the client can't sign them. This helper builds the multipart
 * payload manually as a Uint8Array, so the bytes the client signs and
 * the bytes the server hashes are identical.
 *
 * Parts can be `string` (text fields) or `{ blob: Blob; filename?: string }`
 * (file parts). The browser would normally name a blob field "blob" if
 * no filename was given; we do the same so the upstream Whisper / OpenAI
 * accepts the file part.
 */
export type MultipartPart =
  | { name: string; value: string }
  | { name: string; blob: Blob; filename?: string };

export async function signedMultipart(
  path: string,
  parts: MultipartPart[],
  opts?: { headers?: Record<string, string> },
): Promise<Response> {
  // Random 32-hex boundary. Has to be unguessable enough not to collide
  // with arbitrary user content, which for our payloads (audio bytes) is
  // already implausible — but be safe.
  const boundary = `----SSBoundary${bytesToHex(crypto.getRandomValues(new Uint8Array(16)))}`;
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const part of parts) {
    chunks.push(encoder.encode(`--${boundary}\r\n`));
    if ("value" in part) {
      chunks.push(encoder.encode(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`));
      chunks.push(encoder.encode(part.value));
      chunks.push(encoder.encode("\r\n"));
    } else {
      const filename = part.filename ?? "blob";
      const contentType = part.blob.type || "application/octet-stream";
      chunks.push(encoder.encode(
        `Content-Disposition: form-data; name="${part.name}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
      ));
      const blobBytes = new Uint8Array(await part.blob.arrayBuffer());
      chunks.push(blobBytes);
      chunks.push(encoder.encode("\r\n"));
    }
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));

  // Concatenate.
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const body = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.byteLength;
  }

  return signedFetch(path, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      ...(opts?.headers ?? {}),
    },
    body,
  });
}
