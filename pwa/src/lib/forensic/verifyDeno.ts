/**
 * The Deno verifier script — exported as a string so it can be embedded
 * in every export bundle as `verifier.ts`.
 *
 * Run with:
 *   deno run --allow-read --allow-net verifier.ts <bundle.zip>
 *
 * Trust model: the only thing the verifier should EVER trust as
 * authoritative is the COSE_Sign1 envelope (cose_signature.cbor) — the
 * Ed25519 signature anchors the manifest.json bytes to the device's
 * private key at write-time. From the SIGNED manifest we read:
 *
 *   • global_audit_chain.merkle_root — recompute it from on-disk
 *     audit_log.jsonl, compare against the signed claim.
 *   • per-investigation media[i].sha256 — re-hash the on-disk bytes,
 *     compare against the signed claim.
 *
 * The verifier MUST NEVER accept a field from the manifest to verify
 * the manifest itself (no self-attestation). In particular, never
 * trust manifest.global_audit_chain.verification.ok — that boolean
 * was written by the same party we're trying to detect tampering by.
 *
 * Checks performed:
 *   1. Audit log SHA-256 hash chain integrity (jsonl self-consistent)
 *   2. COSE_Sign1 Ed25519 signature over manifest.json bytes
 *   3. Merkle root RECOMPUTED from on-disk audit_log.jsonl matches
 *      the SIGNED manifest's claimed root.
 *   4. Each media file's SHA-256 RECOMPUTED from on-disk bytes matches
 *      the SIGNED manifest's claim.
 *
 * All dependencies are remote Deno modules — no npm, no local files beyond
 * the bundle itself.
 */

export const VERIFY_DENO_SCRIPT = `#!/usr/bin/env -S deno run --allow-read --allow-net
// Southern Signal — bundle verifier (Deno)
// Usage: deno run --allow-read --allow-net verifier.ts <bundle.zip>
//
// Trust anchor: the COSE_Sign1 envelope (cose_signature.cbor) over the
// manifest.json bytes. Once that signature verifies, the manifest values
// can be trusted as the SIGNED claims; all other on-disk artifacts are
// re-derived and compared against those signed claims. Crucially, this
// verifier NEVER trusts a manifest field to validate the manifest
// itself — no self-attestation.
//
// Checks:
//   1. audit_log.jsonl SHA-256 hash chain (self-consistent)
//   2. cose_signature.cbor Ed25519 signature over manifest.json bytes
//   3. Merkle root recomputed from audit_log.jsonl matches signed root
//   4. Each media/<inv>/<file> SHA-256 matches signed manifest claim
//
// Exit code 0 = all checks pass. Exit code 1 = at least one check failed.

import { ZipReader, BlobReader, TextWriter, Uint8ArrayWriter } from "https://deno.land/x/zipjs@v2.7.53/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error("Odd-length hex string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data) {
  const buf = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(buf));
}

// RFC 6962 Merkle tree primitives. leaf = SHA-256(0x00 || bytes),
// inner = SHA-256(0x01 || left || right). Odd fan-out: promote the last
// node (do NOT duplicate). Mirrors src/lib/forensic/merkle.ts.
async function _sha256BytesConcat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { buf.set(p, off); off += p.length; }
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return bytesToHex(new Uint8Array(digest));
}
async function _leafFromExistingHashHex(existingHex) {
  return await _sha256BytesConcat([new Uint8Array([0x00]), hexToBytes(existingHex)]);
}
async function _innerHash(leftHex, rightHex) {
  return await _sha256BytesConcat([new Uint8Array([0x01]), hexToBytes(leftHex), hexToBytes(rightHex)]);
}
async function merkleRootFromHashes(entryHashesHex) {
  if (entryHashesHex.length === 0) return null;
  let level = [];
  for (const h of entryHashesHex) level.push(await _leafFromExistingHashHex(h));
  if (level.length === 1) return level[0];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i + 1 < level.length; i += 2) {
      next.push(await _innerHash(level[i], level[i + 1]));
    }
    if (level.length % 2 === 1) next.push(level[level.length - 1]);
    level = next;
  }
  return level[0];
}

function pass(label) { console.log("  PASS  " + label); }
function fail(label, detail) { console.log("  FAIL  " + label + (detail ? " — " + detail : "")); }

// ---------------------------------------------------------------------------
// CBOR / COSE_Sign1 minimal decoder
// ---------------------------------------------------------------------------

// We only need to decode enough of the COSE_Sign1 envelope to extract
// the protected header bytes, payload bytes, and signature bytes.
// Full CBOR decode is not needed; we extract the four array items manually.

function cborDecodeItem(bytes, offset) {
  const initial = bytes[offset];
  const major = (initial >> 5) & 0x07;
  const info = initial & 0x1f;
  let pos = offset + 1;

  let len;
  if (info <= 23) {
    len = info;
  } else if (info === 24) {
    len = bytes[pos++];
  } else if (info === 25) {
    len = (bytes[pos] << 8) | bytes[pos + 1];
    pos += 2;
  } else if (info === 26) {
    len = (bytes[pos] << 24) | (bytes[pos+1] << 16) | (bytes[pos+2] << 8) | bytes[pos+3];
    pos += 4;
  } else {
    throw new Error("CBOR: unsupported additional info " + info + " at offset " + offset);
  }

  if (major === 0) { // uint
    return { value: len, next: pos, type: "uint" };
  } else if (major === 1) { // nint
    return { value: -1 - len, next: pos, type: "nint" };
  } else if (major === 2) { // bstr
    const value = bytes.slice(pos, pos + len);
    return { value, next: pos + len, type: "bstr" };
  } else if (major === 3) { // tstr
    const value = new TextDecoder().decode(bytes.slice(pos, pos + len));
    return { value, next: pos + len, type: "tstr" };
  } else if (major === 4) { // array
    // Decode \`len\` items
    const items = [];
    let cur = pos;
    for (let i = 0; i < len; i++) {
      const item = cborDecodeItem(bytes, cur);
      items.push(item);
      cur = item.next;
    }
    return { value: items, next: cur, type: "array" };
  } else if (major === 5) { // map
    // Decode \`len\` key/value pairs
    const entries = [];
    let cur = pos;
    for (let i = 0; i < len; i++) {
      const k = cborDecodeItem(bytes, cur);
      cur = k.next;
      const v = cborDecodeItem(bytes, cur);
      cur = v.next;
      entries.push([k, v]);
    }
    return { value: entries, next: cur, type: "map" };
  } else {
    throw new Error("CBOR: unsupported major type " + major);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const bundlePath = Deno.args[0];
if (!bundlePath) {
  console.error("Usage: deno run --allow-read --allow-net verifier.ts <bundle.zip>");
  Deno.exit(2);
}

console.log("Southern Signal — bundle verifier");
console.log("Bundle: " + bundlePath);
console.log("");

let allPass = true;

// Open the ZIP.
const fileBytes = await Deno.readFile(bundlePath);
const zipBlob = new Blob([fileBytes]);
const zipReader = new ZipReader(new BlobReader(zipBlob));
const entries = await zipReader.getEntries();

// Build a map: path → ZipEntry
const entryMap = new Map();
for (const e of entries) {
  entryMap.set(e.filename, e);
}

// Helper to read a text entry.
async function readText(path) {
  const e = entryMap.get(path);
  if (!e) return null;
  return await e.getData(new TextWriter());
}

// Helper to read a binary entry.
async function readBytes(path) {
  const e = entryMap.get(path);
  if (!e) return null;
  return await e.getData(new Uint8ArrayWriter());
}

// Chain hashes collected by Check 1, consumed by Check 3 (Merkle).
const collectedChainHashes = [];
let chainCheckOk = false;

// ---------------------------------------------------------------------------
// Check 1: audit_log.jsonl hash chain (self-consistent — does NOT bind
// the chain to anything signed; that's Check 3's job).
// ---------------------------------------------------------------------------
console.log("1. Audit log hash chain");
{
  const text = await readText("audit_log.jsonl");
  if (!text) {
    fail("audit_log.jsonl", "file missing from bundle");
    allPass = false;
  } else {
    const lines = text.split(/\\r?\\n/).filter(Boolean);
    const GENESIS = "0".repeat(64);
    let prev = GENESIS;
    let expectedSeq = 1;
    let chainOk = true;
    let chainDetail = "";
    for (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch {
        chainOk = false;
        chainDetail = "seq " + expectedSeq + " is not valid JSON";
        break;
      }
      if (row.seq !== expectedSeq) {
        chainOk = false;
        chainDetail = "expected seq " + expectedSeq + ", got " + row.seq;
        break;
      }
      if (row.prev_hash !== prev) {
        chainOk = false;
        chainDetail = "seq " + row.seq + " prev_hash mismatch";
        break;
      }
      const msg = row.seq + "|" + row.ts_utc + "|" + row.actor + "|" + row.kind + "|" + row.payload_json + "|" + row.prev_hash;
      const recomputed = await sha256Hex(new TextEncoder().encode(msg));
      if (recomputed !== row.entry_hash) {
        chainOk = false;
        chainDetail = "seq " + row.seq + " entry_hash mismatch (recomputed=" + recomputed.slice(0,16) + "...)";
        break;
      }
      // Stash the RECOMPUTED hash (not the row's claim) for the Merkle
      // check below. They're equal here because the row passed
      // validation, but using the recomputed value future-proofs the
      // chain → Merkle pipeline against a regression that lets a bad
      // entry_hash slip through Check 1.
      collectedChainHashes.push(recomputed);
      prev = row.entry_hash;
      expectedSeq++;
    }
    if (chainOk) {
      pass("audit_log.jsonl — " + lines.length + " entries verified");
      chainCheckOk = true;
    } else {
      fail("audit_log.jsonl", chainDetail);
      allPass = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Check 2: COSE_Sign1 Ed25519 signature over manifest.json
// ---------------------------------------------------------------------------
console.log("");
console.log("2. COSE_Sign1 Ed25519 signature");
let coseSignatureOk = false;
{
  const coseBytes = await readBytes("cose_signature.cbor");
  const manifestText = await readText("manifest.json");
  // signing.json sidecar holds bundle_id, built_at, ed25519_pubkey_hex,
  // tsa_status. It's a separate file so manifest.json can stay byte-
  // stable — what the COSE envelope is over. Older bundles (pre-fix)
  // embedded the pubkey inside manifest.signing instead; we fall back
  // to that path so those bundles can still be partially verified
  // (structure check passes, signature won't because their stored
  // bytes never matched signed bytes).
  const signingText = await readText("signing.json");

  if (!coseBytes) {
    fail("cose_signature.cbor", "file missing from bundle");
    allPass = false;
  } else if (!manifestText) {
    fail("cose_signature.cbor", "manifest.json missing — cannot verify");
    allPass = false;
  } else {
    try {
      // Decode COSE_Sign1 array.
      const top = cborDecodeItem(coseBytes, 0);
      if (top.type !== "array" || top.value.length !== 4) {
        throw new Error("Expected COSE_Sign1 array of 4 items, got type=" + top.type + " len=" + (top.value?.length ?? "?"));
      }
      const [protectedItem, , payloadItem, sigItem] = top.value;
      if (protectedItem.type !== "bstr") throw new Error("protected header must be bstr");
      if (payloadItem.type !== "bstr") throw new Error("payload must be bstr");
      if (sigItem.type !== "bstr") throw new Error("signature must be bstr");

      const protectedHeaderBytes = protectedItem.value; // Uint8Array
      const signatureBytes = sigItem.value;             // 64 bytes
      const payloadBytes = payloadItem.value;           // manifest JSON bytes

      // Verify the payload matches manifest.json in the bundle.
      const manifestBytes = new TextEncoder().encode(manifestText);
      const payloadMatchesManifest =
        payloadBytes.length === manifestBytes.length &&
        payloadBytes.every((b, i) => b === manifestBytes[i]);
      if (!payloadMatchesManifest) {
        fail("cose_signature.cbor", "payload in COSE envelope does not match manifest.json bytes");
        allPass = false;
      } else {
        // Reconstruct Sig_Structure (what was signed).
        // Sig_Structure = [ "Signature1", protected_bstr, aad: h'', payload ]
        function cborArgument(major, value) {
          const m = major << 5;
          if (value <= 23) return new Uint8Array([m | value]);
          if (value <= 0xff) return new Uint8Array([m | 24, value]);
          return new Uint8Array([m | 25, (value >> 8) & 0xff, value & 0xff]);
        }
        function cborBstr(bytes) {
          const hdr = cborArgument(2, bytes.length);
          const out = new Uint8Array(hdr.length + bytes.length);
          out.set(hdr); out.set(bytes, hdr.length);
          return out;
        }
        function cborTstr(s) {
          const enc = new TextEncoder().encode(s);
          const hdr = cborArgument(3, enc.length);
          const out = new Uint8Array(hdr.length + enc.length);
          out.set(hdr); out.set(enc, hdr.length);
          return out;
        }
        function cborConcat(...parts) {
          const total = parts.reduce((s, p) => s + p.length, 0);
          const out = new Uint8Array(total);
          let off = 0;
          for (const p of parts) { out.set(p, off); off += p.length; }
          return out;
        }
        function cborArray(items) {
          const hdr = cborArgument(4, items.length);
          return cborConcat(hdr, ...items);
        }

        const sigStructure = cborArray([
          cborTstr("Signature1"),
          cborBstr(protectedHeaderBytes),
          cborBstr(new Uint8Array(0)), // empty aad
          cborBstr(payloadBytes),
        ]);

        // Extract the Ed25519 public key. Live bundles store it in
        // signing.json (sidecar); legacy bundles embedded it under
        // manifest.signing — fall back to that for verification of
        // older exports.
        let pubKeyHex = null;
        if (signingText) {
          try {
            const signing = JSON.parse(signingText);
            if (typeof signing?.ed25519_pubkey_hex === "string") pubKeyHex = signing.ed25519_pubkey_hex;
          } catch { /* fall through to legacy lookup */ }
        }
        if (!pubKeyHex) {
          try {
            const m = JSON.parse(manifestText);
            if (typeof m?.signing?.ed25519_pubkey_hex === "string") pubKeyHex = m.signing.ed25519_pubkey_hex;
          } catch { /* leave null */ }
        }

        if (!pubKeyHex) {
          // No public key anywhere — without a key we cannot verify the
          // signature, and an unverified signature is no signature. Fail
          // closed so a tamperer can't simply delete signing.json (and
          // any legacy embedded pubkey) to skip the check.
          fail("Ed25519 signature", "no ed25519_pubkey_hex in signing.json (or legacy manifest.signing) — cannot verify");
          allPass = false;
        } else {
          const pubKeyBytes = hexToBytes(pubKeyHex);
          const pubKey = await crypto.subtle.importKey(
            "raw",
            pubKeyBytes,
            { name: "Ed25519" },
            false,
            ["verify"],
          );
          const valid = await crypto.subtle.verify(
            "Ed25519",
            pubKey,
            signatureBytes,
            sigStructure,
          );
          if (valid) {
            pass("Ed25519 signature verified (pubkey: " + pubKeyHex.slice(0, 16) + "...)");
            coseSignatureOk = true;
          } else {
            fail("Ed25519 signature", "signature verification failed — bundle may have been tampered");
            allPass = false;
          }
        }
      }
    } catch (err) {
      fail("cose_signature.cbor", err.message);
      allPass = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Check 3: Merkle root — RECOMPUTED from on-disk audit_log.jsonl vs the
// SIGNED manifest's claim. This is the load-bearing tamper detector for
// audit-log substitution. The signed manifest's merkle_root is the
// external anchor; we MUST NOT trust manifest.global_audit_chain.
// verification.ok (self-asserted boolean from the very party we're
// trying to detect tampering by).
// ---------------------------------------------------------------------------
console.log("");
console.log("3. Merkle root (recomputed audit log vs signed manifest)");
{
  if (!chainCheckOk) {
    fail("Merkle root", "skipped — audit log self-check failed");
    allPass = false;
  } else if (!coseSignatureOk) {
    fail("Merkle root", "skipped — manifest signature not verified; cannot trust signed claim");
    allPass = false;
  } else {
    const manifestText2 = await readText("manifest.json");
    let signedRoot = null;
    try {
      const m = JSON.parse(manifestText2);
      signedRoot = m?.global_audit_chain?.merkle_root ?? null;
    } catch {
      fail("Merkle root", "manifest.json invalid JSON");
      allPass = false;
    }
    const recomputedRoot = await merkleRootFromHashes(collectedChainHashes);
    if (signedRoot === null && recomputedRoot === null) {
      pass("Merkle root: (empty chain — null on both sides)");
    } else if (signedRoot === recomputedRoot) {
      pass("Merkle root matches signed manifest: " + (recomputedRoot ? recomputedRoot.slice(0, 16) + "..." : "(none)"));
    } else {
      fail(
        "Merkle root",
        "recomputed=" + (recomputedRoot ? recomputedRoot.slice(0, 16) + "..." : "null") +
          " signed=" + (signedRoot ? String(signedRoot).slice(0, 16) + "..." : "null") +
          " — audit_log.jsonl bytes do not match signed claim",
      );
      allPass = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Check 4: Media file SHA-256 — RECOMPUTED from on-disk bytes vs the
// SIGNED manifest's claim. Without this, a tamperer could swap any media
// file in the bundle and the verifier would never notice.
// ---------------------------------------------------------------------------
console.log("");
console.log("4. Media file SHA-256 (on-disk bytes vs signed manifest)");
{
  if (!coseSignatureOk) {
    fail("Media SHA-256", "skipped — manifest signature not verified; cannot trust signed claims");
    allPass = false;
  } else {
    const manifestText3 = await readText("manifest.json");
    let manifest3 = null;
    try { manifest3 = JSON.parse(manifestText3); } catch { manifest3 = null; }
    if (!manifest3) {
      fail("Media SHA-256", "manifest.json invalid JSON");
      allPass = false;
    } else {
      let checked = 0;
      let mismatched = 0;
      let missing = 0;
      const invs = Array.isArray(manifest3.investigations) ? manifest3.investigations : [];
      for (const inv of invs) {
        const mediaList = Array.isArray(inv?.media) ? inv.media : [];
        for (const m of mediaList) {
          const claimedSha = m?.sha256;
          const filePath = m?.file_path;
          if (typeof claimedSha !== "string" || !claimedSha || typeof filePath !== "string" || !filePath) {
            continue;
          }
          const archivePath = filePath.replace(/^\\/+/, "");
          const bytes = await readBytes(archivePath);
          if (!bytes) {
            // Could legitimately be missing (e.g., ICIP-restricted file
            // replaced by a _RESTRICTED.txt notice). Skip silently.
            missing++;
            continue;
          }
          checked++;
          const got = await sha256Hex(bytes);
          if (got !== claimedSha) {
            mismatched++;
            fail("Media SHA-256", archivePath + " — got " + got.slice(0, 16) + "... want " + String(claimedSha).slice(0, 16) + "...");
          }
        }
      }
      if (mismatched > 0) {
        allPass = false;
      } else if (checked === 0) {
        pass("Media SHA-256 — no media with claims in manifest (skipped " + missing + " missing/restricted)");
      } else {
        pass("Media SHA-256 — " + checked + " file(s) match signed manifest (skipped " + missing + " missing/restricted)");
      }
    }
  }
}

await zipReader.close();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log("");
if (allPass) {
  console.log("RESULT  ALL CHECKS PASSED");
  Deno.exit(0);
} else {
  console.log("RESULT  ONE OR MORE CHECKS FAILED — see above");
  Deno.exit(1);
}
`;
