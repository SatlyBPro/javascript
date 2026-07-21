// Service worker for offline support.
//
// Two caching strategies, since the app has two very different kinds of
// assets:
//
// 1. App shell (index.html, app.js, styles.css, manifest.json, icons):
//    these are small, change when we deploy, and the app already has its
//    own "Refresh app" button (see refreshApp() in app.js) that unregisters
//    this service worker and clears all caches to force a fresh copy. So
//    we cache-first these too, but keep the list explicit and versioned:
//    bump CACHE_VERSION below whenever app.js/styles.css/index.html change,
//    and the old cache is dropped on activate.
//
// 2. Monaco, loaded from cdn.jsdelivr.net: this is a large AMD module
//    loader that fetches dozens of files at runtime (editor.main.js,
//    language/worker files, etc.) whose exact names depend on the Monaco
//    version and aren't practical to precache by hand. Instead we
//    runtime-cache anything fetched from the jsdelivr CDN, cache-first:
//    once a file's been fetched successfully once, it's saved forever
//    (Monaco versions its own URLs, so a cached file for one version never
//    collides with another version), and later loads - online or offline -
//    read it straight from cache instead of hitting the network.

const CACHE_VERSION = "v1";
const SHELL_CACHE = "js-runner-shell-" + CACHE_VERSION;
const CDN_CACHE = "js-runner-cdn-" + CACHE_VERSION;

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./styles.css",
  "./manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== CDN_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Monaco CDN: cache-first, runtime-populated.
  if (url.hostname === "cdn.jsdelivr.net") {
    event.respondWith(
      caches.open(CDN_CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          if (cached) return cached;
          return fetch(req).then((res) => {
            // Only cache real, successful, non-opaque responses.
            if (res.ok) cache.put(req, res.clone());
            return res;
          });
        })
      )
    );
    return;
  }

  // Same-origin app shell: cache-first, falling back to network, and
  // updating the cache with whatever the network returns so a normal
  // reload (not just the explicit refresh button) can still pick up
  // small changes without needing a full cache wipe.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const networkFetch = fetch(req)
          .then((res) => {
            if (res.ok) {
              caches.open(SHELL_CACHE).then((cache) => cache.put(req, res.clone()));
            }
            return res;
          })
          .catch(() => cached);
        return cached || networkFetch;
      })
    );
  }
});