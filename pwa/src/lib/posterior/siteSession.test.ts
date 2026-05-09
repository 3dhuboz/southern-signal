import { beforeEach, describe, expect, it, vi } from "vitest";

const { auditFn } = vi.hoisted(() => ({ auditFn: vi.fn() }));

vi.mock("../db/auditLog", () => ({ appendAuditEntry: auditFn }));

import { applyAndAudit, createSiteSession, type SiteSession } from "./siteSession";
import type { ApplyEvidenceInput } from "./posterior";

const ev = (over: Partial<ApplyEvidenceInput> = {}): ApplyEvidenceInput => ({
  channel: "acoustic",
  logLr: 1.2,
  reason: "transient at FRONT-R",
  nowMs: 1_700_000_000_000, // deterministic across runs
  metadata: { sector: "FRONT-R" },
  ...over,
});

describe("createSiteSession", () => {
  it("starts with empty recentIncrements and a zero increment count", () => {
    const s = createSiteSession();
    expect(s.recentIncrements).toEqual([]);
    expect(s.state.incrementCount).toBe(0);
  });

  it("forwards prior and decay tau into the underlying PosteriorState", () => {
    const s = createSiteSession({ prior: 0.2, decayTauSeconds: 600, nowMs: 1_700_000_000_000 });
    expect(s.state.prior).toBe(0.2);
    expect(s.state.decayTauSeconds).toBe(600);
    expect(s.state.lastUpdateMs).toBe(1_700_000_000_000);
  });
});

describe("applyAndAudit", () => {
  beforeEach(() => {
    auditFn.mockReset();
    auditFn.mockResolvedValue({ seq: 1, ts_utc: "x", prev_hash: "0".repeat(64), entry_hash: "h" });
  });

  it("returns a new session with the increment appended (no mutation of input)", async () => {
    const initial = createSiteSession({ nowMs: 1_700_000_000_000 });
    const before = JSON.stringify(initial);
    const { session: next } = await applyAndAudit(initial, ev());
    expect(JSON.stringify(initial)).toBe(before); // input untouched
    expect(next.recentIncrements).toHaveLength(1);
    expect(next.recentIncrements[0].channel).toBe("acoustic");
    expect(next.state.incrementCount).toBe(1);
  });

  it("caps recentIncrements at 12 (sliding window)", async () => {
    let s: SiteSession = createSiteSession({ nowMs: 1_700_000_000_000 });
    for (let i = 0; i < 15; i += 1) {
      const out = await applyAndAudit(s, ev({ logLr: 0.05, nowMs: 1_700_000_000_000 + i * 1000 }));
      s = out.session;
    }
    expect(s.recentIncrements).toHaveLength(12);
    expect(s.state.incrementCount).toBe(15);
  });

  it("writes an audit entry with the full before/after telemetry", async () => {
    const initial = createSiteSession({ prior: 0.05, nowMs: 1_700_000_000_000 });
    await applyAndAudit(initial, ev({ logLr: 1.5, reason: "spike" }));
    expect(auditFn).toHaveBeenCalledTimes(1);
    const entry = auditFn.mock.calls[0][0];
    expect(entry.actor).toBe("posterior");
    expect(entry.kind).toBe("evidence.acoustic");
    expect(entry.payload).toMatchObject({
      channel: "acoustic",
      log_lr: 1.5,
      reason: "spike",
      capped: false,
      metadata: { sector: "FRONT-R" },
    });
    expect(typeof entry.payload.logit_before).toBe("number");
    expect(typeof entry.payload.logit_after).toBe("number");
    expect(entry.payload.posterior_after).toBeGreaterThan(entry.payload.posterior_before);
  });

  it("flags capped=true when |log_lr| exceeds the hard ceiling", async () => {
    const initial = createSiteSession({ nowMs: 1_700_000_000_000 });
    const result = await applyAndAudit(initial, ev({ logLr: 9.5 }));
    expect(result.capped).toBe(true);
    expect(auditFn.mock.calls[0][0].payload.capped).toBe(true);
    // The recorded log_lr in the audit reflects the CAPPED value, not raw.
    expect(auditFn.mock.calls[0][0].payload.log_lr).toBeLessThanOrEqual(4);
  });

  it("emits an ISO timestamp matching the increment's ts", async () => {
    const initial = createSiteSession({ nowMs: 1_700_000_000_000 });
    const at = 1_700_000_010_000;
    await applyAndAudit(initial, ev({ nowMs: at }));
    expect(auditFn.mock.calls[0][0].ts).toBe(new Date(at).toISOString());
  });

  it("uses the channel name in audit kind so per-channel queries work", async () => {
    const initial = createSiteSession({ nowMs: 1_700_000_000_000 });
    await applyAndAudit(initial, ev({ channel: "infrasound" }));
    await applyAndAudit(initial, ev({ channel: "magnetometer" }));
    expect(auditFn.mock.calls[0][0].kind).toBe("evidence.infrasound");
    expect(auditFn.mock.calls[1][0].kind).toBe("evidence.magnetometer");
  });

  it("propagates a hostile-write rejection (audit-chain integrity is non-negotiable)", async () => {
    auditFn.mockRejectedValueOnce(new Error("integrity violation"));
    const initial = createSiteSession({ nowMs: 1_700_000_000_000 });
    await expect(applyAndAudit(initial, ev())).rejects.toThrow(/integrity violation/);
  });
});
