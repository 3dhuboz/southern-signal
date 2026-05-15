/**
 * Minimal CBOR encoder + COSE_Sign1 builder (RFC 8152).
 * Zero external dependencies — uses only stdlib types.
 *
 * CBOR major types used:
 *   0 = unsigned integer
 *   1 = negative integer
 *   2 = byte string (bstr)
 *   3 = text string (tstr)
 *   4 = array
 *   5 = map
 *
 * COSE_Sign1 structure:
 *   [ protected: bstr, unprotected: {}, payload: bstr, signature: bstr ]
 *
 * Protected header: { 1: -8 } — alg = EdDSA (Ed25519)
 *   Encodes as a1 01 27 (map(1), uint(1), nint(-8))
 *
 * Sig_Structure:
 *   [ "Signature1", protected_header_bytes, aad: h'', payload ]
 */

// ---------------------------------------------------------------------------
// CBOR encoding primitives
// ---------------------------------------------------------------------------

/** Encode an argument value (≤ 23 inline, 24..255 one extra byte, else two). */
function encodeCborArgument(majorType: number, value: number): Uint8Array {
  const major = majorType << 5;
  if (value <= 23) {
    return new Uint8Array([major | value]);
  } else if (value <= 0xff) {
    return new Uint8Array([major | 24, value]);
  } else if (value <= 0xffff) {
    return new Uint8Array([major | 25, (value >> 8) & 0xff, value & 0xff]);
  } else {
    // 4-byte: major | 26
    return new Uint8Array([
      major | 26,
      (value >> 24) & 0xff,
      (value >> 16) & 0xff,
      (value >> 8) & 0xff,
      value & 0xff,
    ]);
  }
}

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

/** CBOR unsigned integer (major type 0). */
function encodeCborUint(n: number): Uint8Array {
  return encodeCborArgument(0, n);
}

/** CBOR negative integer (major type 1). value is the magnitude minus 1: -1 → 0, -8 → 7. */
function encodeCborNint(magnitude: number): Uint8Array {
  return encodeCborArgument(1, magnitude);
}

/** CBOR byte string (major type 2). */
function encodeCborBstr(bytes: Uint8Array): Uint8Array {
  return concat(encodeCborArgument(2, bytes.length), bytes);
}

/** CBOR text string (major type 3). */
function encodeCborTstr(s: string): Uint8Array {
  const encoded = new TextEncoder().encode(s);
  return concat(encodeCborArgument(3, encoded.length), encoded);
}

/**
 * CBOR map with integer keys and integer values (major type 5).
 * Used only for the protected header { 1: -8 }.
 * Negative values encode as CBOR nint (major type 1, value = abs(n) - 1).
 */
function encodeCborMap(entries: Array<[number, number]>): Uint8Array {
  const parts: Uint8Array[] = [encodeCborArgument(5, entries.length)];
  for (const [k, v] of entries) {
    parts.push(encodeCborUint(k));
    if (v < 0) {
      parts.push(encodeCborNint(-v - 1));
    } else {
      parts.push(encodeCborUint(v));
    }
  }
  return concat(...parts);
}

/** CBOR array of pre-encoded items (major type 4). */
function encodeCborArray(items: Uint8Array[]): Uint8Array {
  return concat(encodeCborArgument(4, items.length), ...items);
}

// ---------------------------------------------------------------------------
// COSE_Sign1 builder
// ---------------------------------------------------------------------------

/** Protected header { 1: -8 } — alg = EdDSA */
const PROTECTED_HEADER = encodeCborMap([[1, -8]]);

/**
 * Build a COSE_Sign1 envelope (RFC 8152 §4.2).
 *
 * @param payload    The bytes being signed (manifest JSON in our case).
 * @param signFn     Async signer: receives the Sig_Structure bytes and
 *                   returns the 64-byte Ed25519 signature.
 * @returns          Serialised COSE_Sign1 as a CBOR-encoded Uint8Array.
 */
export async function buildCoseSign1(
  payload: Uint8Array,
  signFn: (toBeSigned: Uint8Array) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  // Sig_Structure = [ "Signature1", protected_bstr, aad: h'', payload ]
  const sigStructure = encodeCborArray([
    encodeCborTstr("Signature1"),
    encodeCborBstr(PROTECTED_HEADER), // protected_bstr
    encodeCborBstr(new Uint8Array(0)), // empty aad
    encodeCborBstr(payload),
  ]);

  const signature = await signFn(sigStructure);

  // COSE_Sign1 = [ protected_bstr, unprotected: {}, payload, signature ]
  // Unprotected header is an empty CBOR map (0xa0).
  const emptyMap = new Uint8Array([0xa0]);

  return encodeCborArray([
    encodeCborBstr(PROTECTED_HEADER),
    emptyMap,
    encodeCborBstr(payload),
    encodeCborBstr(signature),
  ]);
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Base64-encode a Uint8Array (standard alphabet, with = padding).
 * Uses the btoa() approach — safe for binary data by converting via
 * a Latin-1 character string.
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
