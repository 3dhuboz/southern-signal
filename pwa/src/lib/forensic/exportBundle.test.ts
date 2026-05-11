import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryFn } = vi.hoisted(() => ({ queryFn: vi.fn() }));
vi.mock("../db/db", () => ({ query: queryFn, exec: vi.fn() }));

import { buildResearchEntries, loadResearchForBundle, type BundleDossierRow, type BundleFindingNoteRow } from "./exportBundle";

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
