/**
 * Listens for `ss:sw-update-available` (dispatched by
 * registerServiceWorker.ts when a new SW reaches the "installed"
 * state on a tab that already has a controlling SW) and renders a
 * dismissible banner offering Reload-to-update.
 *
 * Sits beneath AppHeader; styled to be quiet but obvious. Dismiss
 * remembers the dismissal for the rest of the tab's life — if a
 * subsequent update lands, the banner returns.
 */

import { useCallback, useEffect, useState } from "react";
import { applyServiceWorkerUpdate, SW_UPDATE_EVENT } from "../lib/registerServiceWorker";
import s from "./ServiceWorkerUpdateBanner.module.css";

export function ServiceWorkerUpdateBanner() {
  const [show, setShow] = useState(false);
  // Track which update we last dismissed so a *new* update re-surfaces.
  const [dismissedRegistrationToken, setDismissedRegistrationToken] = useState<unknown>(null);

  useEffect(() => {
    function onEvent(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail && detail.registration === dismissedRegistrationToken) return;
      setShow(true);
    }
    window.addEventListener(SW_UPDATE_EVENT, onEvent as EventListener);
    return () => window.removeEventListener(SW_UPDATE_EVENT, onEvent as EventListener);
  }, [dismissedRegistrationToken]);

  const handleReload = useCallback(() => {
    applyServiceWorkerUpdate();
  }, []);

  const handleDismiss = useCallback(() => {
    setShow(false);
    // Remember this registration token; if a NEW updatefound fires the
    // banner returns automatically.
    if (typeof navigator !== "undefined" && navigator.serviceWorker?.controller) {
      setDismissedRegistrationToken(navigator.serviceWorker.controller);
    }
  }, []);

  if (!show) return null;

  return (
    <div className={s.banner} role="status" aria-live="polite">
      <span className={s.dot} aria-hidden="true" />
      <span className={s.body}>
        <strong>New version available.</strong> Reload to update — your in-progress session
        will continue uninterrupted.
      </span>
      <button type="button" className={s.reload} onClick={handleReload}>
        Reload
      </button>
      <button type="button" className={s.dismiss} onClick={handleDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
