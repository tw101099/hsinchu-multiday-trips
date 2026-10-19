
const CACHE_VERSION = "v12";
const CACHE_NAME = `hsinchu-multiday-${CACHE_VERSION}`;

const SHELL_ASSETS = [
  "./",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-192-maskable.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon.svg",
  "./icons/favicon-32.png",
  "./icons/trip-empty.webp",
  "./icons/seal.webp",
  "./vendor/leaflet/leaflet.js",
  "./vendor/leaflet/leaflet.css",
  "./vendor/leaflet/images/layers.png",
  "./vendor/leaflet/images/layers-2x.png",
  "./vendor/leaflet/images/marker-icon.png",
  "./vendor/leaflet/images/marker-icon-2x.png",
  "./vendor/leaflet/images/marker-shadow.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(
        SHELL_ASSETS.map((url) => cache.add(url).catch(() => {}))
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith("hsinchu-multiday-") && n !== CACHE_NAME)
          .map((n) => caches.delete(n))
      );
      try {
        await prunePageCopies(await caches.open(CACHE_NAME));
      } catch (e) {}
      await self.clients.claim();
    })()
  );
});

function isNavigationRequest(request) {
  if (request.mode === "navigate") return true;
  return (
    request.method === "GET" &&
    request.headers.get("accept") &&
    request.headers.get("accept").includes("text/html")
  );
}

function isShellAsset(url) {
  return /\/manifest\.webmanifest$/.test(url.pathname) || /\/icons\//.test(url.pathname) ||
    /\/vendor\//.test(url.pathname);
}

function isDataAsset(url) {
  return /\/data\//.test(url.pathname);
}

const NET_TIMEOUT_MS = 3000;
const TIMED_OUT = Symbol("network-timeout");

function timeoutAfter(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms, TIMED_OUT));
}

function pageKey(request) {
  const u = new URL(request.url);
  u.search = "";
  u.hash = "";
  return u.href;
}

async function prunePageCopies(cache) {
  const keys = await cache.keys();
  await Promise.all(
    keys
      .filter((req) => {
        const u = new URL(req.url);
        return u.search !== "" && !isDataAsset(u) && !isShellAsset(u);
      })
      .map((req) => cache.delete(req))
  );
}

function cachedFallback(cache, request) {
  return cache
    .match(pageKey(request))
    .then((hit) => hit || cache.match("./"))
    .then((hit) => hit || cache.match("./index.html"));
}

function offlinePage() {
  return new Response(
    "<!doctype html><meta charset=utf-8><title>離線</title>" +
      "<body style='font-family:system-ui;padding:2em;color:#5c5449'>" +
      "<h1>目前離線</h1><p>連不上網路，也還沒有快取過這一頁。恢復網路後重新整理即可。</p>",
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

async function networkFirst(request, event) {
  const opening = caches.open(CACHE_NAME);
  const network = fetch(request, { cache: "no-cache" }).then(async (fresh) => {
    if (fresh && fresh.ok) {
      const cache = await opening;
      cache.put(pageKey(request), fresh.clone()).then(() => prunePageCopies(cache)).catch(() => {});
    }
    return fresh;
  });
  if (event) event.waitUntil(network.catch(() => {}));
  else network.catch(() => {});

  try {
    const first = await Promise.race([network, timeoutAfter(NET_TIMEOUT_MS)]);
    if (first !== TIMED_OUT) return first;
    const cached = await cachedFallback(await opening, request);
    if (cached) return cached;
    return await network;
  } catch (err) {
    const cached = await cachedFallback(await opening, request);
    if (cached) return cached;
    return offlinePage();
  }
}

async function pruneOldVersions(cache, url) {
  const keys = await cache.keys();
  await Promise.all(
    keys
      .filter((req) => {
        const u = new URL(req.url);
        return u.origin === url.origin && u.pathname === url.pathname && u.search !== url.search;
      })
      .map((req) => cache.delete(req))
  );
}

async function networkFirstData(request, event) {
  const url = new URL(request.url);
  const opening = caches.open(CACHE_NAME);
  const network = fetch(request).then(async (fresh) => {
    if (fresh && fresh.ok) {
      const cache = await opening;
      await cache.put(request, fresh.clone());
      await pruneOldVersions(cache, url);
    }
    return fresh;
  });
  if (event) event.waitUntil(network.catch(() => {}));
  else network.catch(() => {});

  try {
    const first = await Promise.race([network, timeoutAfter(NET_TIMEOUT_MS)]);
    if (first !== TIMED_OUT) return first;
    const cached = await (await opening).match(request);
    if (cached) return cached;
    return await network;
  } catch (err) {
    const cached = await (await opening).match(request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh && fresh.ok) {
    cache.put(request, fresh.clone());
  }
  return fresh;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isNavigationRequest(request)) {
    event.respondWith(networkFirst(request, event));
    return;
  }

  if (isShellAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (isDataAsset(url)) {
    event.respondWith(networkFirstData(request, event));
    return;
  }

});
