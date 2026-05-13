import { describe, expect, it } from "vitest";
import { computeReadiness, type ReadinessInput } from "./preAirReadiness";
import type { ReviewerDiscipline, ReviewerSignoffRow } from "../db/schema";

function row(partial: Partial<ReviewerSignoffRow> & { discipline: ReviewerDiscipline }): ReviewerSignoffRow {
  return {
    id: partial.id ?? `id-${Math.random()}`,
    reviewer_name: partial.reviewer_name ?? "Reviewer X",
    affiliation: partial.affiliation ?? null,
    identifier: partial.identifier ?? null,
    discipline: partial.discipline,
    signed_at: partial.signed_at ?? "2026-05-01",
    app_version: partial.app_version ?? "0.1.0",
    statement: partial.statement ?? "ok",
    source_url: partial.source_url ?? null,
    created_at: partial.created_at ?? "2026-05-01T00:00:00Z",
    updated_at: partial.updated_at ?? "2026-05-01T00:00:00Z",
  };
}

function mkInput(partial: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    aocAccepted: partial.aocAccepted ?? true,
    appVersion: partial.appVersion ?? "0.1.0",
    signoffs: partial.signoffs ?? [],
    chain: partial.chain ?? { ok: true },
  };
}

describe("computeReadiness — overall status", () => {
  it("returns 'ready' when AoC is accepted, both reviewers present (same version), chain ok", () => {
    const report = computeReadiness(mkInput({
      signoffs: [row({ discipline: "bayesian" }), row({ discipline: "acoustician" })],
    }));
    expect(report.overall).toBe("ready");
    expect(report.summary).toMatch(/ready for premiere/i);
    // No fail rows.
    expect(report.checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("returns 'blocked' when AoC is missing", () => {
    const report = computeReadiness(mkInput({
      aocAccepted: false,
      signoffs: [row({ discipline: "bayesian" }), row({ discipline: "acoustician" })],
    }));
    expect(report.overall).toBe("blocked");
    expect(report.summary).toMatch(/blocked/i);
    const aoc = report.checks.find((c) => c.id === "aoc");
    expect(aoc?.status).toBe("fail");
  });

  it("returns 'blocked' when Bayesian sign-off is missing", () => {
    const report = computeReadiness(mkInput({
      signoffs: [row({ discipline: "acoustician" })],
    }));
    expect(report.overall).toBe("blocked");
    const b = report.checks.find((c) => c.id === "signoff-bayesian");
    expect(b?.status).toBe("fail");
  });

  it("returns 'blocked' when acoustician sign-off is missing", () => {
    const report = computeReadiness(mkInput({
      signoffs: [row({ discipline: "bayesian" })],
    }));
    expect(report.overall).toBe("blocked");
    const a = report.checks.find((c) => c.id === "signoff-acoustician");
    expect(a?.status).toBe("fail");
  });

  it("returns 'blocked' when the audit chain is broken", () => {
    const report = computeReadiness(mkInput({
      signoffs: [row({ discipline: "bayesian" }), row({ discipline: "acoustician" })],
      chain: { ok: false, brokenAtSeq: 42, reason: "entry_hash mismatch" },
    }));
    expect(report.overall).toBe("blocked");
    const c = report.checks.find((c) => c.id === "chain");
    expect(c?.status).toBe("fail");
    expect(c?.detail).toMatch(/seq 42/);
    expect(c?.detail).toMatch(/entry_hash mismatch/);
  });

  it("returns 'caveats' when both reviewers are present but on an older version", () => {
    const report = computeReadiness(mkInput({
      appVersion: "0.2.0",
      signoffs: [
        row({ discipline: "bayesian",    app_version: "0.1.0" }),
        row({ discipline: "acoustician", app_version: "0.1.0" }),
      ],
    }));
    expect(report.overall).toBe("caveats");
    expect(report.summary).toMatch(/caveats/i);
    const v = report.checks.find((c) => c.id === "version-coverage");
    expect(v?.status).toBe("fail");
    expect(v?.severity).toBe("warn");
    expect(v?.detail).toMatch(/bayesian/);
    expect(v?.detail).toMatch(/acoustician/);
  });

  it("returns 'caveats' when one reviewer is on the current version and the other is on an older one", () => {
    const report = computeReadiness(mkInput({
      appVersion: "0.2.0",
      signoffs: [
        row({ discipline: "bayesian",    app_version: "0.2.0" }),
        row({ discipline: "acoustician", app_version: "0.1.0" }),
      ],
    }));
    expect(report.overall).toBe("caveats");
    const v = report.checks.find((c) => c.id === "version-coverage");
    expect(v?.detail).toMatch(/acoustician/);
    expect(v?.detail).not.toMatch(/bayesian/);
  });

  it("does not include a version-coverage row when both reviewers are missing (covered by hard blocks)", () => {
    const report = computeReadiness(mkInput({
      appVersion: "0.2.0",
      signoffs: [],
    }));
    const v = report.checks.find((c) => c.id === "version-coverage");
    expect(v).toBeUndefined();
  });
});

describe("computeReadiness — counts", () => {
  it("buckets reviewers by discipline", () => {
    const report = computeReadiness(mkInput({
      signoffs: [
        row({ discipline: "bayesian" }),
        row({ discipline: "bayesian" }),
        row({ discipline: "acoustician" }),
        row({ discipline: "cultural" }),
        row({ discipline: "other" }),
      ],
    }));
    expect(report.counts).toEqual({ signoffs: 5, bayesian: 2, acoustician: 1, cultural: 1, other: 1 });
  });

  it("reports zeros on an empty list", () => {
    const report = computeReadiness(mkInput({}));
    expect(report.counts).toEqual({ signoffs: 0, bayesian: 0, acoustician: 0, cultural: 0, other: 0 });
  });
});

describe("computeReadiness — check detail strings", () => {
  it("singular vs plural reviewer counts", () => {
    const singular = computeReadiness(mkInput({
      signoffs: [row({ discipline: "bayesian" }), row({ discipline: "acoustician" })],
    }));
    expect(singular.checks.find((c) => c.id === "signoff-bayesian")?.detail).toMatch(/^1 reviewer recorded/);

    const plural = computeReadiness(mkInput({
      signoffs: [
        row({ discipline: "bayesian" }),
        row({ discipline: "bayesian" }),
        row({ discipline: "acoustician" }),
      ],
    }));
    expect(plural.checks.find((c) => c.id === "signoff-bayesian")?.detail).toMatch(/^2 reviewers recorded/);
  });

  it("AoC passing leaves the detail empty (no noise)", () => {
    const r = computeReadiness(mkInput({
      signoffs: [row({ discipline: "bayesian" }), row({ discipline: "acoustician" })],
    }));
    expect(r.checks.find((c) => c.id === "aoc")?.detail).toBe("");
  });
});
