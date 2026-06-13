// sw.js — Service Worker（Stale-While-Revalidate 快取策略）
//
// 部署新版本時，只要修改 CACHE_VERSION 即可讓所有使用者拿到新檔案。
// 格式建議：YYYY-MM-DD 或遞增版號
const CACHE_VERSION = "2026-04-29a";
const CACHE_NAME = `b1-stall-${CACHE_VERSION}`;

const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/config.js",
  "./js/app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

// Install: 預載靜態資源
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: 清除舊版快取，並通知頁面「有新版本可用」
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(async (keys) => {
      const oldCaches = keys.filter((k) => k !== CACHE_NAME);
      if (oldCaches.length > 0) {
        // 有舊快取 → 代表這是一次更新，通知所有開啟的頁面
        const clients = await self.clients.matchAll({ type: "window" });
        clients.forEach((client) =>
          client.postMessage({ type: "SW_UPDATED", version: CACHE_VERSION })
        );
      }
      return Promise.all(oldCaches.map((k) => caches.delete(k)));
    })
  );
  self.clients.claim();
});

// Fetch 策略：
//   Google Sheets API → Network First（資料優先新鮮）
//   index.html        → Network First（確保每次都能拿到最新 HTML）
//   其他靜態資源      → Stale-While-Revalidate（快速回應 + 背景更新）
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Google Sheets API → Network First
  if (url.hostname === "sheets.googleapis.com") {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // data.json → Network First（Cloudflare Pages 版資料來源）
  if (url.pathname.endsWith("/data.json")) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // index.html → Network First（避免舊 HTML 殼殼包著新 JS）
  if (url.pathname.endsWith("/") || url.pathname.endsWith("index.html")) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // 其他靜態資源（CSS/JS/圖片）→ Stale-While-Revalidate
  event.respondWith(staleWhileRevalidate(event.request));
});

// Stale-While-Revalidate：先回傳快取，同時背景更新
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  // 背景更新（不等待）
  const networkFetch = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  // 有快取 → 立即回傳快取版本（同時背景更新）
  if (cached) return cached;

  // 無快取 → 等待網路（首次造訪或快取被清除）
  return networkFetch.then((res) => res || new Response("Offline", { status: 503 }));
}

// Network First：優先網路，失敗才用快取
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Sheets API 離線時回傳空資料（讓 app.js 顯示離線提示）
    const reqUrl = new URL(request.url);
    if (reqUrl.hostname === "sheets.googleapis.com") {
      return new Response('{"values":[]}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // data.json 離線時回傳空資料
    if (reqUrl.pathname.endsWith("/data.json")) {
      return new Response('{"rows":[],"updated_at":""}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Offline", { status: 503 });
  }
}
