import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryFn } = vi.hoisted(() => ({
  queryFn: vi.fn(),
}));

vi.mock("./db", () => ({ query: queryFn, exec: vi.fn() }));

import { collectMarkerOverrides, loadMarkerOverrides } from "./markerOverrides";

beforeEach(() => {
  queryFn.mockReset();
});

// Marker.annotated / marker.dismissed audit rows are produced by Review.tsx via
// appendAuditEntry. Their payloads always carry { marker_id } and
// optionally { note, category } for the annotated kind. Tests below mirror
// that wire format precisely so we exercise the same shape the chain emits.

function annotated(marker_id: string, payload: Record<string, unknown> = {}) {
  return { kind: "marker.annotated", payload_json: JSON.stringify({ marker_id, ...payload }) };
}
function dismissed(marker_id: string) {
  return { kind: "marker.dismissed", payload_json: JSON.stringify({ marker_id }) };
}

describe("collectMarkerOverrides — folding semantics", () => {
  it("returns empty overrides for an empty row list", () => {
    const out = collectMarkerOverrides([]);
    expect(out.dismissed.size).toBe(0);
    expect(out.annotations.size).toBe(0);
  });

  it("records the latest annotation per marker_id (latest-wins on multiple annotates)", () => {
    const out = collectMarkerOverrides([
      annotated("m1", { note: "first pass", category: "sound" }),
      annotated("m1", { note: "second pass", category: "movement" }),
      annotated("m1", { note: "third pass", category: "felt" }),
    ]);
    expect(out.annotations.get("m1")).toEqual({ note: "third pass", category: "felt" });
  });

  it("dismissal is absorbing — once dismissed, later annotates do NOT remove dismissal", () => {
    // The annotations Map still picks up the post-dismissal annotation (because
    // the chain is replayed verbatim), but the marker remains in `dismissed`.
    // Consumers MUST treat `dismissed` membership as absolute when rendering.
    const out = collectMarkerOverrides([
      annotated("m1", { note: "early note", category: "sound" }),
      dismissed("m1"),
      annotated("m1", { note: "post-dismiss edit", category: "movement" }),
    ]);
    expect(out.dismissed.has("m1")).toBe(true);
    // Verify the source code's actual behaviour: annotations map still records
    // the post-dismissal edit (forensic chain replays every event verbatim).
    expect(out.annotations.get("m1")).toEqual({ note: "post-dismiss edit", category: "movement" });
  });

  it("category can be explicitly set to null (Untagged)", () => {
    const out = collectMarkerOverrides([
      annotated("m1", { note: "thought it was sound", category: "sound" }),
      annotated("m1", { note: "actually unclear", category: null }),
    ]);
    expect(out.annotations.get("m1")).toEqual({ note: "actually unclear", category: null });
  });

  it("annotate without explicit category inherits the prior category", () => {
    // category undefined (or missing) in a later annotation must NOT clobber an
    // earlier explicit category — only note changes.
    const out = collectMarkerOverrides([
      annotated("m1", { note: "first", category: "sound" }),
      annotated("m1", { note: "refined note" }),
    ]);
    expect(out.annotations.get("m1")).toEqual({ note: "refined note", category: "sound" });
  });

  it("annotate without an explicit note inherits the prior note", () => {
    const out = collectMarkerOverrides([
      annotated("m1", { note: "first", category: "sound" }),
      annotated("m1", { category: "movement" }),
    ]);
    expect(out.annotations.get("m1")).toEqual({ note: "first", category: "movement" });
  });

  it("rejects garbage payload_json (parse failure) without throwing", () => {
    const out = collectMarkerOverrides([
      { kind: "marker.annotated", payload_json: "not json {{{" },
      annotated("m2", { note: "ok", category: "sound" }),
    ]);
    expect(out.annotations.has("m2")).toBe(true);
    expect(out.annotations.size).toBe(1);
  });

  it("skips rows missing marker_id (typed as anything other than string)", () => {
    const out = collectMarkerOverrides([
      { kind: "marker.annotated", payload_json: JSON.stringify({ note: "no id", category: "sound" }) },
      { kind: "marker.dismissed", payload_json: JSON.stringify({ marker_id: 42 }) },
      annotated("m1", { note: "good", category: "sound" }),
    ]);
    expect(out.annotations.size).toBe(1);
    expect(out.dismissed.size).toBe(0);
    expect(out.annotations.get("m1")).toEqual({ note: "good", category: "sound" });
  });

  it("ignores unknown category values (preserves prior category)", () => {
    const out = collectMarkerOverrides([
      annotated("m1", { note: "n", category: "sound" }),
      annotated("m1", { note: "n2", category: "BOGUS" }),
    ]);
    expect(out.annotations.get("m1")).toEqual({ note: "n2", category: "sound" });
  });

  it("category undefined on the first-ever annotation stays undefined (no override)", () => {
    const out = collectMarkerOverrides([
      annotated("m1", { note: "just a note" }),
    ]);
    expect(out.annotations.get("m1")).toEqual({ note: "just a note", category: undefined });
  });

  it("note coerces to null when payload omits it", () => {
    const out = collectMarkerOverrides([
      annotated("m1", { category: "sound" }),
    ]);
    expect(out.annotations.get("m1")).toEqual({ note: null, category: "sound" });
  });

  it("dismissals across multiple markers are all captured", () => {
    const out = collectMarkerOverrides([
      dismissed("m1"),
      dismissed("m2"),
      dismissed("m3"),
    ]);
    expect(out.dismissed).toEqual(new Set(["m1", "m2", "m3"]));
    expect(out.annotations.size).toBe(0);
  });
});

describe("loadMarkerOverrides — DB integration", () => {
  it("queries audit_log filtered to marker.annotated + marker.dismissed in seq order", async () => {
    queryFn.mockResolvedValueOnce([]);
    await loadMarkerOverrides();
    expect(queryFn).toHaveBeenCalledTimes(1);
    const sql = queryFn.mock.calls[0][0] as string;
    expect(sql).toMatch(/audit_log/);
    expect(sql).toMatch(/'marker\.annotated'/);
    expect(sql).toMatch(/'marker\.dismissed'/);
    expect(sql).toMatch(/ORDER BY seq ASC/);
  });

  it("returns the EMPTY result when query throws (pre-v1 schema / missing table)", async () => {
    queryFn.mockRejectedValueOnce(new Error("no such table: audit_log"));
    const out = await loadMarkerOverrides();
    expect(out.dismissed.size).toBe(0);
    expect(out.annotations.size).toBe(0);
  });

  it("folds DB rows through collectMarkerOverrides end-to-end", async () => {
    queryFn.mockResolvedValueOnce([
      annotated("m1", { note: "n1", category: "sound" }),
      annotated("m2", { note: "n2", category: "movement" }),
      dismissed("m2"),
    ]);
    const out = await loadMarkerOverrides();
    expect(out.annotations.get("m1")).toEqual({ note: "n1", category: "sound" });
    expect(out.dismissed.has("m2")).toBe(true);
  });
});
