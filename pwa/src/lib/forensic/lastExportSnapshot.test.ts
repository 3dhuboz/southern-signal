import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// localStorage isn't available in the default Node test environment. Use the
// same in-memory stub pattern as sessionBaseline.test.ts.
// ---------------------------------------------------------------------------

const { storage } = vi.hoisted(() => {
  const map = new Map<string, string>();
  const s: Storage = {
    get length() { return map.size; },
    clear() { map.clear(); },
    getItem(key: string) { return map.has(key) ? (map.get(key) as string) : null; },
    key(index: number) { return Array.from(map.keys())[index] ?? null; },
    removeItem(key: string) { map.delete(key); },
    setItem(key: string, value: string) { map.set(key, String(value)); },
  };
  return { storage: s };
});

vi.stubGlobal("localStorage", storage);

import {
  saveLastExportSnapshot,
  loadLastExportSnapshot,
  clearLastExportSnapshot,
  compareAgainstSnapshot,
  type LastExportSnapshot,
} from "./lastExportSnapshot";

const STORAGE_KEY = "ss-last-export-snapshot-v1";

function makeSnapshot(overrides: Partial<LastExportSnapshot> = {}): LastExportSnapshot {
  return {
    exportedAt: "2026-05-19T12:00:00Z",
    chainLength: 3,
    merkleRoot: "a".repeat(64),
    hashesBySeq: { 1: "h1".padEnd(64, "0"), 2: "h2".padEnd(64, "0"), 3: "h3".padEnd(64, "0") },
    bundleLabel: "southern-signal-bundle-2026-05-19.zip",
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("saveLastExportSnapshot / loadLastExportSnapshot — round trip", () => {
  it("round-trips a snapshot via localStorage", () => {
    const snap = makeSnapshot();
    saveLastExportSnapshot(snap);
    const loaded = loadLastExportSnapshot();
    expect(loaded).toEqual(snap);
  });

  it("returns null when no snapshot has been saved", () => {
    expect(loadLastExportSnapshot()).toBeNull();
  });

  it("persists under the versioned storage key", () => {
    saveLastExportSnapshot(makeSnapshot());
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it("overwrites the previous snapshot when called twice", () => {
    saveLastExportSnapshot(makeSnapshot({ chainLength: 1, bundleLabel: "first.zip" }));
    saveLastExportSnapshot(makeSnapshot({ chainLength: 5, bundleLabel: "second.zip" }));
    const loaded = loadLastExportSnapshot();
    expect(loaded?.chainLength).toBe(5);
    expect(loaded?.bundleLabel).toBe("second.zip");
  });

  it("handles a null merkleRoot (empty chain at export time)", () => {
    saveLastExportSnapshot(makeSnapshot({ merkleRoot: null, chainLength: 0, hashesBySeq: {} }));
    const loaded = loadLastExportSnapshot();
    expect(loaded?.merkleRoot).toBeNull();
    expect(loaded?.chainLength).toBe(0);
  });
});

describe("loadLastExportSnapshot — defensive parsing", () => {
  it("returns null when the stored JSON is malformed", () => {
    localStorage.setItem(STORAGE_KEY, "{not valid json");
    expect(loadLastExportSnapshot()).toBeNull();
  });

  it("returns null when exportedAt is missing/wrong type", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ chainLength: 1, hashesBySeq: {} }));
    expect(loadLastExportSnapshot()).toBeNull();
  });

  it("returns null when chainLength is missing/wrong type", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ exportedAt: "2026-05-19T...", hashesBySeq: {} }));
    expect(loadLastExportSnapshot()).toBeNull();
  });

  it("returns null when hashesBySeq is not an object", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      exportedAt: "...", chainLength: 1, merkleRoot: null, hashesBySeq: "nope",
    }));
    expect(loadLastExportSnapshot()).toBeNull();
  });

  it("returns null when merkleRoot is the wrong type (e.g. number)", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      exportedAt: "...", chainLength: 1, merkleRoot: 42, hashesBySeq: {},
    }));
    expect(loadLastExportSnapshot()).toBeNull();
  });
});

describe("clearLastExportSnapshot", () => {
  it("removes a saved snapshot", () => {
    saveLastExportSnapshot(makeSnapshot());
    expect(loadLastExportSnapshot()).not.toBeNull();
    clearLastExportSnapshot();
    expect(loadLastExportSnapshot()).toBeNull();
  });

  it("is a no-op when no snapshot exists", () => {
    expect(() => clearLastExportSnapshot()).not.toThrow();
  });
});

describe("compareAgainstSnapshot", () => {
  it("reports matches=true when every common-seq hash matches", () => {
    const snap = makeSnapshot();
    const current = new Map(Object.entries(snap.hashesBySeq).map(([k, v]) => [Number(k), v]));
    const cmp = compareAgainstSnapshot(snap, current);
    expect(cmp.matches).toBe(true);
    expect(cmp.firstDivergenceSeq).toBeNull();
    expect(cmp.missingFromCurrent).toBe(0);
    expect(cmp.appendedSinceExport).toBe(0);
    expect(cmp.comparedCount).toBe(3);
  });

  it("flags the FIRST divergence and reports matches=false", () => {
    const snap = makeSnapshot();
    const current = new Map([
      [1, snap.hashesBySeq[1]],
      [2, "different".padEnd(64, "0")],
      [3, "also-different".padEnd(64, "0")],
    ]);
    const cmp = compareAgainstSnapshot(snap, current);
    expect(cmp.matches).toBe(false);
    expect(cmp.firstDivergenceSeq).toBe(2);
    expect(cmp.comparedCount).toBe(3);
  });

  it("counts appendedSinceExport for entries added after the export", () => {
    const snap = makeSnapshot({ chainLength: 3 });
    const current = new Map([
      [1, snap.hashesBySeq[1]],
      [2, snap.hashesBySeq[2]],
      [3, snap.hashesBySeq[3]],
      [4, "new-entry-4".padEnd(64, "0")],
      [5, "new-entry-5".padEnd(64, "0")],
    ]);
    const cmp = compareAgainstSnapshot(snap, current);
    expect(cmp.matches).toBe(true);
    expect(cmp.appendedSinceExport).toBe(2);
  });

  it("counts missingFromCurrent when the current chain is shorter than the snapshot", () => {
    const snap = makeSnapshot({ chainLength: 3 });
    const current = new Map([
      [1, snap.hashesBySeq[1]],
      // seq 2 and 3 are missing entirely.
    ]);
    const cmp = compareAgainstSnapshot(snap, current);
    expect(cmp.matches).toBe(false);
    expect(cmp.missingFromCurrent).toBe(2);
    expect(cmp.comparedCount).toBe(1);
  });
});
