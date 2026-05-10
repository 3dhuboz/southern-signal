import { beforeEach, describe, expect, it, vi } from "vitest";

const { storage } = vi.hoisted(() => {
  const map = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
  return { storage };
});

vi.stubGlobal("localStorage", storage);

import {
  baselineStorageKey,
  clearBaseline,
  createBaselineCapture,
  loadBaseline,
  saveBaseline,
  type BaselineSummary,
} from "./sessionBaseline";

const INV_ID = "inv-test-0001";

describe("createBaselineCapture", () => {
  it("starts in idle and transitions through capturing → completed", () => {
    const ctrl = createBaselineCapture();
    expect(ctrl.state()).toBe("idle");
    ctrl.start();
    expect(ctrl.state()).toBe("capturing");
    ctrl.stop();
    expect(ctrl.state()).toBe("completed");
  });

  it("ignores pushSample calls when not capturing", () => {
    const ctrl = createBaselineCapture();
    ctrl.pushSample({ audioRms: 0.5, emfMagnitude: 25 });
    expect(ctrl.sampleCount()).toBe(0);
    ctrl.start();
    ctrl.pushSample({ audioRms: 0.5, emfMagnitude: 25 });
    expect(ctrl.sampleCount()).toBe(1);
    ctrl.stop();
    ctrl.pushSample({ audioRms: 0.9, emfMagnitude: 99 });
    expect(ctrl.sampleCount()).toBe(1); // unchanged
  });

  it("calls onSample for every accepted sample with the running count", () => {
    const ctrl = createBaselineCapture();
    const onSample = vi.fn();
    ctrl.start({ onSample });
    ctrl.pushSample({ audioRms: 0.1, emfMagnitude: 10 });
    ctrl.pushSample({ audioRms: 0.2, emfMagnitude: 20 });
    expect(onSample).toHaveBeenCalledTimes(2);
    expect(onSample.mock.calls[0][1]).toBe(1);
    expect(onSample.mock.calls[1][1]).toBe(2);
  });

  it("computes mean / p95 / max correctly across captured audio samples", () => {
    const ctrl = createBaselineCapture();
    ctrl.start();
    // 20 samples 0.01..0.20 — sorted index for p95: floor(0.95 * 19) = 18 → 0.19
    for (let i = 1; i <= 20; i += 1) {
      ctrl.pushSample({ audioRms: i / 100, emfMagnitude: i });
    }
    ctrl.stop();
    const summary = ctrl.summarize();
    expect(summary.sampleCount).toBe(20);
    // mean of 0.01..0.20 = 0.105
    expect(summary.audioRmsMean).toBeCloseTo(0.105, 6);
    // p95 = sample at sorted index floor(0.95 * (20-1)) = 18 → 0.19
    expect(summary.audioRmsP95).toBeCloseTo(0.19, 6);
    expect(summary.audioRmsMax).toBeCloseTo(0.20, 6);
    // EMF same indices, scaled: mean of 1..20 = 10.5
    expect(summary.emfMean).toBeCloseTo(10.5, 6);
    expect(summary.emfP95).toBeCloseTo(19, 6);
    expect(summary.emfMax).toBeCloseTo(20, 6);
  });

  it("p95 returns the only sample for n=1 (idx = floor(0.95 * 0) = 0)", () => {
    const ctrl = createBaselineCapture();
    ctrl.start();
    ctrl.pushSample({ audioRms: 0.42, emfMagnitude: 7 });
    ctrl.stop();
    const summary = ctrl.summarize();
    expect(summary.audioRmsP95).toBe(0.42);
    expect(summary.audioRmsMax).toBe(0.42);
    expect(summary.audioRmsMean).toBe(0.42);
  });

  it("p95 picks an actual observed sample (not interpolated)", () => {
    const ctrl = createBaselineCapture();
    ctrl.start();
    // 100 samples 0..99 — floor(0.95 * 99) = 94 → 94
    for (let i = 0; i < 100; i += 1) {
      ctrl.pushSample({ audioRms: i, emfMagnitude: i });
    }
    ctrl.stop();
    const summary = ctrl.summarize();
    expect(summary.audioRmsP95).toBe(94);
    expect(summary.emfP95).toBe(94);
  });

  it("ignores null EMF readings but still records audio (devices without magnetometer)", () => {
    const ctrl = createBaselineCapture();
    ctrl.start();
    ctrl.pushSample({ audioRms: 0.1, emfMagnitude: null });
    ctrl.pushSample({ audioRms: 0.2, emfMagnitude: null });
    ctrl.stop();
    const summary = ctrl.summarize();
    expect(summary.sampleCount).toBe(2);
    expect(summary.audioRmsMean).toBeCloseTo(0.15, 6);
    // No EMF samples at all → mean / p95 / max all 0.
    expect(summary.emfMean).toBe(0);
    expect(summary.emfP95).toBe(0);
    expect(summary.emfMax).toBe(0);
  });

  it("throws if summarize is called before any sample is captured", () => {
    const ctrl = createBaselineCapture();
    ctrl.start();
    expect(() => ctrl.summarize()).toThrow(/no samples/i);
  });

  it("emits an ISO-8601 capturedAt timestamp", () => {
    const ctrl = createBaselineCapture();
    ctrl.start();
    ctrl.pushSample({ audioRms: 0.1, emfMagnitude: 5 });
    ctrl.stop();
    const summary = ctrl.summarize();
    expect(summary.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(new Date(summary.capturedAt).toString()).not.toBe("Invalid Date");
  });
});

describe("baseline localStorage round-trip", () => {
  beforeEach(() => {
    storage.clear();
  });

  it("returns null when nothing is stored", () => {
    expect(loadBaseline(INV_ID)).toBeNull();
  });

  it("save → load round-trips a summary verbatim", () => {
    const summary: BaselineSummary = {
      audioRmsMean: 0.12,
      audioRmsP95: 0.31,
      audioRmsMax: 0.44,
      emfMean: 22.5,
      emfP95: 38.1,
      emfMax: 41.0,
      durationSeconds: 90,
      sampleCount: 540,
      capturedAt: "2026-05-10T12:34:56.000Z",
    };
    saveBaseline(INV_ID, summary);
    const loaded = loadBaseline(INV_ID);
    expect(loaded).toEqual(summary);
  });

  it("uses the documented ss-baseline-<investigationId> key shape", () => {
    const summary: BaselineSummary = {
      audioRmsMean: 0.05,
      audioRmsP95: 0.05,
      audioRmsMax: 0.05,
      emfMean: 0,
      emfP95: 0,
      emfMax: 0,
      durationSeconds: 1,
      sampleCount: 1,
      capturedAt: "2026-05-10T00:00:00.000Z",
    };
    saveBaseline(INV_ID, summary);
    expect(baselineStorageKey(INV_ID)).toBe(`ss-baseline-${INV_ID}`);
    expect(storage.getItem(`ss-baseline-${INV_ID}`)).toBeTruthy();
  });

  it("returns null and does not throw for malformed JSON", () => {
    storage.setItem(baselineStorageKey(INV_ID), "{not-json");
    expect(loadBaseline(INV_ID)).toBeNull();
  });

  it("returns null for valid JSON missing required fields", () => {
    storage.setItem(baselineStorageKey(INV_ID), JSON.stringify({ foo: "bar" }));
    expect(loadBaseline(INV_ID)).toBeNull();
  });

  it("clearBaseline removes a stored entry", () => {
    const summary: BaselineSummary = {
      audioRmsMean: 0.05,
      audioRmsP95: 0.05,
      audioRmsMax: 0.05,
      emfMean: 0,
      emfP95: 0,
      emfMax: 0,
      durationSeconds: 1,
      sampleCount: 1,
      capturedAt: "2026-05-10T00:00:00.000Z",
    };
    saveBaseline(INV_ID, summary);
    expect(loadBaseline(INV_ID)).not.toBeNull();
    clearBaseline(INV_ID);
    expect(loadBaseline(INV_ID)).toBeNull();
  });

  it("scopes baselines per investigation id", () => {
    const a: BaselineSummary = {
      audioRmsMean: 0.10, audioRmsP95: 0.10, audioRmsMax: 0.10,
      emfMean: 0, emfP95: 0, emfMax: 0,
      durationSeconds: 1, sampleCount: 1, capturedAt: "2026-05-10T00:00:00.000Z",
    };
    const b: BaselineSummary = { ...a, audioRmsMean: 0.99 };
    saveBaseline("case-a", a);
    saveBaseline("case-b", b);
    expect(loadBaseline("case-a")?.audioRmsMean).toBe(0.10);
    expect(loadBaseline("case-b")?.audioRmsMean).toBe(0.99);
  });

  it("ignores empty investigation id (defensive against unset session.current)", () => {
    const summary: BaselineSummary = {
      audioRmsMean: 0.1, audioRmsP95: 0.1, audioRmsMax: 0.1,
      emfMean: 0, emfP95: 0, emfMax: 0,
      durationSeconds: 1, sampleCount: 1, capturedAt: "2026-05-10T00:00:00.000Z",
    };
    saveBaseline("", summary);
    expect(loadBaseline("")).toBeNull();
  });
});
