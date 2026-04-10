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
  let showEmpty = true;    // 顯示空位
  let activeCat  = null;   // 類別篩選（null = 全部）
  let _cachedDayRows = []; // 供篩選重繪使用

  // ── DOM refs ──
  const $date = document.getElementById("current-date");
  const $badge = document.getElementById("date-badge");
  const $updated = document.getElementById("updated-time");
  const $boothList   = document.getElementById("booth-list");
  const $boothMap    = document.getElementById("booth-map");
  const $boothSearch = document.getElementById("booth-search");
  const $prevBtn = document.getElementById("btn-prev");
  const $nextBtn = document.getElementById("btn-next");
  const $offlineBanner = document.getElementById("offline-banner");
  const $loading = document.getElementById("loading");
  const $tabList   = document.getElementById("tab-list");
  const $tabMap    = document.getElementById("tab-map");
  const $tabSearch = document.getElementById("tab-search");

  // ── Init ──
  window.addEventListener("load", init);
  window.addEventListener("online", () => { isOffline = false; hideBanner(); fetchData(); });
  window.addEventListener("offline", () => { isOffline = true; showBanner(); });
  $prevBtn.addEventListener("click", () => navigate(-1));
  $nextBtn.addEventListener("click", () => navigate(1));
  $tabList.addEventListener("click", () => switchView("list"));
  $tabMap.addEventListener("click", () => switchView("map"));
  $tabSearch.addEventListener("click", () => switchView("search"));
  $boothList.addEventListener("click", handleListClick);

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
    $tabSearch.classList.toggle("active", mode === "search");
    $tabList.setAttribute("aria-pressed", mode === "list");
    $tabMap.setAttribute("aria-pressed", mode === "map");
    $tabSearch.setAttribute("aria-pressed", mode === "search");
    $boothList.hidden = mode !== "list";
    $boothMap.hidden = mode !== "map";
    $boothSearch.hidden = mode !== "search";
    if (mode === "search") {
      renderSearch();
    } else {
      render();
    }
  }

  // ── Data fetching ──
  async function fetchData() {
    showLoading(true);
    try {
      const [rows, log] = await Promise.all([fetchSheet(), fetchLog()]);
      allRows = parseRows(rows);
      lastUpdated = parseLog(log);
      const _today = new Date().toISOString().slice(0, 10);
      availableDates = [...new Set(allRows.map(r => r.date))].sort().filter(d => d >= _today);
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

  // ── 未來擺攤排程輔助 ──
  function getFutureSchedule(vendorNo, vendorName) {
    const currentDate = availableDates[currentIndex] || "";
    return allRows
      .filter(r => (vendorNo ? r.vendor_no === vendorNo : r.vendor_name === vendorName) && r.date > currentDate)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  function buildScheduleHtml(futureDates, title = "📅 之後擺攤日期") {
    if (futureDates.length === 0) {
      return `<div class="detail-schedule"><div class="sched-none">（本次是最近一場）</div></div>`;
    }
    const items = futureDates.map(r =>
      `<div class="sched-item">
         <span class="sched-date">${r.date.replace(/-/g, '/')} (${r.weekday})</span>
         <span class="sched-booth">${r.booth_no}號</span>
       </div>`
    ).join('');
    return `<div class="detail-schedule"><div class="sched-title">${title}</div>${items}</div>`;
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
    } else {
      $badge.textContent = "";
      $badge.className = "badge";
    }
    $date.classList.remove("past");

    $updated.textContent = lastUpdated ? `更新時間：${lastUpdated}` : "";

    if (viewMode === "map") {
      renderMap(dayRows);
    } else {
      renderBooths(dayRows);
    }
    updateNavButtons();
  }

  function renderBooths(dayRows) {
    _cachedDayRows = dayRows;
    const boothMap = {};
    dayRows.forEach(r => { boothMap[r.booth_no] = r; });

    // 今日已存在的類別
    const catsInDay = [...new Set(dayRows.filter(r => r.vendor_no && r.category).map(r => r.category))];

    // ── 篩選列 ──
    let filterChips = `<button class="filter-chip${!activeCat ? ' active' : ''}" data-cat="">全部</button>`;
    catsInDay.forEach(cat => {
      const ci = getCat(cat);
      const isActive = activeCat === cat;
      filterChips += `<button class="filter-chip${isActive ? ' active' : ''}" data-cat="${escapeHtml(cat)}" style="--chip-color:${ci.color};">${ci.abbr} ${cat.split('/')[0]}</button>`;
    });
    const hideLabel = showEmpty ? '👁 含空位' : '🙈 僅有攤';
    let html = `
      <div class="list-filter-bar">
        <div class="list-filter-cats">${filterChips}</div>
        <button class="hide-empty-btn${showEmpty ? '' : ' active'}" data-action="toggle-empty">${hideLabel}</button>
      </div>`;

    // ── 攤位卡片 ──
    let cardCount = 0;
    for (let i = 1; i <= CONFIG.BOOTH_COUNT; i++) {
      const r = boothMap[i];
      if (r && r.vendor_no) {
        if (activeCat && r.category !== activeCat) continue;
        const catInfo = r.category ? getCat(r.category) : null;
        const catColor = catInfo ? catInfo.color : '#bbb';
        const catAbbr  = catInfo ? catInfo.abbr  : '';
        const futureCount = getFutureSchedule(r.vendor_no, r.vendor_name).length;
        const futureHtml = futureCount > 0
          ? `<div class="booth-future-hint">還有<br><strong>${futureCount}</strong>場</div>`
          : `<div class="booth-future-hint last-time">最後<br>一場</div>`;
        cardCount++;
        html += `
          <article class="booth-card booth-clickable"
                   data-booth-no="${i}"
                   data-vendor-no="${escapeHtml(r.vendor_no)}"
                   data-vendor-name="${escapeHtml(r.vendor_name)}"
                   data-category="${escapeHtml(r.category || '')}"
                   data-product="${escapeHtml(r.product || '')}"
                   style="border-left: 4px solid ${catColor};">
            <div class="booth-no">${i}號</div>
            <div class="booth-info">
              <div class="vendor-name">
                ${escapeHtml(r.vendor_name)}
                ${catAbbr ? `<span class="list-cat-chip" style="background:${catColor};">${catAbbr}</span>` : ''}
              </div>
              ${r.product ? `<div class="vendor-detail">${escapeHtml(r.product)}</div>` : ''}
            </div>
            ${futureHtml}
          </article>`;
      } else {
        if (!showEmpty || activeCat) continue;
        cardCount++;
        html += `
          <article class="booth-card booth-empty">
            <div class="booth-no">${i}號</div>
            <div class="booth-info">
              <div class="vendor-name">（空位）</div>
            </div>
          </article>`;
      }
    }
    if (cardCount === 0) {
      html += `<p class="empty-msg">今日無符合條件的攤位</p>`;
    }
    html += `<div id="list-detail" class="map-detail" hidden></div>`;
    $boothList.innerHTML = html;
  }

  // ── Map rendering ──
  // 格子: [boothNo, gridCol, gridRowStart, gridRowEnd(可選)]
  // Grid: 6 cols × 9 rows
  // Col 1=外部左標籤(7-11/喜憨兒), Col 2=攤位9欄, Col 3-5=主攤位, Col 6=右側地標(餐廳)
  // Row 1=電梯, Row 2=攤位列A, Row 3=步行走廊,
  // Row 4=攤位列B, Row 5=實體牆, Row 6=攤位列C,
  // Row 7=步行走廊, Row 8=攤位列D, Row 9=底部地標
  const FLOOR_LAYOUT = [
    // [攤位號, grid-column, grid-row-start, grid-row-end(不含)]
    [9,  2, 2, 5],   // 攤位9跨 row2~4（高瘦垂直攤位）
    [3,  3, 2],
    [2,  4, 2],
    [1,  5, 2],
    [7,  3, 4],
    [6,  4, 4],
    [5,  5, 4],
    [12, 3, 6],
    [10, 4, 6],
    [11, 5, 6],
    [8,  3, 8],
    [4,  4, 8],
    [13, 5, 8],
  ];

  // 類別 → { CSS class, 角標字, 圖例顏色 }
  // 前 5 大類別各有專屬顏色；珠寶/飾品 與 服飾/織品 合併同色
  const CAT_MAP = {
    '食品/餐飲': { cls: 'mc-cat-food',    abbr: '食', color: '#F57C00' },
    '生活/百貨': { cls: 'mc-cat-daily',   abbr: '百', color: '#1565C0' },
    '服飾/織品': { cls: 'mc-cat-clothes', abbr: '飾', color: '#6A1B9A' },
    '珠寶/飾品': { cls: 'mc-cat-clothes', abbr: '飾', color: '#6A1B9A' },
    '生鮮/農產': { cls: 'mc-cat-fresh',   abbr: '農', color: '#00796B' },
    '鞋包/皮件': { cls: 'mc-cat-shoes',   abbr: '鞋', color: '#5D4037' },
  };
  // 其餘類別歸入「其他」
  function getCat(cat) {
    return CAT_MAP[cat] || { cls: 'mc-cat-other', abbr: '他', color: '#757575' };
  }

  function renderMap(dayRows) {
    const boothMap = {};
    dayRows.forEach(r => { boothMap[r.booth_no] = r; });

    // 外牆 wrapper 包住整個 floor-grid
    let html = `<div class="floor-plan-wrapper"><div class="floor-grid">`;

    // 電梯標籤 (col 3-5, row 1 — 不含攤位9那欄)
    html += `<div class="lm lm-elevator" style="grid-column:3/6;grid-row:1;">🛗 電梯</div>`;
    // 餐廳 (col 6, row 2-4，與攤位 1-7 同高)
    html += `<div class="lm lm-side" style="grid-column:6;grid-row:2/5;">🍽️ 餐廳</div>`;
    // 7-11 (col 1, row 2-4，與攤位 9 同高，位於攤位 9 左側)
    html += `<div class="lm lm-side" style="grid-column:1;grid-row:2/5;">🏪 販賣部(7-11)</div>`;
    // 喜憨兒 (col 1-2, row 9 — 跨兩欄，與攤位9同欄)
    html += `<div class="lm lm-side" style="grid-column:1/3;grid-row:9;">喜憨兒</div>`;
    // 樓梯（col 6, row 9 — 13號攤位右下角）
    html += `<div class="lm lm-side" style="grid-column:6;grid-row:9;">🪜 樓梯</div>`;

    // 橫向實體牆（row 5，全欄）
    html += `<div class="wall-h" style="grid-row:5;"></div>`;

    // 攤位卡片
    FLOOR_LAYOUT.forEach(([no, col, rowStart, rowEnd]) => {
      const r = boothMap[no];
      const occupied = r && r.vendor_no;
      const catInfo = occupied && r.category ? getCat(r.category) : null;
      const cls = occupied
        ? `mc-card mc-occupied${catInfo ? ' ' + catInfo.cls : ''}`
        : 'mc-card mc-vacant';
      const vendorHtml = occupied
        ? `<div class="mc-name">${escapeHtml(r.vendor_name)}</div>`
        : `<div class="mc-name mc-empty-text">空位</div>`;
      const badgeHtml = catInfo
        ? `<div class="mc-badge">${catInfo.abbr}</div>`
        : '';
      const rowStyle = rowEnd
        ? `grid-column:${col};grid-row:${rowStart}/${rowEnd};${no === 9 ? 'margin-bottom:78px;' : ''}`
        : `grid-column:${col};grid-row:${rowStart};`;

      html += `
        <div class="${cls}" style="${rowStyle}"
             onclick="mapClick(event,${no})"
             data-no="${no}" data-name="${escapeHtml(occupied ? r.vendor_name : "")}"
             data-vendor-no="${escapeHtml(occupied ? r.vendor_no : "")}"
             data-category="${escapeHtml(occupied ? (r.category||"") : "")}"
             data-product="${escapeHtml(occupied ? (r.product||"") : "")}"
             data-occupied="${occupied ? "1" : "0"}">
          ${badgeHtml}
          <div class="mc-no">${no}號</div>
          ${vendorHtml}
        </div>`;
    });

    // 類別圖例（去除重複 cls，合併同色類別）
    const LEGEND_ITEMS = [
      { label: '食品/餐飲', color: '#F57C00' },
      { label: '生活/百貨', color: '#1565C0' },
      { label: '服飾‧飾品', color: '#6A1B9A' },
      { label: '生鮮/農產', color: '#00796B' },
      { label: '鞋包/皮件', color: '#5D4037' },
      { label: '其他',      color: '#757575' },
    ];
    const legendItems = LEGEND_ITEMS.map(({ label, color }) =>
      `<span class="cat-legend-item">
        <span class="cat-legend-dot" style="background:${color};"></span>${label}
       </span>`
    ).join('');
    html += `</div></div>
    <p class="map-disclaimer">本圖為示意性質，空間比例及位置僅供參考</p>
    <div class="cat-legend">${legendItems}</div>
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
      const vendorNo = card.dataset.vendorNo;
      const futureDates = getFutureSchedule(vendorNo, name);
      detail.innerHTML = `
        <div class="detail-header">${no}號攤位</div>
        <div class="detail-row"><span>攤商名稱</span><strong>${name}</strong></div>
        ${cat ? `<div class="detail-row"><span>類別</span><strong>${cat}</strong></div>` : ""}
        ${prod ? `<div class="detail-row"><span>販售品項</span><strong>${prod}</strong></div>` : ""}
        ${buildScheduleHtml(futureDates)}
      `;
    }
    detail.hidden = false;
  };

  function handleListClick(e) {
    // 類別篩選 chip
    const chip = e.target.closest(".filter-chip");
    if (chip) {
      activeCat = chip.dataset.cat || null;
      renderBooths(_cachedDayRows);
      return;
    }
    // 顯示/隱藏空位 toggle
    const hideBtn = e.target.closest(".hide-empty-btn");
    if (hideBtn) {
      showEmpty = !showEmpty;
      renderBooths(_cachedDayRows);
      return;
    }
    // 攤位卡片點擊
    const card = e.target.closest(".booth-clickable");
    if (!card) return;
    $boothList.querySelectorAll(".booth-clickable.selected").forEach(el => el.classList.remove("selected"));
    card.classList.add("selected");
    const detail = document.getElementById("list-detail");
    if (!detail) return;
    const boothNo = card.dataset.boothNo;
    const vendorNo = card.dataset.vendorNo;
    const vendorName = card.dataset.vendorName;
    const cat = card.dataset.category;
    const prod = card.dataset.product;
    const futureDates = getFutureSchedule(vendorNo, vendorName);
    detail.innerHTML = `
      <div class="detail-header">${boothNo}號攤位</div>
      <div class="detail-row"><span>攤商名稱</span><strong>${vendorName}</strong></div>
      ${cat ? `<div class="detail-row"><span>類別</span><strong>${cat}</strong></div>` : ''}
      ${prod ? `<div class="detail-row"><span>販售品項</span><strong>${prod}</strong></div>` : ''}
      ${buildScheduleHtml(futureDates)}
    `;
    detail.hidden = false;
    detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ── 搜尋視圖 ──
  function renderSearch() {
    $boothSearch.innerHTML = `
      <div class="search-bar-wrapper">
        <input type="search" id="search-input" class="search-input"
               placeholder="搜尋攤商名稱或品項…" autocomplete="off" inputmode="search" />
      </div>
      <div id="search-results" class="search-results">
        <p class="search-hint">輸入關鍵字，搜尋今日起的出攤廠商</p>
      </div>
    `;
    const input = document.getElementById("search-input");
    input.addEventListener("input", debounce(() => performSearch(input.value.trim()), 200));
    setTimeout(() => input.focus(), 100);
  }

  function performSearch(query) {
    const $results = document.getElementById("search-results");
    if (!$results) return;

    if (query.length === 0) {
      $results.innerHTML = '<p class="search-hint">輸入關鍵字，搜尋今日起的出攤廠商</p>';
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const q = query.toLowerCase();
    const matchRows = allRows.filter(r =>
      r.date >= today && r.vendor_no &&
      (r.vendor_name.toLowerCase().includes(q) || r.product.toLowerCase().includes(q))
    );

    if (matchRows.length === 0) {
      $results.innerHTML = `<p class="search-hint">找不到「${escapeHtml(query)}」的相關廠商</p>`;
      return;
    }

    // 依廠商分組
    const groups = {};
    matchRows.forEach(r => {
      const key = r.vendor_no || r.vendor_name;
      if (!groups[key]) {
        groups[key] = { vendor_no: r.vendor_no, vendor_name: r.vendor_name, category: r.category, products: new Set(), dates: [] };
      }
      if (r.product) groups[key].products.add(r.product);
      groups[key].dates.push(r);
    });
    Object.values(groups).forEach(g => g.dates.sort((a, b) => a.date.localeCompare(b.date)));
    const sortedGroups = Object.values(groups).sort((a, b) => a.dates[0].date.localeCompare(b.dates[0].date));

    const cards = sortedGroups.map(g => {
      const catInfo = g.category ? getCat(g.category) : null;
      const badgeHtml = catInfo
        ? `<span class="src-cat-badge" style="background:${catInfo.color};">${catInfo.abbr}</span>`
        : '';
      const products = [...g.products].filter(Boolean).join('、');
      const schedHtml = buildScheduleHtml(g.dates, '📅 擺攤日期');
      return `
        <div class="search-result-card">
          <div class="src-header">
            ${badgeHtml}
            <span class="src-name">${escapeHtml(g.vendor_name)}</span>
          </div>
          ${products ? `<div class="src-product">品項：${escapeHtml(products)}</div>` : ''}
          ${schedHtml}
        </div>`;
    }).join('');

    $results.innerHTML = cards;
  }

  function debounce(fn, delay) {
    let timer;
    return function (...args) { clearTimeout(timer); timer = setTimeout(() => fn.apply(this, args), delay); };
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
