/**
 * cryptoSupport — WebCrypto Ed25519 preflight probe tests.
 *
 * Verifies:
 *   • probeEd25519Support returns `{ ok: true }` when `crypto.subtle.generateKey`
 *     resolves with a key pair (the supported-runtime path).
 *   • Returns `{ ok: false }` when generateKey throws a DOMException
 *     (the iOS ≤16.3 path).
 *   • Returns `{ ok: false }` when `crypto.subtle` is absent entirely
 *     (the ancient-browser path).
 *   • The probe is cached — subsequent calls return the same promise
 *     and don't re-invoke generateKey.
 *   • Subscribers fire with the resolved result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We model the generateKey stub with a loose signature — the production
// caller only inspects the resolved value when ok, and only inspects the
// thrown reason when not ok. TypeScript's WebCrypto definitions overload
// generateKey by algorithm name, which makes parameter typing painful in
// a test; a `(...args: unknown[]) => Promise<unknown>` mock keeps us
// honest without fighting the overload chain.
type GenerateKeyStub = (...args: unknown[]) => Promise<unknown>;
const generateKeySpy = vi.fn<GenerateKeyStub>();

beforeEach(() => {
  generateKeySpy.mockReset();
  // The module caches its result in module scope. Reset modules
  // between tests so each `await import(...)` gets a fresh closure.
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubCryptoSubtle(impl: GenerateKeyStub | "absent") {
  if (impl === "absent") {
    vi.stubGlobal("crypto", { /* no subtle */ });
    return;
  }
  generateKeySpy.mockImplementation(impl);
  vi.stubGlobal("crypto", {
    subtle: {
      generateKey: generateKeySpy,
    },
  });
}

describe("probeEd25519Support", () => {
  it("returns ok:true when generateKey resolves with a key pair", async () => {
    stubCryptoSubtle(async () => ({ privateKey: {}, publicKey: {} }));
    const { probeEd25519Support } = await import("./cryptoSupport");
    const result = await probeEd25519Support();
    expect(result.ok).toBe(true);
    expect(generateKeySpy).toHaveBeenCalledTimes(1);
    // The probe passes the same parameters the production signing path uses
    // — non-extractable, sign + verify only — so iOS ≤16.3's rejection
    // matches what the real keygen call would hit.
    const [algo, extractable, usages] = generateKeySpy.mock.calls[0];
    expect((algo as { name: string }).name).toBe("Ed25519");
    expect(extractable).toBe(false);
    expect(usages).toEqual(["sign", "verify"]);
  });

  it("returns ok:false with a reason when generateKey throws (iOS ≤16.3 path)", async () => {
    const err = new DOMException("Ed25519 is not supported", "NotSupportedError");
    stubCryptoSubtle(async () => { throw err; });
    const { probeEd25519Support } = await import("./cryptoSupport");
    const result = await probeEd25519Support();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Ed25519 keygen failed");
      expect(result.reason).toContain("NotSupportedError");
    }
  });

  it("returns ok:false when crypto.subtle is absent (ancient browser path)", async () => {
    stubCryptoSubtle("absent");
    const { probeEd25519Support } = await import("./cryptoSupport");
    const result = await probeEd25519Support();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("WebCrypto SubtleCrypto");
    }
  });

  it("caches the result — second call returns the same promise without re-invoking generateKey", async () => {
    stubCryptoSubtle(async () => ({ privateKey: {}, publicKey: {} }));
    const { probeEd25519Support } = await import("./cryptoSupport");
    const first = await probeEd25519Support();
    const second = await probeEd25519Support();
    expect(first).toBe(second);
    // The cached promise resolves to the same value. generateKey should
    // have been called exactly once across both awaits.
    expect(generateKeySpy).toHaveBeenCalledTimes(1);
  });

  it("notifies subscribers with the resolved result", async () => {
    stubCryptoSubtle(async () => { throw new Error("nope"); });
    const mod = await import("./cryptoSupport");
    const fn = vi.fn();
    const unsub = mod.subscribeEd25519Support(fn);
    await mod.probeEd25519Support();
    // Subscribers fire when the probe resolves — once.
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0].ok).toBe(false);
    unsub();
  });

  it("snapshot returns null before the probe resolves", async () => {
    // Hold generateKey open so the probe doesn't resolve.
    let resolveGen: (v: unknown) => void = () => { /* assigned below */ };
    stubCryptoSubtle(() => new Promise<unknown>((resolve) => { resolveGen = resolve; }));
    const mod = await import("./cryptoSupport");
    expect(mod.getEd25519SupportSnapshot()).toBeNull();
    const probe = mod.probeEd25519Support();
    // Still null while in flight.
    expect(mod.getEd25519SupportSnapshot()).toBeNull();
    resolveGen({ privateKey: {}, publicKey: {} });
    await probe;
    expect(mod.getEd25519SupportSnapshot()).toEqual({ ok: true });
  });
});
