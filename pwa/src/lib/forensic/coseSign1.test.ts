import { describe, expect, it } from "vitest";
import { buildCoseSign1, toBase64 } from "./coseSign1";

// ---------------------------------------------------------------------------
// Minimal CBOR decoder for verifying the COSE_Sign1 envelope structure.
// Deliberately separate from the verifyDeno embedded copy so a bug in either
// surfaces; we only decode the four-item outer array and the inner protected
// header bstr.
// ---------------------------------------------------------------------------

interface CborItem {
  type: "uint" | "nint" | "bstr" | "tstr" | "array" | "map";
  value: unknown;
  next: number;
}

function decodeCbor(bytes: Uint8Array, offset = 0): CborItem {
  const initial = bytes[offset];
  const major = (initial >> 5) & 0x07;
  const info = initial & 0x1f;
  let pos = offset + 1;

  let len: number;
  if (info <= 23) {
    len = info;
  } else if (info === 24) {
    len = bytes[pos++];
  } else if (info === 25) {
    len = (bytes[pos] << 8) | bytes[pos + 1];
    pos += 2;
  } else if (info === 26) {
    len = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
    pos += 4;
  } else {
    throw new Error(`CBOR: unsupported info ${info}`);
  }

  if (major === 0) return { type: "uint", value: len, next: pos };
  if (major === 1) return { type: "nint", value: -1 - len, next: pos };
  if (major === 2) return { type: "bstr", value: bytes.slice(pos, pos + len), next: pos + len };
  if (major === 3) return { type: "tstr", value: new TextDecoder().decode(bytes.slice(pos, pos + len)), next: pos + len };
  if (major === 4) {
    const items: CborItem[] = [];
    let cur = pos;
    for (let i = 0; i < len; i++) {
      const item = decodeCbor(bytes, cur);
      items.push(item);
      cur = item.next;
    }
    return { type: "array", value: items, next: cur };
  }
  if (major === 5) {
    const entries: Array<[CborItem, CborItem]> = [];
    let cur = pos;
    for (let i = 0; i < len; i++) {
      const k = decodeCbor(bytes, cur);
      cur = k.next;
      const v = decodeCbor(bytes, cur);
      cur = v.next;
      entries.push([k, v]);
    }
    return { type: "map", value: entries, next: cur };
  }
  throw new Error(`CBOR: unsupported major ${major}`);
}

/** Re-derive Sig_Structure from a parsed envelope so we can verify the signature. */
function rebuildSigStructure(protectedHeader: Uint8Array, payload: Uint8Array): Uint8Array {
  // [ "Signature1", protected_bstr, aad: h'', payload ]
  // We re-encode using the same CBOR rules used by coseSign1.ts.
  const tstrSig1 = new Uint8Array([0x6a, 0x53, 0x69, 0x67, 0x6e, 0x61, 0x74, 0x75, 0x72, 0x65, 0x31]); // tstr(10) "Signature1"
  const aadBstr = new Uint8Array([0x40]); // bstr(0) empty
  const enc = (b: Uint8Array) => {
    // bstr of arbitrary length up to 255 (our protected header is 3 bytes,
    // payload in tests is small). Match the arg encoding from coseSign1.ts.
    if (b.length <= 23) {
      const out = new Uint8Array(1 + b.length);
      out[0] = 0x40 | b.length;
      out.set(b, 1);
      return out;
    } else if (b.length <= 0xff) {
      const out = new Uint8Array(2 + b.length);
      out[0] = 0x58;
      out[1] = b.length;
      out.set(b, 2);
      return out;
    } else if (b.length <= 0xffff) {
      const out = new Uint8Array(3 + b.length);
      out[0] = 0x59;
      out[1] = (b.length >> 8) & 0xff;
      out[2] = b.length & 0xff;
      out.set(b, 3);
      return out;
    } else {
      const out = new Uint8Array(5 + b.length);
      out[0] = 0x5a;
      out[1] = (b.length >> 24) & 0xff;
      out[2] = (b.length >> 16) & 0xff;
      out[3] = (b.length >> 8) & 0xff;
      out[4] = b.length & 0xff;
      out.set(b, 5);
      return out;
    }
  };
  const items = [tstrSig1, enc(protectedHeader), aadBstr, enc(payload)];
  const total = items.reduce((s, p) => s + p.length, 0);
  // Outer array(4) = 0x84
  const out = new Uint8Array(1 + total);
  out[0] = 0x84;
  let offset = 1;
  for (const it of items) {
    out.set(it, offset);
    offset += it.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// A signFn that mints a fresh Ed25519 keypair and returns the WebCrypto
// signature. We expose the public key so tests can verify.
// ---------------------------------------------------------------------------

async function ed25519Signer() {
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const signFn = async (toBeSigned: Uint8Array): Promise<Uint8Array> => {
    const sig = await crypto.subtle.sign("Ed25519", keyPair.privateKey, toBeSigned as BufferSource);
    return new Uint8Array(sig);
  };
  return { signFn, publicKey: keyPair.publicKey };
}

describe("buildCoseSign1 — envelope shape", () => {
  it("produces a CBOR-encoded array of exactly 4 items", async () => {
    const { signFn } = await ed25519Signer();
    const envelope = await buildCoseSign1(new TextEncoder().encode("hello"), signFn);

    // Outer item must be a CBOR array (major type 4).
    expect(envelope[0] >> 5).toBe(4);

    const parsed = decodeCbor(envelope);
    expect(parsed.type).toBe("array");
    const items = parsed.value as CborItem[];
    expect(items).toHaveLength(4);
  });

  it("encodes the protected header as a bstr containing { 1: -8 } (alg=EdDSA)", async () => {
    const { signFn } = await ed25519Signer();
    const envelope = await buildCoseSign1(new TextEncoder().encode("payload"), signFn);
    const items = (decodeCbor(envelope).value as CborItem[]);

    expect(items[0].type).toBe("bstr");
    const protectedBytes = items[0].value as Uint8Array;
    // Expect exactly: a1 (map of 1) | 01 (key=1) | 27 (nint, value=-8)
    expect(Array.from(protectedBytes)).toEqual([0xa1, 0x01, 0x27]);
  });

  it("encodes the unprotected header as an empty CBOR map (0xa0)", async () => {
    const { signFn } = await ed25519Signer();
    const envelope = await buildCoseSign1(new TextEncoder().encode("payload"), signFn);
    const items = decodeCbor(envelope).value as CborItem[];
    expect(items[1].type).toBe("map");
    expect((items[1].value as unknown[]).length).toBe(0);
  });

  it("includes the payload bytes verbatim as item[2]", async () => {
    const { signFn } = await ed25519Signer();
    const payload = new TextEncoder().encode('{"hello":"world"}');
    const envelope = await buildCoseSign1(payload, signFn);
    const items = decodeCbor(envelope).value as CborItem[];
    expect(items[2].type).toBe("bstr");
    expect(Array.from(items[2].value as Uint8Array)).toEqual(Array.from(payload));
  });

  it("places the 64-byte Ed25519 signature as item[3]", async () => {
    const { signFn } = await ed25519Signer();
    const envelope = await buildCoseSign1(new TextEncoder().encode("payload"), signFn);
    const items = decodeCbor(envelope).value as CborItem[];
    expect(items[3].type).toBe("bstr");
    expect((items[3].value as Uint8Array).length).toBe(64);
  });
});

describe("buildCoseSign1 — round-trip verification", () => {
  it("produces a signature that verifies under the supplied pubkey", async () => {
    const { signFn, publicKey } = await ed25519Signer();
    const payload = new TextEncoder().encode("manifest bytes go here");
    const envelope = await buildCoseSign1(payload, signFn);
    const items = decodeCbor(envelope).value as CborItem[];

    const protectedHeader = items[0].value as Uint8Array;
    const envelopePayload = items[2].value as Uint8Array;
    const signature = items[3].value as Uint8Array;

    // Reconstruct Sig_Structure exactly as the builder would have.
    const sigStructure = rebuildSigStructure(protectedHeader, envelopePayload);
    const ok = await crypto.subtle.verify("Ed25519", publicKey, signature as BufferSource, sigStructure as BufferSource);
    expect(ok).toBe(true);
  });

  it("fails verification when the payload is mutated after signing (tamper detection)", async () => {
    const { signFn, publicKey } = await ed25519Signer();
    const payload = new TextEncoder().encode("original payload");
    const envelope = await buildCoseSign1(payload, signFn);
    const items = decodeCbor(envelope).value as CborItem[];
    const protectedHeader = items[0].value as Uint8Array;
    const signature = items[3].value as Uint8Array;

    // Verify against a TAMPERED payload — must fail.
    const tampered = new TextEncoder().encode("original payloaD"); // capital D
    const sigStructure = rebuildSigStructure(protectedHeader, tampered);
    const ok = await crypto.subtle.verify("Ed25519", publicKey, signature as BufferSource, sigStructure as BufferSource);
    expect(ok).toBe(false);
  });

  it("yields a different signature for different payloads (signFn is invoked per call)", async () => {
    const { signFn } = await ed25519Signer();
    const a = await buildCoseSign1(new TextEncoder().encode("aaa"), signFn);
    const b = await buildCoseSign1(new TextEncoder().encode("bbb"), signFn);
    const sigA = (decodeCbor(a).value as CborItem[])[3].value as Uint8Array;
    const sigB = (decodeCbor(b).value as CborItem[])[3].value as Uint8Array;
    // Same key, different message → different signature.
    expect(Array.from(sigA)).not.toEqual(Array.from(sigB));
  });

  it("propagates signFn errors instead of swallowing them", async () => {
    const failingSign = async () => {
      throw new Error("signer offline");
    };
    await expect(buildCoseSign1(new TextEncoder().encode("x"), failingSign)).rejects.toThrow("signer offline");
  });
});

describe("buildCoseSign1 — payload handling edge cases", () => {
  it("handles an empty payload (Sig_Structure still well-formed)", async () => {
    const { signFn, publicKey } = await ed25519Signer();
    const envelope = await buildCoseSign1(new Uint8Array(0), signFn);
    const items = decodeCbor(envelope).value as CborItem[];
    expect((items[2].value as Uint8Array).length).toBe(0);
    // Signature must still verify over the empty-payload Sig_Structure.
    const sig = items[3].value as Uint8Array;
    const sigStruct = rebuildSigStructure(items[0].value as Uint8Array, new Uint8Array(0));
    const ok = await crypto.subtle.verify("Ed25519", publicKey, sig as BufferSource, sigStruct as BufferSource);
    expect(ok).toBe(true);
  });

  it("handles a large payload (>255 bytes — triggers multi-byte CBOR length)", async () => {
    const { signFn, publicKey } = await ed25519Signer();
    const payload = new Uint8Array(1000).map((_, i) => i & 0xff);
    const envelope = await buildCoseSign1(payload, signFn);
    const items = decodeCbor(envelope).value as CborItem[];
    expect((items[2].value as Uint8Array).length).toBe(1000);
    const sig = items[3].value as Uint8Array;
    const sigStruct = rebuildSigStructure(items[0].value as Uint8Array, payload);
    const ok = await crypto.subtle.verify("Ed25519", publicKey, sig as BufferSource, sigStruct as BufferSource);
    expect(ok).toBe(true);
  });
});

describe("toBase64", () => {
  it("encodes the empty array as empty string", () => {
    expect(toBase64(new Uint8Array(0))).toBe("");
  });

  it("encodes 'hello' bytes the same as btoa", () => {
    const bytes = new TextEncoder().encode("hello");
    expect(toBase64(bytes)).toBe("aGVsbG8=");
  });

  it("round-trips binary data via atob → matches original bytes", () => {
    const original = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0x80, 0x7f, 0xaa, 0x55]);
    const b64 = toBase64(original);
    const back = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(Array.from(back)).toEqual(Array.from(original));
  });
});
