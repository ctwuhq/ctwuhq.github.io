// app.js — 資料載入 + 渲染邏輯

(function () {
  "use strict";

  // ── State ──
  let allRows = [];      // [{date, weekday, booth_no, vendor_no, vendor_name, category, product}]
  let availableDates = []; // sorted unique date strings
  let currentIndex = -1;
  let lastUpdated = "";
  let isOffline = false;

  // ── DOM refs ──
  const $date = document.getElementById("current-date");
  const $badge = document.getElementById("date-badge");
  const $updated = document.getElementById("updated-time");
  const $boothList = document.getElementById("booth-list");
  const $prevBtn = document.getElementById("btn-prev");
  const $nextBtn = document.getElementById("btn-next");
  const $offlineBanner = document.getElementById("offline-banner");
  const $loading = document.getElementById("loading");

  // ── Init ──
  window.addEventListener("load", init);
  window.addEventListener("online", () => { isOffline = false; hideBanner(); fetchData(); });
  window.addEventListener("offline", () => { isOffline = true; showBanner(); });
  $prevBtn.addEventListener("click", () => navigate(-1));
  $nextBtn.addEventListener("click", () => navigate(1));

  async function init() {
    if (!navigator.onLine) isOffline = true;
    await fetchData();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
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
    // Find the closest future date, or last available
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
      updateNavButtons();
      return;
    }

    const dateStr = availableDates[currentIndex];
    const today = new Date().toISOString().slice(0, 10);
    const dayRows = allRows.filter(r => r.date === dateStr);
    const weekday = dayRows.length > 0 ? dayRows[0].weekday : "";

    // Date display
    $date.textContent = `${dateStr.replace(/-/g, "/")} (${weekday})`;

    // Badge
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

    // Updated time
    $updated.textContent = lastUpdated ? `更新時間：${lastUpdated}` : "";

    // Booth cards
    renderBooths(dayRows);
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
