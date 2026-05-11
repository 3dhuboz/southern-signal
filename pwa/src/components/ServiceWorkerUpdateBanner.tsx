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
  // Identity of the waiting worker the user dismissed. A subsequent
  // updatefound produces a different ServiceWorker instance for
  // registration.waiting, which won't equal this — so the banner
  // re-surfaces automatically on the *next* deploy.
  const [dismissedWaitingWorker, setDismissedWaitingWorker] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    function onEvent(e: Event) {
      const detail = (e as CustomEvent).detail as { registration?: ServiceWorkerRegistration } | undefined;
      const waiting = detail?.registration?.waiting ?? null;
      if (waiting && waiting === dismissedWaitingWorker) return;
      setShow(true);
    }
    window.addEventListener(SW_UPDATE_EVENT, onEvent as EventListener);
    return () => window.removeEventListener(SW_UPDATE_EVENT, onEvent as EventListener);
  }, [dismissedWaitingWorker]);

  const handleReload = useCallback(() => {
    applyServiceWorkerUpdate();
  }, []);

  const handleDismiss = useCallback(() => {
    setShow(false);
    // Snapshot the currently-waiting worker so a later updatefound
    // (with a different ServiceWorker instance) wins past the
    // equality gate and re-surfaces the banner.
    void navigator.serviceWorker?.getRegistration?.()?.then?.((reg) => {
      if (reg?.waiting) setDismissedWaitingWorker(reg.waiting);
    });
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
