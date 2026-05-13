import { describe, expect, it } from "vitest";
import { verifyManifest } from "./manifestVerifier";
import type { Manifest, ManifestDossierView, ManifestInvestigationView } from "./manifest";

function mkDossier(partial: Partial<ManifestDossierView>): ManifestDossierView {
  return {
    id: "dossier-1",
    investigation_id: "inv-1",
    venue_name: "Old Court House",
    region: "AU",
    created_at: "2026-05-01T00:00:00Z",
    model: "perplexity/sonar",
    finding_count: 3,
    citation_count: 5,
    result_sha256: "a".repeat(64),
    ...partial,
  };
}

function mkInvestigation(partial: Partial<ManifestInvestigationView>): ManifestInvestigationView {
  return {
    id: "inv-1",
    title: "The Old Court",
    location_name: null,
    status: "ended",
    disposition: "inconclusive",
    created_at: "2026-05-01T00:00:00Z",
    started_at: "2026-05-01T20:00:00Z",
    ended_at: "2026-05-01T22:00:00Z",
    audit_chain: { first_seq: 1, last_seq: 50, leaf_count: 50, merkle_root: "root-inv-1" },
    events: { count: 10, types: {} },
    media: [],
    research_dossiers: [],
    ...partial,
  };
}

function mkManifest(partial: Partial<Manifest>): Manifest {
  return {
    schema: "southern-signal.manifest.v3",
    app_version: "0.1.0",
    generated_at: "2026-05-01T22:00:00Z",
    investigations: [],
    global_audit_chain: {
      leaf_count: 0,
      merkle_root: "root-global",
      verification: { ok: true },
      first_seq: 1,
      last_seq: 0,
    },
    standalone_research_dossiers: [],
    reviewer_signoffs: [],
    ...partial,
  };
}

describe("verifyManifest — happy path", () => {
  it("verifies an identical manifest as fully ok", async () => {
    const m = mkManifest({
      investigations: [mkInvestigation({ research_dossiers: [mkDossier({})] })],
    });
    const report = await verifyManifest(m, m);
    expect(report.ok).toBe(true);
    expect(report.globalChain.status).toBe("match");
    expect(report.investigations[0].chainStatus).toBe("match");
    expect(report.investigations[0].dossiers[0].status).toBe("match");
    expect(report.summary).toMatch(/Verified/);
  });

  it("verifies an empty manifest (no investigations, no dossiers) as ok", async () => {
    const m = mkManifest({});
    const report = await verifyManifest(m, m);
    expect(report.ok).toBe(true);
  });
});

describe("verifyManifest — tamper detection", () => {
  it("flags a global audit chain root mismatch", async () => {
    const trusted = mkManifest({});
    const current = mkManifest({
      global_audit_chain: { ...trusted.global_audit_chain, merkle_root: "DIFFERENT" },
    });
    const report = await verifyManifest(trusted, current);
    expect(report.ok).toBe(false);
    expect(report.globalChain.status).toBe("mismatch");
    expect(report.summary).toMatch(/global audit chain root mismatch/);
  });

  it("flags an investigation chain root mismatch", async () => {
    const trusted = mkManifest({
      investigations: [mkInvestigation({})],
    });
    const current = mkManifest({
      investigations: [mkInvestigation({
        audit_chain: { first_seq: 1, last_seq: 50, leaf_count: 50, merkle_root: "DIFFERENT" },
      })],
    });
    const report = await verifyManifest(trusted, current);
    expect(report.ok).toBe(false);
    expect(report.investigations[0].chainStatus).toBe("mismatch");
    expect(report.summary).toMatch(/investigation chain mismatch/);
  });

  it("flags a dossier whose result_sha256 has been altered", async () => {
    const trusted = mkManifest({
      investigations: [mkInvestigation({
        research_dossiers: [mkDossier({ id: "d1", result_sha256: "a".repeat(64) })],
      })],
    });
    const current = mkManifest({
      investigations: [mkInvestigation({
        research_dossiers: [mkDossier({ id: "d1", result_sha256: "b".repeat(64) })],
      })],
    });
    const report = await verifyManifest(trusted, current);
    expect(report.ok).toBe(false);
    expect(report.investigations[0].dossiers[0].status).toBe("hash_mismatch");
    expect(report.summary).toMatch(/dossier hash mismatch/);
  });

  it("flags a dossier deleted since the trusted export", async () => {
    const trusted = mkManifest({
      investigations: [mkInvestigation({
        research_dossiers: [mkDossier({ id: "d1" }), mkDossier({ id: "d2", venue_name: "Other Site" })],
      })],
    });
    const current = mkManifest({
      investigations: [mkInvestigation({
        research_dossiers: [mkDossier({ id: "d1" })],
      })],
    });
    const report = await verifyManifest(trusted, current);
    expect(report.ok).toBe(false);
    const missing = report.investigations[0].dossiers.find((d) => d.id === "d2");
    expect(missing?.status).toBe("missing_in_current");
    expect(report.summary).toMatch(/missing in current/);
  });

  it("flags a dossier added since the trusted export", async () => {
    const trusted = mkManifest({
      investigations: [mkInvestigation({ research_dossiers: [mkDossier({ id: "d1" })] })],
    });
    const current = mkManifest({
      investigations: [mkInvestigation({
        research_dossiers: [
          mkDossier({ id: "d1" }),
          mkDossier({ id: "d2", venue_name: "Newly Added" }),
        ],
      })],
    });
    const report = await verifyManifest(trusted, current);
    expect(report.ok).toBe(false);
    const extra = report.investigations[0].dossiers.find((d) => d.id === "d2");
    expect(extra?.status).toBe("extra_in_current");
    expect(report.summary).toMatch(/added since export/);
  });

  it("flags an investigation in trusted but missing from current", async () => {
    const trusted = mkManifest({
      investigations: [mkInvestigation({ id: "inv-1" }), mkInvestigation({ id: "inv-2", title: "Second" })],
    });
    const current = mkManifest({
      investigations: [mkInvestigation({ id: "inv-1" })],
    });
    const report = await verifyManifest(trusted, current);
    expect(report.ok).toBe(false);
    const inv2 = report.investigations.find((i) => i.id === "inv-2");
    expect(inv2?.chainStatus).toBe("trusted_only");
  });

  it("flags an investigation added since the trusted export", async () => {
    const trusted = mkManifest({
      investigations: [mkInvestigation({ id: "inv-1" })],
    });
    const current = mkManifest({
      investigations: [
        mkInvestigation({ id: "inv-1" }),
        mkInvestigation({ id: "inv-2", title: "Brand new" }),
      ],
    });
    const report = await verifyManifest(trusted, current);
    // An investigation added since export is "current_only" — this is
    // strictly a non-match, so ok=false. Reviewers might want to allow
    // additions, but the verifier's job is to surface drift, not to
    // make policy.
    expect(report.ok).toBe(false);
    const inv2 = report.investigations.find((i) => i.id === "inv-2");
    expect(inv2?.chainStatus).toBe("current_only");
  });
});

describe("verifyManifest — standalone dossier handling", () => {
  it("verifies standalone dossiers when both sides match", async () => {
    const m = mkManifest({
      standalone_research_dossiers: [mkDossier({ investigation_id: null })],
    });
    const report = await verifyManifest(m, m);
    expect(report.ok).toBe(true);
    expect(report.standaloneDossiers[0].status).toBe("match");
  });

  it("flags a tampered standalone dossier", async () => {
    const trusted = mkManifest({
      standalone_research_dossiers: [mkDossier({ id: "s1", investigation_id: null, result_sha256: "a".repeat(64) })],
    });
    const current = mkManifest({
      standalone_research_dossiers: [mkDossier({ id: "s1", investigation_id: null, result_sha256: "c".repeat(64) })],
    });
    const report = await verifyManifest(trusted, current);
    expect(report.ok).toBe(false);
    expect(report.standaloneDossiers[0].status).toBe("hash_mismatch");
  });
});

describe("verifyManifest — schema v1 backwards compatibility", () => {
  it("accepts a v1 manifest (no dossier arrays) and verifies cleanly when current has no dossiers either", async () => {
    // Cast through unknown because v1 InvestigationView didn't have research_dossiers.
    // The verifier tolerates absence — see asDossierList().
    const trusted = {
      schema: "southern-signal.manifest.v1" as const,
      app_version: "0.1.0",
      generated_at: "2026-04-01T00:00:00Z",
      investigations: [{
        id: "inv-1",
        title: "Old case",
        location_name: null,
        status: "ended",
        disposition: null,
        created_at: "2026-04-01T00:00:00Z",
        started_at: null,
        ended_at: null,
        audit_chain: { first_seq: 1, last_seq: 5, leaf_count: 5, merkle_root: "root-x" },
        events: { count: 0, types: {} },
        media: [],
      }],
      global_audit_chain: {
        leaf_count: 5,
        merkle_root: "root-global-v1",
        verification: { ok: true as const },
        first_seq: 1,
        last_seq: 5,
      },
    } as unknown as Manifest;
    const current = mkManifest({
      investigations: [mkInvestigation({
        id: "inv-1", title: "Old case",
        audit_chain: { first_seq: 1, last_seq: 5, leaf_count: 5, merkle_root: "root-x" },
        events: { count: 0, types: {} },
        research_dossiers: [],
      })],
      global_audit_chain: {
        leaf_count: 5,
        merkle_root: "root-global-v1",
        verification: { ok: true },
        first_seq: 1,
        last_seq: 5,
      },
    });
    const report = await verifyManifest(trusted, current);
    expect(report.ok).toBe(true);
    expect(report.trustedSchema).toBe("southern-signal.manifest.v1");
  });
});
