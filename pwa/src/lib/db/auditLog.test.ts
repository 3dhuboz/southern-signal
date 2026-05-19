import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryFn, execFn, enqueueFn } = vi.hoisted(() => ({
  queryFn: vi.fn(),
  execFn: vi.fn(),
  enqueueFn: vi.fn(),
}));

// Inline withTransaction in tests so we don't have to assert on
// BEGIN/COMMIT bookkeeping that exists purely for the production
// promiser path. The function body runs exactly as it would in
// production; just no transactional bracketing.
vi.mock("./db", () => ({
  query: queryFn,
  exec: execFn,
  withTransaction: async <T>(body: () => Promise<T>): Promise<T> => body(),
}));
vi.mock("../sync/queue", () => ({ enqueue: enqueueFn, setAuditLogger: vi.fn() }));

import { appendAuditEntry, verifyAuditChain } from "./auditLog";
import { canonicalJson, sha256Hex } from "../forensic/canonicalJson";

const GENESIS = "0".repeat(64);

beforeEach(() => {
  queryFn.mockReset();
  execFn.mockReset().mockResolvedValue(undefined);
  enqueueFn.mockReset().mockResolvedValue(undefined);
});

describe("appendAuditEntry", () => {
  it("seeds the chain with seq=1, prev_hash=GENESIS when the table is empty", async () => {
    queryFn.mockResolvedValueOnce([]); // getLastEntry → no prior
    const result = await appendAuditEntry({
      actor: "system",
      kind: "session_start",
      payload: { investigation_id: "case-A" },
      ts: "2026-05-10T00:00:00.000Z",
    });
    expect(result.seq).toBe(1);
    expect(result.prev_hash).toBe(GENESIS);
    expect(result.entry_hash).toMatch(/^[0-9a-f]{64}$/);
    // The INSERT bound parameters carry the hashes that the function returned.
    const insertArgs = execFn.mock.calls[0][1] as unknown[];
    expect(insertArgs[0]).toBe(1);
    expect(insertArgs[5]).toBe(GENESIS); // prev_hash
    expect(insertArgs[6]).toBe(result.entry_hash);
  });

  it("computes the entry_hash from seq|ts|actor|kind|canonical-payload|prev_hash", async () => {
    queryFn.mockResolvedValueOnce([]);
    const ts = "2026-05-10T00:00:00.000Z";
    const payload = { investigation_id: "case-A", b: 2, a: 1 };
    const result = await appendAuditEntry({ actor: "system", kind: "marker", payload, ts });
    const expected = await sha256Hex(`1|${ts}|system|marker|${canonicalJson(payload)}|${GENESIS}`);
    expect(result.entry_hash).toBe(expected);
  });

  it("chains seq+1 onto the prior entry's hash", async () => {
    queryFn.mockResolvedValueOnce([{ seq: 7, entry_hash: "a".repeat(64) }]);
    const result = await appendAuditEntry({
      actor: "user",
      kind: "contamination.tag",
      payload: { tag: "voice_me" },
      ts: "2026-05-10T00:01:00.000Z",
    });
    expect(result.seq).toBe(8);
    expect(result.prev_hash).toBe("a".repeat(64));
  });

  it("survives a sync enqueue failure (chain integrity is local-first)", async () => {
    queryFn.mockResolvedValueOnce([]);
    enqueueFn.mockRejectedValueOnce(new Error("offline"));
    await expect(
      appendAuditEntry({ actor: "system", kind: "ev", payload: {}, ts: "2026-05-10T00:00:00.000Z" }),
    ).resolves.toMatchObject({ seq: 1 });
    expect(execFn).toHaveBeenCalledTimes(1); // local INSERT still happened
  });

  it("enqueues the audit row for cloud sync with kind='audit'", async () => {
    queryFn.mockResolvedValueOnce([]);
    await appendAuditEntry({ actor: "system", kind: "ev", payload: { x: 1 }, ts: "2026-05-10T00:00:00.000Z" });
    expect(enqueueFn).toHaveBeenCalledTimes(1);
    expect(enqueueFn.mock.calls[0][0]).toMatchObject({ kind: "audit", ref_id: "1" });
    expect(enqueueFn.mock.calls[0][0].payload).toMatchObject({ seq: 1, prev_hash: GENESIS, actor: "system" });
  });

  it("canonicalizes payload before hashing — key order does not change the hash", async () => {
    queryFn.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const tsA = "2026-05-10T00:00:00.000Z";
    const a = await appendAuditEntry({ actor: "x", kind: "k", payload: { a: 1, b: 2 }, ts: tsA });
    queryFn.mockResolvedValueOnce([]); // reset chain for a clean second seq=1
    const b = await appendAuditEntry({ actor: "x", kind: "k", payload: { b: 2, a: 1 }, ts: tsA });
    expect(a.entry_hash).toBe(b.entry_hash);
  });
});

describe("verifyAuditChain", () => {
  async function buildChain(entries: { actor: string; kind: string; payload: Record<string, unknown>; ts: string }[]) {
    const rows: {
      seq: number; ts_utc: string; actor: string; kind: string;
      payload_json: string; prev_hash: string; entry_hash: string;
    }[] = [];
    let prev = GENESIS;
    for (let i = 0; i < entries.length; i += 1) {
      const seq = i + 1;
      const e = entries[i];
      const payload_json = canonicalJson(e.payload);
      const entry_hash = await sha256Hex(`${seq}|${e.ts}|${e.actor}|${e.kind}|${payload_json}|${prev}`);
      rows.push({ seq, ts_utc: e.ts, actor: e.actor, kind: e.kind, payload_json, prev_hash: prev, entry_hash });
      prev = entry_hash;
    }
    return rows;
  }

  it("ok when an empty chain is verified", async () => {
    queryFn.mockResolvedValueOnce([]);
    expect(await verifyAuditChain()).toEqual({ ok: true });
  });

  it("ok when a multi-entry chain is consistent", async () => {
    const rows = await buildChain([
      { actor: "system", kind: "session_start", payload: {}, ts: "2026-05-10T00:00:00.000Z" },
      { actor: "posterior", kind: "evidence.acoustic", payload: { log_lr: 0.5 }, ts: "2026-05-10T00:01:00.000Z" },
      { actor: "user", kind: "marker", payload: { idx: 1 }, ts: "2026-05-10T00:02:00.000Z" },
    ]);
    queryFn.mockResolvedValueOnce(rows);
    expect(await verifyAuditChain()).toEqual({ ok: true });
  });

  it("flags a tampered payload — entry_hash no longer matches", async () => {
    const rows = await buildChain([
      { actor: "system", kind: "ev1", payload: { v: 1 }, ts: "2026-05-10T00:00:00.000Z" },
      { actor: "system", kind: "ev2", payload: { v: 2 }, ts: "2026-05-10T00:01:00.000Z" },
    ]);
    rows[1].payload_json = JSON.stringify({ v: 999 });
    queryFn.mockResolvedValueOnce(rows);
    const result = await verifyAuditChain();
    expect(result).toEqual({ ok: false, brokenAtSeq: 2, reason: "entry_hash mismatch" });
  });

  it("flags a broken prev_hash linkage", async () => {
    const rows = await buildChain([
      { actor: "system", kind: "ev1", payload: {}, ts: "2026-05-10T00:00:00.000Z" },
      { actor: "system", kind: "ev2", payload: {}, ts: "2026-05-10T00:01:00.000Z" },
    ]);
    rows[1].prev_hash = "deadbeef".repeat(8);
    queryFn.mockResolvedValueOnce(rows);
    const result = await verifyAuditChain();
    expect(result).toEqual({ ok: false, brokenAtSeq: 2, reason: "prev_hash mismatch" });
  });

  it("flags a missing seq (chain has a gap)", async () => {
    const rows = await buildChain([
      { actor: "system", kind: "ev1", payload: {}, ts: "2026-05-10T00:00:00.000Z" },
      { actor: "system", kind: "ev2", payload: {}, ts: "2026-05-10T00:01:00.000Z" },
    ]);
    rows[1].seq = 3; // jump from 1 to 3
    queryFn.mockResolvedValueOnce(rows);
    const result = await verifyAuditChain();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.brokenAtSeq).toBe(3);
  });
});
