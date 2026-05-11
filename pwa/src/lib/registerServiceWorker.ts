/**
 * Service-worker registration + update detection.
 *
 * The SW does the cache work (stale-while-revalidate). What this
 * module adds is *update detection*: when a new SW deploys to the
 * server, the existing tab needs to be reloaded to pick up the new
 * bundle. Without UI nudge, operators stay on stale builds for days.
 *
 * Strategy:
 *   1. Register the SW. Cache the registration.
 *   2. Listen for `updatefound` and watch the incoming worker.
 *   3. When the new worker transitions to "installed" AND
 *      navigator.serviceWorker.controller is non-null (i.e. an older
 *      SW is currently controlling this tab), publish an "update
 *      available" event.
 *   4. UI mounts a banner that listens for the event and offers a
 *      reload button.
 *   5. Bonus: poll for updates every 30 minutes so long-running tabs
 *      eventually find new deploys.
 *
 * Custom event name: `ss:sw-update-available`. Cancelable: false.
 * Detail: { registration: ServiceWorkerRegistration }.
 */

export const SW_UPDATE_EVENT = "ss:sw-update-available";

let cachedRegistration: ServiceWorkerRegistration | null = null;

function publishUpdateAvailable(registration: ServiceWorkerRegistration): void {
  window.dispatchEvent(new CustomEvent(SW_UPDATE_EVENT, { detail: { registration } }));
}

function watchForUpdate(registration: ServiceWorkerRegistration): void {
  cachedRegistration = registration;
  // If there's already a waiting worker (e.g. the user came back to a
  // tab that was hibernated through a deploy), publish immediately.
  if (registration.waiting && navigator.serviceWorker.controller) {
    publishUpdateAvailable(registration);
  }
  registration.addEventListener("updatefound", () => {
    const incoming = registration.installing;
    if (!incoming) return;
    incoming.addEventListener("statechange", () => {
      if (incoming.state !== "installed") return;
      if (!navigator.serviceWorker.controller) {
        // No controller → first install, not an update. Don't nudge.
        return;
      }
      publishUpdateAvailable(registration);
    });
  });
}

/**
 * Trigger a controlled reload after a new SW has installed. Posts
 * SKIP_WAITING to the waiting worker (in case the SW honours it), then
 * reloads after a controller change OR a short timeout fallback.
 */
export function applyServiceWorkerUpdate(): void {
  const reg = cachedRegistration;
  const waiting = reg?.waiting;
  if (waiting) {
    waiting.postMessage({ type: "SKIP_WAITING" });
  }
  let reloaded = false;
  const reload = () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  };
  // If the new SW takes over, controllerchange fires — reload then.
  navigator.serviceWorker.addEventListener("controllerchange", reload);
  // Fallback: reload after a short delay even if controllerchange
  // doesn't fire (some browsers' edge cases).
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
