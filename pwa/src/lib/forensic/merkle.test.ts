import { describe, expect, test } from "vitest";
import {
  innerHash,
  leafFromExistingHashHex,
  leafHash,
  merkleRoot,
} from "./merkle";

// --- Helpers --------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(...parts: Uint8Array[]): Promise<string> {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return bytesToHex(new Uint8Array(digest));
}

// Two distinct leaf hashes (already 32-byte SHA-256 outputs in hex form).
const LEAF_A = "a".repeat(64);
const LEAF_B = "b".repeat(64);
const LEAF_C = "c".repeat(64);

// --- Tests ----------------------------------------------------------------

describe("merkleRoot", () => {
  test("empty input returns null", async () => {
    const root = await merkleRoot([]);
    expect(root).toBeNull();
  });

  test("single leaf returns the leaf unchanged", async () => {
    const root = await merkleRoot([LEAF_A]);
    expect(root).toBe(LEAF_A);
  });

  test("two leaves equals SHA-256(0x01 || a || b)", async () => {
    const root = await merkleRoot([LEAF_A, LEAF_B]);
    const expected = await sha256Hex(
      new Uint8Array([0x01]),
      hexToBytes(LEAF_A),
      hexToBytes(LEAF_B),
    );
    expect(root).toBe(expected);
    // Cross-check via the exposed inner-hash helper.
    expect(root).toBe(await innerHash(LEAF_A, LEAF_B));
  });

  test("three leaves: RFC 6962 promote-not-duplicate style", async () => {
    // Per merkle.ts docstring: odd levels promote the trailing node.
    // Level 0: [A, B, C]  -> pair (A,B) into AB; promote C unchanged.
    // Level 1: [AB, C]    -> pair into root.
    const root = await merkleRoot([LEAF_A, LEAF_B, LEAF_C]);
    const ab = await innerHash(LEAF_A, LEAF_B);
    const expected = await innerHash(ab, LEAF_C);
    expect(root).toBe(expected);

    // Sanity: must NOT equal the Bitcoin-style duplicate-last variant,
    // i.e. innerHash(ab, innerHash(C, C)). Pinning the documented behaviour.
    const cc = await innerHash(LEAF_C, LEAF_C);
    const bitcoinStyle = await innerHash(ab, cc);
    expect(root).not.toBe(bitcoinStyle);
  });

  test("idempotent: same input yields same output", async () => {
    const leaves = [LEAF_A, LEAF_B, LEAF_C];
    const r1 = await merkleRoot(leaves);
    const r2 = await merkleRoot(leaves.slice());
    expect(r1).toBe(r2);
    expect(r1).not.toBeNull();
  });

  test("order-sensitive: swapping two leaves changes the root", async () => {
    const r1 = await merkleRoot([LEAF_A, LEAF_B]);
    const r2 = await merkleRoot([LEAF_B, LEAF_A]);
    expect(r1).not.toBe(r2);
  });

  test("four leaves: balanced tree composes correctly", async () => {
    const LEAF_D = "d".repeat(64);
    const root = await merkleRoot([LEAF_A, LEAF_B, LEAF_C, LEAF_D]);
    const ab = await innerHash(LEAF_A, LEAF_B);
    const cd = await innerHash(LEAF_C, LEAF_D);
    const expected = await innerHash(ab, cd);
    expect(root).toBe(expected);
  });
});

describe("leafFromExistingHashHex", () => {
  test("matches SHA-256(0x00 || decoded-hex-bytes)", async () => {
    const existing =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const got = await leafFromExistingHashHex(existing);
    const expected = await sha256Hex(
      new Uint8Array([0x00]),
      hexToBytes(existing),
    );
    expect(got).toBe(expected);
    // Output must itself be a 64-char lowercase hex string.
    expect(got).toMatch(/^[0-9a-f]{64}$/);
  });

  test("agrees with leafHash when given the same bytes", async () => {
    const existing =
      "deadbeefcafebabe0011223344556677deadbeefcafebabe0011223344556677";
    const viaHex = await leafFromExistingHashHex(existing);
    const viaBytes = await leafHash(hexToBytes(existing));
    expect(viaHex).toBe(viaBytes);
  });

  test("accepts 0x-prefixed hex (matches non-prefixed result)", async () => {
    const existing =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const a = await leafFromExistingHashHex(existing);
    const b = await leafFromExistingHashHex("0x" + existing);
    expect(a).toBe(b);
  });

  test("throws on odd-length hex input", async () => {
    await expect(leafFromExistingHashHex("abc")).rejects.toThrow();
  });
});

describe("manifest integration: leafFromExistingHashHex + merkleRoot", () => {
  test("produces a 64-char lowercase hex root from fake audit_log entry hashes", async () => {
    const fakeEntryHashes = [
      "1111111111111111111111111111111111111111111111111111111111111111",
      "2222222222222222222222222222222222222222222222222222222222222222",
      "3333333333333333333333333333333333333333333333333333333333333333",
      "4444444444444444444444444444444444444444444444444444444444444444",
      "5555555555555555555555555555555555555555555555555555555555555555",
    ];
    const leaves = await Promise.all(
      fakeEntryHashes.map((h) => leafFromExistingHashHex(h)),
    );
    expect(leaves).toHaveLength(5);
    for (const l of leaves) expect(l).toMatch(/^[0-9a-f]{64}$/);

    const root = await merkleRoot(leaves);
    expect(root).not.toBeNull();
    expect(root).toMatch(/^[0-9a-f]{64}$/);

    // Manually reconstruct the 5-leaf RFC 6962 root to double-check
    // composition end-to-end (promote-not-duplicate at odd levels).
    // Level 0: [L0, L1, L2, L3, L4] -> pair (L0,L1)=h01, (L2,L3)=h23; promote L4.
    // Level 1: [h01, h23, L4]       -> pair (h01,h23)=hh; promote L4.
    // Level 2: [hh, L4]             -> root = inner(hh, L4).
    const h01 = await innerHash(leaves[0], leaves[1]);
    const h23 = await innerHash(leaves[2], leaves[3]);
    const hh = await innerHash(h01, h23);
    const expected = await innerHash(hh, leaves[4]);
    expect(root).toBe(expected);
  });
});
