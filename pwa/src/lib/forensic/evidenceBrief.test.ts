import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Investigation } from "../db/schema";

const { queryFn, verifyChainFn, manifestFn, prefsFn } = vi.hoisted(() => ({
  queryFn: vi.fn(),
  verifyChainFn: vi.fn(),
  manifestFn: vi.fn(),
  prefsFn: vi.fn(),
}));

vi.mock("../db/db", () => ({ query: queryFn, exec: vi.fn() }));
vi.mock("../db/auditLog", () => ({ verifyAuditChain: verifyChainFn }));
vi.mock("./manifest", () => ({ buildManifest: manifestFn }));
vi.mock("../preferences", () => ({ getPreferences: prefsFn }));

import { buildEvidenceBrief, findMostRecentInvestigationId } from "./evidenceBrief";

const SESSION_START = "2026-05-10T20:00:00.000Z";
const SESSION_END = "2026-05-10T21:00:00.000Z";

const FIXTURE_INV: Investigation = {
  id: "case-1",
  title: "Old Town Hall",
  location_name: "Wurundjeri Country, Vic",
  notes: null,
  created_at: SESSION_START,
  started_at: SESSION_START,
  ended_at: SESSION_END,
  status: "ended",
  disposition: "flagged",
  source: "pwa",
  culturally_sensitive: 0,
  protocol_json: null,
  protocol_hash: null,
  session_type: "active",
  paired_investigation_id: null,
  to_consent_path: null,
  commercial_use_approved: 0,
};

const PREFS_DEFAULT = {
  acknowledgementOfCountry: { statement: "We acknowledge…", acceptedAt: SESSION_START },
};

interface DossierRowFixture {
  id: string;
  investigation_id: string | null;
  venue_name: string;
  location_hint: string | null;
  region: string;
  created_at: string;
  model: string;
  result_json: string;
}

interface FindingNoteFixture {
  id: string;
  dossier_id: string;
  finding_key: string;
  text: string;
  created_at: string;
  updated_at: string;
}

/** Configure queryFn to dispatch by SQL fragment match. Order-independent. */
function setupQueries(opts: {
  investigation?: Investigation | null;
  increments?: { ts_utc: string; payload_json: string }[];
  events?: { event_type: string; n: number }[];
  media?: { media_type: string; n: number }[];
  debunks?: { payload_json: string }[];
  dossiers?: DossierRowFixture[];
  notes?: FindingNoteFixture[];
}) {
  queryFn.mockImplementation((sql: string, _params: unknown[] = []) => {
    if (sql.includes("FROM investigations")) {
      return Promise.resolve(opts.investigation ? [opts.investigation] : []);
    }
    if (sql.includes("FROM audit_log") && sql.includes("evidence.%")) {
      return Promise.resolve(opts.increments ?? []);
    }
    if (sql.includes("FROM evidence_events")) {
      return Promise.resolve(opts.events ?? []);
    }
    if (sql.includes("FROM media_assets")) {
      return Promise.resolve(opts.media ?? []);
    }
    if (sql.includes("FROM audit_log") && sql.includes("ai.debunk.proposed")) {
      return Promise.resolve(opts.debunks ?? []);
    }
    if (sql.includes("FROM research_dossiers")) {
      return Promise.resolve(opts.dossiers ?? []);
    }
    if (sql.includes("FROM research_finding_notes")) {
      return Promise.resolve(opts.notes ?? []);
    }
    return Promise.resolve([]);
  });
}

beforeEach(() => {
  queryFn.mockReset();
  verifyChainFn.mockReset().mockResolvedValue({ ok: true });
  manifestFn.mockReset().mockResolvedValue({ global_audit_chain: { merkle_root: "abc123def456" } });
  prefsFn.mockReset().mockReturnValue(PREFS_DEFAULT);
});

describe("buildEvidenceBrief", () => {
  it("returns null when the investigation does not exist", async () => {
    setupQueries({ investigation: null });
    const result = await buildEvidenceBrief("missing-id");
    expect(result).toBeNull();
  });

  it("populates basic case metadata + duration", async () => {
    setupQueries({ investigation: FIXTURE_INV });
    const r = await buildEvidenceBrief("case-1");
    expect(r).not.toBeNull();
    expect(r!.investigation.title).toBe("Old Town Hall");
    expect(r!.durationSeconds).toBeCloseTo(3600, 1); // 1 hour
    expect(r!.acknowledgementStatement).toBe("We acknowledge…");
  });

  it("computes peak posterior as max of posterior_after across increments", async () => {
    const increments = [
      { ts_utc: "2026-05-10T20:05:00.000Z", payload_json: JSON.stringify({ channel: "acoustic", log_lr: 1.0, posterior_before: 0.05, posterior_after: 0.13, reason: "tap", metadata: {} }) },
      { ts_utc: "2026-05-10T20:10:00.000Z", payload_json: JSON.stringify({ channel: "magnetometer", log_lr: 2.6, posterior_before: 0.13, posterior_after: 0.71, reason: "spike", metadata: {} }) },
      { ts_utc: "2026-05-10T20:15:00.000Z", payload_json: JSON.stringify({ channel: "acoustic", log_lr: -0.5, posterior_before: 0.71, posterior_after: 0.62, reason: "decay", metadata: {} }) },
    ];
    setupQueries({ investigation: FIXTURE_INV, increments });
    const r = await buildEvidenceBrief("case-1");
    expect(r!.peakPosterior).toBeCloseTo(0.71, 6);
    expect(r!.finalPosterior).toBeCloseTo(0.62, 6);
    expect(r!.totalIncrements).toBe(3);
  });

  it("returns top 5 moments sorted by absolute log_lr", async () => {
    const increments = [
      { ts_utc: "t1", payload_json: JSON.stringify({ channel: "acoustic", log_lr: 0.5, posterior_before: 0, posterior_after: 0.1, reason: "a", metadata: {} }) },
      { ts_utc: "t2", payload_json: JSON.stringify({ channel: "acoustic", log_lr: 3.5, posterior_before: 0.1, posterior_after: 0.5, reason: "b", metadata: {} }) },
      { ts_utc: "t3", payload_json: JSON.stringify({ channel: "magnetometer", log_lr: -3.0, posterior_before: 0.5, posterior_after: 0.3, reason: "c", metadata: {} }) },
      { ts_utc: "t4", payload_json: JSON.stringify({ channel: "infrasound", log_lr: 1.7, posterior_before: 0.3, posterior_after: 0.4, reason: "d", metadata: {} }) },
      { ts_utc: "t5", payload_json: JSON.stringify({ channel: "acoustic", log_lr: 0.1, posterior_before: 0.4, posterior_after: 0.41, reason: "e", metadata: {} }) },
      { ts_utc: "t6", payload_json: JSON.stringify({ channel: "acoustic", log_lr: 2.0, posterior_before: 0.41, posterior_after: 0.65, reason: "f", metadata: {} }) },
      { ts_utc: "t7", payload_json: JSON.stringify({ channel: "acoustic", log_lr: 0.2, posterior_before: 0.65, posterior_after: 0.66, reason: "g", metadata: {} }) },
    ];
    setupQueries({ investigation: FIXTURE_INV, increments });
    const r = await buildEvidenceBrief("case-1");
    expect(r!.topMoments).toHaveLength(5);
    expect(r!.topMoments.map((m) => m.logLr)).toEqual([3.5, -3.0, 2.0, 1.7, 0.5]);
    expect(r!.topMoments[0].reason).toBe("b");
  });

  it("tallies contamination / marker / observation events", async () => {
    setupQueries({
      investigation: FIXTURE_INV,
      events: [
        { event_type: "contamination", n: 3 },
        { event_type: "marker", n: 7 },
        { event_type: "observation", n: 2 },
      ],
    });
    const r = await buildEvidenceBrief("case-1");
    expect(r!.contaminationCount).toBe(3);
    expect(r!.markerCount).toBe(7);
    expect(r!.observationCount).toBe(2);
  });

  it("populates mediaByType with zero defaults for missing rows", async () => {
    setupQueries({
      investigation: FIXTURE_INV,
      media: [{ media_type: "audio", n: 5 }],
    });
    const r = await buildEvidenceBrief("case-1");
    expect(r!.mediaByType).toEqual({ audio: 5, image: 0, video: 0 });
  });

  it("falls back to default H₀ when there are no debunk entries", async () => {
    setupQueries({ investigation: FIXTURE_INV, debunks: [] });
    const r = await buildEvidenceBrief("case-1");
    expect(r!.h0FromData).toBe(false);
    expect(r!.h0Confidence).toBeCloseTo(0.18, 6);
    expect(r!.h0SampleCount).toBe(0);
  });

  it("computes H₀ from real debunk entries' max_plausibility", async () => {
    setupQueries({
      investigation: FIXTURE_INV,
      debunks: [
        { payload_json: JSON.stringify({ max_plausibility: 0.9 }) },
        { payload_json: JSON.stringify({ max_plausibility: 0.7 }) },
        { payload_json: JSON.stringify({ max_plausibility: 0.5 }) },
      ],
    });
    const r = await buildEvidenceBrief("case-1");
    // insufficiencies 0.1 / 0.3 / 0.5 → mean 0.3
    expect(r!.h0Confidence).toBeCloseTo(0.3, 6);
    expect(r!.h0FromData).toBe(true);
    expect(r!.h0SampleCount).toBe(3);
  });

  it("yields UNEXPLAINED verdict when peak crosses flag and H₀ is low", async () => {
    setupQueries({
      investigation: FIXTURE_INV,
      increments: [
        { ts_utc: "t1", payload_json: JSON.stringify({ channel: "acoustic", log_lr: 4.0, posterior_before: 0.05, posterior_after: 0.97, reason: "x", metadata: {} }) },
      ],
      debunks: [{ payload_json: JSON.stringify({ max_plausibility: 0.95 }) }],
    });
    const r = await buildEvidenceBrief("case-1");
    expect(r!.ahtVerdict.verdict).toBe("unexplained");
  });

  it("yields SUSPENDED verdict when H₀ is high, even at flag-level posterior", async () => {
    setupQueries({
      investigation: FIXTURE_INV,
      increments: [
        { ts_utc: "t1", payload_json: JSON.stringify({ channel: "acoustic", log_lr: 4.0, posterior_before: 0.05, posterior_after: 0.97, reason: "x", metadata: {} }) },
      ],
      debunks: [
        { payload_json: JSON.stringify({ max_plausibility: 0.1 }) },
        { payload_json: JSON.stringify({ max_plausibility: 0.2 }) },
      ],
    });
    const r = await buildEvidenceBrief("case-1");
    // insufficiencies 0.9 + 0.8 → mean 0.85, well above the 0.4 suspend threshold
    expect(r!.h0Confidence).toBeCloseTo(0.85, 6);
    expect(r!.ahtVerdict.verdict).toBe("suspended");
  });

  it("yields NULL verdict for a quiet session with healthy H₀", async () => {
    setupQueries({
      investigation: { ...FIXTURE_INV, disposition: "null" },
      increments: [],
      debunks: [{ payload_json: JSON.stringify({ max_plausibility: 0.9 }) }],
    });
    const r = await buildEvidenceBrief("case-1");
    expect(r!.ahtVerdict.verdict).toBe("null");
  });

  it("flags culturally_sensitive when the row carries the flag", async () => {
    setupQueries({ investigation: { ...FIXTURE_INV, culturally_sensitive: 1 } });
    const r = await buildEvidenceBrief("case-1");
    expect(r!.culturallySensitive).toBe(true);
  });

  it("propagates a broken-chain status to the brief", async () => {
    verifyChainFn.mockResolvedValue({ ok: false, brokenAtSeq: 42, reason: "entry_hash mismatch" });
    setupQueries({ investigation: FIXTURE_INV });
    const r = await buildEvidenceBrief("case-1");
    expect(r!.chainStatus).toEqual({ ok: false, brokenAtSeq: 42, reason: "entry_hash mismatch" });
  });

  it("survives a manifest build failure with merkleRoot=null", async () => {
    manifestFn.mockRejectedValue(new Error("manifest build failed"));
    setupQueries({ investigation: FIXTURE_INV });
    const r = await buildEvidenceBrief("case-1");
    expect(r!.merkleRoot).toBeNull();
    // brief still assembled
    expect(r!.investigation.id).toBe("case-1");
  });
});

describe("buildEvidenceBrief — research dossiers", () => {
  /**
   * Compute the same finding_key the production code does so we can
   * line up note fixtures with finding fixtures without depending on
   * the repo module (which would pull in the DB layer at test time).
   */
  async function findingKey(tier: string, title: string, body: string): Promise<string> {
    const data = new TextEncoder().encode(`${tier}|${title}|${body}`);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
  }

  function mkDossier(partial: Partial<DossierRowFixture> & { findings: { tier: string; title: string; body: string; sources?: { label: string; url: string }[] }[] }): DossierRowFixture {
    const result = {
      findings: partial.findings.map((f) => ({ tier: f.tier, title: f.title, body: f.body, sources: f.sources ?? [] })),
      suggestions: [],
      search_terms_used: [],
      citations_raw: [],
      model: "test/mock",
      warnings: [],
    };
    return {
      id: partial.id ?? "d1",
      investigation_id: partial.investigation_id ?? FIXTURE_INV.id,
      venue_name: partial.venue_name ?? "Old Town Hall",
      location_hint: partial.location_hint ?? null,
      region: partial.region ?? "AU",
      created_at: partial.created_at ?? SESSION_START,
      model: partial.model ?? "perplexity/sonar",
      result_json: JSON.stringify(result),
    };
  }

  it("returns an empty dossier array when no rows exist", async () => {
    setupQueries({ investigation: FIXTURE_INV });
    const r = await buildEvidenceBrief("case-1");
    expect(r!.researchDossiers).toEqual([]);
  });

  it("renders one dossier with tier-grouped findings and citation count", async () => {
    setupQueries({
      investigation: FIXTURE_INV,
      dossiers: [mkDossier({
        findings: [
          { tier: "HERITAGE", title: "Built 1894", body: "Foundation date.", sources: [{ label: "NSW Heritage", url: "https://heritage.nsw" }] },
          { tier: "DOCUMENTED_INCIDENT", title: "Fire 1953", body: "Court records.", sources: [{ label: "AustLII", url: "https://austlii" }, { label: "SMH", url: "https://smh" }] },
          { tier: "FOLKLORE", title: "Ghost story", body: "Tour anecdote.", sources: [] },
        ],
      })],
    });
    const r = await buildEvidenceBrief("case-1");
    expect(r!.researchDossiers).toHaveLength(1);
    const d = r!.researchDossiers[0];
    expect(d.findingCount).toBe(3);
    expect(d.citationCount).toBe(3);
    expect(d.hasPrimarySources).toBe(true);
    // Tier order: CULTURAL_SIGNIFICANCE → HERITAGE → DOCUMENTED_INCIDENT → FOLKLORE → SYNTHESIS
    expect(d.findingsByTier.map((g) => g.tier)).toEqual(["HERITAGE", "DOCUMENTED_INCIDENT", "FOLKLORE"]);
  });

  it("flags hasPrimarySources=false when all findings are folklore / synthesis", async () => {
    setupQueries({
      investigation: FIXTURE_INV,
      dossiers: [mkDossier({
        findings: [
          { tier: "FOLKLORE", title: "Local legend", body: "Said to be haunted." },
          { tier: "SYNTHESIS", title: "Possibly Victorian-era", body: "Inferred from photos." },
        ],
      })],
    });
    const r = await buildEvidenceBrief("case-1");
    expect(r!.researchDossiers[0].hasPrimarySources).toBe(false);
  });

  it("attaches reviewer notes via content-anchored finding_key", async () => {
    const notedFinding = { tier: "HERITAGE", title: "Built 1894", body: "Foundation date." };
    const key = await findingKey(notedFinding.tier, notedFinding.title, notedFinding.body);
    setupQueries({
      investigation: FIXTURE_INV,
      dossiers: [mkDossier({ id: "d1", findings: [notedFinding] })],
      notes: [{
        id: "n1",
        dossier_id: "d1",
        finding_key: key,
        text: "Verified via Trove 2026-05-08.",
        created_at: SESSION_START,
        updated_at: SESSION_START,
      }],
    });
    const r = await buildEvidenceBrief("case-1");
    const finding = r!.researchDossiers[0].findingsByTier[0].findings[0];
    expect(finding.findingKey).toBe(key);
    expect(finding.reviewerNote?.text).toBe("Verified via Trove 2026-05-08.");
    expect(r!.researchDossiers[0].reviewerNoteCount).toBe(1);
  });

  it("leaves reviewerNote=null when finding_key doesn't match any note row", async () => {
    setupQueries({
      investigation: FIXTURE_INV,
      dossiers: [mkDossier({ id: "d1", findings: [{ tier: "HERITAGE", title: "T1", body: "B1" }] })],
      notes: [{
        id: "n1",
        dossier_id: "d1",
        finding_key: "deadbeefdeadbeefdeadbeef", // intentionally wrong key
        text: "Orphan note.",
        created_at: SESSION_START,
        updated_at: SESSION_START,
      }],
    });
    const r = await buildEvidenceBrief("case-1");
    expect(r!.researchDossiers[0].findingsByTier[0].findings[0].reviewerNote).toBeNull();
    expect(r!.researchDossiers[0].reviewerNoteCount).toBe(0);
  });

  it("preserves the raw ResearchResult for callers needing suggestions / warnings", async () => {
    const dossier = mkDossier({ findings: [{ tier: "HERITAGE", title: "x", body: "y" }] });
    // Override result_json with suggestions+warnings.
    const raw = JSON.parse(dossier.result_json);
    raw.suggestions = ["Try Trove from 1894-1920"];
    raw.warnings = ["citation A had no scheme"];
    dossier.result_json = JSON.stringify(raw);
    setupQueries({ investigation: FIXTURE_INV, dossiers: [dossier] });
    const r = await buildEvidenceBrief("case-1");
    expect(r!.researchDossiers[0].raw.suggestions).toEqual(["Try Trove from 1894-1920"]);
    expect(r!.researchDossiers[0].raw.warnings).toEqual(["citation A had no scheme"]);
  });

  it("skips dossiers with malformed result_json instead of crashing the brief", async () => {
    const ok = mkDossier({ id: "ok", findings: [{ tier: "HERITAGE", title: "x", body: "y" }] });
    const bad: DossierRowFixture = {
      id: "bad",
      investigation_id: FIXTURE_INV.id,
      venue_name: "Bad row",
      location_hint: null,
      region: "AU",
      created_at: SESSION_START,
      model: "test/mock",
      result_json: "{not valid json",
    };
    setupQueries({ investigation: FIXTURE_INV, dossiers: [ok, bad] });
    const r = await buildEvidenceBrief("case-1");
    // Only the ok dossier should render.
    expect(r!.researchDossiers).toHaveLength(1);
    expect(r!.researchDossiers[0].id).toBe("ok");
  });

  it("counts citations across all findings, not just primary-source tiers", async () => {
    setupQueries({
      investigation: FIXTURE_INV,
      dossiers: [mkDossier({
        findings: [
          { tier: "HERITAGE", title: "A", body: "x", sources: [{ label: "s1", url: "https://a" }] },
          { tier: "FOLKLORE", title: "B", body: "y", sources: [{ label: "s2", url: "https://b" }, { label: "s3", url: "https://c" }] },
        ],
      })],
    });
    const r = await buildEvidenceBrief("case-1");
    expect(r!.researchDossiers[0].citationCount).toBe(3);
  });
});

describe("findMostRecentInvestigationId", () => {
  it("returns the id from the first row", async () => {
    queryFn.mockResolvedValue([{ id: "case-recent" }]);
    expect(await findMostRecentInvestigationId()).toBe("case-recent");
  });

  it("returns null when there are no investigations", async () => {
    queryFn.mockResolvedValue([]);
    expect(await findMostRecentInvestigationId()).toBeNull();
  });
});
