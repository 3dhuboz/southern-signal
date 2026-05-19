import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryFn, execFn, enqueueFn, appendAuditFn } = vi.hoisted(() => ({
  queryFn: vi.fn(),
  execFn: vi.fn(),
  enqueueFn: vi.fn(),
  appendAuditFn: vi.fn(),
}));

// withTransaction is a thin BEGIN/COMMIT wrapper around the underlying
// exec(). In production it inserts BEGIN + body + COMMIT into the same
// worker; under test we run the body inline so the assertions can target
// exec()/query() the same way they did before transactions were added.
vi.mock("./db", () => ({
  query: queryFn,
  exec: execFn,
  withTransaction: async <T>(body: () => Promise<T>): Promise<T> => body(),
}));
vi.mock("../sync/queue", () => ({ enqueue: enqueueFn, clearSensitivityCache: vi.fn() }));
vi.mock("./auditLog", () => ({ appendAuditEntry: appendAuditFn }));

import { createSignoff, deleteSignoff, findingKeyFor, listSignoffs, saveDossier, saveFindingNote, updateSignoff } from "./repo";

beforeEach(() => {
  queryFn.mockReset().mockResolvedValue([]);
  execFn.mockReset().mockResolvedValue(undefined);
  enqueueFn.mockReset().mockResolvedValue(undefined);
  appendAuditFn.mockReset().mockResolvedValue(undefined);
});

describe("findingKeyFor — content-stable hash", () => {
  it("produces the same key for the same (tier, title, body)", async () => {
    const a = await findingKeyFor({ tier: "HERITAGE", title: "Built 1894", body: "Foundation date." });
    const b = await findingKeyFor({ tier: "HERITAGE", title: "Built 1894", body: "Foundation date." });
    expect(a).toBe(b);
  });

  it("changes when the tier changes (even with same title+body)", async () => {
    const a = await findingKeyFor({ tier: "HERITAGE", title: "X", body: "Y" });
    const b = await findingKeyFor({ tier: "FOLKLORE", title: "X", body: "Y" });
    expect(a).not.toBe(b);
  });

  it("changes when the body is reworded", async () => {
    const a = await findingKeyFor({ tier: "HERITAGE", title: "T", body: "Built 1894" });
    const b = await findingKeyFor({ tier: "HERITAGE", title: "T", body: "Built circa 1894" });
    expect(a).not.toBe(b);
  });

  it("returns a 24-char lowercase hex string", async () => {
    const k = await findingKeyFor({ tier: "HERITAGE", title: "T", body: "B" });
    expect(k).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe("saveDossier — size caps", () => {
  it("inserts a row and fires sync enqueue for a normal-sized dossier", async () => {
    const row = await saveDossier({
      investigation_id: "inv-1",
      venue_name: "Old Court",
      region: "AU",
      model: "perplexity/sonar",
      result: { findings: [], suggestions: [], search_terms_used: [], citations_raw: [], model: "test", warnings: [] },
    });
    expect(row.venue_name).toBe("Old Court");
    expect(execFn).toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO research_dossiers/), expect.any(Array));
    expect(enqueueFn).toHaveBeenCalledWith(expect.objectContaining({ kind: "dossier" }));
    // Normal-sized payload doesn't fire the size_warning audit entry.
    const kinds = appendAuditFn.mock.calls.map((c) => (c[0] as { kind: string }).kind);
    expect(kinds).not.toContain("research.dossier.size_warning");
  });

  it("hard-refuses payloads over 1 MB without inserting a row", async () => {
    // Build a result with a single finding whose body is 1.1 MB of text.
    const huge = "x".repeat(1_100_000);
    await expect(saveDossier({
      investigation_id: "inv-1",
      venue_name: "Old Court",
      region: "AU",
      model: "test",
      result: { findings: [{ tier: "HERITAGE", title: "t", body: huge, sources: [] }], suggestions: [], search_terms_used: [], citations_raw: [], model: "test", warnings: [] },
    })).rejects.toThrow(/exceeds.*KB/);
    expect(execFn).not.toHaveBeenCalled();
    // Audit chain records the refusal — chain integrity matters even
    // when no row was written.
    expect(appendAuditFn).toHaveBeenCalledWith(expect.objectContaining({
      kind: "research.dossier.save_refused_oversize",
    }));
  });

  it("fires a size_warning audit entry for payloads in the 200 KB - 1 MB band", async () => {
    const body = "x".repeat(220_000);
    await saveDossier({
      investigation_id: "inv-1",
      venue_name: "Old Court",
      region: "AU",
      model: "test",
      result: { findings: [{ tier: "HERITAGE", title: "t", body, sources: [] }], suggestions: [], search_terms_used: [], citations_raw: [], model: "test", warnings: [] },
    });
    // The row STILL gets inserted (this is a soft warning, not a refusal).
    expect(execFn).toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO research_dossiers/), expect.any(Array));
    const kinds = appendAuditFn.mock.calls.map((c) => (c[0] as { kind: string }).kind);
    expect(kinds).toContain("research.dossier.size_warning");
  });
});

describe("saveFindingNote — upsert behaviour", () => {
  it("inserts a new note when none exists for (dossier_id, finding_key)", async () => {
    queryFn.mockResolvedValueOnce([]); // no existing row
    const row = await saveFindingNote({
      dossier_id: "d1",
      finding_key: "abc123",
      text: "Verified via Trove.",
    });
    expect(row).not.toBeNull();
    expect(row!.text).toBe("Verified via Trove.");
    expect(execFn).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO research_finding_notes/),
      expect.any(Array),
    );
    expect(appendAuditFn).toHaveBeenCalledWith(expect.objectContaining({
      kind: "research.finding_note.create",
    }));
  });

  it("updates an existing note and fires the update kind", async () => {
    const existing = { id: "n1", dossier_id: "d1", finding_key: "abc123", text: "old", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-01T00:00:00Z" };
    queryFn.mockResolvedValueOnce([existing]);
    const row = await saveFindingNote({
      dossier_id: "d1",
      finding_key: "abc123",
      text: "Verified — corrected.",
    });
    // The row's id and created_at are preserved across the update.
    expect(row!.id).toBe("n1");
    expect(row!.created_at).toBe("2026-05-01T00:00:00Z");
    expect(row!.text).toBe("Verified — corrected.");
    expect(appendAuditFn).toHaveBeenCalledWith(expect.objectContaining({
      kind: "research.finding_note.update",
    }));
  });

  it("treats an empty/whitespace-only save as a delete", async () => {
    const existing = { id: "n1", dossier_id: "d1", finding_key: "abc123", text: "old", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-01T00:00:00Z" };
    queryFn.mockResolvedValueOnce([existing]); // existing-row lookup inside deleteFindingNote
    const row = await saveFindingNote({ dossier_id: "d1", finding_key: "abc123", text: "   " });
    expect(row).toBeNull();
    expect(execFn).toHaveBeenCalledWith(
      expect.stringMatching(/DELETE FROM research_finding_notes/),
      expect.any(Array),
    );
    expect(appendAuditFn).toHaveBeenCalledWith(expect.objectContaining({
      kind: "research.finding_note.delete",
    }));
  });

  it("audit-chain payload includes text_length but never the raw text", async () => {
    queryFn.mockResolvedValueOnce([]);
    await saveFindingNote({
      dossier_id: "d1",
      finding_key: "abc123",
      text: "Sensitive reviewer assertion that shouldn't end up in the audit payload verbatim.",
    });
    const payload = (appendAuditFn.mock.calls[0][0] as { payload: Record<string, unknown> }).payload;
    expect(payload).toHaveProperty("text_length");
    expect(payload.text_length).toBeGreaterThan(0);
    // The full text is in the row, not the chain payload — chain payloads
    // can leak into wider archives, the row stays on-device.
    expect(JSON.stringify(payload)).not.toContain("Sensitive reviewer assertion");
  });
});

describe("createSignoff — happy path + validation", () => {
  it("inserts a row, hash-chains the statement, and returns the persisted shape", async () => {
    const row = await createSignoff({
      reviewer_name: "Prof. Example",
      affiliation: "ANU",
      identifier: "ORCID 0000-0000-0000-0000",
      discipline: "bayesian",
      signed_at: "2026-05-01",
      app_version: "0.1.0",
      statement: "Methodology approved.",
      source_url: "https://orcid.org/0000-0000-0000-0000",
    });
    expect(row.reviewer_name).toBe("Prof. Example");
    expect(row.discipline).toBe("bayesian");
    expect(execFn).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO reviewer_signoffs/),
      expect.any(Array),
    );
    const audit = appendAuditFn.mock.calls[0][0] as { kind: string; payload: Record<string, unknown> };
    expect(audit.kind).toBe("reviewer.signoff.create");
    // The chain payload anchors the statement bytes via sha256 — the raw
    // statement never appears in the chain (it stays on the row).
    expect(audit.payload).toHaveProperty("statement_sha256");
    expect(JSON.stringify(audit.payload)).not.toContain("Methodology approved.");
  });

  it("trims whitespace and strips control characters", async () => {
    const row = await createSignoff({
      reviewer_name: "  Dr. Spacey\x07  ",
      discipline: "acoustician",
      signed_at: "2026-05-01",
      app_version: "0.1.0",
      statement: "  ok\x00 ",
    });
    expect(row.reviewer_name).toBe("Dr. Spacey");
    expect(row.statement).toBe("ok");
  });

  it("refuses an empty reviewer name", async () => {
    await expect(createSignoff({
      reviewer_name: "   ",
      discipline: "bayesian",
      signed_at: "2026-05-01",
      app_version: "0.1.0",
      statement: "ok",
    })).rejects.toThrow(/name is required/i);
    expect(execFn).not.toHaveBeenCalled();
  });

  it("refuses an empty statement", async () => {
    await expect(createSignoff({
      reviewer_name: "X",
      discipline: "bayesian",
      signed_at: "2026-05-01",
      app_version: "0.1.0",
      statement: "   ",
    })).rejects.toThrow(/statement is required/i);
  });

  it("refuses statements over the 4 000-char cap", async () => {
    await expect(createSignoff({
      reviewer_name: "X",
      discipline: "bayesian",
      signed_at: "2026-05-01",
      app_version: "0.1.0",
      statement: "x".repeat(4001),
    })).rejects.toThrow(/4 000/);
  });

  it("refuses a non-http(s) source URL", async () => {
    await expect(createSignoff({
      reviewer_name: "X",
      discipline: "bayesian",
      signed_at: "2026-05-01",
      app_version: "0.1.0",
      statement: "ok",
      source_url: "javascript:alert(1)",
    })).rejects.toThrow(/http/i);
  });

  it("refuses an unknown discipline", async () => {
    await expect(createSignoff({
      reviewer_name: "X",
      // @ts-expect-error — testing runtime rejection of out-of-union value.
      discipline: "wizard",
      signed_at: "2026-05-01",
      app_version: "0.1.0",
      statement: "ok",
    })).rejects.toThrow(/discipline/i);
  });
});

describe("updateSignoff — preserves created_at and fires update audit", () => {
  it("updates an existing row and keeps created_at", async () => {
    const existing = {
      id: "s1",
      reviewer_name: "Old Name",
      affiliation: null,
      identifier: null,
      discipline: "bayesian",
      signed_at: "2026-05-01",
      app_version: "0.1.0",
      statement: "old",
      source_url: null,
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-01T00:00:00Z",
    };
    queryFn.mockResolvedValueOnce([existing]);
    const row = await updateSignoff("s1", {
      reviewer_name: "New Name",
      discipline: "acoustician",
      signed_at: "2026-05-10",
      app_version: "0.1.0",
      statement: "new",
    });
    expect(row.id).toBe("s1");
    expect(row.created_at).toBe("2026-05-01T00:00:00Z");
    expect(row.reviewer_name).toBe("New Name");
    expect(row.discipline).toBe("acoustician");
    expect(appendAuditFn).toHaveBeenCalledWith(expect.objectContaining({
      kind: "reviewer.signoff.update",
    }));
  });

  it("throws when the id does not exist", async () => {
    queryFn.mockResolvedValueOnce([]);
    await expect(updateSignoff("missing", {
      reviewer_name: "X",
      discipline: "bayesian",
      signed_at: "2026-05-01",
      app_version: "0.1.0",
      statement: "ok",
    })).rejects.toThrow(/not found/i);
  });
});

describe("deleteSignoff", () => {
  it("deletes the row and emits a delete audit entry", async () => {
    queryFn.mockResolvedValueOnce([{ id: "s1", reviewer_name: "X", discipline: "bayesian" }]);
    await deleteSignoff("s1");
    expect(execFn).toHaveBeenCalledWith(
      expect.stringMatching(/DELETE FROM reviewer_signoffs/),
      ["s1"],
    );
    expect(appendAuditFn).toHaveBeenCalledWith(expect.objectContaining({
      kind: "reviewer.signoff.delete",
    }));
  });

  it("silently no-ops when the row is already gone (idempotent)", async () => {
    queryFn.mockResolvedValueOnce([]);
    await deleteSignoff("missing");
    expect(execFn).not.toHaveBeenCalled();
    expect(appendAuditFn).not.toHaveBeenCalled();
  });
});

describe("listSignoffs", () => {
  it("returns an empty array on pre-v6 schemas where the table is missing", async () => {
    queryFn.mockRejectedValueOnce(new Error("no such table: reviewer_signoffs"));
    const rows = await listSignoffs();
    expect(rows).toEqual([]);
  });

  it("returns the rows the query produces, in DB order", async () => {
    const stub = [{ id: "s2" }, { id: "s1" }];
    queryFn.mockResolvedValueOnce(stub);
    const rows = await listSignoffs();
    expect(rows.map((r) => r.id)).toEqual(["s2", "s1"]);
  });
});
