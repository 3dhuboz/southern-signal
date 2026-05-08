/**
 * RFC 6962 Merkle tree over hex-encoded SHA-256 leaves.
 *
 * Leaf hash:   SHA-256(0x00 || entry-bytes)
 * Inner hash:  SHA-256(0x01 || left || right)
 *
 * Odd-fan-out: when a level has an odd number of nodes, the last node
 * is promoted (NOT duplicated — RFC 6962 explicitly forbids the
 * Bitcoin-style duplication footgun).
 *
 * Inputs are hex strings (lowercase). Output is a hex string.
 *
 * Web Crypto only — no new deps.
 */

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("Hex string must have even length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function sha256(parts: Uint8Array[]): Promise<string> {
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { buf.set(p, off); off += p.length; }
  const digest = await crypto.subtle.digest("SHA-256", buf as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

/** Hash a leaf: SHA-256(0x00 || entry-bytes). Caller passes raw bytes. */
export async function leafHash(entry: Uint8Array): Promise<string> {
  return sha256([new Uint8Array([0x00]), entry]);
}

/** Promote a pre-hashed entry into a leaf hash (e.g. existing audit_log entry_hash). */
export async function leafFromExistingHashHex(existingHex: string): Promise<string> {
  return sha256([new Uint8Array([0x00]), hexToBytes(existingHex)]);
}

/** Inner node hash: SHA-256(0x01 || left || right). */
export async function innerHash(leftHex: string, rightHex: string): Promise<string> {
  return sha256([new Uint8Array([0x01]), hexToBytes(leftHex), hexToBytes(rightHex)]);
}

/**
 * Build the Merkle root over an ordered list of leaf hashes (hex).
 * Returns null for an empty list (empty-tree convention is application-specific).
 */
export async function merkleRoot(leaves: string[]): Promise<string | null> {
  if (leaves.length === 0) return null;
  if (leaves.length === 1) return leaves[0];
  let level = leaves.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) {
      next.push(await innerHash(level[i], level[i + 1]));
    }
    if (level.length % 2 === 1) next.push(level[level.length - 1]); // promote, do NOT duplicate
    level = next;
  }
  return level[0];
}
