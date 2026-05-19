/**
 * Adversarial regression tests for the Deno bundle verifier
 * (src/lib/forensic/verifyDeno.ts).
 *
 * Threat model the verifier closes:
 *
 *   The Deno verifier is the reviewer-side tool that ships INSIDE every
 *   export bundle. A motivated tamperer with write-access to the bundle
 *   on disk (a leaked review copy, a stolen press kit) will try to:
 *
 *     1. Swap a media file but leave the manifest claim alone.
 *     2. Edit an audit-log row but leave the manifest claim alone.
 *     3. Flip a bit in the COSE signature.
 *     4. Strip the COSE envelope entirely.
 *     5. Set manifest.global_audit_chain.verification.ok = true even
 *        though the chain is internally broken (self-attestation).
 *
 *   The verifier MUST detect all five. Crucially, it MUST NOT trust the
 *   self-attested `verification.ok` boolean — that bit was written by
 *   the same party we're trying to detect tampering by.
 *
 * Why we re-implement the verifier in TypeScript here (instead of
 * running the Deno script): vitest can't shell out to `deno run` with
 * any reliability across CI environments, and the script string isn't
 * directly callable. The verifier's logic is documented in the
 * top-of-file block of verifyDeno.ts; we mirror it byte-for-byte using
 * the SAME merkle / canonicalJson / coseSign1 primitives the runtime
 * uses, so this file proves the algorithm rejects the bypasses. We
 * also pin two contract checks against the literal VERIFY_DENO_SCRIPT
 * string so a future patch can't quietly remove the load-bearing
 * "use the SIGNED merkle_root, not the self-asserted ok flag" line.
 */

import { describe, expect, it, beforeAll } from "vitest";
import { webcrypto } from "node:crypto";
import { leafFromExistingHashHex, merkleRoot } from "../lib/forensic/merkle";
import { sha256Hex, sha256HexBytes, canonicalJson } from "../lib/forensic/canonicalJson";
import { buildCoseSign1 } from "../lib/forensic/coseSign1";
import { VERIFY_DENO_SCRIPT } from "../lib/forensic/verifyDeno";

// Node ≥20 exposes Ed25519 via webcrypto. Vitest polyfills globalThis.crypto
// in modern versions; guard anyway so this file runs on older Node too.
if (typeof (globalThis as { crypto?: Crypto }).crypto === "undefined") {
  (globalThis as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const GENESIS = "0".repeat(64);

interface AuditRow {
  seq: number;
  ts_utc: string;
  actor: string;
  kind: string;
  payload_json: string;
  prev_hash: string;
  entry_hash: string;
}

interface MediaClaim {
  archivePath: string;
  bytes: Uint8Array;
  /** The claim the manifest will carry. Defaults to the real hash of bytes. */
  claimedSha?: string;
}

interface Bundle {
  manifestText: string;
  /** Bytes the COSE envelope is over — by default these match manifestText. */
  coseSignedPayload: Uint8Array;
  coseBytes: Uint8Array | null;
  signingPubkeyHex: string | null;
  auditJsonl: string;
  /** archive path → bytes the bundle "stores" for that media file. */
  mediaByPath: Map<string, Uint8Array>;
}

async function chainFromPayloads(payloads: Record<string, unknown>[]): Promise<AuditRow[]> {
  const rows: AuditRow[] = [];
  let prev = GENESIS;
  for (let i = 0; i < payloads.length; i += 1) {
    const seq = i + 1;
    const ts = `2026-05-19T00:0${i}:00.000Z`;
    const actor = "system";
    const kind = "test";
    const payload_json = canonicalJson(payloads[i]);
    const entry_hash = await sha256Hex(`${seq}|${ts}|${actor}|${kind}|${payload_json}|${prev}`);
    rows.push({ seq, ts_utc: ts, actor, kind, payload_json, prev_hash: prev, entry_hash });
    prev = entry_hash;
  }
  return rows;
}

async function merkleRootOverRows(rows: AuditRow[]): Promise<string | null> {
  if (rows.length === 0) return null;
  const leaves = await Promise.all(rows.map((r) => leafFromExistingHashHex(r.entry_hash)));
  return merkleRoot(leaves);
}

/**
 * Build a full, well-formed bundle. Returns a Bundle the verifier should
 * accept. Mutators in the individual tests then break exactly one thing.
 */
async function buildGoodBundle(opts: {
  payloads?: Record<string, unknown>[];
  media?: Array<{ path: string; bytes: Uint8Array; investigationId: string }>;
}): Promise<Bundle & {
  rows: AuditRow[];
  signedMerkleRoot: string | null;
  mediaClaims: MediaClaim[];
  privateKey: CryptoKey;
  publicKeyHex: string;
}> {
  const payloads = opts.payloads ?? [{ a: 1 }, { a: 2 }, { a: 3 }];
  const rows = await chainFromPayloads(payloads);
  const signedMerkleRoot = await merkleRootOverRows(rows);

  // Media claims — real hashes.
  const mediaClaims: MediaClaim[] = [];
  const mediaByPath = new Map<string, Uint8Array>();
  const manifestMedia: Array<{ id: string; media_type: string; file_path: string; sha256: string }> = [];
  if (opts.media) {
    for (let i = 0; i < opts.media.length; i += 1) {
      const m = opts.media[i];
      const sha = await sha256HexBytes(m.bytes);
      mediaClaims.push({ archivePath: m.path, bytes: m.bytes, claimedSha: sha });
      mediaByPath.set(m.path, m.bytes);
      manifestMedia.push({ id: `media-${i}`, media_type: "audio/wav", file_path: m.path, sha256: sha });
    }
  }

  // Group media into a per-investigation list to mirror the manifest shape.
  const investigationsForManifest = opts.media && opts.media.length
    ? [{ id: opts.media[0].investigationId, media: manifestMedia }]
    : [];

  const manifestObj = {
    schema: "southern-signal.manifest.v3",
    app_version: "0.1.0",
    generated_at: "2026-05-19T00:00:00.000Z",
    investigations: investigationsForManifest,
    global_audit_chain: {
      leaf_count: rows.length,
      merkle_root: signedMerkleRoot,
      verification: { ok: true } as { ok: true } | { ok: false; brokenAtSeq: number; reason: string },
      first_seq: rows.length > 0 ? rows[0].seq : null,
      last_seq: rows.length > 0 ? rows[rows.length - 1].seq : null,
    },
    standalone_research_dossiers: [],
    reviewer_signoffs: [],
  };

  const manifestText = JSON.stringify(manifestObj, null, 2);
  const manifestBytes = new TextEncoder().encode(manifestText);

  // Real Ed25519 keypair — signs the actual manifest bytes.
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pubRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const publicKeyHex = Array.from(new Uint8Array(pubRaw))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const coseBytes = await buildCoseSign1(manifestBytes, async (toBeSigned) => {
    const sigBuf = await crypto.subtle.sign("Ed25519", keyPair.privateKey, toBeSigned as BufferSource);
    return new Uint8Array(sigBuf);
  });

  const auditJsonl = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : "");

  return {
    rows,
    signedMerkleRoot,
    mediaClaims,
    privateKey: keyPair.privateKey,
    publicKeyHex,
    manifestText,
    coseSignedPayload: manifestBytes,
    coseBytes,
    signingPubkeyHex: publicKeyHex,
    auditJsonl,
    mediaByPath,
  };
}

// ---------------------------------------------------------------------------
// Verifier — mirrors the algorithm documented in verifyDeno.ts.
//
// Trust anchor: COSE_Sign1 over manifest.json bytes. After signature
// verification passes, the manifest values are SIGNED CLAIMS; on-disk
// artefacts are re-hashed and compared against those claims. The
// verifier NEVER reads manifest.global_audit_chain.verification.ok as
// authoritative.
// ---------------------------------------------------------------------------

interface VerifyResult {
  ok: boolean;
  steps: {
    chainOk: boolean;
    chainReason?: string;
    sigOk: boolean;
    sigReason?: string;
    merkleOk: boolean;
    merkleReason?: string;
    mediaOk: boolean;
    mediaReason?: string;
  };
  failReason?:
    | "missing signature"
    | "signature invalid"
    | "audit chain broken"
    | "merkle root mismatch"
    | "media hash mismatch";
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Minimal CBOR top-level array decode, just enough to pull the four
 * COSE_Sign1 items out. Mirrors the cborDecodeItem function inside
 * the Deno verifier script.
 */
function decodeCoseTopLevelArray(bytes: Uint8Array): { protectedBytes: Uint8Array; payload: Uint8Array; signature: Uint8Array } {
  let pos = 0;
  const arrInitial = bytes[pos];
  const arrMajor = (arrInitial >> 5) & 0x07;
  const arrInfo = arrInitial & 0x1f;
  if (arrMajor !== 4) throw new Error("COSE: expected top-level array");
  pos += 1;
  let arrLen: number;
  if (arrInfo <= 23) arrLen = arrInfo;
  else if (arrInfo === 24) { arrLen = bytes[pos]; pos += 1; }
  else throw new Error(`COSE: unexpected array additional info ${arrInfo}`);
  if (arrLen !== 4) throw new Error(`COSE: expected 4-item array, got ${arrLen}`);

  function decodeNext(): { type: "bstr" | "map" | "other"; value: Uint8Array } {
    const initial = bytes[pos];
    const major = (initial >> 5) & 0x07;
    const info = initial & 0x1f;
    pos += 1;
    let len: number;
    if (info <= 23) len = info;
    else if (info === 24) { len = bytes[pos]; pos += 1; }
    else if (info === 25) { len = (bytes[pos] << 8) | bytes[pos + 1]; pos += 2; }
    else if (info === 26) {
      len = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
      pos += 4;
    } else throw new Error(`COSE: unsupported additional info ${info}`);
    if (major === 2) {
      const value = bytes.slice(pos, pos + len);
      pos += len;
      return { type: "bstr", value };
    }
    if (major === 5) {
      // unprotected header: empty map
      for (let i = 0; i < len; i += 1) {
        // each entry is k,v; for an empty map len=0 so we skip
        // (we don't fully decode this branch — only ever empty in COSE_Sign1)
      }
      return { type: "map", value: new Uint8Array(0) };
    }
    throw new Error(`COSE: unexpected major ${major}`);
  }

  const protectedItem = decodeNext();
  const unprotectedItem = decodeNext();
  const payloadItem = decodeNext();
  const sigItem = decodeNext();
  if (protectedItem.type !== "bstr") throw new Error("COSE: protected must be bstr");
  // unprotectedItem is the empty map placeholder; assert via type tag.
  if (unprotectedItem.type !== "map") throw new Error("COSE: unprotected must be map");
  if (payloadItem.type !== "bstr") throw new Error("COSE: payload must be bstr");
  if (sigItem.type !== "bstr") throw new Error("COSE: signature must be bstr");
  return {
    protectedBytes: protectedItem.value,
    payload: payloadItem.value,
    signature: sigItem.value,
  };
}

function buildSigStructure(protectedBytes: Uint8Array, payload: Uint8Array): Uint8Array {
  // Sig_Structure = [ "Signature1", protected_bstr, aad: h'', payload ]
  // Hand-encoded CBOR.
  function arg(major: number, value: number): Uint8Array {
    const m = major << 5;
    if (value <= 23) return new Uint8Array([m | value]);
    if (value <= 0xff) return new Uint8Array([m | 24, value]);
    return new Uint8Array([m | 25, (value >> 8) & 0xff, value & 0xff]);
  }
  function bstr(b: Uint8Array): Uint8Array {
    const h = arg(2, b.length);
    const out = new Uint8Array(h.length + b.length);
    out.set(h); out.set(b, h.length); return out;
  }
  function tstr(s: string): Uint8Array {
    const enc = new TextEncoder().encode(s);
    const h = arg(3, enc.length);
    const out = new Uint8Array(h.length + enc.length);
    out.set(h); out.set(enc, h.length); return out;
  }
  const items = [tstr("Signature1"), bstr(protectedBytes), bstr(new Uint8Array(0)), bstr(payload)];
  const header = arg(4, items.length);
  let total = header.length;
  for (const x of items) total += x.length;
  const out = new Uint8Array(total);
  out.set(header, 0);
  let off = header.length;
  for (const x of items) { out.set(x, off); off += x.length; }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function verifyBundle(bundle: Bundle): Promise<VerifyResult> {
  const steps: VerifyResult["steps"] = {
    chainOk: false,
    sigOk: false,
    merkleOk: false,
    mediaOk: false,
  };

  // Check 1 — audit chain self-consistency. Crucially we DO NOT trust
  // any manifest field here; we recompute from the on-disk bytes.
  const lines = bundle.auditJsonl.split(/\r?\n/).filter(Boolean);
  const recomputedHashes: string[] = [];
  let expectedPrev = GENESIS;
  let expectedSeq = 1;
  for (const line of lines) {
    let row: AuditRow;
    try { row = JSON.parse(line) as AuditRow; }
    catch { steps.chainReason = "json"; return { ok: false, steps, failReason: "audit chain broken" }; }
    if (row.seq !== expectedSeq) {
      steps.chainReason = "seq";
      return { ok: false, steps, failReason: "audit chain broken" };
    }
    if (row.prev_hash !== expectedPrev) {
      steps.chainReason = "prev_hash";
      return { ok: false, steps, failReason: "audit chain broken" };
    }
    const recomputed = await sha256Hex(
      `${row.seq}|${row.ts_utc}|${row.actor}|${row.kind}|${row.payload_json}|${row.prev_hash}`,
    );
    if (recomputed !== row.entry_hash) {
      steps.chainReason = "entry_hash";
      return { ok: false, steps, failReason: "audit chain broken" };
    }
    recomputedHashes.push(recomputed);
    expectedPrev = row.entry_hash;
    expectedSeq += 1;
  }
  steps.chainOk = true;

  // Check 2 — COSE_Sign1 envelope.
  if (!bundle.coseBytes) {
    steps.sigReason = "missing";
    return { ok: false, steps, failReason: "missing signature" };
  }
  if (!bundle.signingPubkeyHex) {
    // No pubkey in signing.json AND no legacy embedded pubkey — refuse.
    steps.sigReason = "no pubkey";
    return { ok: false, steps, failReason: "missing signature" };
  }
  let protectedBytes: Uint8Array;
  let payload: Uint8Array;
  let signature: Uint8Array;
  try {
    ({ protectedBytes, payload, signature } = decodeCoseTopLevelArray(bundle.coseBytes));
  } catch (err) {
    steps.sigReason = `cose decode: ${(err as Error).message}`;
    return { ok: false, steps, failReason: "signature invalid" };
  }
  const manifestBytes = new TextEncoder().encode(bundle.manifestText);
  if (!bytesEqual(payload, manifestBytes)) {
    steps.sigReason = "payload != manifest.json";
    return { ok: false, steps, failReason: "signature invalid" };
  }
  const sigStructure = buildSigStructure(protectedBytes, payload);
  const pubBytes = hexToBytes(bundle.signingPubkeyHex);
  const pubKey = await crypto.subtle.importKey(
    "raw",
    pubBytes as BufferSource,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const sigOk = await crypto.subtle.verify(
    "Ed25519",
    pubKey,
    signature as BufferSource,
    sigStructure as BufferSource,
  );
  if (!sigOk) {
    steps.sigReason = "ed25519 verify failed";
    return { ok: false, steps, failReason: "signature invalid" };
  }
  steps.sigOk = true;

  // Check 3 — recomputed Merkle root from on-disk chain MUST equal the
  // SIGNED manifest claim. Self-attested verification.ok is NOT consulted.
  let signedRoot: string | null;
  try {
    const m = JSON.parse(bundle.manifestText) as { global_audit_chain?: { merkle_root?: string | null } };
    signedRoot = m.global_audit_chain?.merkle_root ?? null;
  } catch {
    steps.merkleReason = "manifest not json";
    return { ok: false, steps, failReason: "merkle root mismatch" };
  }
  const recomputedLeaves = await Promise.all(recomputedHashes.map((h) => leafFromExistingHashHex(h)));
  const recomputedRoot = await merkleRoot(recomputedLeaves);
  if (signedRoot !== recomputedRoot) {
    steps.merkleReason = `signed=${signedRoot} recomputed=${recomputedRoot}`;
    return { ok: false, steps, failReason: "merkle root mismatch" };
  }
  steps.merkleOk = true;

  // Check 4 — on-disk media bytes' SHA-256 must equal the SIGNED claim.
  let manifest: { investigations?: Array<{ media?: Array<{ file_path?: string; sha256?: string }> }> };
  try {
    manifest = JSON.parse(bundle.manifestText);
  } catch {
    steps.mediaReason = "manifest not json";
    return { ok: false, steps, failReason: "media hash mismatch" };
  }
  for (const inv of manifest.investigations ?? []) {
    for (const m of inv.media ?? []) {
      if (typeof m.sha256 !== "string" || typeof m.file_path !== "string") continue;
      const archivePath = m.file_path.replace(/^\/+/, "");
      const onDisk = bundle.mediaByPath.get(archivePath);
      if (!onDisk) continue; // missing/restricted — skip silently, matches Deno script
      const got = await sha256HexBytes(onDisk);
      if (got !== m.sha256) {
        steps.mediaReason = `${archivePath} got=${got.slice(0, 16)} want=${m.sha256.slice(0, 16)}`;
        return { ok: false, steps, failReason: "media hash mismatch" };
      }
    }
  }
  steps.mediaOk = true;

  return { ok: true, steps };
}

// ---------------------------------------------------------------------------
// Adversarial tests
// ---------------------------------------------------------------------------

describe("verifyDeno — adversarial guards", () => {
  // Pre-warm: ensure a good bundle does indeed pass the verifier. If the
  // happy path isn't green, no failure-case test below proves anything.
  let goodBundle: Awaited<ReturnType<typeof buildGoodBundle>>;

  beforeAll(async () => {
    goodBundle = await buildGoodBundle({
      media: [
        { path: "media/inv-1/clip.wav", bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03, 0x04]), investigationId: "inv-1" },
      ],
    });
  });

  it("happy path: a well-formed bundle passes all four checks", async () => {
    const result = await verifyBundle(goodBundle);
    expect(result.ok).toBe(true);
    expect(result.steps.chainOk).toBe(true);
    expect(result.steps.sigOk).toBe(true);
    expect(result.steps.merkleOk).toBe(true);
    expect(result.steps.mediaOk).toBe(true);
  });

  it("rejects a tampered media file (bytes changed; manifest claim left alone) — 'media hash mismatch'", async () => {
    const tampered: Bundle = {
      ...goodBundle,
      mediaByPath: new Map(goodBundle.mediaByPath),
    };
    // Flip the first byte of the media file. Manifest still claims the
    // ORIGINAL SHA-256, signed by the device key. The verifier MUST
    // detect this even though the manifest signature is still valid.
    const orig = goodBundle.mediaByPath.get("media/inv-1/clip.wav")!;
    const mutated = new Uint8Array(orig);
    mutated[0] ^= 0xff;
    tampered.mediaByPath.set("media/inv-1/clip.wav", mutated);

    const result = await verifyBundle(tampered);
    expect(result.ok).toBe(false);
    expect(result.failReason).toBe("media hash mismatch");
    // The manifest signature MUST still verify — the attack is detected
    // purely because the on-disk bytes don't match the SIGNED claim.
    expect(result.steps.sigOk).toBe(true);
  });

  it("rejects a tampered audit-log row (manifest's merkle_root unchanged) — 'merkle root mismatch' or chain broken", async () => {
    // Mutate one row of the on-disk audit_log.jsonl. Re-hashing it for
    // self-consistency would also require re-hashing every later row;
    // we leave them untouched so the chain self-check trips first OR
    // the recomputed root differs from the SIGNED root. Either is a
    // valid "tamper detected" — both close the same bypass.
    const lines = goodBundle.auditJsonl.split("\n").filter(Boolean);
    const row1 = JSON.parse(lines[1]) as AuditRow;
    row1.payload_json = canonicalJson({ a: 9999 }); // payload changed; entry_hash stays the same
    lines[1] = JSON.stringify(row1);
    const tamperedJsonl = lines.join("\n") + "\n";

    const tampered: Bundle = {
      ...goodBundle,
      auditJsonl: tamperedJsonl,
      mediaByPath: new Map(goodBundle.mediaByPath),
    };
    const result = await verifyBundle(tampered);
    expect(result.ok).toBe(false);
    // Either the chain self-check or the merkle anchor catches it.
    expect(["audit chain broken", "merkle root mismatch"]).toContain(result.failReason);
  });

  it("rejects a tampered audit-log row even if the chain is internally consistent — 'merkle root mismatch'", async () => {
    // Stronger version of the above: rebuild a consistent chain with a
    // DIFFERENT payload. The on-disk chain now self-verifies (Check 1
    // passes), but the recomputed Merkle root won't match the SIGNED
    // root because every entry_hash changed. This is the load-bearing
    // test for "use the signed merkle_root as the external anchor".
    const otherRows = await chainFromPayloads([{ a: 1 }, { a: 99 }, { a: 3 }]);
    const otherJsonl = otherRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    const tampered: Bundle = {
      ...goodBundle,
      auditJsonl: otherJsonl,
      // mediaByPath stays the same; we don't want media to fail first.
      mediaByPath: new Map(goodBundle.mediaByPath),
    };
    const result = await verifyBundle(tampered);
    expect(result.ok).toBe(false);
    expect(result.failReason).toBe("merkle root mismatch");
    // The chain self-check should be green here — that's the whole point.
    expect(result.steps.chainOk).toBe(true);
    expect(result.steps.sigOk).toBe(true);
  });

  it("rejects a flipped COSE signature bit — 'signature invalid'", async () => {
    const tamperedCose = new Uint8Array(goodBundle.coseBytes!);
    // Find the signature offset by decoding, then flip the last byte
    // of the signature payload (just before the file ends).
    tamperedCose[tamperedCose.length - 1] ^= 0x01;
    const tampered: Bundle = { ...goodBundle, coseBytes: tamperedCose };
    const result = await verifyBundle(tampered);
    expect(result.ok).toBe(false);
    expect(result.failReason).toBe("signature invalid");
  });

  it("rejects a bundle with the COSE envelope stripped entirely — 'missing signature'", async () => {
    const tampered: Bundle = { ...goodBundle, coseBytes: null };
    const result = await verifyBundle(tampered);
    expect(result.ok).toBe(false);
    expect(result.failReason).toBe("missing signature");
  });

  it("rejects a bundle whose signing.json is missing AND has no legacy pubkey — 'missing signature'", async () => {
    // Attempt to "skip" signature verification by deleting the pubkey
    // material. The verifier MUST refuse — an unverified signature is
    // no signature.
    const tampered: Bundle = { ...goodBundle, signingPubkeyHex: null };
    const result = await verifyBundle(tampered);
    expect(result.ok).toBe(false);
    expect(result.failReason).toBe("missing signature");
  });

  it("rejects a bundle whose manifest.verification.ok=true LIES while the chain is broken — uses recomputed Merkle, not self-attestation", async () => {
    // Build the manifest by hand with verification.ok=true but ship an
    // on-disk audit_log.jsonl that doesn't agree. If the verifier ever
    // regressed to "trust manifest.global_audit_chain.verification.ok",
    // this bundle would slip past. The recomputed Merkle root catches
    // it instead.
    const realRows = await chainFromPayloads([{ a: 1 }, { a: 2 }, { a: 3 }]);
    const realRoot = await merkleRootOverRows(realRows);

    // Manifest CLAIMS a different (fake) Merkle root but ALSO claims ok:true.
    const fakeRoot = "f".repeat(64);
    const lyingManifestObj = {
      schema: "southern-signal.manifest.v3",
      app_version: "0.1.0",
      generated_at: "2026-05-19T00:00:00.000Z",
      investigations: [],
      global_audit_chain: {
        leaf_count: realRows.length,
        merkle_root: fakeRoot,
        // The lie: verification.ok=true even though the math doesn't agree.
        verification: { ok: true },
        first_seq: 1,
        last_seq: realRows.length,
      },
      standalone_research_dossiers: [],
      reviewer_signoffs: [],
    };
    const lyingManifestText = JSON.stringify(lyingManifestObj, null, 2);
    const lyingManifestBytes = new TextEncoder().encode(lyingManifestText);

    // Sign the lying manifest with a fresh key — so signature alone passes.
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const pubRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
    const pubKeyHex = Array.from(new Uint8Array(pubRaw)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const coseBytes = await buildCoseSign1(lyingManifestBytes, async (toBeSigned) => {
      const sig = await crypto.subtle.sign("Ed25519", keyPair.privateKey, toBeSigned as BufferSource);
      return new Uint8Array(sig);
    });

    const tampered: Bundle = {
      manifestText: lyingManifestText,
      coseSignedPayload: lyingManifestBytes,
      coseBytes,
      signingPubkeyHex: pubKeyHex,
      auditJsonl: realRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      mediaByPath: new Map(),
    };
    const result = await verifyBundle(tampered);
    expect(result.ok).toBe(false);
    expect(result.failReason).toBe("merkle root mismatch");
    // Signature alone is valid — proving the verifier looked PAST the
    // signed `verification.ok` and recomputed from on-disk bytes.
    expect(result.steps.sigOk).toBe(true);
    // And the real value (not the fake claim).
    expect(realRoot).not.toBe(fakeRoot);
  });
});

// ---------------------------------------------------------------------------
// String-contract tests against the literal VERIFY_DENO_SCRIPT.
//
// Even if every behavioural test above passes, a future patch could
// silently drop the "use SIGNED merkle_root, not self-attested ok" line
// from the embedded Deno script. The behavioural tests use our local
// TypeScript mirror — they wouldn't catch a regression in the bundled
// script's source. These contract tests pin a few load-bearing
// substrings so a regression in the script itself fails the suite.
// ---------------------------------------------------------------------------

describe("verifyDeno — embedded script contract", () => {
  it("explicitly forbids trusting manifest.global_audit_chain.verification.ok", () => {
    // The comment block at the top documents this. If a refactor
    // deletes it, the contract fragment is gone too. The two known
    // phrasings ("never trust ... verification.ok" and "MUST NOT trust
    // ... verification.ok") both pin the same intent.
    const banned = /(never|MUST\s+NOT)[\s\S]{0,160}verification\.ok/i;
    expect(VERIFY_DENO_SCRIPT).toMatch(banned);
  });

  it("recomputes the Merkle root from on-disk audit_log.jsonl and compares to the SIGNED claim", () => {
    expect(VERIFY_DENO_SCRIPT).toMatch(/merkleRootFromHashes/);
    expect(VERIFY_DENO_SCRIPT).toMatch(/Merkle root recomputed/i);
  });

  it("hashes each media file on disk and compares to the manifest's signed sha256", () => {
    expect(VERIFY_DENO_SCRIPT).toMatch(/m\?\.sha256/);
    expect(VERIFY_DENO_SCRIPT).toMatch(/Media SHA-256/);
  });

  it("refuses to proceed past Merkle check when COSE signature isn't verified (no fall-through)", () => {
    // Look for the explicit guard. Phrased as 'cannot trust signed claim'.
    expect(VERIFY_DENO_SCRIPT).toMatch(/cannot trust signed/);
  });

  it("fails closed when no public key is available (no signing.json + no legacy embedded pubkey)", () => {
    expect(VERIFY_DENO_SCRIPT).toMatch(/no ed25519_pubkey_hex/);
  });
});
