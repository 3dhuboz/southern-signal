import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queryFn, execFn } = vi.hoisted(() => ({
  queryFn: vi.fn(),
  execFn: vi.fn(),
}));

vi.mock("../db/db", () => ({ query: queryFn, exec: execFn }));
vi.mock("../db/auditLog", () => ({ appendAuditEntry: vi.fn() }));
vi.mock("../preferences", () => ({ getPreferences: () => ({ globalCulturalSensitivityFlag: false }) }));

import {
  getStats,
  listDueForUpload,
  listRecentFailures,
  markDone,
  markFailed,
  markInFlight,
  purgeDoneOlderThan,
  recoverInFlight,
  retryAllFailed,
} from "./queue";

beforeEach(() => {
  queryFn.mockReset().mockResolvedValue([]);
  execFn.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// markFailed — exponential backoff schedule
// ---------------------------------------------------------------------------

describe("markFailed — exponential backoff", () => {
  it("flips to pending with 2^attempts seconds of backoff (attempts=1 → ~2s)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T00:00:00.000Z"));
    await markFailed(42, "transient", 1);
    const args = execFn.mock.calls[0][1] as unknown[];
    expect(args[0]).toBe("pending");
    expect(args[1]).toBe(1);
    // 2^1 = 2 seconds.
    expect(args[3]).toBe("2026-05-10T00:00:02.000Z");
    expect(args[4]).toBe(42);
  });

  it("backoff doubles each attempt up to the 300s ceiling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T00:00:00.000Z"));
    // attempts=4 → 2^4=16s
    await markFailed(1, "err", 4);
    expect((execFn.mock.calls[0][1] as unknown[])[3]).toBe("2026-05-10T00:00:16.000Z");
    execFn.mockClear();
    // attempts=7 → 2^7=128s
    await markFailed(1, "err", 7);
    expect((execFn.mock.calls[0][1] as unknown[])[3]).toBe("2026-05-10T00:02:08.000Z");
    execFn.mockClear();
    // attempts=20 → 2^20 is enormous but capped at 300s = 5min.
    await markFailed(1, "err", 20);
    expect((execFn.mock.calls[0][1] as unknown[])[3]).toBe("2026-05-10T00:05:00.000Z");
  });

  it("flips to 'failed' (terminal) when attempts >= MAX_ATTEMPTS (8)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T00:00:00.000Z"));
    await markFailed(99, "boom", 8);
    const args = execFn.mock.calls[0][1] as unknown[];
    expect(args[0]).toBe("failed");
    expect(args[1]).toBe(8);
  });

  it("stays 'pending' at attempts=7 (one below MAX)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T00:00:00.000Z"));
    await markFailed(99, "boom", 7);
    expect((execFn.mock.calls[0][1] as unknown[])[0]).toBe("pending");
  });

  it("truncates last_error to 400 chars to keep the queue table bounded", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T00:00:00.000Z"));
    const longErr = "x".repeat(800);
    await markFailed(7, longErr, 2);
    const args = execFn.mock.calls[0][1] as unknown[];
    expect((args[2] as string).length).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// recoverInFlight — bootstrap recovery
// ---------------------------------------------------------------------------

describe("recoverInFlight", () => {
  it("flips any in_flight rows back to pending with next_attempt_at = now", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T01:23:45.000Z"));
    await recoverInFlight();
    expect(execFn).toHaveBeenCalledTimes(1);
    const sql = execFn.mock.calls[0][0] as string;
    expect(sql).toMatch(/UPDATE sync_queue/);
    expect(sql).toMatch(/SET status = 'pending'/);
    expect(sql).toMatch(/WHERE status = 'in_flight'/);
    const args = execFn.mock.calls[0][1] as unknown[];
    expect(args[0]).toBe("2026-05-10T01:23:45.000Z");
  });

  it("issues the recovery UPDATE even when nothing is stuck (no pre-count)", async () => {
    // The implementation is unconditional — that's fine: an UPDATE that
    // matches zero rows is cheap and avoids a separate SELECT round trip.
    await recoverInFlight();
    expect(execFn).toHaveBeenCalledTimes(1);
    // No SELECT is performed before the UPDATE.
    expect(queryFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// retryAllFailed — manual operator retry
// ---------------------------------------------------------------------------

describe("retryAllFailed", () => {
  it("clears attempts + last_error and bumps next_attempt_at to now for ALL failed rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T03:00:00.000Z"));
    queryFn.mockResolvedValueOnce([{ n: 5 }]);
    const n = await retryAllFailed();
    expect(n).toBe(5);
    const sql = execFn.mock.calls[0][0] as string;
    expect(sql).toMatch(/UPDATE sync_queue/);
    expect(sql).toMatch(/SET status = 'pending'/);
    expect(sql).toMatch(/attempts = 0/);
    expect(sql).toMatch(/last_error = NULL/);
    expect(sql).toMatch(/WHERE status = 'failed'/);
    expect((execFn.mock.calls[0][1] as unknown[])[0]).toBe("2026-05-10T03:00:00.000Z");
  });

  it("returns 0 when there are no failed rows (count query returns empty array)", async () => {
    // The select-count returns `[]` rather than `[{ n: 0 }]` only when the
    // count aggregate fails; the implementation guards with `?? 0`. Verify.
    queryFn.mockResolvedValueOnce([]);
    const n = await retryAllFailed();
    expect(n).toBe(0);
    // The UPDATE still runs unconditionally — operator hit retry, we comply.
    expect(execFn).toHaveBeenCalledTimes(1);
  });

  it("returns the pre-update count, not the post-update count", async () => {
    queryFn.mockResolvedValueOnce([{ n: 12 }]);
    const n = await retryAllFailed();
    expect(n).toBe(12);
    // Count is read BEFORE the UPDATE — that ordering matters because the
    // UPDATE flips them out of 'failed' and a post-update count would be 0.
    const callOrder = [
      queryFn.mock.invocationCallOrder[0],
      execFn.mock.invocationCallOrder[0],
    ];
    expect(callOrder[0]).toBeLessThan(callOrder[1]);
  });
});

// ---------------------------------------------------------------------------
// listRecentFailures — operator UI helper
// ---------------------------------------------------------------------------

describe("listRecentFailures", () => {
  it("returns newest-first failed rows up to limit", async () => {
    const rows = [
      { id: 7, kind: "media_row", ref_id: "r7", attempts: 8, last_error: "timeout", next_attempt_at: "x" },
      { id: 3, kind: "audit", ref_id: "r3", attempts: 8, last_error: "400", next_attempt_at: "x" },
    ];
    queryFn.mockResolvedValueOnce(rows);
    const out = await listRecentFailures(5);
    expect(out).toEqual(rows);
    const sql = queryFn.mock.calls[0][0] as string;
    expect(sql).toMatch(/WHERE status = 'failed'/);
    expect(sql).toMatch(/ORDER BY id DESC/);
    expect(queryFn.mock.calls[0][1]).toEqual([5]);
  });

  it("defaults to 5 when limit is omitted", async () => {
    queryFn.mockResolvedValueOnce([]);
    await listRecentFailures();
    expect(queryFn.mock.calls[0][1]).toEqual([5]);
  });

  it("gracefully handles failed rows whose ref_id is empty / sentinel-style (no investigation-id)", async () => {
    // Some failed rows — particularly skip-audit failures — have no
    // resolvable investigation_id. listRecentFailures must NOT filter them
    // out; it's a display helper that returns whatever's in the table.
    queryFn.mockResolvedValueOnce([
      { id: 1, kind: "audit", ref_id: "", attempts: 8, last_error: "broken chain", next_attempt_at: "x" },
    ]);
    const out = await listRecentFailures();
    expect(out).toHaveLength(1);
    expect(out[0].ref_id).toBe("");
  });
});

// ---------------------------------------------------------------------------
// markInFlight / markDone — bulk mark helpers (touched by retry pipeline)
// ---------------------------------------------------------------------------

describe("markInFlight / markDone — bulk-id behaviour", () => {
  it("markInFlight with empty ids does nothing (no SQL)", async () => {
    await markInFlight([]);
    expect(execFn).not.toHaveBeenCalled();
  });

  it("markInFlight binds one placeholder per id and uses IN (...)", async () => {
    await markInFlight([3, 5, 11]);
    const sql = execFn.mock.calls[0][0] as string;
    expect(sql).toContain("IN (?,?,?)");
    expect(execFn.mock.calls[0][1]).toEqual([3, 5, 11]);
  });

  it("markDone clears last_error and stamps uploaded_at", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T04:00:00.000Z"));
    await markDone([7]);
    const sql = execFn.mock.calls[0][0] as string;
    expect(sql).toMatch(/uploaded_at = \?/);
    expect(sql).toMatch(/last_error = NULL/);
    expect(execFn.mock.calls[0][1]).toEqual(["2026-05-10T04:00:00.000Z", 7]);
  });

  it("markDone with empty ids does nothing", async () => {
    await markDone([]);
    expect(execFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// listDueForUpload — drain-side filter
// ---------------------------------------------------------------------------

describe("listDueForUpload", () => {
  it("filters to pending rows whose next_attempt_at is in the past", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T05:00:00.000Z"));
    queryFn.mockResolvedValueOnce([]);
    await listDueForUpload(4);
    const sql = queryFn.mock.calls[0][0] as string;
    expect(sql).toMatch(/status = 'pending'/);
    expect(sql).toMatch(/next_attempt_at <= \?/);
    expect(sql).toMatch(/ORDER BY id ASC/);
    expect(queryFn.mock.calls[0][1]).toEqual(["2026-05-10T05:00:00.000Z", 4]);
  });
});

// ---------------------------------------------------------------------------
// getStats — coverage to round out retry pipeline visibility
// ---------------------------------------------------------------------------

describe("getStats", () => {
  it("rolls counts into the {pending, in_flight, done, failed} shape with safe zeros", async () => {
    queryFn
      .mockResolvedValueOnce([{ status: "pending", n: 3 }, { status: "failed", n: 1 }])
      .mockResolvedValueOnce([{ ts: "2026-05-10T00:00:00.000Z" }])
      .mockResolvedValueOnce([{ ts: null }]);
    const s = await getStats();
    expect(s).toEqual({
      pending: 3,
      in_flight: 0,
      done: 0,
      failed: 1,
      oldest_pending_at: "2026-05-10T00:00:00.000Z",
      last_uploaded_at: null,
    });
  });
});

// ---------------------------------------------------------------------------
// purgeDoneOlderThan — table-bound trimmer
// ---------------------------------------------------------------------------

describe("purgeDoneOlderThan", () => {
  it("returns the number of rows that matched the cutoff and deletes them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T00:00:00.000Z"));
    queryFn.mockResolvedValueOnce([{ n: 4 }]);
    const n = await purgeDoneOlderThan(7);
    expect(n).toBe(4);
    // Cutoff = now - 7 * 86400000ms = 2026-05-03T00:00:00.000Z
    expect(queryFn.mock.calls[0][1]).toEqual(["2026-05-03T00:00:00.000Z"]);
    expect(execFn.mock.calls[0][1]).toEqual(["2026-05-03T00:00:00.000Z"]);
  });
});
