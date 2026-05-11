import { describe, expect, it } from "vitest";
import { diffResearchResults } from "./diff";
import type { ResearchFinding, ResearchResult } from "./api";

function mkFinding(partial: Partial<ResearchFinding>): ResearchFinding {
  return {
    tier: "HERITAGE",
    title: "Untitled",
    body: "",
    sources: [],
    ...partial,
  };
}

function mkResult(findings: ResearchFinding[]): ResearchResult {
  return {
    findings,
    suggestions: [],
    search_terms_used: [],
    citations_raw: [],
    model: "test/mock",
    warnings: [],
  };
}

describe("diffResearchResults", () => {
  it("treats identical results as fully unchanged", async () => {
    const findings = [
      mkFinding({ tier: "HERITAGE", title: "A", body: "alpha" }),
      mkFinding({ tier: "FOLKLORE", title: "B", body: "beta" }),
    ];
    const diff = await diffResearchResults(mkResult(findings), mkResult(findings));
    expect(diff.counts).toEqual({ added: 0, removed: 0, unchanged: 2 });
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(2);
  });

  it("flags purely new findings as added", async () => {
    const prev = mkResult([mkFinding({ tier: "HERITAGE", title: "A", body: "alpha" })]);
    const curr = mkResult([
      mkFinding({ tier: "HERITAGE", title: "A", body: "alpha" }),
      mkFinding({ tier: "DOCUMENTED_INCIDENT", title: "Fire 1953", body: "Court records" }),
    ]);
    const diff = await diffResearchResults(prev, curr);
    expect(diff.counts).toEqual({ added: 1, removed: 0, unchanged: 1 });
    expect(diff.added[0].title).toBe("Fire 1953");
  });

  it("flags missing findings as removed", async () => {
    const prev = mkResult([
      mkFinding({ tier: "HERITAGE", title: "A", body: "alpha" }),
      mkFinding({ tier: "FOLKLORE", title: "Ghost story", body: "Spooky" }),
    ]);
    const curr = mkResult([mkFinding({ tier: "HERITAGE", title: "A", body: "alpha" })]);
    const diff = await diffResearchResults(prev, curr);
    expect(diff.counts).toEqual({ added: 0, removed: 1, unchanged: 1 });
    expect(diff.removed[0].title).toBe("Ghost story");
  });

  it("treats a reworded body as remove + add (content-anchored)", async () => {
    const prev = mkResult([mkFinding({ tier: "HERITAGE", title: "Building", body: "Built 1894" })]);
    const curr = mkResult([mkFinding({ tier: "HERITAGE", title: "Building", body: "Built circa 1894" })]);
    const diff = await diffResearchResults(prev, curr);
    expect(diff.counts.unchanged).toBe(0);
    expect(diff.counts.added).toBe(1);
    expect(diff.counts.removed).toBe(1);
  });

  it("ignores tier ordering — keys depend only on tier|title|body", async () => {
    const a = mkFinding({ tier: "HERITAGE", title: "A", body: "x" });
    const b = mkFinding({ tier: "FOLKLORE", title: "B", body: "y" });
    const diff = await diffResearchResults(mkResult([a, b]), mkResult([b, a]));
    expect(diff.counts).toEqual({ added: 0, removed: 0, unchanged: 2 });
  });

  it("handles empty previous result (everything is new)", async () => {
    const curr = mkResult([
      mkFinding({ tier: "HERITAGE", title: "A", body: "alpha" }),
      mkFinding({ tier: "FOLKLORE", title: "B", body: "beta" }),
    ]);
    const diff = await diffResearchResults(mkResult([]), curr);
    expect(diff.counts).toEqual({ added: 2, removed: 0, unchanged: 0 });
  });

  it("handles empty current result (everything is removed)", async () => {
    const prev = mkResult([mkFinding({ tier: "HERITAGE", title: "A", body: "alpha" })]);
    const diff = await diffResearchResults(prev, mkResult([]));
    expect(diff.counts).toEqual({ added: 0, removed: 1, unchanged: 0 });
  });
});
