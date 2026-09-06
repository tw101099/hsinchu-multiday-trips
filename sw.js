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
// ── 3 秒 timeout（2026-09-05 本人核定）────────────────────────────────────
// 上面那條「絕不准變成 cache-first」**沒有被推翻，一個字都沒有**。加的是一道
// 只在最壞情境才起作用的閘門：網路請求超過 3 秒還沒回來、而且快取裡有副本時，
// 先把副本丟出去讓畫面可用。
//
// 為什麼這不違反那條規矩的精神——三件事：
//   1. **有網而且正常時，行為一個位元組不變**：網路先到就回網路那一份，
//      快取那一份連查都不會查。3 秒是「慢到不正常」的門檻，不是常態路徑。
//   2. **網路請求不中止**：逾時只改變「先讓誰上畫面」，那一趟 fetch 照樣跑完、
//      照樣寫進快取（event.waitUntil 把 SW 留到它回來為止）。所以**下一次開站
//      拿到的就是這一次抓到的新版**——卡在舊版最多卡一次，而且是在網路半死的
//      那一次。cache-first 的問題是「永遠先給舊的」，這裡是「慢到不能用時才
//      先給舊的，而且同時在把新的抓回來」。
//   3. **它堵的是原本沒有出口的那一格**：fetch 沒有失敗、只是很久的時候，
//      舊寫法不會 fallback（catch 進不去），使用者就一直等。這一格才是本人
//      回報「十幾秒」的來源（診斷全文見 reports/perf-audit.md 第 3 節）。
//
// 改這支檔案時，如果動到「殼層資源要不要重新抓」的判斷（例如 icons 換了），
// 記得把 CACHE_VERSION 往前推一號，逼 activate 清掉舊快取；純粹調整
// network-first 的容錯邏輯不需要動版本號（它本來就每次都打網路）——**加這道
// timeout 也不需要，而且刻意不動**：bump 會讓 activate 清掉現有快取，等於把
// 這道閘門要倚靠的那份副本親手刪掉，下一次開站反而少一層保護。SW 自己的更新
// 靠瀏覽器對 sw.js 的位元組比對，跟版本號無關。

// v1→v2：2026-09-06 水墨改版換了 og 與五顆 icon（棒 INK2），照上面那條規則推號，
// 逼 activate 清掉舊快取——不推的話 icons 走 cache-first 且命中不 revalidate，
// 回訪者會永遠拿到舊 icon（棒 INK2 線上實測：SW 端 17747 bytes 舊檔 vs 網路 64353 新檔）。
const CACHE_VERSION = "v2";
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

// 「慢到不正常」的門檻（見檔頭）。網路正常的一趟遠遠碰不到它。
const NET_TIMEOUT_MS = 3000;
// 用一個獨一無二的哨兵區分「網路回來了」與「時間到了」——`undefined`／`null`
// 都可能是 fetch 的合法結果，拿它們當哨兵會誤判。
const TIMED_OUT = Symbol("network-timeout");

function timeoutAfter(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms, TIMED_OUT));
}

// 快取裡的備援副本：先找這個請求自己的，再退到殼層那兩把鑰匙。
function cachedFallback(cache, request) {
  return cache
    .match(request)
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
  // 先發車再開快取：`caches.open()` 不 await，fetch 就不必等它。
  const opening = caches.open(CACHE_NAME);
  const network = fetch(request).then(async (fresh) => {
    // 只快取成功的同源回應；opaque/失敗回應不寫入快取。
    // **put 刻意不 await**（跟加 timeout 之前逐字相同）：等寫完才回應會替
    // 正常路徑平白加上一次寫入的時間。
    if (fresh && fresh.ok) {
      (await opening).put(request, fresh.clone());
    }
    return fresh;
  });
  // 逾時先回快取之後，瀏覽器可能在網路那一趟回來之前就把 SW 收掉——waitUntil
  // 把它留住，那一份新的才寫得進快取（下一次開站就是新的）。catch 的 noop 是
  // 為了不讓 fetch 失敗變成 unhandled rejection：真正的失敗處理在下面的 catch。
  if (event) event.waitUntil(network.catch(() => {}));
  else network.catch(() => {});

  try {
    const first = await Promise.race([network, timeoutAfter(NET_TIMEOUT_MS)]);
    // ── 網路先到：這一整條與加 timeout 之前完全相同（連快取都不查）
    if (first !== TIMED_OUT) return first;
    // ── 慢而不斷：有副本就先給副本，網路那一趟仍在跑、仍會寫快取
    const cached = await cachedFallback(await opening, request);
    if (cached) return cached;
    // ── 慢而且沒有副本可退：照舊等網路（它自己的失敗會落到下面的 catch）
    return await network;
  } catch (err) {
    const cached = await cachedFallback(await opening, request);
    if (cached) return cached;
    return offlinePage();
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
    event.respondWith(networkFirst(request, event));
    return;
  }

  if (isShellAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // 其餘同源請求（例如未來新增的同源腳本/樣式）：不特別處理，走瀏覽器預設。
});
