/**
 * RFC 3161 TSA (Time-Stamp Authority) client.
 *
 * Builds a minimal DER-encoded TimeStampReq over a SHA-256 hash,
 * POST-s it to freetsa.org, and returns the raw TimeStampResp bytes.
 *
 * All encoding is hand-rolled DER — no external dependencies.
 *
 * Callers are responsible for handling the offline case: catch the thrown
 * error from sendTsaRequest() and queue for later (e.g. keep tsa_status
 * = 'pending' in the bundle_signatures table).
 */

const TSA_URL = "https://freetsa.org/tsr";

// ---------------------------------------------------------------------------
// Minimal DER encoder
// ---------------------------------------------------------------------------

/** Concatenate Uint8Arrays. */
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Encode a DER length field. */
function derLength(n: number): Uint8Array {
  if (n <= 0x7f) return new Uint8Array([n]);
  if (n <= 0xff) return new Uint8Array([0x81, n]);
  if (n <= 0xffff) return new Uint8Array([0x82, (n >> 8) & 0xff, n & 0xff]);
  // For our use-case (≤ 64 KB payloads) 3 bytes is the ceiling we'll hit.
  return new Uint8Array([0x83, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}

/** Wrap content with a DER tag + length. */
function derTag(tag: number, content: Uint8Array): Uint8Array {
  return concat(new Uint8Array([tag]), derLength(content.length), content);
}

/** DER SEQUENCE (0x30). */
function derSequence(inner: Uint8Array): Uint8Array {
  return derTag(0x30, inner);
}

/**
 * DER INTEGER for small non-negative values (0..127 fits in one byte,
 * larger values need a leading 0x00 if the high bit is set).
 */
function derInteger(n: number): Uint8Array {
  // Determine minimum byte count.
  let len = 1;
  let tmp = n;
  while (tmp > 0x7f) { tmp >>= 8; len++; }
  // If the high bit of the most-significant byte would be set, prepend 0x00.
  const needsPad = ((n >> ((len - 1) * 8)) & 0x80) !== 0;
  const bytes = new Uint8Array(needsPad ? len + 1 : len);
  if (needsPad) bytes[0] = 0x00;
  for (let i = 0; i < len; i++) {
    bytes[bytes.length - 1 - i] = (n >> (i * 8)) & 0xff;
  }
  return derTag(0x02, bytes);
}

/**
 * DER INTEGER for arbitrary-length bytes (e.g. a random nonce).
 * Prepends 0x00 if the high bit of the first byte is set (to keep positive).
 */
function derBigInteger(bytes: Uint8Array): Uint8Array {
  let content: Uint8Array;
  if (bytes.length > 0 && (bytes[0] & 0x80) !== 0) {
    content = new Uint8Array(bytes.length + 1);
    content[0] = 0x00;
    content.set(bytes, 1);
  } else {
    content = bytes;
  }
  return derTag(0x02, content);
}

/** DER OID — caller supplies the raw BER-encoded OID bytes. */
function derOid(bytes: Uint8Array): Uint8Array {
  return derTag(0x06, bytes);
}

/** DER NULL (0x05 0x00). */
function derNull(): Uint8Array {
  return new Uint8Array([0x05, 0x00]);
}

/** DER OCTET STRING (0x04). */
function derOctetString(bytes: Uint8Array): Uint8Array {
  return derTag(0x04, bytes);
}

/** DER BOOLEAN (0x01). TRUE = 0xff, FALSE = 0x00. */
function derBoolean(v: boolean): Uint8Array {
  return derTag(0x01, new Uint8Array([v ? 0xff : 0x00]));
}

// ---------------------------------------------------------------------------
// TimeStampReq builder
// ---------------------------------------------------------------------------

/**
 * SHA-256 AlgorithmIdentifier OID bytes.
 * OID 2.16.840.1.101.3.4.2.1 → 60 86 48 01 65 03 04 02 01
 */
const OID_SHA256 = new Uint8Array([0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]);

/**
 * Build a minimal RFC 3161 TimeStampReq DER structure for a SHA-256 hash.
 *
 * Structure:
 *   SEQUENCE {
 *     INTEGER 1                        -- version
 *     SEQUENCE {                       -- MessageImprint
 *       SEQUENCE {                     -- AlgorithmIdentifier
 *         OID 2.16.840.1.101.3.4.2.1  -- SHA-256
 *         NULL
 *       }
 *       OCTET STRING <hash>            -- 32 bytes
 *     }
 *     INTEGER <nonce>                  -- 8 random bytes
 *     BOOLEAN TRUE                     -- certReq
 *   }
 */
export function buildTsaRequest(sha256Hash: Uint8Array): Uint8Array {
  const version = derInteger(1);

  const algorithmId = derSequence(concat(derOid(OID_SHA256), derNull()));
  const messageImprint = derSequence(concat(algorithmId, derOctetString(sha256Hash)));

  // 8-byte random nonce.
  const nonceBytes = crypto.getRandomValues(new Uint8Array(8));
  const nonce = derBigInteger(nonceBytes);

  const certReq = derBoolean(true);

  return derSequence(concat(version, messageImprint, nonce, certReq));
}

// ---------------------------------------------------------------------------
// TSA HTTP client
// ---------------------------------------------------------------------------

/**
 * POST a TimeStampReq to the free TSA and return the raw TimeStampResp bytes.
 * Throws on network error or non-200 response — callers should catch and
 * treat as offline / failed.
 */
export async function sendTsaRequest(sha256Hash: Uint8Array): Promise<Uint8Array> {
  const reqBytes = buildTsaRequest(sha256Hash);

  const response = await fetch(TSA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/timestamp-query" },
    body: reqBytes,
  });

  if (!response.ok) {
    throw new Error(`TSA responded ${response.status} ${response.statusText}`);
  }

  const buf = await response.arrayBuffer();
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// TSA response heuristic check
// ---------------------------------------------------------------------------

/**
 * Heuristic check: did the TSA accept the request?
 *
 * A TimeStampResp starts with a SEQUENCE containing PKIStatusInfo.
 * A successful status is INTEGER 0. We check:
 *   responseBytes[4] === 0x02  — INTEGER tag at position 4
 *   responseBytes[6] === 0x00  — value 0 (= granted)
 *
 * This is not a full ASN.1 parse — it's sufficient to distinguish
 * "TSA said OK" from "TSA returned an error" for our logging purposes.
 */
export function tsaResponseOk(responseBytes: Uint8Array): boolean {
  // Minimum length: SEQUENCE(tag+len) + SEQUENCE(tag+len) + INTEGER(tag+len+val) = 7 bytes
  if (responseBytes.length < 7) return false;
  // bytes[4] should be INTEGER tag (0x02), bytes[5] length (0x01), bytes[6] value (0x00 = granted)
  return responseBytes[4] === 0x02 && responseBytes[6] === 0x00;
}
