/**
 * Trust-boundary tests for cloudAi.ts.
 *
 * The cultural-sensitivity gate is a fail-CLOSED hard wall: any uncertainty
 * (DB throws, row missing, preferences blob corrupted, ctx flag missing) must
 * REFUSE cloud routing. These tests pin that contract — if anyone introduces
 * a try/catch that swallows-and-allows, this suite breaks the build.
 *
 * The PWA is used at Indigenous sites in Australia. There is no acceptable
 * "optimistic transmit" path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// db.query is the auth call we control. Mock it before importing cloudAi.
vi.mock("../db/db", () => ({
  query: vi.fn(),
}));
vi.mock("../preferences", () => ({
  getPreferences: vi.fn(),
}));

import { query } from "../db/db";
import { getPreferences } from "../preferences";
import { CloudGuardError, ensureRoutable, isInvestigationSensitive } from "./cloudAi";

const queryMock = query as unknown as ReturnType<typeof vi.fn>;
const prefsMock = getPreferences as unknown as ReturnType<typeof vi.fn>;

const SAFE_PREFS = {
  globalCulturalSensitivityFlag: false,
} as unknown as ReturnType<typeof getPreferences>;

beforeEach(() => {
  queryMock.mockReset();
  prefsMock.mockReset();
  prefsMock.mockReturnValue(SAFE_PREFS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isInvestigationSensitive — fail-CLOSED contract", () => {
  it("returns true when investigationId is missing", async () => {
    expect(await isInvestigationSensitive("")).toBe(true);
    expect(await isInvestigationSensitive(undefined as unknown as string)).toBe(true);
    expect(await isInvestigationSensitive(null as unknown as string)).toBe(true);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns true when query throws", async () => {
    queryMock.mockRejectedValueOnce(new Error("db offline"));
    expect(await isInvestigationSensitive("inv-1")).toBe(true);
  });

  it("returns true when no row is found (stale or unsaved id)", async () => {
    queryMock.mockResolvedValueOnce([]);
    expect(await isInvestigationSensitive("inv-missing")).toBe(true);
  });

  it("returns true when the row exists but the flag is null/undefined", async () => {
    queryMock.mockResolvedValueOnce([{ culturally_sensitive: null }]);
    expect(await isInvestigationSensitive("inv-1")).toBe(true);
  });

  it("returns true when the row has culturally_sensitive=1", async () => {
    queryMock.mockResolvedValueOnce([{ culturally_sensitive: 1 }]);
    expect(await isInvestigationSensitive("inv-1")).toBe(true);
  });

  it("returns true when the row has culturally_sensitive=1n (bigint)", async () => {
    queryMock.mockResolvedValueOnce([{ culturally_sensitive: 1n }]);
    expect(await isInvestigationSensitive("inv-1")).toBe(true);
  });

  it("returns false ONLY when the row exists and the flag is explicit 0", async () => {
    queryMock.mockResolvedValueOnce([{ culturally_sensitive: 0 }]);
    expect(await isInvestigationSensitive("inv-1")).toBe(false);
  });
});

describe("ensureRoutable — fail-CLOSED gate", () => {
  it("throws when ctx.culturallySensitive is true (even if DB is clean)", async () => {
    queryMock.mockResolvedValueOnce([{ culturally_sensitive: 0 }]);
    await expect(
      ensureRoutable({ investigationId: "inv-1", culturallySensitive: true }),
    ).rejects.toBeInstanceOf(CloudGuardError);
  });

  it("throws when global pref flag is true", async () => {
    queryMock.mockResolvedValueOnce([{ culturally_sensitive: 0 }]);
    prefsMock.mockReturnValue({ globalCulturalSensitivityFlag: true });
    await expect(
      ensureRoutable({ investigationId: "inv-1", culturallySensitive: false }),
    ).rejects.toBeInstanceOf(CloudGuardError);
  });

  it("throws when DB row says culturally_sensitive=1 (per-case)", async () => {
    queryMock.mockResolvedValueOnce([{ culturally_sensitive: 1 }]);
    await expect(
      ensureRoutable({ investigationId: "inv-1", culturallySensitive: false }),
    ).rejects.toBeInstanceOf(CloudGuardError);
  });

  it("throws when DB row is missing (could be stale id)", async () => {
    queryMock.mockResolvedValueOnce([]);
    await expect(
      ensureRoutable({ investigationId: "inv-1", culturallySensitive: false }),
    ).rejects.toBeInstanceOf(CloudGuardError);
  });

  it("throws when DB query itself throws", async () => {
    queryMock.mockRejectedValueOnce(new Error("db boom"));
    await expect(
      ensureRoutable({ investigationId: "inv-1", culturallySensitive: false }),
    ).rejects.toBeInstanceOf(CloudGuardError);
  });

  it("throws when getPreferences throws (corrupted blob)", async () => {
    queryMock.mockResolvedValueOnce([{ culturally_sensitive: 0 }]);
    prefsMock.mockImplementation(() => { throw new Error("storage unavailable"); });
    await expect(
      ensureRoutable({ investigationId: "inv-1", culturallySensitive: false }),
    ).rejects.toBeInstanceOf(CloudGuardError);
  });

  it("throws when prefs returns a shape where globalCulturalSensitivityFlag is undefined", async () => {
    queryMock.mockResolvedValueOnce([{ culturally_sensitive: 0 }]);
    prefsMock.mockReturnValue({} as unknown as ReturnType<typeof getPreferences>);
    await expect(
      ensureRoutable({ investigationId: "inv-1", culturallySensitive: false }),
    ).rejects.toBeInstanceOf(CloudGuardError);
  });

  it("throws when investigationId is empty string", async () => {
    await expect(
      ensureRoutable({ investigationId: "", culturallySensitive: false }),
    ).rejects.toBeInstanceOf(CloudGuardError);
  });

  it("permits routing ONLY when every signal is explicit-clean", async () => {
    queryMock.mockResolvedValueOnce([{ culturally_sensitive: 0 }]);
    prefsMock.mockReturnValue({ globalCulturalSensitivityFlag: false });
    await expect(
      ensureRoutable({ investigationId: "inv-1", culturallySensitive: false }),
    ).resolves.toBeUndefined();
  });
});
