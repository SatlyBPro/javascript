// Service worker for offline support.
//
// This ONLY caches the Monaco CDN (cdn.jsdelivr.net). It deliberately does
// NOT intercept same-origin requests (index.html/app.js/styles.css).
//
// Why: app.js already has its own freshness mechanism, checkForStaleVersion(),
// which on every resume fetches index.html with a cache-busting query param
// and `cache: "no-store"`, compares the embedded version string, and forces
// a full refresh+reload if it's stale. That already correctly solves "the
// home-screen app shows an old version after being resumed."
//
// A service worker that cache-first intercepts same-origin fetches breaks
// that mechanism: it would serve the cached (stale) index.html back to that
// no-store freshness check too, so the check always sees "same version"
// and never detects staleness - which is what caused the reopen showing an
// old version for a few seconds before flipping back. So: same-origin
// requests are left completely alone here and go straight to the network,
// exactly as they would with no service worker installed. Only the Monaco
// CDN, which changes rarely and is versioned in its own URL, is cached.
const CACHE_VERSION = "v3";
const CDN_CACHE = "js-runner-cdn-" + CACHE_VERSION;

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CDN_CACHE)
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

  // Monaco CDN only: cache-first, runtime-populated. Same-origin requests
  // (index.html, app.js, styles.css, manifest.json) are intentionally not
  // touched here at all - see the note above.
  if (url.hostname === "cdn.jsdelivr.net") {
    event.respondWith(
      caches.open(CDN_CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          if (cached) return cached;
          return fetch(req).then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          });
        })
      )
    );
  }
});