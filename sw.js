// 新竹出發多日遊 — Service Worker
//
// CACHE_NAME 的前綴（見下面 CACHE_NAME）**必須是這個站專屬的**：使用者的手機上
// 可能同時加了別的站到主畫面，前綴撞名的話 activate 那段「清掉不是自己的舊快取」
// 會互相刪對方的快取。
//
// 站台幾乎天天發布（見 publish.py），策略刻意保守：
//   - 頁面本體（導覽請求、./、./index.html）一律 network-first——本人一定要
//     看到最新版，快取只當「查不到網路時」的備援，絕不准變成 cache-first
//     讓本人卡在舊版。
//   - manifest／icons 這類幾乎不變的殼層資源才 cache-first。
//   - OSM 圖磚（tile.openstreetmap.org 等）完全不經手，第一版不快取，
//     交給瀏覽器預設行為。
//
// 改這支檔案時，如果動到「殼層資源要不要重新抓」的判斷（例如 icons 換了），
// 記得把 CACHE_VERSION 往前推一號，逼 activate 清掉舊快取；純粹調整
// network-first 的容錯邏輯不需要動版本號（它本來就每次都打網路）。

const CACHE_VERSION = "v1";
const CACHE_NAME = `hsinchu-multiday-${CACHE_VERSION}`;

// 殼層資源：install 時預熱，之後 cache-first。都是同源、幾乎不變的檔案。
const SHELL_ASSETS = [
  "./",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-192-maskable.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // 個別 add 失敗（例如某個 icon 檔在本地測試環境還沒 ready）不該讓整個
      // install 失敗——逐一 try，缺的之後靠 fetch handler 補快取。
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
      await self.clients.claim();
    })()
  );
});

function isNavigationRequest(request) {
  if (request.mode === "navigate") return true;
  // 部分瀏覽器對 iframe/某些情境不標記 navigate，用副檔名輔助判斷。
  return (
    request.method === "GET" &&
    request.headers.get("accept") &&
    request.headers.get("accept").includes("text/html")
  );
}

function isShellAsset(url) {
  // manifest 與 icons：同源、路徑在 scope 底下的 manifest.webmanifest 或 icons/*
  return /\/manifest\.webmanifest$/.test(url.pathname) || /\/icons\//.test(url.pathname);
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(request);
    // 只快取成功的同源回應；opaque/失敗回應不寫入快取。
    if (fresh && fresh.ok) {
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (err) {
    const cached =
      (await cache.match(request)) || (await cache.match("./")) || (await cache.match("./index.html"));
    if (cached) return cached;
    return new Response(
      "<!doctype html><meta charset=utf-8><title>離線</title>" +
        "<body style='font-family:system-ui;padding:2em;color:#5c5449'>" +
        "<h1>目前離線</h1><p>連不上網路，也還沒有快取過這一頁。恢復網路後重新整理即可。</p>",
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
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
  if (request.method !== "GET") return; // 只處理讀取，寫入類請求原樣放行

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // 跨源（OSM 圖磚等）完全不經手

  if (isNavigationRequest(request)) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (isShellAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // 其餘同源請求（例如未來新增的同源腳本/樣式）：不特別處理，走瀏覽器預設。
});
