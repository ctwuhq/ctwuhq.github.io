// app.js — 資料載入 + 渲染邏輯

(function () {
  "use strict";

  // ── State ──
  let allRows = [];      // [{date, weekday, booth_no, vendor_no, vendor_name, category, product}]
  let availableDates = []; // sorted unique date strings
  let currentIndex = -1;
  let lastUpdated = "";
  let isOffline = false;
  let viewMode = "list"; // "list" | "map"

  // ── DOM refs ──
  const $date = document.getElementById("current-date");
  const $badge = document.getElementById("date-badge");
  const $updated = document.getElementById("updated-time");
  const $boothList = document.getElementById("booth-list");
  const $boothMap = document.getElementById("booth-map");
  const $prevBtn = document.getElementById("btn-prev");
  const $nextBtn = document.getElementById("btn-next");
  const $offlineBanner = document.getElementById("offline-banner");
  const $loading = document.getElementById("loading");
  const $tabList = document.getElementById("tab-list");
  const $tabMap = document.getElementById("tab-map");

  // ── Init ──
  window.addEventListener("load", init);
  window.addEventListener("online", () => { isOffline = false; hideBanner(); fetchData(); });
  window.addEventListener("offline", () => { isOffline = true; showBanner(); });
  $prevBtn.addEventListener("click", () => navigate(-1));
  $nextBtn.addEventListener("click", () => navigate(1));
  $tabList.addEventListener("click", () => switchView("list"));
  $tabMap.addEventListener("click", () => switchView("map"));

  async function init() {
    if (!navigator.onLine) isOffline = true;
    await fetchData();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  function switchView(mode) {
    viewMode = mode;
    $tabList.classList.toggle("active", mode === "list");
    $tabMap.classList.toggle("active", mode === "map");
    $tabList.setAttribute("aria-pressed", mode === "list");
    $tabMap.setAttribute("aria-pressed", mode === "map");
    $boothList.hidden = mode !== "list";
    $boothMap.hidden = mode !== "map";
    render();
  }

  // ── Data fetching ──
  async function fetchData() {
    showLoading(true);
    try {
      const [rows, log] = await Promise.all([fetchSheet(), fetchLog()]);
      allRows = parseRows(rows);
      lastUpdated = parseLog(log);
      availableDates = [...new Set(allRows.map(r => r.date))].sort();
      jumpToToday();
    } catch (err) {
      console.error("資料載入失敗", err);
      if (allRows.length === 0) {
        $boothList.innerHTML = '<p class="empty-msg">無法載入資料，請稍後再試。</p>';
      }
    }
    showLoading(false);
  }

  async function fetchSheet() {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${encodeURIComponent(CONFIG.SHEET_RANGE)}?key=${CONFIG.API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Sheets API ${res.status}`);
    const data = await res.json();
    return data.values || [];
  }

  async function fetchLog() {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${encodeURIComponent(CONFIG.LOG_RANGE)}?key=${CONFIG.API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return data.values || [];
  }

  function parseRows(values) {
    if (values.length < 2) return [];
    return values.slice(1).map(r => ({
      date: r[0] || "",
      weekday: r[1] || "",
      booth_no: parseInt(r[2], 10) || 0,
      vendor_no: r[3] || "",
      vendor_name: r[4] || "",
      category: r[5] || "",
      product: r[6] || "",
    })).filter(r => r.date && r.booth_no);
  }

  function parseLog(values) {
    if (values.length < 2) return "";
    const last = values[values.length - 1];
    return last[0] || "";
  }

  // ── Navigation ──
  function jumpToToday() {
    const today = new Date().toISOString().slice(0, 10);
    const idx = availableDates.indexOf(today);
    currentIndex = idx >= 0 ? idx : findClosestDate(today);
    render();
  }

  function findClosestDate(target) {
    if (availableDates.length === 0) return -1;
    for (let i = 0; i < availableDates.length; i++) {
      if (availableDates[i] >= target) return i;
    }
    return availableDates.length - 1;
  }

  function navigate(delta) {
    const next = currentIndex + delta;
    if (next < 0 || next >= availableDates.length) return;
    currentIndex = next;
    render();
  }

  // ── Rendering ──
  function render() {
    if (availableDates.length === 0 || currentIndex < 0) {
      $date.textContent = "無攤位資料";
      $badge.textContent = "";
      $updated.textContent = "";
      $boothList.innerHTML = '<p class="empty-msg">目前沒有已發布的攤位資料。</p>';
      $boothMap.innerHTML = "";
      updateNavButtons();
      return;
    }

    const dateStr = availableDates[currentIndex];
    const today = new Date().toISOString().slice(0, 10);
    const dayRows = allRows.filter(r => r.date === dateStr);
    const weekday = dayRows.length > 0 ? dayRows[0].weekday : "";

    $date.textContent = `${dateStr.replace(/-/g, "/")} (${weekday})`;

    if (dateStr === today) {
      $badge.textContent = "📍 今日";
      $badge.className = "badge badge-today";
      $date.classList.remove("past");
    } else if (dateStr < today) {
      $badge.textContent = "（已過）";
      $badge.className = "badge badge-past";
      $date.classList.add("past");
    } else {
      $badge.textContent = "";
      $badge.className = "badge";
      $date.classList.remove("past");
    }

    $updated.textContent = lastUpdated ? `更新時間：${lastUpdated}` : "";

    if (viewMode === "map") {
      renderMap(dayRows);
    } else {
      renderBooths(dayRows);
    }
    updateNavButtons();
  }

  function renderBooths(dayRows) {
    const boothMap = {};
    dayRows.forEach(r => { boothMap[r.booth_no] = r; });

    let html = "";
    for (let i = 1; i <= CONFIG.BOOTH_COUNT; i++) {
      const r = boothMap[i];
      if (r && r.vendor_no) {
        const detail = [r.category, r.product].filter(Boolean).join("｜");
        html += `
          <article class="booth-card">
            <div class="booth-no">${i}號</div>
            <div class="booth-info">
              <div class="vendor-name">${escapeHtml(r.vendor_name)}</div>
              <div class="vendor-detail">${escapeHtml(detail)}</div>
            </div>
          </article>`;
      } else {
        html += `
          <article class="booth-card booth-empty">
            <div class="booth-no">${i}號</div>
            <div class="booth-info">
              <div class="vendor-name">（空位）</div>
            </div>
          </article>`;
      }
    }
    $boothList.innerHTML = html;
  }

  // ── Map rendering ──
  // 每個格子: [boothNo, gridCol, gridRow]  (null = 地標)
  // Grid: 5 cols × 5 rows
  // Col 1=left-landmark, Col 2-4=booths, Col 5=right-landmark
  // Row 1=elevator, Row 2-5=booth rows
  const FLOOR_LAYOUT = [
    // 攤位號, grid-column (1-5), grid-row (1-5)
    [9,  1, 2],
    [3,  2, 2],
    [2,  3, 2],
    [1,  4, 2],
    [7,  2, 3],
    [6,  3, 3],
    [5,  4, 3],
    [12, 2, 4],
    [10, 3, 4],
    [11, 4, 4],
    [8,  2, 5],
    [4,  3, 5],
    [13, 4, 5],
  ];

  function renderMap(dayRows) {
    const boothMap = {};
    dayRows.forEach(r => { boothMap[r.booth_no] = r; });

    let html = `<div class="floor-grid">`;

    // 電梯標籤 (col 2-4, row 1)
    html += `<div class="lm lm-elevator" style="grid-column:2/5;grid-row:1;">🛗 電梯</div>`;
    // 餐廳 (col 5, row 2-3)
    html += `<div class="lm lm-side" style="grid-column:5;grid-row:2/4;">餐廳</div>`;
    // 7-11 (col 1, row 3)
    html += `<div class="lm lm-side" style="grid-column:1;grid-row:3;">7-11</div>`;
    // 喜憨兒 (col 1, row 5)
    html += `<div class="lm lm-side" style="grid-column:1;grid-row:5;">喜憨兒</div>`;

    // 攤位卡片
    FLOOR_LAYOUT.forEach(([no, col, row]) => {
      const r = boothMap[no];
      const occupied = r && r.vendor_no;
      const cls = occupied ? "mc-card mc-occupied" : "mc-card mc-vacant";
      const vendorHtml = occupied
        ? `<div class="mc-name">${escapeHtml(r.vendor_name)}</div>
           ${r.category ? `<div class="mc-tag">${escapeHtml(r.category)}</div>` : ""}`
        : `<div class="mc-name mc-empty-text">空位</div>`;

      html += `
        <div class="${cls}" style="grid-column:${col};grid-row:${row};"
             onclick="mapClick(event,${no})"
             data-no="${no}" data-name="${escapeHtml(occupied ? r.vendor_name : "")}"
             data-category="${escapeHtml(occupied ? (r.category||"") : "")}"
             data-product="${escapeHtml(occupied ? (r.product||"") : "")}"
             data-occupied="${occupied ? "1" : "0"}">
          <div class="mc-no">${no}號</div>
          ${vendorHtml}
        </div>`;
    });

    html += `</div>
    <div id="map-detail" class="map-detail" hidden></div>`;

    $boothMap.innerHTML = html;
  }

  // 點擊攤位 → 顯示詳情（全域函數，供 onclick 呼叫）
  window.mapClick = function(e, no) {
    const card = e.currentTarget;
    // 清除其他選中
    $boothMap.querySelectorAll(".mc-card.mc-selected").forEach(el => el.classList.remove("mc-selected"));
    card.classList.add("mc-selected");

    const detail = document.getElementById("map-detail");
    const occupied = card.dataset.occupied === "1";
    if (!occupied) {
      detail.innerHTML = `<div class="detail-empty">📦 ${no}號攤位　目前無攤商進駐</div>`;
    } else {
      const name = card.dataset.name;
      const cat = card.dataset.category;
      const prod = card.dataset.product;
      detail.innerHTML = `
        <div class="detail-header">${no}號攤位</div>
        <div class="detail-row"><span>攤商名稱</span><strong>${name}</strong></div>
        ${cat ? `<div class="detail-row"><span>類別</span><strong>${cat}</strong></div>` : ""}
        ${prod ? `<div class="detail-row"><span>販售品項</span><strong>${prod}</strong></div>` : ""}
      `;
    }
    detail.hidden = false;
  };

  function updateNavButtons() {
    $prevBtn.disabled = currentIndex <= 0;
    $nextBtn.disabled = currentIndex >= availableDates.length - 1;
  }

  // ── Helpers ──
  function showLoading(show) {
    $loading.style.display = show ? "flex" : "none";
  }

  function showBanner() {
    $offlineBanner.hidden = false;
  }

  function hideBanner() {
    $offlineBanner.hidden = true;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
})();
