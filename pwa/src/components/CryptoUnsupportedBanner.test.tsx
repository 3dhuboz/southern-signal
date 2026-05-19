// @vitest-environment happy-dom

/**
 * Smoke test for CryptoUnsupportedBanner.
 *
 * The banner is the user-facing surface for the WebCrypto Ed25519
 * preflight gate. Two behaviours matter:
 *
 *   1. When the probe reports `ok: false`, the banner renders and the
 *      copy contains "iOS 17" so a future copy edit can't accidentally
 *      drop the upgrade instruction.
 *   2. When the probe reports `ok: true`, the banner renders nothing —
 *      operators on supported devices never see it.
 *
 * We mock the probe module directly rather than stub `crypto.subtle` so
 * the test exercises the component's subscription path against a
 * predictable result, decoupled from the WebCrypto availability of the
 * test runtime.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const {
  probeFn, subscribeFn, snapshotFn,
} = vi.hoisted(() => ({
  probeFn: vi.fn(),
  subscribeFn: vi.fn(),
  snapshotFn: vi.fn(),
}));

vi.mock("../lib/forensic/cryptoSupport", () => ({
  probeEd25519Support: probeFn,
  subscribeEd25519Support: subscribeFn,
  getEd25519SupportSnapshot: snapshotFn,
}));

import { CryptoUnsupportedBanner } from "./CryptoUnsupportedBanner";

beforeEach(() => {
  probeFn.mockReset();
  subscribeFn.mockReset();
  snapshotFn.mockReset();
  // sessionStorage doesn't auto-clear between happy-dom tests.
  try { sessionStorage.clear(); } catch { /* ignore */ }
});

afterEach(() => {
  cleanup();
});

describe("CryptoUnsupportedBanner", () => {
  it("renders nothing while the probe is still in flight (snapshot null)", () => {
    snapshotFn.mockReturnValue(null);
    subscribeFn.mockImplementation(() => () => { /* unsubscribe */ });
    probeFn.mockResolvedValue({ ok: false, reason: "not supported" });

    const { container } = render(<CryptoUnsupportedBanner />);
    expect(container.querySelector("[data-testid='crypto-unsupported-banner']")).toBeNull();
  });

  it("renders nothing when the probe reports ok:true", () => {
    snapshotFn.mockReturnValue({ ok: true });
    subscribeFn.mockImplementation((fn: (r: { ok: true }) => void) => {
      // Banner subscribes with the current snapshot — emit ok:true.
      fn({ ok: true });
      return () => { /* unsubscribe */ };
    });
    probeFn.mockResolvedValue({ ok: true });

    const { container } = render(<CryptoUnsupportedBanner />);
    expect(container.querySelector("[data-testid='crypto-unsupported-banner']")).toBeNull();
  });

  it("renders the iOS 17 upgrade instruction when the probe reports ok:false", async () => {
    snapshotFn.mockReturnValue({ ok: false, reason: "NotSupportedError" });
    subscribeFn.mockImplementation((fn: (r: { ok: false; reason: string }) => void) => {
      fn({ ok: false, reason: "NotSupportedError" });
      return () => { /* unsubscribe */ };
    });
    probeFn.mockResolvedValue({ ok: false, reason: "NotSupportedError" });

    render(<CryptoUnsupportedBanner />);
    const banner = await waitFor(() => screen.getByTestId("crypto-unsupported-banner"));
    // Copy contract — a future tweak that drops "iOS 17" fails here. The
    // copy is the load-bearing piece of the banner; the actual hostname
    // of the alert isn't.
    expect(banner.textContent ?? "").toContain("iOS 17");
    // And it mentions the gated surfaces by name so the operator knows
    // why their Export / AI buttons are disabled.
    expect(banner.textContent ?? "").toContain("Export Bundle");
    expect(banner.textContent ?? "").toContain("AI Assist");
  });

  it("hides itself when the user clicks Hide and persists the dismissal for the session", async () => {
    snapshotFn.mockReturnValue({ ok: false, reason: "n/a" });
    subscribeFn.mockImplementation((fn: (r: { ok: false; reason: string }) => void) => {
      fn({ ok: false, reason: "n/a" });
      return () => { /* unsubscribe */ };
    });
    probeFn.mockResolvedValue({ ok: false, reason: "n/a" });

    const { getByRole, queryByTestId } = render(<CryptoUnsupportedBanner />);
    await waitFor(() => screen.getByTestId("crypto-unsupported-banner"));
    getByRole("button", { name: /Hide/i }).click();
    await waitFor(() => expect(queryByTestId("crypto-unsupported-banner")).toBeNull());
    expect(sessionStorage.getItem("ss-crypto-unsupported-dismissed")).toBe("1");
  });
});
