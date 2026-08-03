/*
 * Minimal service worker: an installable offline *shell*, nothing more.
 *
 * Why so small: this app's value is live financial data, and stale money
 * figures are worse than no figures. So the SW deliberately caches only the
 * things that are safe to serve from disk — the HTML shell, hashed build
 * assets and fonts — and never touches /api. There is no background sync, no
 * stale-while-revalidate on data, no queueing of mutations. Opening the app
 * offline gets you the UI and an honest network error, not yesterday's balance.
 *
 * Bump CACHE_VERSION to invalidate everything; `activate` deletes older caches.
 */

const CACHE_VERSION = "v1";
const CACHE_NAME = `finance-planner-${CACHE_VERSION}`;

/* The offline shell plus the fonts it needs to render without a flash of
 * fallback type. Hashed /assets/* files are not listed — their names change
 * every build, so they are picked up lazily by the cache-first branch below. */
const PRECACHE_URLS = [
  "/",
  "/fonts/jetbrains-mono-latin-normal.woff2",
  "/fonts/jetbrains-mono-latin-ext-normal.woff2",
  "/fonts/jetbrains-mono-latin-italic.woff2",
  "/fonts/jetbrains-mono-latin-ext-italic.woff2",
];

/* Long-lived, content-addressed or immutable-by-convention paths. */
const CACHEABLE_PATH = /^\/(assets|fonts)\//;
const CACHEABLE_DESTINATION = new Set(["font", "style", "script", "image"]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only GETs are ever cacheable, and only our own origin is our business.
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // (a) API traffic: always the network, never the cache. Falling through
  //     without respondWith() leaves the browser's default handling in place.
  if (url.pathname.startsWith("/api/")) return;

  // (c) Navigations: network-first so a deploy is picked up immediately,
  //     falling back to the cached shell when offline. React Router then
  //     renders the requested route client-side.
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }

  // (b) Static assets: cache-first. Hashed filenames make this safe.
  if (CACHEABLE_PATH.test(url.pathname) || CACHEABLE_DESTINATION.has(request.destination)) {
    event.respondWith(cacheFirst(request));
  }
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    // Keep the offline shell in step with the latest deploy.
    if (response.ok) cache.put("/", response.clone());
    return response;
  } catch (error) {
    const shell = await cache.match("/");
    if (shell) return shell;
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  // Only full, successful responses — never a 206 range or an error page.
  if (response.status === 200) cache.put(request, response.clone());
  return response;
}
