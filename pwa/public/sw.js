// Version bumped each deploy so the cache key differs and activate
// can prune old caches cleanly. Update detection lives client-side in
// registerServiceWorker.ts — when this file changes the browser sees
// a new SW and walks it through install → installed → activate; the
// client banner picks up the "installed" state and offers a reload.
//
// v3 (2026-05-11): switch to a network-first strategy for HTML
// navigations, and skipWaiting on install. Why: the old
// stale-while-revalidate path served the cached `/` first, which kept
// pointing scripts at old asset hashes. Users would refresh, still see
// the broken old bundle, and the SW would only catch up on a *second*
// refresh. Network-first for HTML guarantees a freshly-deployed bundle
// reaches the user on the very next reload. Hashed assets keep
// cache-first since the content-hash is the cache key.
//
// The `__BUILD_ID__` token is substituted at build time by the
// `swVersionInject` plugin in vite.config.ts. Each build derives a
// fresh id from the package version + the build timestamp, so the SW
// cache namespace changes per-deploy automatically — no more manual
// version bumps and no more unbounded cache growth.
// In dev mode (where the public file is served as-is) the token stays
// in place; the SW is only registered against the built bundle.
const VERSION = "ss-pwa-__BUILD_ID__";
const STATIC_CACHE = `static-${VERSION}`;
const STATIC_ASSETS = ["/manifest.webmanifest", "/icon-192.svg", "/icon-512.svg", "/icon-mask.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
  // Take over immediately so a single reload is enough to escape a
  // bad cached bundle. The previous SW would only swap on the second
  // refresh, which made the "stuck on Starting…" failure mode worse.
  self.skipWaiting();
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
  if (url.origin !== self.location.origin) return;

  // HTML navigations: NETWORK FIRST. Falls back to the most-recent cached
  // HTML only when offline, so the freshly-deployed bundle's asset hashes
  // are always picked up on the next reload.
  const isHtml = req.mode === "navigate" || req.destination === "document";
  if (isHtml) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(STATIC_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match("/")))
    );
    return;
  }

  // Hashed assets + everything else: stale-while-revalidate. Vite emits
  // content-hashed filenames so the cache key changes when content
  // changes — safe to serve cached aggressively while we refresh in the
  // background.
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
});
