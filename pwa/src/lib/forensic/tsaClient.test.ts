import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTsaRequest, sendTsaRequest, tsaResponseOk } from "./tsaClient";

// ---------------------------------------------------------------------------
// Minimal DER walker — independent of tsaClient.ts so a bug in either side
// surfaces. Only walks the outer SEQUENCE structure of a TimeStampReq.
// ---------------------------------------------------------------------------

/** Returns [length, headerSize] starting at offset. */
function derLen(bytes: Uint8Array, offset: number): { length: number; headerSize: number } {
  const first = bytes[offset];
  if (first <= 0x7f) return { length: first, headerSize: 1 };
  if (first === 0x81) return { length: bytes[offset + 1], headerSize: 2 };
  if (first === 0x82) return { length: (bytes[offset + 1] << 8) | bytes[offset + 2], headerSize: 3 };
  if (first === 0x83) return {
    length: (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3],
    headerSize: 4,
  };
  throw new Error("DER length too large");
}

const SHA256_HASH = new Uint8Array(32).fill(0xab);

describe("buildTsaRequest — DER structure", () => {
  it("starts with a SEQUENCE tag (0x30)", () => {
    const req = buildTsaRequest(SHA256_HASH);
    expect(req[0]).toBe(0x30);
  });

  it("declares its length consistently with the body size", () => {
    const req = buildTsaRequest(SHA256_HASH);
    const { length, headerSize } = derLen(req, 1);
    expect(req.length).toBe(1 + headerSize + length);
  });

  it("starts the body with INTEGER 1 (version)", () => {
    const req = buildTsaRequest(SHA256_HASH);
    const { headerSize } = derLen(req, 1);
    const bodyStart = 1 + headerSize;
    // INTEGER tag = 0x02, length = 0x01, value = 0x01
    expect(req[bodyStart]).toBe(0x02);
    expect(req[bodyStart + 1]).toBe(0x01);
    expect(req[bodyStart + 2]).toBe(0x01);
  });

  it("embeds the supplied SHA-256 hash inside an OCTET STRING (length 32)", () => {
    const req = buildTsaRequest(SHA256_HASH);
    // Walk: outer SEQ → INTEGER(1) → SEQUENCE(MessageImprint) → SEQUENCE(AlgID) → OID → NULL → OCTET STRING(32 bytes)
    // Simpler: find the OCTET STRING (0x04 0x20 …) substring.
    const sig = [0x04, 0x20, ...Array.from(SHA256_HASH)];
    let found = false;
    for (let i = 0; i + sig.length <= req.length; i++) {
      let match = true;
      for (let j = 0; j < sig.length; j++) {
        if (req[i + j] !== sig[j]) { match = false; break; }
      }
      if (match) { found = true; break; }
    }
    expect(found).toBe(true);
  });

  it("contains the SHA-256 OID bytes (2.16.840.1.101.3.4.2.1)", () => {
    const req = buildTsaRequest(SHA256_HASH);
    const oidBytes = [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];
    let found = false;
    for (let i = 0; i + oidBytes.length <= req.length; i++) {
      let match = true;
      for (let j = 0; j < oidBytes.length; j++) {
        if (req[i + j] !== oidBytes[j]) { match = false; break; }
      }
      if (match) { found = true; break; }
    }
    expect(found).toBe(true);
  });

  it("ends with BOOLEAN TRUE (certReq = 0xff)", () => {
    const req = buildTsaRequest(SHA256_HASH);
    // Last 3 bytes should be tag(0x01) length(0x01) value(0xff)
    expect(req[req.length - 3]).toBe(0x01);
    expect(req[req.length - 2]).toBe(0x01);
    expect(req[req.length - 1]).toBe(0xff);
  });

  it("uses a fresh nonce on each call (random 8-byte block)", () => {
    const r1 = buildTsaRequest(SHA256_HASH);
    const r2 = buildTsaRequest(SHA256_HASH);
    // Same hash + same body length means the only varying bytes are the nonce.
    // We don't need to know its position — just confirm the byte sequences
    // diverge somewhere.
    expect(Array.from(r1)).not.toEqual(Array.from(r2));
  });
});

describe("sendTsaRequest — happy path", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy as unknown as typeof fetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to the TSA URL with the correct Content-Type", async () => {
    const respBytes = new Uint8Array([0x30, 0x05, 0x30, 0x03, 0x02, 0x01, 0x00]);
    fetchSpy.mockResolvedValue(new Response(respBytes as BufferSource, { status: 200 }));

    await sendTsaRequest(SHA256_HASH);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/.*\/tsr$/);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/timestamp-query");
  });

  it("returns the response bytes verbatim", async () => {
    const respBytes = new Uint8Array([0x30, 0x05, 0x30, 0x03, 0x02, 0x01, 0x00]);
    fetchSpy.mockResolvedValue(new Response(respBytes as BufferSource, { status: 200 }));

    const out = await sendTsaRequest(SHA256_HASH);
    expect(Array.from(out)).toEqual(Array.from(respBytes));
  });
});

describe("sendTsaRequest — failure modes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when the TSA returns a non-200 status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array(0) as BufferSource, { status: 500, statusText: "Server Error" }),
    );
    await expect(sendTsaRequest(SHA256_HASH)).rejects.toThrow(/TSA responded 500/);
  });

  it("throws on a 4xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array(0) as BufferSource, { status: 400, statusText: "Bad Request" }),
    );
    await expect(sendTsaRequest(SHA256_HASH)).rejects.toThrow(/400/);
  });

  it("propagates a network/fetch error so callers can mark tsa_status=pending", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    await expect(sendTsaRequest(SHA256_HASH)).rejects.toThrow("network down");
  });
});

describe("tsaResponseOk — heuristic check", () => {
  it("returns true when bytes[4]=0x02 and bytes[6]=0x00 (granted)", () => {
    // SEQUENCE(7) { SEQUENCE(3) { INTEGER(1) 0x00 } ... }
    const ok = new Uint8Array([0x30, 0x07, 0x30, 0x03, 0x02, 0x01, 0x00, 0x00]);
    expect(tsaResponseOk(ok)).toBe(true);
  });

  it("returns false when the status integer is non-zero (e.g. rejection=2)", () => {
    const bad = new Uint8Array([0x30, 0x07, 0x30, 0x03, 0x02, 0x01, 0x02, 0x00]);
    expect(tsaResponseOk(bad)).toBe(false);
  });

  it("returns false for a malformed (too-short) response", () => {
    expect(tsaResponseOk(new Uint8Array(0))).toBe(false);
    expect(tsaResponseOk(new Uint8Array([0x30, 0x02]))).toBe(false);
  });

  it("returns false when bytes[4] is not an INTEGER tag", () => {
    const bad = new Uint8Array([0x30, 0x07, 0x30, 0x03, 0xaa, 0x01, 0x00, 0x00]);
    expect(tsaResponseOk(bad)).toBe(false);
  });
});
