import { describe, expect, it } from "vitest";
import { ageLabel, pickHeadline } from "./researchSnapshotHelpers";
import type { ResearchFinding } from "../lib/research/api";

function mkFinding(partial: Partial<ResearchFinding>): ResearchFinding {
  return {
    tier: partial.tier ?? "HERITAGE",
    title: partial.title ?? "Untitled",
    body: partial.body ?? "",
    sources: partial.sources ?? [],
  };
}

describe("pickHeadline — tier priority", () => {
  it("returns null for an empty findings list", () => {
    expect(pickHeadline([])).toBeNull();
  });

  it("CULTURAL_SIGNIFICANCE wins over every other tier", () => {
    const findings = [
      mkFinding({ tier: "DOCUMENTED_INCIDENT", title: "Fire 1953", sources: [{ label: "x", url: "https://x" }, { label: "y", url: "https://y" }] }),
      mkFinding({ tier: "HERITAGE", title: "Heritage entry" }),
      mkFinding({ tier: "CULTURAL_SIGNIFICANCE", title: "Country significance" }),
    ];
    expect(pickHeadline(findings)?.title).toBe("Country significance");
  });

  it("DOCUMENTED_INCIDENT wins over HERITAGE / FOLKLORE / SYNTHESIS", () => {
    const findings = [
      mkFinding({ tier: "FOLKLORE", title: "Ghost story" }),
      mkFinding({ tier: "HERITAGE", title: "Built 1894" }),
      mkFinding({ tier: "DOCUMENTED_INCIDENT", title: "Court record 1960" }),
      mkFinding({ tier: "SYNTHESIS", title: "Inferred era" }),
    ];
    expect(pickHeadline(findings)?.title).toBe("Court record 1960");
  });

  it("HERITAGE wins over FOLKLORE / SYNTHESIS when no higher tier present", () => {
    const findings = [
      mkFinding({ tier: "SYNTHESIS", title: "Inferred" }),
      mkFinding({ tier: "FOLKLORE", title: "Anecdote" }),
      mkFinding({ tier: "HERITAGE", title: "Register entry" }),
    ];
    expect(pickHeadline(findings)?.title).toBe("Register entry");
  });

  it("FOLKLORE beats SYNTHESIS — at least it's a human source", () => {
    const findings = [
      mkFinding({ tier: "SYNTHESIS", title: "AI inference" }),
      mkFinding({ tier: "FOLKLORE", title: "Local legend" }),
    ];
    expect(pickHeadline(findings)?.title).toBe("Local legend");
  });

  it("falls back to the first finding when all tiers are unknown", () => {
    const findings = [
      mkFinding({ tier: "WEIRD_TIER" as unknown as ResearchFinding["tier"], title: "First" }),
      mkFinding({ tier: "ANOTHER_BAD_TIER" as unknown as ResearchFinding["tier"], title: "Second" }),
    ];
    expect(pickHeadline(findings)?.title).toBe("First");
  });
});

describe("pickHeadline — citation-count tie-break", () => {
  it("within the same tier, more sources wins", () => {
    const findings = [
      mkFinding({ tier: "HERITAGE", title: "Few citations", sources: [{ label: "a", url: "https://a" }] }),
      mkFinding({ tier: "HERITAGE", title: "Many citations", sources: [
        { label: "a", url: "https://a" },
        { label: "b", url: "https://b" },
        { label: "c", url: "https://c" },
      ] }),
    ];
    expect(pickHeadline(findings)?.title).toBe("Many citations");
  });

  it("tier still beats source count — a CULTURAL with 0 sources beats a HERITAGE with 5", () => {
    const findings = [
      mkFinding({ tier: "HERITAGE", title: "Heavy heritage", sources: Array(5).fill({ label: "x", url: "https://x" }) }),
      mkFinding({ tier: "CULTURAL_SIGNIFICANCE", title: "Bare cultural", sources: [] }),
    ];
    const head = pickHeadline(findings);
    expect(head?.title).toBe("Bare cultural");
    expect(head?.sources).toBe(0);
  });

  it("returns sources count alongside title and tier", () => {
    const findings = [mkFinding({ tier: "HERITAGE", title: "X", sources: [
      { label: "a", url: "https://a" },
      { label: "b", url: "https://b" },
    ] })];
    const head = pickHeadline(findings);
    expect(head).toEqual({ tier: "HERITAGE", title: "X", sources: 2 });
  });
});

describe("ageLabel — relative time", () => {
  const BASE = Date.parse("2026-05-10T12:00:00Z");

  it("'just now' for <60s", () => {
    expect(ageLabel("2026-05-10T11:59:30Z", BASE)).toBe("just now");
    expect(ageLabel("2026-05-10T12:00:00Z", BASE)).toBe("just now");
  });

  it("minutes for 1m - 59m", () => {
    expect(ageLabel("2026-05-10T11:55:00Z", BASE)).toBe("5 min ago");
    expect(ageLabel("2026-05-10T11:01:00Z", BASE)).toBe("59 min ago");
  });

  it("hours for 1h - 23h", () => {
    expect(ageLabel("2026-05-10T09:00:00Z", BASE)).toBe("3 h ago");
    expect(ageLabel("2026-05-09T13:00:00Z", BASE)).toBe("23 h ago");
  });

  it("days for >=24h", () => {
    expect(ageLabel("2026-05-09T12:00:00Z", BASE)).toBe("1 d ago");
    expect(ageLabel("2026-05-03T12:00:00Z", BASE)).toBe("7 d ago");
  });
});
