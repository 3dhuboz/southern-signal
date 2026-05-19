/**
 * CryptoUnsupportedBanner — app-shell banner shown when the runtime
 * doesn't support WebCrypto Ed25519 (iOS ≤16.3, ancient Android Chromes,
 * a few locked-down corporate browsers).
 *
 * Why this exists: the forensic Export Bundle and the signed-fetch AI
 * relay both call `crypto.subtle.generateKey({ name: "Ed25519" }, …)`
 * which throws an opaque DOMException on those runtimes. Without a
 * preflight gate the operator sees an unhelpful red squiggle in DevTools
 * and nothing in the UI. The banner tells them what to do.
 *
 * Behaviour:
 *   - Renders only when the probe in `lib/forensic/cryptoSupport.ts`
 *     reports `ok: false`.
 *   - Visible on every route (mounted at the App root, above <Routes>).
 *   - Dismissible per-session via a sessionStorage flag — so the operator
 *     can browse Review/About without nagging — but re-shows on every
 *     fresh session because the limitation is real and the gated buttons
 *     would otherwise be silently disabled with no explanation.
 *   - Styled against the existing --warning token, not --danger. The chain
 *     isn't broken; the operator's device just can't extend it.
 *
 * Copy is deliberately factual and sober — the same voice as About.tsx
 * and the standing disclaimers. No emoji, no exclamation marks.
 */

import { useCallback, useEffect, useState } from "react";
import { useEd25519Support } from "../hooks/useEd25519Support";
import s from "./CryptoUnsupportedBanner.module.css";

const DISMISS_KEY = "ss-crypto-unsupported-dismissed";

export function CryptoUnsupportedBanner() {
  const support = useEd25519Support();
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return sessionStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
  });

  // Sync state back to sessionStorage on every dismissal so a route remount
  // mid-session doesn't bring the banner back. The flag is intentionally
  // sessionStorage (not localStorage) — every new tab / new session
  // surfaces the warning again because Export Bundle + AI Assist are
  // still disabled and the operator deserves a fresh reminder.
  const handleDismiss = useCallback(() => {
    try { sessionStorage.setItem(DISMISS_KEY, "1"); } catch { /* ignore */ }
    setDismissed(true);
  }, []);

  // Clear the dismissal if support flips to ok mid-session (defensive —
  // realistically the probe doesn't re-run, but if a future hot-path
  // re-probes after the user upgrades their browser without a refresh,
  // the banner should disappear cleanly).
  useEffect(() => {
    if (support?.ok) {
      try { sessionStorage.removeItem(DISMISS_KEY); } catch { /* ignore */ }
    }
  }, [support?.ok]);

  if (!support || support.ok || dismissed) return null;

  return (
    <div
      className={s.banner}
      role="region"
      aria-labelledby="ss-crypto-banner-title"
      data-testid="crypto-unsupported-banner"
    >
      <div className={s.body}>
        <strong id="ss-crypto-banner-title" className={s.title}>
          Cryptographic signatures unavailable
        </strong>
        <p className={s.detail}>
          This device's browser doesn't support the cryptographic signatures
          Southern Signal relies on (Ed25519 via WebCrypto). On iOS, update
          to iOS 17 or later. Export Bundle and AI Assist are disabled until
          then.
        </p>
      </div>
      <div className={s.actions}>
        <button
          type="button"
          className={s.dismissBtn}
          onClick={handleDismiss}
          title="Hide for this session. Re-appears on next visit."
        >
          Hide
        </button>
      </div>
    </div>
  );
}
