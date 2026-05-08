const VERSION = "ss-v1";
const STATIC_CACHE = `static-${VERSION}`;
const STATIC_ASSETS = [
  "/",
  "/static/styles.css",
  "/static/app.js",
  "/static/manifest.json",
  "/static/icon-192.svg",
  "/static/icon-512.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
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

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(req).catch(() => new Response("Offline", { status: 503 })));
    return;
  }

  if (url.pathname === "/" || url.pathname.startsWith("/static/")) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) {
          fetch(req).then((fresh) => {
            if (fresh && fresh.status === 200) {
              caches.open(STATIC_CACHE).then((c) => c.put(req, fresh.clone()));
            }
          }).catch(() => {});
          return cached;
        }
        return fetch(req).then((fresh) => {
          if (fresh && fresh.status === 200) {
            const copy = fresh.clone();
            caches.open(STATIC_CACHE).then((c) => c.put(req, copy));
          }
          return fresh;
        }).catch(() => caches.match("/"));
      })
    );
  }
});
