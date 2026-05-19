import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock the database + audit-chain verifier. buildManifest() reads every table
// through query() and walks the chain via verifyAuditChain(), so we stub both.
// ---------------------------------------------------------------------------

const { queryFn, verifyFn } = vi.hoisted(() => ({
  queryFn: vi.fn(),
  verifyFn: vi.fn(),
}));

vi.mock("../db/db", () => ({ query: queryFn, exec: vi.fn() }));
vi.mock("../db/auditLog", () => ({ verifyAuditChain: verifyFn }));

import { buildManifest, type Manifest } from "./manifest";
import { canonicalJson, sha256Hex } from "./canonicalJson";

interface MockedQuery {
  investigations?: unknown[];
  audit_log?: unknown[];
  evidence_events?: unknown[];
  media_assets?: unknown[];
  research_dossiers?: unknown[];
  reviewer_signoffs?: unknown[];
  /** Throws when set — simulates pre-v* installs missing the table. */
  research_dossiersThrow?: boolean;
  reviewer_signoffsThrow?: boolean;
}

function setupQueries(m: MockedQuery) {
  queryFn.mockImplementation((sql: string) => {
    if (sql.includes("FROM investigations")) return Promise.resolve(m.investigations ?? []);
    if (sql.includes("FROM audit_log")) return Promise.resolve(m.audit_log ?? []);
    if (sql.includes("FROM evidence_events")) return Promise.resolve(m.evidence_events ?? []);
    if (sql.includes("FROM media_assets")) return Promise.resolve(m.media_assets ?? []);
    if (sql.includes("FROM research_dossiers")) {
      if (m.research_dossiersThrow) return Promise.reject(new Error("no such table: research_dossiers"));
      return Promise.resolve(m.research_dossiers ?? []);
    }
    if (sql.includes("FROM reviewer_signoffs")) {
      if (m.reviewer_signoffsThrow) return Promise.reject(new Error("no such table: reviewer_signoffs"));
      return Promise.resolve(m.reviewer_signoffs ?? []);
    }
    return Promise.resolve([]);
  });
}

beforeEach(() => {
  queryFn.mockReset();
  verifyFn.mockReset();
  verifyFn.mockResolvedValue({ ok: true });
});

describe("buildManifest — required fields", () => {
  it("returns the v3 schema label, app_version, and an ISO generated_at", async () => {
    setupQueries({});
    const m = await buildManifest();
    expect(m.schema).toBe("southern-signal.manifest.v3");
    expect(m.app_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(m.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("includes investigations, global_audit_chain, standalone_research_dossiers, reviewer_signoffs at the top level", async () => {
    setupQueries({});
    const m = await buildManifest();
    expect(m).toHaveProperty("investigations");
    expect(m).toHaveProperty("global_audit_chain");
    expect(m).toHaveProperty("standalone_research_dossiers");
    expect(m).toHaveProperty("reviewer_signoffs");
  });

  it("emits an empty manifest cleanly when all tables are empty", async () => {
    setupQueries({});
    const m = await buildManifest();
    expect(m.investigations).toEqual([]);
    expect(m.standalone_research_dossiers).toEqual([]);
    expect(m.reviewer_signoffs).toEqual([]);
    expect(m.global_audit_chain.leaf_count).toBe(0);
    expect(m.global_audit_chain.merkle_root).toBeNull();
    expect(m.global_audit_chain.first_seq).toBeNull();
    expect(m.global_audit_chain.last_seq).toBeNull();
  });
});

describe("buildManifest — global_audit_chain summary", () => {
  it("summarises the chain length, first/last seq and embeds the verifier result", async () => {
    const auditEntries = [1, 2, 3].map((seq) => ({
      seq,
      ts_utc: `2026-05-19T0${seq}:00:00Z`,
      actor: "test",
      kind: "x",
      payload_json: "{}",
      prev_hash: "00".repeat(32),
      entry_hash: `${seq}`.padStart(64, "a"), // 64-char placeholders
    }));
    setupQueries({ audit_log: auditEntries });
    verifyFn.mockResolvedValue({ ok: true });

    const m = await buildManifest();
    expect(m.global_audit_chain.leaf_count).toBe(3);
    expect(m.global_audit_chain.first_seq).toBe(1);
    expect(m.global_audit_chain.last_seq).toBe(3);
    expect(m.global_audit_chain.merkle_root).toMatch(/^[0-9a-f]{64}$/);
    expect(m.global_audit_chain.verification).toEqual({ ok: true });
  });

  it("passes through a broken-chain verification verdict unchanged", async () => {
    setupQueries({});
    verifyFn.mockResolvedValue({ ok: false, brokenAtSeq: 7, reason: "entry_hash mismatch" });
    const m = await buildManifest();
    expect(m.global_audit_chain.verification).toEqual({
      ok: false,
      brokenAtSeq: 7,
      reason: "entry_hash mismatch",
    });
  });
});

describe("buildManifest — investigation views", () => {
  it("emits one ManifestInvestigationView per row with the required fields", async () => {
    setupQueries({
      investigations: [{
        id: "inv-1",
        title: "Old Town Hall",
        location_name: "Sydney NSW",
        status: "active",
        disposition: null,
        created_at: "2026-05-10T00:00:00Z",
        started_at: null,
        ended_at: null,
      }],
    });
    const m = await buildManifest();
    expect(m.investigations).toHaveLength(1);
    const inv = m.investigations[0];
    expect(inv.id).toBe("inv-1");
    expect(inv.title).toBe("Old Town Hall");
    expect(inv.location_name).toBe("Sydney NSW");
    expect(inv.events).toEqual({ count: 0, types: {} });
    expect(inv.media).toEqual([]);
    expect(inv.research_dossiers).toEqual([]);
    expect(inv.audit_chain).toEqual({ first_seq: null, last_seq: null, leaf_count: 0, merkle_root: null });
  });

  it("counts evidence events by event_type", async () => {
    setupQueries({
      investigations: [{ id: "inv-1", title: "X", location_name: null, status: "active", disposition: null, created_at: "2026-05-10T00:00:00Z", started_at: null, ended_at: null }],
      evidence_events: [
        { id: "e1", investigation_id: "inv-1", timestamp: "...", source: "manual", event_type: "marker" },
        { id: "e2", investigation_id: "inv-1", timestamp: "...", source: "manual", event_type: "marker" },
        { id: "e3", investigation_id: "inv-1", timestamp: "...", source: "auto", event_type: "session_start" },
      ],
    });
    const m = await buildManifest();
    expect(m.investigations[0].events.count).toBe(3);
    expect(m.investigations[0].events.types).toEqual({ marker: 2, session_start: 1 });
  });

  it("maps media rows to {id, media_type, file_path, sha256}", async () => {
    setupQueries({
      investigations: [{ id: "inv-1", title: "X", location_name: null, status: "active", disposition: null, created_at: "2026-05-10T00:00:00Z", started_at: null, ended_at: null }],
      media_assets: [{
        id: "m1",
        investigation_id: "inv-1",
        media_type: "audio/wav",
        file_path: "media/inv-1/m1.wav",
        timestamp_start: "...",
        timestamp_end: null,
        checksum_sha256: "deadbeef".padEnd(64, "0"),
      }],
    });
    const m = await buildManifest();
    expect(m.investigations[0].media).toHaveLength(1);
    expect(m.investigations[0].media[0]).toEqual({
      id: "m1",
      media_type: "audio/wav",
      file_path: "media/inv-1/m1.wav",
      sha256: "deadbeef".padEnd(64, "0"),
    });
  });
});

describe("buildManifest — research dossier anchoring", () => {
  it("emits standalone dossiers under standalone_research_dossiers with a result_sha256 hash", async () => {
    const dossier = {
      id: "d-recon-1",
      investigation_id: null,
      venue_name: "Cox St Bridge",
      region: "NSW",
      created_at: "2026-05-10T00:00:00Z",
      model: "perplexity/sonar",
      result_json: '{"findings":[{"title":"a","sources":[1,2,3]},{"title":"b","sources":[]}]}',
    };
    setupQueries({ research_dossiers: [dossier] });
    const m = await buildManifest();
    expect(m.standalone_research_dossiers).toHaveLength(1);
    const view = m.standalone_research_dossiers[0];
    expect(view.id).toBe("d-recon-1");
    expect(view.investigation_id).toBeNull();
    expect(view.finding_count).toBe(2);
    expect(view.citation_count).toBe(3);
    // result_sha256 must match the raw result_json bytes — same hash a
    // reviewer can reproduce off the on-device row.
    expect(view.result_sha256).toBe(await sha256Hex(dossier.result_json));
  });

  it("groups case-attached dossiers into the investigation view", async () => {
    setupQueries({
      investigations: [{ id: "inv-A", title: "X", location_name: null, status: "active", disposition: null, created_at: "2026-05-10T00:00:00Z", started_at: null, ended_at: null }],
      research_dossiers: [{
        id: "d-1",
        investigation_id: "inv-A",
        venue_name: "X",
        region: "NSW",
        created_at: "2026-05-10T00:00:00Z",
        model: "perplexity/sonar",
        result_json: "{}",
      }],
    });
    const m = await buildManifest();
    expect(m.investigations[0].research_dossiers).toHaveLength(1);
    expect(m.investigations[0].research_dossiers[0].id).toBe("d-1");
    // No standalone entry for case-attached dossiers.
    expect(m.standalone_research_dossiers).toEqual([]);
  });

  it("treats malformed result_json as zero counts but still emits a hash entry", async () => {
    const dossier = {
      id: "d-bad",
      investigation_id: null,
      venue_name: "X",
      region: "NSW",
      created_at: "2026-05-10T00:00:00Z",
      model: "perplexity/sonar",
      result_json: "{not valid json",
    };
    setupQueries({ research_dossiers: [dossier] });
    const m = await buildManifest();
    expect(m.standalone_research_dossiers[0].finding_count).toBe(0);
    expect(m.standalone_research_dossiers[0].citation_count).toBe(0);
    expect(m.standalone_research_dossiers[0].result_sha256).toBe(await sha256Hex(dossier.result_json));
  });

  it("survives a pre-v4 schema where research_dossiers doesn't exist", async () => {
    setupQueries({ research_dossiersThrow: true });
    const m = await buildManifest();
    expect(m.standalone_research_dossiers).toEqual([]);
  });
});

describe("buildManifest — reviewer signoff anchoring", () => {
  it("emits each reviewer with a statement_sha256 over the raw statement bytes", async () => {
    const signoff = {
      id: "r-1",
      reviewer_name: "Dr Foo",
      affiliation: "Some Uni",
      identifier: "ORCID:0000-0001",
      discipline: "bayesian",
      signed_at: "2026-05-19T00:00:00Z",
      app_version: "0.1.0",
      statement: "I have reviewed the methodology.",
      source_url: "https://example.org",
      created_at: "2026-05-19T00:00:00Z",
      updated_at: "2026-05-19T00:00:00Z",
    };
    setupQueries({ reviewer_signoffs: [signoff] });
    const m = await buildManifest();
    expect(m.reviewer_signoffs).toHaveLength(1);
    expect(m.reviewer_signoffs[0].statement_sha256).toBe(await sha256Hex(signoff.statement));
    expect(m.reviewer_signoffs[0].reviewer_name).toBe("Dr Foo");
    expect(m.reviewer_signoffs[0].discipline).toBe("bayesian");
  });

  it("survives a pre-v6 schema where reviewer_signoffs doesn't exist", async () => {
    setupQueries({ reviewer_signoffsThrow: true });
    const m = await buildManifest();
    expect(m.reviewer_signoffs).toEqual([]);
  });
});

describe("buildManifest — determinism / byte stability", () => {
  // The manifest is the document the COSE_Sign1 envelope wraps. Even a
  // single-byte drift between two builds on the same inputs would break
  // signature verification. canonicalJson is the contract.
  const sample = {
    investigations: [{ id: "inv-1", title: "T", location_name: null, status: "active", disposition: null, created_at: "2026-05-10T00:00:00Z", started_at: null, ended_at: null }],
    media_assets: [{ id: "m1", investigation_id: "inv-1", media_type: "audio/wav", file_path: "media/inv-1/m1.wav", timestamp_start: "...", timestamp_end: null, checksum_sha256: null }],
    research_dossiers: [{ id: "d1", investigation_id: "inv-1", venue_name: "x", region: "NSW", created_at: "...", model: "perplexity/sonar", result_json: "{}" }],
  };

  it("produces byte-identical canonical-JSON output across two builds (ignoring generated_at)", async () => {
    setupQueries(sample);
    const a = await buildManifest();
    setupQueries(sample);
    const b = await buildManifest();
    // generated_at is "new Date().toISOString()" — strip before comparison.
    const stripGenerated = (m: Manifest) => ({ ...m, generated_at: "<stripped>" });
    expect(canonicalJson(stripGenerated(a))).toBe(canonicalJson(stripGenerated(b)));
  });

  it("the manifest object survives JSON.stringify + JSON.parse round-trip (no NaN/undefined)", async () => {
    setupQueries(sample);
    const m = await buildManifest();
    const round = JSON.parse(JSON.stringify(m));
    expect(round).toEqual(m);
  });
});
