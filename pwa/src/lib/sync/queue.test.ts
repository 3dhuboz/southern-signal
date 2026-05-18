import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryFn, execFn, auditFn, prefsFn } = vi.hoisted(() => ({
  queryFn: vi.fn(),
  execFn: vi.fn(),
  auditFn: vi.fn(),
  prefsFn: vi.fn(),
}));

vi.mock("../db/db", () => ({ query: queryFn, exec: execFn }));
vi.mock("../db/auditLog", () => ({ appendAuditEntry: auditFn }));
vi.mock("../preferences", () => ({ getPreferences: prefsFn }));

import { clearSensitivityCache, enqueue, setAuditLogger } from "./queue";

// Wire the audit logger directly. In production this happens at module-init
// time inside auditLog.ts; under test, auditLog.ts is mocked, so we register
// the mock here.
setAuditLogger(auditFn);

const PREFS_PRISTINE = { globalCulturalSensitivityFlag: false } as const;

describe("enqueue · cultural-sensitivity gating", () => {
  beforeEach(() => {
    queryFn.mockReset();
    execFn.mockReset();
    auditFn.mockReset();
    prefsFn.mockReset();
    prefsFn.mockReturnValue(PREFS_PRISTINE);
    queryFn.mockResolvedValue([]);
    execFn.mockResolvedValue(undefined);
    auditFn.mockResolvedValue(undefined);
    clearSensitivityCache();
  });

  it("skips a row whose investigation is flagged sensitive and writes a skip-audit", async () => {
    queryFn.mockResolvedValueOnce([{ culturally_sensitive: 1 }]);
    await enqueue({
      kind: "investigation",
      ref_id: "case-A",
      payload: { id: "case-A", title: "Sensitive site" },
    });
    expect(execFn).not.toHaveBeenCalled();
    expect(auditFn).toHaveBeenCalledTimes(1);
    expect(auditFn.mock.calls[0][0]).toMatchObject({
      actor: "system",
      kind: "sync.skip_sensitive",
      payload: { kind: "investigation", ref_id: "case-A", investigation_id: "case-A" },
    });
  });

  it("enqueues a row whose investigation is NOT sensitive", async () => {
    queryFn.mockResolvedValueOnce([{ culturally_sensitive: 0 }]);
    await enqueue({
      kind: "investigation",
      ref_id: "case-B",
      payload: { id: "case-B", title: "Ordinary site" },
    });
    expect(execFn).toHaveBeenCalledTimes(1);
    expect(auditFn).not.toHaveBeenCalled();
  });

  it("hard-blocks ALL non-audit enqueues when globalCulturalSensitivityFlag is on", async () => {
    prefsFn.mockReturnValue({ globalCulturalSensitivityFlag: true });
    await enqueue({
      kind: "event",
      ref_id: "ev-1",
      payload: { investigation_id: "case-C", title: "anything" },
    });
    expect(execFn).not.toHaveBeenCalled();
    expect(auditFn).toHaveBeenCalledTimes(1);
    expect(auditFn.mock.calls[0][0]).toMatchObject({
      kind: "sync.skip_global_sensitive",
      payload: { kind: "event", ref_id: "ev-1", investigation_id: "case-C" },
    });
  });

  it("audit-kind rows always enqueue, even when the global flag is on", async () => {
    prefsFn.mockReturnValue({ globalCulturalSensitivityFlag: true });
    await enqueue({
      kind: "audit",
      ref_id: "audit-1",
      payload: { hash: "abc" },
    });
    expect(execFn).toHaveBeenCalledTimes(1);
    expect(auditFn).not.toHaveBeenCalled();
  });

  it("audit-kind rows bypass the per-case gate too", async () => {
    queryFn.mockResolvedValueOnce([{ culturally_sensitive: 1 }]);
    await enqueue({
      kind: "audit",
      ref_id: "audit-2",
      payload: { investigation_id: "case-A", hash: "def" },
    });
    expect(execFn).toHaveBeenCalledTimes(1);
    // Per-case lookup is short-circuited for audit rows.
    expect(queryFn).not.toHaveBeenCalled();
  });

  it("caches per-case sensitivity decisions across calls in the TTL window", async () => {
    queryFn.mockResolvedValueOnce([{ culturally_sensitive: 0 }]);
    await enqueue({
      kind: "investigation",
      ref_id: "case-D",
      payload: { id: "case-D" },
    });
    await enqueue({
      kind: "event",
      ref_id: "ev-2",
      payload: { investigation_id: "case-D" },
    });
    // Second call should hit the cache, so query is invoked exactly once.
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(execFn).toHaveBeenCalledTimes(2);
  });

  it("logSkip never blocks the path even if audit append fails", async () => {
    prefsFn.mockReturnValue({ globalCulturalSensitivityFlag: true });
    auditFn.mockRejectedValueOnce(new Error("disk full"));
    // Should resolve without throwing — logSkip swallows audit errors.
    await expect(
      enqueue({ kind: "event", ref_id: "ev-3", payload: { investigation_id: "case-E" } }),
    ).resolves.toBeUndefined();
    expect(execFn).not.toHaveBeenCalled();
  });
});
