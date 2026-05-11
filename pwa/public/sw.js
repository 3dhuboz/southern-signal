// Version bumped each deploy so the cache key differs and activate
// can prune old caches cleanly. Update detection lives client-side in
// registerServiceWorker.ts — when this file changes the browser sees
// a new SW and walks it through install → installed → activate; the
// client banner picks up the "installed" state and offers a reload.
const VERSION = "ss-pwa-v2";
const STATIC_CACHE = `static-${VERSION}`;
const STATIC_ASSETS = ["/", "/manifest.webmanifest", "/icon-192.svg", "/icon-512.svg", "/icon-mask.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
  // Don't skipWaiting unconditionally — let the client decide when to
  // swap. The client sends a SKIP_WAITING message after the user
  // clicks "Reload to update" so we don't yank the rug out from under
  // a session mid-recording.
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== STATIC_CACHE).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Stale-while-revalidate for same-origin GET
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fresh = fetch(req)
          .then((res) => {
            if (res && res.status === 200) {
              const copy = res.clone();
              caches.open(STATIC_CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(() => cached);
        return cached || fresh;
      })
    );
  }
});
