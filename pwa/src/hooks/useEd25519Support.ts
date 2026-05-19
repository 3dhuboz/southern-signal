/**
 * useEd25519Support — React hook returning the cached WebCrypto Ed25519
 * probe result. Subscribes to the probe singleton in
 * `lib/forensic/cryptoSupport.ts` and re-renders the host component when
 * the result lands.
 *
 * Return shape:
 *   • `null` until the boot-time probe resolves (typical case is a single
 *     microtask hop, so this usually flips before first paint).
 *   • `{ ok: true }` when the runtime supports Ed25519 keygen.
 *   • `{ ok: false, reason }` when keygen failed — caller should treat
 *     the affected feature as gated and surface the upgrade-to-iOS-17
 *     copy in the persistent banner.
 *
 * The probe runs at boot from App.tsx; this hook is purely a subscription.
 */

import { useEffect, useState } from "react";
import {
  getEd25519SupportSnapshot,
  probeEd25519Support,
  subscribeEd25519Support,
  type Ed25519SupportResult,
} from "../lib/forensic/cryptoSupport";

export function useEd25519Support(): Ed25519SupportResult | null {
  const [result, setResult] = useState<Ed25519SupportResult | null>(getEd25519SupportSnapshot);

  useEffect(() => {
    // Belt-and-braces: if no caller has kicked the probe yet (e.g. a route
    // mounts before App's boot-time call) fire it here. Idempotent.
    void probeEd25519Support();
    const unsub = subscribeEd25519Support((r) => setResult(r));
    return unsub;
  }, []);

  return result;
}
