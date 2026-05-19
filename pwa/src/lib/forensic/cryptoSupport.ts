/**
 * WebCrypto Ed25519 support probe.
 *
 * Ed25519 in WebCrypto landed in Safari/iOS 17 (Sept 2023) and recent
 * Chromium/Firefox. On iOS ≤16.3 — still in active use as of 2026 because
 * older iPads / locked-down work-issue iPhones never received the 17.x
 * upgrade — `crypto.subtle.generateKey({ name: "Ed25519" }, …)` throws
 * an opaque DOMException. That kills two flows in the PWA:
 *
 *   1. The forensic Export Bundle button (signs the manifest).
 *   2. The signed-fetch AI relay (every /api/ai/* call).
 *
 * Without a preflight gate the operator sees an unhelpful red squiggle in
 * DevTools and no error in the UI. This module exposes a one-shot probe
 * that the app shell runs at boot, surfaces the result to the UI via a
 * subscriber list, and lets the affected buttons render disabled with a
 * clear "Requires iOS 17 or later" tooltip.
 *
 * Why not a JS polyfill?
 *   The whole point of the WebCrypto path is hardware-backed,
 *   non-extractable keys (see signingKeyStore.ts). A JS Ed25519 polyfill
 *   would have to extract the key into JS memory, which an XSS payload
 *   could then exfiltrate via `crypto.subtle.exportKey()` or by reading
 *   the JS variable directly. That defeats the forensic-chain contract
 *   and would invalidate every bundle this device has ever produced.
 *   Hard-block instead.
 */

export type Ed25519SupportResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Module-level cache: we probe at most once per page load. The probe
 * itself is cheap (microseconds on supporting hardware, a thrown
 * exception on non-supporting hardware), but cascading callers can
 * easily fire it dozens of times if there's no cache.
 */
let probePromise: Promise<Ed25519SupportResult> | null = null;

/**
 * Synchronous snapshot of the last probe result, or `null` if the probe
 * hasn't resolved yet. Callers that need a sync answer (component render
 * paths, button disabled prop) should read this; if it's null the
 * subscribers fire when the probe lands.
 */
let probeSnapshot: Ed25519SupportResult | null = null;

const subscribers = new Set<(result: Ed25519SupportResult) => void>();

function notify(result: Ed25519SupportResult): void {
  probeSnapshot = result;
  for (const fn of subscribers) {
    try { fn(result); } catch { /* don't let one subscriber break the rest */ }
  }
}

/**
 * Subscribe to probe-result changes. Fires once with the current snapshot
 * if it's already resolved, then again whenever a fresh probe lands
 * (which only happens if `resetForTests` is invoked).
 *
 * Returns an unsubscribe function.
 */
export function subscribeEd25519Support(fn: (result: Ed25519SupportResult) => void): () => void {
  subscribers.add(fn);
  if (probeSnapshot !== null) {
    try { fn(probeSnapshot); } catch { /* ignore */ }
  }
  return () => { subscribers.delete(fn); };
}

/** Synchronous read of the cached result. Returns null until the probe lands. */
export function getEd25519SupportSnapshot(): Ed25519SupportResult | null {
  return probeSnapshot;
}

/**
 * Probe for WebCrypto Ed25519 support. Idempotent — calls after the first
 * return the cached promise. The check itself attempts to generate a
 * non-extractable Ed25519 keypair (same parameters as the real signing
 * code path) and catches any error.
 *
 * The keypair is discarded — we never persist it, never sign with it,
 * never expose it to callers. It exists purely so the runtime tells us
 * whether the algorithm is wired up.
 */
export function probeEd25519Support(): Promise<Ed25519SupportResult> {
  if (probePromise) return probePromise;
  probePromise = (async () => {
    // The probe needs four things to all be present: globalThis.crypto,
    // crypto.subtle, subtle.generateKey, and Ed25519 as a recognised
    // algorithm. Older Safari has `crypto.subtle` but rejects the
    // algorithm name; ancient browsers might be missing subtle entirely.
    try {
      if (typeof crypto === "undefined" || !crypto?.subtle?.generateKey) {
        const result: Ed25519SupportResult = {
          ok: false,
          reason: "WebCrypto SubtleCrypto is not available on this browser.",
        };
        notify(result);
        return result;
      }
      await crypto.subtle.generateKey(
        { name: "Ed25519" },
        /* extractable */ false,
        ["sign", "verify"],
      );
      const result: Ed25519SupportResult = { ok: true };
      notify(result);
      return result;
    } catch (err) {
      // The DOMException Safari/iOS ≤16.3 raises is `NotSupportedError`
      // but we don't dispatch on the name — any failure here is a
      // hard-block regardless of how the runtime spells it.
      const reason = err instanceof Error
        ? `${err.name}: ${err.message}`
        : "Unknown error";
      const result: Ed25519SupportResult = {
        ok: false,
        reason: `Ed25519 keygen failed: ${reason}`,
      };
      notify(result);
      return result;
    }
  })();
  return probePromise;
}

/**
 * Test-only escape hatch. Resets the cached promise, snapshot, and
 * subscribers so a unit test can probe multiple times against different
 * stubs of `crypto.subtle.generateKey`. Never called from production
 * code paths.
 */
export function resetEd25519SupportForTests(): void {
  probePromise = null;
  probeSnapshot = null;
  subscribers.clear();
}
