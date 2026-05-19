/**
 * Adversarial regression tests for the fail-CLOSED cultural-sensitivity
 * gate (src/lib/ai/cloudAi.ts — commit 72b4235).
 *
 * Threat model the fix closes:
 *
 *   Southern Signal is deployed at Indigenous sites in Australia. The
 *   cultural-sensitivity flag on an investigation is the policy boundary
 *   that decides whether audio and notes from that case may EVER be
 *   transmitted off-device to a cloud LLM. Failing OPEN (treating
 *   ambiguity as "not sensitive, route it") is a policy violation, not a
 *   bug.
 *
 *   Every place the gate could read "false" or fall through MUST be
 *   tested. A regression that adds a `try { ... } catch { return false }`
 *   anywhere inside isInvestigationSensitive — or that returns when the
 *   row isn't found, or that coerces NULL to 0 — would silently relax
 *   the policy in production. There is no acceptable "optimistic
 *   transmit" path.
 *
 * The existing cloudAi.test.ts pins the happy-path contract. This file
 * is the attacker / failure-mode sibling: each test simulates a state
 * where a NAIVE implementation would route despite the fail-closed
 * contract. Specifically:
 *
 *   1. culturally_sensitive column is missing from the row (older DB).
 *   2. DB query throws (worker dead, OPFS quota, mid-init race).
 *   3. Row doesn't exist (stale id from URL, race with case creation).
 *   4. preferences blob is corrupt (truthy non-bool, throws on read).
 *   5. investigationId is empty/whitespace/non-string-ish.
 *
 * In every case the gate MUST refuse cloud routing. We assert by mocking
 * the db module (so each test can simulate the DB state independently)
 * and calling the public surface (isInvestigationSensitive +
 * ensureRoutable).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the boundaries the gate consults. We import the implementation
// AFTER vi.mock so the gate sees the mocked db.query / getPreferences.
vi.mock("../lib/db/db", () => ({
  query: vi.fn(),
}));
vi.mock("../lib/preferences", () => ({
  getPreferences: vi.fn(),
}));

import { query } from "../lib/db/db";
import { getPreferences } from "../lib/preferences";
import {
  CloudGuardError,
  ensureRoutable,
  isInvestigationSensitive,
} from "../lib/ai/cloudAi";

const queryMock = query as unknown as ReturnType<typeof vi.fn>;
const prefsMock = getPreferences as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  queryMock.mockReset();
  // Default prefs blob — explicit clean. Adversarial tests override.
  prefsMock.mockReset().mockReturnValue({ globalCulturalSensitivityFlag: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Adversarial: isInvestigationSensitive — fail-CLOSED under all uncertainty
// ---------------------------------------------------------------------------

describe("isInvestigationSensitive — adversarial: DB returns ambiguous shapes", () => {
  it("attacker passes empty string id → returns true WITHOUT querying DB", async () => {
    // A bug that lets through "" would let an attacker (or a UI race
    // condition) ship audio without ever consulting the DB. The gate
    // refuses up-front.
    expect(await isInvestigationSensitive("")).toBe(true);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("attacker passes undefined id → returns true WITHOUT querying DB", async () => {
    expect(await isInvestigationSensitive(undefined as unknown as string)).toBe(true);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("attacker passes null id → returns true WITHOUT querying DB", async () => {
    expect(await isInvestigationSensitive(null as unknown as string)).toBe(true);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("attacker passes a numeric id (wrong type) → returns true WITHOUT querying DB", async () => {
    // A future regression that uses `if (!investigationId)` instead of
    // explicit string-check would skip the guard here. Pin the explicit
    // string requirement.
    expect(await isInvestigationSensitive(42 as unknown as string)).toBe(true);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("DB transient failure (worker dead) → query throws → returns true", async () => {
    queryMock.mockRejectedValueOnce(new Error("sqlite worker error: timed out"));
    expect(await isInvestigationSensitive("inv-1")).toBe(true);
  });

  it("DB query rejects with a non-Error (string thrown) → returns true", async () => {
    // A throw-of-something-non-Error is rare but legal JS. The catch
    // must not assume `err instanceof Error`.
    queryMock.mockRejectedValueOnce("boom");
    expect(await isInvestigationSensitive("inv-1")).toBe(true);
  });

  it("row not found (stale id; case deleted; race with creation) → returns true", async () => {
    queryMock.mockResolvedValueOnce([]);
    expect(await isInvestigationSensitive("inv-stale")).toBe(true);
  });

  it("row exists but culturally_sensitive column is NULL (legacy DB / column missing) → returns true", async () => {
    queryMock.mockResolvedValueOnce([{ culturally_sensitive: null }]);
    expect(await isInvestigationSensitive("inv-1")).toBe(true);
  });

  it("row exists but culturally_sensitive is undefined (sqlite returned no key) → returns true", async () => {
    queryMock.mockResolvedValueOnce([{} as { culturally_sensitive: number }]);
    expect(await isInvestigationSensitive("inv-1")).toBe(true);
  });

  it("row has culturally_sensitive=1n (bigint, as sqlite-wasm sometimes returns) → returns true", async () => {
    queryMock.mockResolvedValueOnce([{ culturally_sensitive: 1n }]);
    expect(await isInvestigationSensitive("inv-1")).toBe(true);
  });

  it("row has culturally_sensitive='1' as a STRING (driver mis-coercion) → returns true (Number('1') === 1)", async () => {
    queryMock.mockResolvedValueOnce([{ culturally_sensitive: "1" as unknown as number }]);
    expect(await isInvestigationSensitive("inv-1")).toBe(true);
  });

  it("query returns null/undefined (driver glitch) → returns true", async () => {
    queryMock.mockResolvedValueOnce(null as unknown as []);
    expect(await isInvestigationSensitive("inv-1")).toBe(true);
  });

  it("ONLY route returns false: row exists with culturally_sensitive=0 (explicit clean)", async () => {
    // This is the single, explicit, type-coerced path that's allowed
    // through. If a future refactor adds another path (e.g. accepts
    // string "false"), the test count diverges from explicit-clean.
    queryMock.mockResolvedValueOnce([{ culturally_sensitive: 0 }]);
    expect(await isInvestigationSensitive("inv-1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Adversarial: ensureRoutable — corrupt prefs blob
// ---------------------------------------------------------------------------

describe("ensureRoutable — adversarial: corrupt preferences blob", () => {
  it("prefs read throws (storage offline / quota / corrupted JSON) → throws CloudGuardError", async () => {
    // Even though the DB says clean and ctx says clean, an unreadable
    // prefs blob means we don't KNOW the global cultural-sensitivity
    // flag. Fail closed.
    queryMock.mockResolvedValueOnce([{ culturally_sensitive: 0 }]);
    prefsMock.mockImplementation(() => {
      throw new Error("localStorage is disabled in private browsing");
    });
    await expect(
      ensureRoutable({ investigationId: "inv-1", culturallySensitive: false }),
    ).rejects.toBeInstanceOf(CloudGuardError);
  });

  it("prefs returns an empty object (missing globalCulturalSensitivityFlag key) → throws", async () => {
    // A partial blob would leave globalCulturalSensitivityFlag undefined.
    // The implementation coerces `!== false` → true → throws. Pin it.
    queryMock.mockResolvedValueOnce([{ culturally_sensitive: 0 }]);
    prefsMock.mockReturnValue({} as unknown as ReturnType<typeof getPreferences>);
    await expect(
      ensureRoutable({ investigationId: "inv-1", culturallySensitive: false }),
    ).rejects.toBeInstanceOf(CloudGuardError);
  });

  it("prefs returns null (catastrophic localStorage corruption) → throws", async () => {
    // A null prefs object would crash `prefs.globalCulturalSensitivityFlag`
    // with TypeError on a naive implementation. The gate guards with `?.`
    // → undefined → !== false → true → throws.
    queryMock.mockResolvedValueOnce([{ culturally_sensitive: 0 }]);
    prefsMock.mockReturnValue(null as unknown as ReturnType<typeof getPreferences>);
    await expect(
      ensureRoutable({ investigationId: "inv-1", culturallySensitive: false }),
    ).rejects.toBeInstanceOf(CloudGuardError);
  });

  it("prefs returns globalCulturalSensitivityFlag = 'false' (string, not boolean) → throws (strict !==)", async () => {
    // Any future patch that does `Boolean(flag)` instead of strict
    // `!== false` would let the string 'false' (truthy!) through as if
    // it meant 'don't be sensitive'. The strict comparison treats this
    // as 'unknown' → throws. Pin the strictness.
    queryMock.mockResolvedValueOnce([{ culturally_sensitive: 0 }]);
    prefsMock.mockReturnValue({
      globalCulturalSensitivityFlag: "false" as unknown as boolean,
    } as unknown as ReturnType<typeof getPreferences>);
    await expect(
      ensureRoutable({ investigationId: "inv-1", culturallySensitive: false }),
    ).rejects.toBeInstanceOf(CloudGuardError);
  });

  it("prefs returns globalCulturalSensitivityFlag = 0 (numeric falsy, not boolean false) → throws (strict !==)", async () => {
    queryMock.mockResolvedValueOnce([{ culturally_sensitive: 0 }]);
    prefsMock.mockReturnValue({
      globalCulturalSensitivityFlag: 0 as unknown as boolean,
    } as unknown as ReturnType<typeof getPreferences>);
    await expect(
      ensureRoutable({ investigationId: "inv-1", culturallySensitive: false }),
    ).rejects.toBeInstanceOf(CloudGuardError);
  });
});

// ---------------------------------------------------------------------------
// Adversarial: ensureRoutable — any single signal positive must veto
// ---------------------------------------------------------------------------

describe("ensureRoutable — adversarial: each individual signal vetoes", () => {
  it("DB says sensitive (1) — ctx and prefs clean — still throws", async () => {
    queryMock.mockResolvedValueOnce([{ culturally_sensitive: 1 }]);
    await expect(
      ensureRoutable({ investigationId: "inv-1", culturallySensitive: false }),
    ).rejects.toBeInstanceOf(CloudGuardError);
  });

  it("ctx says sensitive — DB and prefs clean — still throws (caller-passed flag)", async () => {
    // Even if the DB hasn't been updated yet (mid-toggle), the caller
    // passing culturallySensitive: true should refuse routing.
    queryMock.mockResolvedValueOnce([{ culturally_sensitive: 0 }]);
    await expect(
      ensureRoutable({ investigationId: "inv-1", culturallySensitive: true }),
    ).rejects.toBeInstanceOf(CloudGuardError);
  });

  it("global pref says sensitive — DB and ctx clean — still throws", async () => {
    queryMock.mockResolvedValueOnce([{ culturally_sensitive: 0 }]);
    prefsMock.mockReturnValue({ globalCulturalSensitivityFlag: true });
    await expect(
      ensureRoutable({ investigationId: "inv-1", culturallySensitive: false }),
    ).rejects.toBeInstanceOf(CloudGuardError);
  });

  it("DB query throws — ctx and prefs clean — still throws (DB uncertainty propagates)", async () => {
    queryMock.mockRejectedValueOnce(new Error("opfs sahpool dead"));
    await expect(
      ensureRoutable({ investigationId: "inv-1", culturallySensitive: false }),
    ).rejects.toBeInstanceOf(CloudGuardError);
  });

  it("DB returns no row — ctx and prefs clean — still throws (stale id)", async () => {
    queryMock.mockResolvedValueOnce([]);
    await expect(
      ensureRoutable({ investigationId: "inv-1", culturallySensitive: false }),
    ).rejects.toBeInstanceOf(CloudGuardError);
  });

  it("investigationId empty — anything else clean — still throws (cannot verify a flag against no id)", async () => {
    await expect(
      ensureRoutable({ investigationId: "", culturallySensitive: false }),
    ).rejects.toBeInstanceOf(CloudGuardError);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Sanity: the only-explicit-clean path actually permits routing.
// If THIS is red, every rejection above could be a false positive.
// ---------------------------------------------------------------------------

describe("ensureRoutable — permits ONLY when every signal is explicit-clean", () => {
  it("DB=0, ctx=false, prefs.globalCulturalSensitivityFlag === false → resolves", async () => {
    queryMock.mockResolvedValueOnce([{ culturally_sensitive: 0 }]);
    prefsMock.mockReturnValue({ globalCulturalSensitivityFlag: false });
    await expect(
      ensureRoutable({ investigationId: "inv-1", culturallySensitive: false }),
    ).resolves.toBeUndefined();
  });

  it("contract: every refusal throws specifically a CloudGuardError (not a generic Error)", async () => {
    // Callers may catch CloudGuardError to render the specific
    // "cultural sensitivity refused" UI without leaking other failures
    // to that branch. If a refactor ever throws plain Error for one of
    // the rejection paths, this test fails.
    queryMock.mockResolvedValueOnce([{ culturally_sensitive: 1 }]);
    let caught: unknown;
    try {
      await ensureRoutable({ investigationId: "inv-1", culturallySensitive: false });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(CloudGuardError);
    expect((caught as Error).message.toLowerCase()).toContain("culturally");
  });
});
