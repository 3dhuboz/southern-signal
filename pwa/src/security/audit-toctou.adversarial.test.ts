/**
 * Adversarial regression tests for the export-bundle TOCTOU fix
 * (src/lib/forensic/exportBundle.ts → buildExportBundle).
 *
 * Threat model the fix closes:
 *
 *   Before the fix, buildExportBundle read the audit log THEN called
 *   buildManifest which independently re-queried the audit log. A
 *   concurrent appendAuditEntry landing between those two reads would:
 *
 *     - leave manifest.global_audit_chain.merkle_root pinned to the
 *       SHORTER snapshot (manifest's own SELECT happened first), but
 *     - place a row in audit_log.jsonl that the SIGNED merkle_root
 *       doesn't account for (because the bundle's SELECT happened
 *       AFTER manifest's, picking up the appended row).
 *
 *   At reviewer time the verifier would correctly flag the bundle as
 *   tampered — false positive on legit exports, AND a hole an attacker
 *   could squeeze an unauthorised row into.
 *
 *   The fix (see comment block on buildExportBundle): read the audit
 *   log ONCE, then pass that exact array into buildManifest via
 *   `pinned`. The audit_log.jsonl entry is serialised from the SAME
 *   array. Any concurrent append lands in the DB but not in this
 *   bundle.
 *
 * This test simulates the race by making the second `query` call (the
 * one that would re-read the chain inside buildManifest) NEVER happen
 * — by asserting via mock that buildManifest received `pinned` and
 * never re-read FROM audit_log on its own. We also drive a "concurrent
 * append" scenario: the query mock returns rows[0..2] on the first
 * audit_log call; on any later audit_log call it would return rows[0..3]
 * (i.e. someone wrote a row mid-export). If the fix held, that fourth
 * row MUST NOT appear in the bundle's audit_log.jsonl AND MUST NOT
 * influence the manifest's signed merkle_root.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";

if (typeof (globalThis as { crypto?: Crypto }).crypto === "undefined") {
  (globalThis as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
}

// ---------------------------------------------------------------------------
// Mock the low-level boundaries: DB query, OPFS, preferences, signing,
// TSA, etc. We let buildExportBundle and buildManifest themselves run —
// those are the ACTUAL functions whose contract we're verifying.
// ---------------------------------------------------------------------------

const {
  queryFn,
  signBytesFn,
  getOrCreateSigningKeyFn,
  capturedEntries,
  saveBundleSignatureFn,
  sendTsaRequestFn,
} = vi.hoisted(() => ({
  queryFn: vi.fn(),
  signBytesFn: vi.fn(),
  getOrCreateSigningKeyFn: vi.fn(),
  capturedEntries: { current: null as Array<{ path: string; data: Uint8Array }> | null },
  saveBundleSignatureFn: vi.fn(),
  sendTsaRequestFn: vi.fn(),
}));

vi.mock("../lib/db/db", () => ({ query: queryFn, exec: vi.fn() }));
vi.mock("../lib/opfs", () => ({
  readFile: vi.fn(),
  exists: vi.fn().mockResolvedValue(false),
}));
vi.mock("../lib/preferences", () => ({
  getPreferences: () => ({
    acknowledgementOfCountry: { accepted: false, statement: null, acceptedAt: null },
  }),
}));
vi.mock("../lib/db/markerOverrides", () => ({
  loadMarkerOverrides: vi.fn().mockResolvedValue({ dismissed: new Set(), annotations: new Map() }),
}));
vi.mock("../lib/db/bundleSignatureRepo", () => ({ saveBundleSignature: saveBundleSignatureFn }));
vi.mock("../lib/forensic/tsaClient", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/forensic/tsaClient")>();
  return { ...orig, sendTsaRequest: sendTsaRequestFn };
});
vi.mock("../lib/forensic/signingKeyStore", () => ({
  getOrCreateSigningKey: getOrCreateSigningKeyFn,
  signBytes: signBytesFn,
}));
// verifyAuditChain is a SECOND code path that would re-read audit_log
// from the DB inside buildManifest. The fix routes around it by passing
// `pinned`; mock the original to NEVER yield a different verdict, then
// assert it received the pinned snapshot via the manifest claim.
vi.mock("../lib/db/auditLog", () => ({
  verifyAuditChain: vi.fn().mockResolvedValue({ ok: true }),
  appendAuditEntry: vi.fn(),
}));
// Wrap buildZip so we can capture the entries the bundle would write.
vi.mock("../lib/forensic/zip", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/forensic/zip")>();
  return {
    ...orig,
    buildZip: (entries: Array<{ path: string; data: Uint8Array }>) => {
      capturedEntries.current = entries.map((e) => ({ path: e.path, data: e.data }));
      return orig.buildZip(entries);
    },
  };
});

import { buildExportBundle } from "../lib/forensic/exportBundle";
import { sha256Hex, canonicalJson } from "../lib/forensic/canonicalJson";
import { leafFromExistingHashHex, merkleRoot } from "../lib/forensic/merkle";

const GENESIS = "0".repeat(64);

interface ChainEntry {
  seq: number;
  ts_utc: string;
  actor: string;
  kind: string;
  payload_json: string;
  prev_hash: string;
  entry_hash: string;
}

async function buildChain(payloads: Record<string, unknown>[]): Promise<ChainEntry[]> {
  const rows: ChainEntry[] = [];
  let prev = GENESIS;
  for (let i = 0; i < payloads.length; i += 1) {
    const seq = i + 1;
    const ts = `2026-05-19T00:00:${String(i).padStart(2, "0")}.000Z`;
    const actor = "system";
    const kind = "test";
    const payload_json = canonicalJson(payloads[i]);
    const entry_hash = await sha256Hex(`${seq}|${ts}|${actor}|${kind}|${payload_json}|${prev}`);
    rows.push({ seq, ts_utc: ts, actor, kind, payload_json, prev_hash: prev, entry_hash });
    prev = entry_hash;
  }
  return rows;
}

async function rootOf(rows: ChainEntry[]): Promise<string | null> {
  if (rows.length === 0) return null;
  const leaves = await Promise.all(rows.map((r) => leafFromExistingHashHex(r.entry_hash)));
  return merkleRoot(leaves);
}

beforeEach(() => {
  queryFn.mockReset();
  signBytesFn.mockReset();
  getOrCreateSigningKeyFn.mockReset();
  saveBundleSignatureFn.mockReset();
  sendTsaRequestFn.mockReset();
  capturedEntries.current = null;

  // Signing infrastructure — deterministic so we don't have to assert
  // anything about real Ed25519 output. The TOCTOU test isn't about
  // signing; we just need the export to complete cleanly.
  getOrCreateSigningKeyFn.mockResolvedValue({
    privateKey: {} as CryptoKey,
    publicKeyHex: "ab".repeat(32),
  });
  signBytesFn.mockResolvedValue(new Uint8Array(64).fill(0xcc));
  sendTsaRequestFn.mockRejectedValue(new Error("offline — TSA n/a in tests"));
  saveBundleSignatureFn.mockResolvedValue(undefined);
});

describe("buildExportBundle — TOCTOU race against concurrent appendAuditEntry", () => {
  it("pins the bundle's audit_log.jsonl to the snapshot taken AT THE TOP of the export — concurrent appends never appear", async () => {
    // The export reads the audit log once at the very top of buildExportBundle
    // and passes that array as `pinned` into buildManifest. ANY query whose SQL
    // mentions audit_log AFTER that first call would return the post-append
    // snapshot — we use the auditCallCount to switch between the two snapshots.

    // Snapshot A: what was in the DB when the export started.
    const snapshotA = await buildChain([{ a: 1 }, { a: 2 }, { a: 3 }]);

    // Snapshot B: a malicious row landed mid-export. seq 4's payload is
    // crafted so a tamperer trying to slip into the bundle would prefer
    // it goes in the merkle root. Chain extends cleanly from row 3.
    const post = await buildChain([{ a: 1 }, { a: 2 }, { a: 3 }, { a: 999, attacker: true }]);

    // Pre-compute roots for assertions.
    const rootA = await rootOf(snapshotA);
    const rootB = await rootOf(post);
    expect(rootA).not.toBe(rootB);

    let auditCallCount = 0;
    queryFn.mockImplementation((sql: string) => {
      if (sql.includes("FROM audit_log")) {
        auditCallCount += 1;
        // The fix means we expect EXACTLY ONE audit_log SELECT. Even
        // if the function did re-read, we'd return the post-append
        // snapshot so the failure mode is concrete: bundle ships post
        // row, signed root is A → verifier detects a "merkle root
        // mismatch" downstream. The fix should mean we never hit case 2.
        return Promise.resolve(auditCallCount === 1 ? snapshotA : post);
      }
      // Everything else — investigations, evidence_events, media, etc. —
      // returns empty so the bundle build doesn't error on unrelated tables.
      return Promise.resolve([]);
    });

    const { summary } = await buildExportBundle();
    expect(summary).toBeDefined();
    expect(capturedEntries.current).not.toBeNull();
    const byPath = new Map(capturedEntries.current!.map((e) => [e.path, e.data]));

    // ---- Invariant 1: audit_log.jsonl in the bundle equals snapshot A ----
    const jsonlBytes = byPath.get("audit_log.jsonl");
    expect(jsonlBytes).toBeDefined();
    const jsonlText = new TextDecoder().decode(jsonlBytes!);
    const lines = jsonlText.split(/\r?\n/).filter(Boolean);
    // Exactly the rows from snapshot A — no fourth attacker row.
    expect(lines).toHaveLength(snapshotA.length);
    const bundledRows = lines.map((l) => JSON.parse(l) as ChainEntry);
    expect(bundledRows.map((r) => r.seq)).toEqual([1, 2, 3]);
    // None of the bundled payload_json strings contains the attacker
    // marker — proving the post-snapshot row never made it into bytes.
    for (const r of bundledRows) {
      expect(r.payload_json).not.toContain("attacker");
    }

    // ---- Invariant 2: manifest's signed merkle_root matches snapshot A ----
    const manifestBytes = byPath.get("manifest.json")!;
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
      global_audit_chain: { merkle_root: string | null; leaf_count: number };
    };
    expect(manifest.global_audit_chain.leaf_count).toBe(snapshotA.length);
    expect(manifest.global_audit_chain.merkle_root).toBe(rootA);
    // Crucially NOT the post-append root — proves no leakage.
    expect(manifest.global_audit_chain.merkle_root).not.toBe(rootB);

    // ---- Invariant 3: audit_log SELECT happened exactly once ----
    // The TOCTOU fix is specifically about reading the chain a single
    // time. If a future refactor re-reads inside buildManifest, this
    // assertion fails. We see EITHER exactly 1 (the strict fix) or — if
    // the implementation defensively re-queries — the bundle and manifest
    // must STILL agree (Invariants 1+2 above). We pin the strict count.
    expect(auditCallCount).toBe(1);
  });

  it("manifest's signed merkle_root matches the recomputed root of the bundled audit_log.jsonl (byte-equality of the snapshot)", async () => {
    // Even without a "race", the strongest invariant of the TOCTOU fix
    // is: WHATEVER bytes ended up in audit_log.jsonl, when you recompute
    // the Merkle root from them, you MUST get the value the manifest
    // claims. This is what the Deno verifier checks at reviewer time —
    // and the fix is exactly the contract that keeps it green.

    const snapshot = await buildChain([{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }, { a: 5 }]);
    queryFn.mockImplementation((sql: string) => {
      if (sql.includes("FROM audit_log")) return Promise.resolve(snapshot);
      return Promise.resolve([]);
    });

    await buildExportBundle();
    const byPath = new Map(capturedEntries.current!.map((e) => [e.path, e.data]));
    const jsonlText = new TextDecoder().decode(byPath.get("audit_log.jsonl")!);
    const bundledRows = jsonlText.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as ChainEntry);
    const bundledRoot = await rootOf(bundledRows);
    const manifest = JSON.parse(new TextDecoder().decode(byPath.get("manifest.json")!)) as {
      global_audit_chain: { merkle_root: string | null };
    };
    expect(manifest.global_audit_chain.merkle_root).toBe(bundledRoot);
  });

  it("post-snapshot rows are NOT incorporated even when the second audit_log read returns more rows (would-have-been the bug)", async () => {
    // Adversarial sequencing: snapshot A returns the small chain on the
    // first read; if the implementation ever re-queries, snapshot B is
    // returned with an extra row. We confirm the bundle ships snapshot
    // A regardless. (Note: with the fix, the second read never happens;
    // this test still passes because the first read is what got pinned.
    // If a future regression re-introduces a second read inside
    // buildManifest, the manifest's merkle_root would change to root B
    // while the bundle's audit_log.jsonl could be either A or B depending
    // on call order — making this test fail.)

    const snapshotA = await buildChain([{ a: 1 }, { a: 2 }]);
    const snapshotB = await buildChain([{ a: 1 }, { a: 2 }, { malicious: true }]);
    let callIdx = 0;
    queryFn.mockImplementation((sql: string) => {
      if (sql.includes("FROM audit_log")) {
        callIdx += 1;
        return Promise.resolve(callIdx === 1 ? snapshotA : snapshotB);
      }
      return Promise.resolve([]);
    });

    await buildExportBundle();
    const byPath = new Map(capturedEntries.current!.map((e) => [e.path, e.data]));
    const jsonlText = new TextDecoder().decode(byPath.get("audit_log.jsonl")!);
    expect(jsonlText).not.toContain("malicious");
    const bundledRoot = await rootOf(
      jsonlText.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as ChainEntry),
    );
    const manifest = JSON.parse(new TextDecoder().decode(byPath.get("manifest.json")!)) as {
      global_audit_chain: { merkle_root: string | null };
    };
    expect(manifest.global_audit_chain.merkle_root).toBe(bundledRoot);
    // And specifically the snapshot-A root, not snapshot-B's.
    expect(manifest.global_audit_chain.merkle_root).toBe(await rootOf(snapshotA));
  });

  it("manifest.global_audit_chain.verification is derived from the pinned snapshot, not a stale DB re-read", async () => {
    // The pinned-snapshot path uses verifyAuditChainFromRows inline
    // (see manifest.ts) instead of calling the external verifyAuditChain.
    // If a refactor ever re-routed to the DB-reading verifier, a
    // concurrent appendAuditEntry could produce a verification verdict
    // that doesn't correspond to the bundle's audit_log.jsonl bytes.
    //
    // We exploit the mock: set verifyAuditChain (the external one) to
    // return a HEAVILY DIFFERENT verdict — if the manifest accepted it,
    // verification.ok would flip to false. The pinned path ignores the
    // external function and runs the loop inline → still ok:true.

    const auditLogMock = await import("../lib/db/auditLog");
    (auditLogMock.verifyAuditChain as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      brokenAtSeq: 1,
      reason: "stale external read — should be ignored when pinned",
    });

    const snapshot = await buildChain([{ x: 1 }]);
    queryFn.mockImplementation((sql: string) => {
      if (sql.includes("FROM audit_log")) return Promise.resolve(snapshot);
      return Promise.resolve([]);
    });

    await buildExportBundle();
    const byPath = new Map(capturedEntries.current!.map((e) => [e.path, e.data]));
    const manifest = JSON.parse(new TextDecoder().decode(byPath.get("manifest.json")!)) as {
      global_audit_chain: { verification: { ok: boolean } };
    };
    expect(manifest.global_audit_chain.verification.ok).toBe(true);
  });
});
