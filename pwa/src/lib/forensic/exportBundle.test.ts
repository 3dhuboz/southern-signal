import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryFn, capturedEntries, sendTsaRequestFn, saveBundleSignatureFn, signBytesFn, getOrCreateSigningKeyFn } = vi.hoisted(() => ({
  queryFn: vi.fn(),
  // Captures the entries array passed to buildZip so the sidecar-flow tests
  // can inspect what would end up in the ZIP without parsing the binary.
  capturedEntries: { current: null as Array<{ path: string; data: Uint8Array }> | null },
  sendTsaRequestFn: vi.fn(),
  saveBundleSignatureFn: vi.fn(),
  signBytesFn: vi.fn(),
  getOrCreateSigningKeyFn: vi.fn(),
}));
vi.mock("../db/db", () => ({ query: queryFn, exec: vi.fn() }));
vi.mock("../opfs", () => ({ readFile: vi.fn(), exists: vi.fn().mockResolvedValue(false) }));
vi.mock("../preferences", () => ({
  getPreferences: () => ({
    acknowledgementOfCountry: { accepted: false, statement: null, acceptedAt: null },
  }),
}));
vi.mock("../db/bundleSignatureRepo", () => ({ saveBundleSignature: saveBundleSignatureFn }));
vi.mock("../db/markerOverrides", () => ({
  loadMarkerOverrides: vi.fn().mockResolvedValue({ dismissed: new Set(), annotations: new Map() }),
}));
vi.mock("./tsaClient", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./tsaClient")>();
  return { ...orig, sendTsaRequest: sendTsaRequestFn };
});
vi.mock("./signingKeyStore", () => ({
  getOrCreateSigningKey: getOrCreateSigningKeyFn,
  signBytes: signBytesFn,
}));
// Wrap buildZip so we can capture the entry list AS PASSED IN, in order.
// The signing flow depends on manifest.json appearing BEFORE the signing block
// — a wrap (not a stub) means the rest of the export still produces a real
// Blob if anything else cares about it.
vi.mock("./zip", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./zip")>();
  return {
    ...orig,
    buildZip: (entries: Array<{ path: string; data: Uint8Array }>) => {
      capturedEntries.current = entries.map((e) => ({ path: e.path, data: e.data }));
      return orig.buildZip(entries);
    },
  };
});

import { buildResearchEntries, loadResearchForBundle, type BundleDossierRow, type BundleFindingNoteRow, buildExportBundle } from "./exportBundle";

function dossierRow(partial: Partial<BundleDossierRow> & { id: string }): BundleDossierRow {
  return {
    id: partial.id,
    investigation_id: partial.investigation_id ?? null,
    venue_name: partial.venue_name ?? "Untitled Venue",
    location_hint: partial.location_hint ?? null,
    region: partial.region ?? "AU",
    created_at: partial.created_at ?? "2026-05-10T00:00:00Z",
    model: partial.model ?? "perplexity/sonar",
    result_json: partial.result_json ?? `{"findings":[],"suggestions":[],"search_terms_used":[],"citations_raw":[],"model":"test","warnings":[]}`,
  };
}

function noteRow(partial: Partial<BundleFindingNoteRow> & { id: string; dossier_id: string; finding_key: string }): BundleFindingNoteRow {
  return {
    id: partial.id,
    dossier_id: partial.dossier_id,
    finding_key: partial.finding_key,
    text: partial.text ?? "Reviewer text",
    created_at: partial.created_at ?? "2026-05-10T00:00:00Z",
    updated_at: partial.updated_at ?? "2026-05-10T00:00:00Z",
  };
}

beforeEach(() => {
  queryFn.mockReset();
});

describe("loadResearchForBundle — dossier matching", () => {
  it("returns standalone-only rows when investigationIds is empty", async () => {
    const standalone = dossierRow({ id: "d-standalone", investigation_id: null, venue_name: "Old Town Hall" });
    queryFn.mockImplementation((sql: string) => {
      if (sql.includes("FROM research_dossiers")) return Promise.resolve([standalone]);
      return Promise.resolve([]);
    });
    const result = await loadResearchForBundle([], []);
    expect(result.dossiers).toHaveLength(1);
    expect(result.dossiers[0].id).toBe("d-standalone");
    // Verify the standalone-only SQL was used, not the investigation-scope SQL.
    const [calledSql] = queryFn.mock.calls[0] as [string, unknown[]];
    expect(calledSql).toMatch(/WHERE investigation_id IS NULL/);
    expect(calledSql).not.toMatch(/investigation_id IN/);
  });

  it("matches a standalone dossier by venue_name = case title (the OR fix)", async () => {
    const titleMatch = dossierRow({ id: "d-by-title", investigation_id: null, venue_name: "Old Town Hall" });
    queryFn.mockImplementation((sql: string, params: unknown[]) => {
      if (!sql.includes("FROM research_dossiers")) return Promise.resolve([]);
      // The query parameters must include the lowercased title.
      expect(params).toContain("old town hall");
      // The SQL must use OR between the two LOWER(venue_name) IN clauses,
      // not AND (the bug the simplify pass fixed).
      expect(sql).toMatch(/LOWER\(venue_name\) IN[^)]+\)\s+OR\s+LOWER\(venue_name\) IN/);
      expect(sql).not.toMatch(/LOWER\(venue_name\) IN[^)]+\)\s+AND\s+LOWER\(venue_name\) IN/);
      return Promise.resolve([titleMatch]);
    });
    const result = await loadResearchForBundle(["inv-1"], [
      { id: "inv-1", title: "Old Town Hall", location_name: "Sydney NSW" },
    ]);
    expect(result.dossiers).toHaveLength(1);
    expect(result.dossiers[0].id).toBe("d-by-title");
  });

  it("returns empty arrays when research_dossiers table is missing (pre-v4)", async () => {
    queryFn.mockImplementation((sql: string) => {
      if (sql.includes("FROM research_dossiers")) {
        return Promise.reject(new Error("no such table: research_dossiers"));
      }
      return Promise.resolve([]);
    });
    const result = await loadResearchForBundle(["inv-1"], [
      { id: "inv-1", title: "X", location_name: null },
    ]);
    expect(result.dossiers).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  it("returns dossiers but empty notes when research_finding_notes table is missing (pre-v5)", async () => {
    const d = dossierRow({ id: "d1", investigation_id: "inv-1" });
    queryFn.mockImplementation((sql: string) => {
      if (sql.includes("FROM research_dossiers")) return Promise.resolve([d]);
      if (sql.includes("FROM research_finding_notes")) {
        return Promise.reject(new Error("no such table: research_finding_notes"));
      }
      return Promise.resolve([]);
    });
    const result = await loadResearchForBundle(["inv-1"], [
      { id: "inv-1", title: "X", location_name: null },
    ]);
    expect(result.dossiers).toHaveLength(1);
    expect(result.notes).toEqual([]);
  });

  it("joins notes for the loaded dossier ids", async () => {
    const d = dossierRow({ id: "d1", investigation_id: "inv-1" });
    const n = noteRow({ id: "n1", dossier_id: "d1", finding_key: "abc123" });
    queryFn.mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes("FROM research_dossiers")) return Promise.resolve([d]);
      if (sql.includes("FROM research_finding_notes")) {
        expect(params).toContain("d1");
        return Promise.resolve([n]);
      }
      return Promise.resolve([]);
    });
    const result = await loadResearchForBundle(["inv-1"], [
      { id: "inv-1", title: "X", location_name: null },
    ]);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0].finding_key).toBe("abc123");
  });

  it("skips the notes query entirely when there are zero dossiers", async () => {
    queryFn.mockImplementation((sql: string) => {
      if (sql.includes("FROM research_dossiers")) return Promise.resolve([]);
      if (sql.includes("FROM research_finding_notes")) {
        throw new Error("notes query should not be called when dossiers is empty");
      }
      return Promise.resolve([]);
    });
    const result = await loadResearchForBundle(["inv-1"], [
      { id: "inv-1", title: "X", location_name: null },
    ]);
    expect(result.dossiers).toEqual([]);
    expect(result.notes).toEqual([]);
  });
});

describe("buildResearchEntries", () => {
  it("returns no entries when there are no dossiers", () => {
    expect(buildResearchEntries({ dossiers: [], notes: [] })).toEqual([]);
  });

  it("groups case-attached dossiers under research/<investigation_id>/", () => {
    const entries = buildResearchEntries({
      dossiers: [
        dossierRow({ id: "d1", investigation_id: "inv-A" }),
        dossierRow({ id: "d2", investigation_id: "inv-B" }),
      ],
      notes: [],
    });
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("research/inv-A/d1.json");
    expect(paths).toContain("research/inv-B/d2.json");
  });

  it("places standalone dossiers under research/standalone/", () => {
    const entries = buildResearchEntries({
      dossiers: [dossierRow({ id: "recon-1", investigation_id: null })],
      notes: [],
    });
    expect(entries.map((e) => e.path)).toContain("research/standalone/recon-1.json");
  });

  it("emits research/finding_notes.json when notes exist", () => {
    const entries = buildResearchEntries({
      dossiers: [dossierRow({ id: "d1", investigation_id: "inv-A" })],
      notes: [noteRow({ id: "n1", dossier_id: "d1", finding_key: "k1" })],
    });
    expect(entries.map((e) => e.path)).toContain("research/finding_notes.json");
  });

  it("omits research/finding_notes.json when there are no notes", () => {
    const entries = buildResearchEntries({
      dossiers: [dossierRow({ id: "d1", investigation_id: "inv-A" })],
      notes: [],
    });
    expect(entries.map((e) => e.path)).not.toContain("research/finding_notes.json");
  });

  it("pretty-prints valid result_json in the bundle entry", () => {
    const entries = buildResearchEntries({
      dossiers: [dossierRow({
        id: "d1",
        investigation_id: "inv-A",
        result_json: JSON.stringify({ findings: [{ tier: "HERITAGE", title: "x", body: "y", sources: [] }] }),
      })],
      notes: [],
    });
    const data = new TextDecoder().decode(entries[0].data as Uint8Array);
    // Pretty-print uses indentation, single-line raw doesn't.
    expect(data).toContain("\n");
    expect(data).toContain("\"findings\"");
  });

  it("preserves malformed result_json as a raw string instead of crashing", () => {
    const entries = buildResearchEntries({
      dossiers: [dossierRow({
        id: "d1",
        investigation_id: "inv-A",
        result_json: "{not valid json",
      })],
      notes: [],
    });
    const data = new TextDecoder().decode(entries[0].data as Uint8Array);
    // The malformed string should appear escaped inside the wrapping JSON.
    expect(data).toContain("{not valid json");
  });
});

// ---------------------------------------------------------------------------
// Integration: sidecar-based signing flow.
//
// Critical invariants:
//   1. manifest.json is written to the entry list BEFORE the cose_signature.cbor
//      and signing.json entries (the manifest's bytes are what gets signed).
//   2. signing.json holds ed25519_pubkey_hex (sidecar) — NOT manifest.json.
//   3. cose_signature.cbor signs the EXACT bytes that landed in manifest.json,
//      not a re-stringified copy.
// ---------------------------------------------------------------------------

describe("buildExportBundle — sidecar signing flow", () => {
  // Mock SubtleCrypto.digest so we don't need crypto.subtle.digest to land
  // on a real Uint8Array; let real WebCrypto handle it. We DO NOT mock crypto
  // here because Node 20+ provides it natively.

  beforeEach(() => {
    queryFn.mockReset();
    sendTsaRequestFn.mockReset();
    saveBundleSignatureFn.mockReset();
    signBytesFn.mockReset();
    getOrCreateSigningKeyFn.mockReset();
    capturedEntries.current = null;

    // No DB rows for the integration tests — just enough to let buildManifest
    // and buildExportBundle run to completion with empty state.
    queryFn.mockImplementation(() => Promise.resolve([]));

    // Signing key: stable, deterministic pubkey hex so the assertion is concrete.
    getOrCreateSigningKeyFn.mockResolvedValue({
      privateKey: {} as CryptoKey,
      publicKeyHex: "ab".repeat(32), // 64 chars
    });
    // Deterministic 64-byte signature — buildCoseSign1 just relays signBytes' output.
    signBytesFn.mockResolvedValue(new Uint8Array(64).fill(0xee));

    // Offline by default — TSA throws; signing.json should still have a pubkey.
    sendTsaRequestFn.mockRejectedValue(new Error("offline"));

    saveBundleSignatureFn.mockResolvedValue(undefined);
  });

  async function runExport() {
    await buildExportBundle();
    if (!capturedEntries.current) throw new Error("buildZip was not called");
    const byPath = new Map(capturedEntries.current.map((e) => [e.path, e.data]));
    const indexByPath = new Map(capturedEntries.current.map((e, i) => [e.path, i]));
    return { entries: capturedEntries.current, byPath, indexByPath };
  }

  it("writes manifest.json BEFORE cose_signature.cbor and signing.json (order is load-bearing)", async () => {
    const { indexByPath } = await runExport();
    const iManifest = indexByPath.get("manifest.json");
    const iCose = indexByPath.get("cose_signature.cbor");
    const iSigning = indexByPath.get("signing.json");
    expect(iManifest).toBeDefined();
    expect(iCose).toBeDefined();
    expect(iSigning).toBeDefined();
    expect(iManifest!).toBeLessThan(iCose!);
    expect(iManifest!).toBeLessThan(iSigning!);
  });

  it("keeps manifest.json byte-stable (no signing fields embedded)", async () => {
    const { byPath } = await runExport();
    const manifestBytes = byPath.get("manifest.json");
    expect(manifestBytes).toBeDefined();
    const parsed = JSON.parse(new TextDecoder().decode(manifestBytes!));
    // None of the signing fields should leak into manifest.json — that's the
    // whole point of the sidecar fix.
    expect(parsed).not.toHaveProperty("signing");
    expect(parsed).not.toHaveProperty("ed25519_pubkey_hex");
    expect(parsed).not.toHaveProperty("cose_signature");
    expect(parsed).not.toHaveProperty("tsa_status");
    expect(parsed).not.toHaveProperty("bundle_id");
    // Sanity: it still IS a manifest.
    expect(parsed.schema).toMatch(/^southern-signal\.manifest\./);
  });

  it("puts ed25519_pubkey_hex in signing.json, not manifest.json", async () => {
    const { byPath } = await runExport();
    const signing = JSON.parse(new TextDecoder().decode(byPath.get("signing.json")!));
    expect(signing.ed25519_pubkey_hex).toBe("ab".repeat(32));
    expect(signing).toHaveProperty("bundle_id");
    expect(signing).toHaveProperty("built_at");
    expect(signing).toHaveProperty("tsa_status");
  });

  it("signs the EXACT manifest.json bytes (no re-stringification)", async () => {
    const { byPath } = await runExport();
    const manifestBytes = byPath.get("manifest.json")!;
    // signBytes should have been called with the COSE Sig_Structure built
    // over manifestBytes. The Sig_Structure CBOR encoding embeds the payload
    // verbatim, so the manifest bytes must appear as a contiguous substring
    // somewhere in the bytes passed to signBytes.
    expect(signBytesFn).toHaveBeenCalled();
    const sigArg = signBytesFn.mock.calls[0]?.[0] as Uint8Array;
    expect(sigArg).toBeInstanceOf(Uint8Array);
    // Search sigArg for manifestBytes.
    const haystack = Array.from(sigArg);
    const needle = Array.from(manifestBytes);
    let found = false;
    for (let i = 0; i + needle.length <= haystack.length; i++) {
      let ok = true;
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) { ok = false; break; }
      }
      if (ok) { found = true; break; }
    }
    expect(found).toBe(true);
  });

  it("marks tsa_status='pending' in signing.json when the TSA is offline", async () => {
    const { byPath } = await runExport();
    const signing = JSON.parse(new TextDecoder().decode(byPath.get("signing.json")!));
    expect(signing.tsa_status).toBe("pending");
    // No tsa_token.der entry when offline.
    expect(byPath.has("tsa_token.der")).toBe(false);
  });

  it("marks tsa_status='anchored' and emits tsa_token.der when the TSA returns granted", async () => {
    // Granted heuristic: bytes[4]=0x02 length=0x01 value=0x00.
    sendTsaRequestFn.mockResolvedValue(new Uint8Array([0x30, 0x07, 0x30, 0x03, 0x02, 0x01, 0x00, 0x00]));
    const { byPath } = await runExport();
    const signing = JSON.parse(new TextDecoder().decode(byPath.get("signing.json")!));
    expect(signing.tsa_status).toBe("anchored");
    expect(byPath.has("tsa_token.der")).toBe(true);
  });

  it("persists bundle_signatures with the sidecar's ed25519_pubkey_hex", async () => {
    await runExport();
    expect(saveBundleSignatureFn).toHaveBeenCalledTimes(1);
    const row = saveBundleSignatureFn.mock.calls[0]?.[0] as { ed25519_pubkey_hex: string };
    expect(row.ed25519_pubkey_hex).toBe("ab".repeat(32));
  });
});
