import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolvePreflightOverrides, runPreflight } from "./preflight";

// ---------------------------------------------------------------------------
// Navigator stub.
//
// preflight reads navigator.mediaDevices / navigator.permissions /
// navigator.storage / (navigator as any).getBattery. vitest's default
// environment is node, so we install a minimal Navigator-shaped object for
// each test and tear it down after.
// ---------------------------------------------------------------------------

interface PermissionsLike {
  query?: (descriptor: { name: string }) => Promise<{ state: "granted" | "denied" | "prompt" }>;
}
interface StorageLike { estimate?: () => Promise<{ usage?: number; quota?: number }>; }
interface MediaDevicesLike { getUserMedia?: () => Promise<MediaStream>; }
interface BatteryLike { level: number; charging: boolean; }

interface FakeNavigator {
  mediaDevices?: MediaDevicesLike;
  permissions?: PermissionsLike;
  storage?: StorageLike;
  getBattery?: () => Promise<BatteryLike>;
}

const originalNavigator = (globalThis as { navigator?: unknown }).navigator;

function installNavigator(nav: FakeNavigator) {
  vi.stubGlobal("navigator", nav);
}

beforeEach(() => {
  // Each test installs the exact navigator shape it cares about.
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalNavigator !== undefined) {
    // Restore so other tests that share this worker don't see vitest's stub.
    Object.defineProperty(globalThis, "navigator", { value: originalNavigator, configurable: true, writable: true });
  }
});

// ---------------------------------------------------------------------------
// Individual checks via runPreflight (the per-check functions are not exported)
// ---------------------------------------------------------------------------

describe("runPreflight — camera check", () => {
  it("blocks when navigator.mediaDevices.getUserMedia is missing", async () => {
    installNavigator({
      storage: { estimate: async () => ({ usage: 0, quota: 10 * 1024 * 1024 * 1024 }) },
    });
    const report = await runPreflight({ skipBattery: true });
    const camera = report.checks.find((c) => c.id === "camera");
    expect(camera?.level).toBe("block");
    expect(camera?.message).toMatch(/camera/i);
  });

  it("blocks when navigator.permissions reports camera = denied", async () => {
    installNavigator({
      mediaDevices: { getUserMedia: async () => ({} as MediaStream) },
      permissions: { query: async ({ name }) => ({ state: name === "camera" ? "denied" : "granted" }) },
      storage: { estimate: async () => ({ usage: 0, quota: 10 * 1024 * 1024 * 1024 }) },
    });
    const report = await runPreflight({ skipBattery: true });
    const camera = report.checks.find((c) => c.id === "camera");
    expect(camera?.level).toBe("block");
    expect(camera?.data?.permission).toBe("denied");
  });

  it("returns ok with unknown permission when navigator.permissions throws", async () => {
    installNavigator({
      mediaDevices: { getUserMedia: async () => ({} as MediaStream) },
      permissions: { query: async () => { throw new Error("not implemented"); } },
      storage: { estimate: async () => ({ usage: 0, quota: 10 * 1024 * 1024 * 1024 }) },
    });
    const report = await runPreflight({ skipBattery: true });
    const camera = report.checks.find((c) => c.id === "camera");
    expect(camera?.level).toBe("ok");
    expect(camera?.data?.permission).toBe("unknown");
  });

  it("ok with granted permission when navigator.permissions returns granted", async () => {
    installNavigator({
      mediaDevices: { getUserMedia: async () => ({} as MediaStream) },
      permissions: { query: async () => ({ state: "granted" }) },
      storage: { estimate: async () => ({ usage: 0, quota: 10 * 1024 * 1024 * 1024 }) },
    });
    const report = await runPreflight({ skipBattery: true });
    const camera = report.checks.find((c) => c.id === "camera");
    expect(camera?.level).toBe("ok");
    expect(camera?.data?.permission).toBe("granted");
  });
});

describe("runPreflight — mic check", () => {
  it("blocks when navigator.permissions reports microphone = denied", async () => {
    installNavigator({
      mediaDevices: { getUserMedia: async () => ({} as MediaStream) },
      permissions: { query: async ({ name }) => ({ state: name === "microphone" ? "denied" : "granted" }) },
      storage: { estimate: async () => ({ usage: 0, quota: 10 * 1024 * 1024 * 1024 }) },
    });
    const report = await runPreflight({ skipBattery: true });
    const mic = report.checks.find((c) => c.id === "mic");
    expect(mic?.level).toBe("block");
    expect(mic?.data?.permission).toBe("denied");
  });

  it("ok with unknown permission when navigator.permissions is missing entirely", async () => {
    installNavigator({
      mediaDevices: { getUserMedia: async () => ({} as MediaStream) },
      storage: { estimate: async () => ({ usage: 0, quota: 10 * 1024 * 1024 * 1024 }) },
    });
    const report = await runPreflight({ skipBattery: true });
    const mic = report.checks.find((c) => c.id === "mic");
    expect(mic?.level).toBe("ok");
    expect(mic?.data?.permission).toBe("unknown");
  });
});

describe("runPreflight — storage check", () => {
  it("blocks when free storage is under 200MB default", async () => {
    installNavigator({
      mediaDevices: { getUserMedia: async () => ({} as MediaStream) },
      // 1GB quota, 950MB used → 50MB free (under 200MB).
      storage: { estimate: async () => ({ usage: 950 * 1024 * 1024, quota: 1000 * 1024 * 1024 }) },
    });
    const report = await runPreflight({ skipBattery: true });
    const storage = report.checks.find((c) => c.id === "storage");
    expect(storage?.level).toBe("block");
    expect(storage?.message).toMatch(/MB free/);
    expect(storage?.data?.storageQuotaBytes).toBe(1000 * 1024 * 1024);
  });

  it("ok when free storage exceeds threshold", async () => {
    installNavigator({
      mediaDevices: { getUserMedia: async () => ({} as MediaStream) },
      storage: { estimate: async () => ({ usage: 100 * 1024 * 1024, quota: 10 * 1024 * 1024 * 1024 }) },
    });
    const report = await runPreflight({ skipBattery: true });
    const storage = report.checks.find((c) => c.id === "storage");
    expect(storage?.level).toBe("ok");
  });

  it("warns when storage API is unavailable but is non-blocking", async () => {
    installNavigator({
      mediaDevices: { getUserMedia: async () => ({} as MediaStream) },
      // No storage property at all.
    });
    const report = await runPreflight({ skipBattery: true });
    const storage = report.checks.find((c) => c.id === "storage");
    expect(storage?.level).toBe("warn");
  });

  it("warns when estimate() throws", async () => {
    installNavigator({
      mediaDevices: { getUserMedia: async () => ({} as MediaStream) },
      storage: { estimate: async () => { throw new Error("opaque"); } },
    });
    const report = await runPreflight({ skipBattery: true });
    const storage = report.checks.find((c) => c.id === "storage");
    expect(storage?.level).toBe("warn");
  });

  it("respects minStorageBytes override (scene-level threshold)", async () => {
    installNavigator({
      mediaDevices: { getUserMedia: async () => ({} as MediaStream) },
      // 500MB free.
      storage: { estimate: async () => ({ usage: 500 * 1024 * 1024, quota: 1000 * 1024 * 1024 }) },
    });
    // Override to require 1GB → blocks even though default would pass.
    const report = await runPreflight({ skipBattery: true, minStorageBytes: 1024 * 1024 * 1024 });
    const storage = report.checks.find((c) => c.id === "storage");
    expect(storage?.level).toBe("block");
  });

  it("emits a JSON-safe number even when quota is 0 (free=Infinity is substituted)", async () => {
    installNavigator({
      mediaDevices: { getUserMedia: async () => ({} as MediaStream) },
      storage: { estimate: async () => ({}) },
    });
    const report = await runPreflight({ skipBattery: true });
    const storage = report.checks.find((c) => c.id === "storage");
    // quota=0, usage=0 → free=Infinity, substituted to 0 for JSON safety.
    expect(storage?.data?.storageFreeBytes).toBe(0);
    // No quota → no block.
    expect(storage?.level).toBe("ok");
  });
});

describe("runPreflight — battery check", () => {
  it("warns when battery is below threshold and not charging", async () => {
    installNavigator({
      mediaDevices: { getUserMedia: async () => ({} as MediaStream) },
      storage: { estimate: async () => ({ usage: 0, quota: 10 * 1024 * 1024 * 1024 }) },
      getBattery: async () => ({ level: 0.10, charging: false }),
    });
    const report = await runPreflight();
    const battery = report.checks.find((c) => c.id === "battery");
    expect(battery?.level).toBe("warn");
    expect(battery?.data?.batteryLevel).toBe(0.10);
  });

  it("ok when low battery but charging", async () => {
    installNavigator({
      mediaDevices: { getUserMedia: async () => ({} as MediaStream) },
      storage: { estimate: async () => ({ usage: 0, quota: 10 * 1024 * 1024 * 1024 }) },
      getBattery: async () => ({ level: 0.05, charging: true }),
    });
    const report = await runPreflight();
    const battery = report.checks.find((c) => c.id === "battery");
    expect(battery?.level).toBe("ok");
    expect(battery?.message).toMatch(/charging/);
  });

  it("ok when battery API is unavailable (desktop-class device)", async () => {
    installNavigator({
      mediaDevices: { getUserMedia: async () => ({} as MediaStream) },
      storage: { estimate: async () => ({ usage: 0, quota: 10 * 1024 * 1024 * 1024 }) },
    });
    const report = await runPreflight();
    const battery = report.checks.find((c) => c.id === "battery");
    expect(battery?.level).toBe("ok");
  });

  it("skips the battery check entirely when skipBattery override is set", async () => {
    installNavigator({
      mediaDevices: { getUserMedia: async () => ({} as MediaStream) },
      storage: { estimate: async () => ({ usage: 0, quota: 10 * 1024 * 1024 * 1024 }) },
      getBattery: async () => ({ level: 0.01, charging: false }),
    });
    const report = await runPreflight({ skipBattery: true });
    expect(report.checks.find((c) => c.id === "battery")).toBeUndefined();
  });

  it("respects lowBatteryFraction override (Walkthrough warns at 30%)", async () => {
    installNavigator({
      mediaDevices: { getUserMedia: async () => ({} as MediaStream) },
      storage: { estimate: async () => ({ usage: 0, quota: 10 * 1024 * 1024 * 1024 }) },
      getBattery: async () => ({ level: 0.25, charging: false }),
    });
    const report = await runPreflight({ lowBatteryFraction: 0.3 });
    const battery = report.checks.find((c) => c.id === "battery");
    expect(battery?.level).toBe("warn");
  });
});

// ---------------------------------------------------------------------------
// Overall verdict aggregation
// ---------------------------------------------------------------------------

describe("runPreflight — overall verdict aggregation", () => {
  it("overall is 'ok' when every check is ok", async () => {
    installNavigator({
      mediaDevices: { getUserMedia: async () => ({} as MediaStream) },
      permissions: { query: async () => ({ state: "granted" }) },
      storage: { estimate: async () => ({ usage: 0, quota: 10 * 1024 * 1024 * 1024 }) },
      getBattery: async () => ({ level: 0.9, charging: true }),
    });
    const report = await runPreflight();
    expect(report.overall).toBe("ok");
  });

  it("overall is 'warn' when any check is warn (and none are block)", async () => {
    installNavigator({
      mediaDevices: { getUserMedia: async () => ({} as MediaStream) },
      permissions: { query: async () => ({ state: "granted" }) },
      // No storage → warn.
      getBattery: async () => ({ level: 0.9, charging: true }),
    });
    const report = await runPreflight();
    expect(report.overall).toBe("warn");
  });

  it("overall is 'block' when any check is block, even if others warn (block beats warn)", async () => {
    installNavigator({
      mediaDevices: { getUserMedia: async () => ({} as MediaStream) },
      permissions: { query: async ({ name }) => ({ state: name === "camera" ? "denied" : "granted" }) },
      // No storage estimate → warn — combined with a block, overall must be block.
      getBattery: async () => ({ level: 0.05, charging: false }),
    });
    const report = await runPreflight();
    expect(report.overall).toBe("block");
  });

  it("includes every check id in the report (camera, mic, storage, battery)", async () => {
    installNavigator({
      mediaDevices: { getUserMedia: async () => ({} as MediaStream) },
      permissions: { query: async () => ({ state: "granted" }) },
      storage: { estimate: async () => ({ usage: 0, quota: 10 * 1024 * 1024 * 1024 }) },
      getBattery: async () => ({ level: 0.9, charging: true }),
    });
    const report = await runPreflight();
    const ids = report.checks.map((c) => c.id).sort();
    expect(ids).toEqual(["battery", "camera", "mic", "storage"]);
  });
});

// ---------------------------------------------------------------------------
// resolvePreflightOverrides
// ---------------------------------------------------------------------------

describe("resolvePreflightOverrides — precedence", () => {
  it("returns undefined when nothing is configured (hot-path optimisation)", () => {
    expect(resolvePreflightOverrides()).toBeUndefined();
    expect(resolvePreflightOverrides(null, null)).toBeUndefined();
    expect(resolvePreflightOverrides({}, {})).toBeUndefined();
  });

  it("pref alone wins when no scene override", () => {
    const out = resolvePreflightOverrides({ lowBatteryFraction: 0.4, minStorageMb: 500 });
    expect(out).toEqual({ lowBatteryFraction: 0.4, minStorageBytes: 500 * 1024 * 1024 });
  });

  it("scene override beats pref for the same field (lowBatteryFraction)", () => {
    const out = resolvePreflightOverrides(
      { lowBatteryFraction: 0.2 },
      { lowBatteryFraction: 0.5 },
    );
    expect(out?.lowBatteryFraction).toBe(0.5);
  });

  it("scene override beats pref for the same field (minStorageBytes)", () => {
    const out = resolvePreflightOverrides(
      { minStorageMb: 100 },
      { minStorageBytes: 2 * 1024 * 1024 * 1024 },
    );
    expect(out?.minStorageBytes).toBe(2 * 1024 * 1024 * 1024);
  });

  it("scene skipBattery=true sticks even when pref didn't ask", () => {
    const out = resolvePreflightOverrides(undefined, { skipBattery: true });
    expect(out?.skipBattery).toBe(true);
  });

  it("converts minStorageMb (pref) → minStorageBytes correctly", () => {
    const out = resolvePreflightOverrides({ minStorageMb: 256 });
    expect(out?.minStorageBytes).toBe(256 * 1024 * 1024);
  });

  it("ignores null fields in the pref (treats them as 'unset')", () => {
    const out = resolvePreflightOverrides({ lowBatteryFraction: null, minStorageMb: null });
    expect(out).toBeUndefined();
  });
});
