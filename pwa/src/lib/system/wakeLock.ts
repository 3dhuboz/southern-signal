/**
 * Screen Wake Lock — keeps the device awake during a recording session.
 *
 * iOS Safari reality: when the screen sleeps, the AudioContext suspends and
 * EVP / live-stream recording silently stops. Wake Lock prevents that.
 *
 * Quirks handled here:
 *  - Wake Lock is auto-released by the platform when the document hides.
 *    We re-acquire on visibilitychange so a brief "switch app" doesn't
 *    permanently kill the lock.
 *  - Safari may reject the request (low battery, system policy). We swallow
 *    the rejection — recording still works, the screen just may sleep.
 *  - Older browsers without Wake Lock just no-op; nothing to fall back to.
 */

import { useEffect } from "react";

interface WakeLockSentinelLike {
  released?: boolean;
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void) => void;
}

interface WakeLockApi {
  request: (type: "screen") => Promise<WakeLockSentinelLike>;
}

function getWakeLock(): WakeLockApi | null {
  if (typeof navigator === "undefined") return null;
  const lock = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
  return lock ?? null;
}

export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const lock = getWakeLock();
    if (!lock) return;

    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (cancelled) return;
      if (typeof document === "undefined" || document.visibilityState !== "visible") return;
      try {
        sentinel = await lock.request("screen");
        // Sentinel may be auto-released when the document hides; clear our
        // ref so the visibility handler knows to re-acquire.
        sentinel.addEventListener("release", () => {
          if (!cancelled) sentinel = null;
        });
      } catch {
        // Browser refused (low battery, focus lost). Silent — recording still works.
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible" && !sentinel) {
        void acquire();
      }
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      const ref = sentinel;
      sentinel = null;
      ref?.release().catch(() => { /* ignore */ });
    };
  }, [active]);
}
