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
};

const PREFS_DEFAULT = {
  acknowledgementOfCountry: { statement: "We acknowledge…", acceptedAt: SESSION_START },
};

/** Configure queryFn to dispatch by SQL fragment match. Order-independent. */
function setupQueries(opts: {
  investigation?: Investigation | null;
  increments?: { ts_utc: string; payload_json: string }[];
  events?: { event_type: string; n: number }[];
  media?: { media_type: string; n: number }[];
  debunks?: { payload_json: string }[];
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
