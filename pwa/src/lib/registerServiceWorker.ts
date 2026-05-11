/**
 * Service-worker registration + update detection. Without a UI nudge,
 * operators stay on stale builds for days after a deploy — so this
 * module emits a `ss:sw-update-available` window CustomEvent (detail
 * `{ registration }`) when an incoming worker reaches `installed`
 * AND a prior SW was already controlling the tab. The banner picks
 * that up and offers reload.
 */

export const SW_UPDATE_EVENT = "ss:sw-update-available";

let cachedRegistration: ServiceWorkerRegistration | null = null;

function publishUpdateAvailable(registration: ServiceWorkerRegistration): void {
  window.dispatchEvent(new CustomEvent(SW_UPDATE_EVENT, { detail: { registration } }));
}

function watchForUpdate(registration: ServiceWorkerRegistration): void {
  cachedRegistration = registration;
  // Hibernated-through-deploy: a waiting worker is already pending
  // before this module ever runs.
  if (registration.waiting && navigator.serviceWorker.controller) {
    publishUpdateAvailable(registration);
  }
  registration.addEventListener("updatefound", () => {
    const incoming = registration.installing;
    if (!incoming) return;
    incoming.addEventListener("statechange", () => {
      if (incoming.state !== "installed") return;
      // No controller → first install, not an update; skip the nudge.
      if (!navigator.serviceWorker.controller) return;
      publishUpdateAvailable(registration);
    });
  });
}

/**
 * Trigger a controlled reload. Asks the waiting worker to skipWaiting,
 * then reloads on controllerchange — with a 1.2s timeout fallback for
 * browsers where the event doesn't fire reliably.
 */
export function applyServiceWorkerUpdate(): void {
  cachedRegistration?.waiting?.postMessage({ type: "SKIP_WAITING" });
  let reloaded = false;
  const reload = () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  };
  navigator.serviceWorker.addEventListener("controllerchange", reload);
  window.setTimeout(reload, 1200);
}

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js")
      .then((reg) => {
        watchForUpdate(reg);
        // Poll for updates every 30 min so a tab left open all day
        // eventually finds the latest deploy.
        window.setInterval(() => { void reg.update().catch(() => {}); }, 30 * 60 * 1000);
      })
      .catch(() => {
        /* swallow — offline registration is a nice-to-have, not critical */
      });
  });
}
