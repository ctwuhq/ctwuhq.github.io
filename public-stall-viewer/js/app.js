// app.js — 資料載入 + 渲染邏輯

(function () {
  "use strict";

  // ── State ──
  let allRows = [];      // [{date, weekday, booth_no, vendor_no, vendor_name, category, product}]
  let availableDates = []; // sorted unique date strings
  let currentIndex = -1;
  let lastUpdated = "";
  let isOffline = false;
  let viewMode = "map"; // "list" | "map"
  let mapZone = "stall"; // "stall" | "restaurant" | "shop"
  let showEmpty = true;    // 顯示空位
  let activeCat  = null;   // 類別篩選（null = 全部）
  let activeMapCat = null; // 地圖類別篩選（null = 全部）
  let pendingMapBoothNo = null; // 從搜尋跳轉後自動選取攤位
  let _cachedDayRows = []; // 供篩選重繪使用
  let restaurantLayout = [];
  let shopLayout = [];

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
  $boothMap.addEventListener("click", handleMapContainerClick);
  $boothSearch.addEventListener("click", handleSearchClick);

  const $zoomTrigger = document.getElementById("zoom-trigger");
  const $zoomPanel = document.getElementById("zoom-panel");
  const $zoomWidget = document.getElementById("zoom-widget");

  if ($zoomTrigger && $zoomPanel && $zoomWidget) {
    $zoomTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const isHidden = $zoomPanel.hidden;
      $zoomPanel.hidden = !isHidden;
      $zoomTrigger.setAttribute("aria-expanded", isHidden);
    });

    $zoomPanel.addEventListener("click", (e) => {
      const btn = e.target.closest(".zoom-panel-btn");
      if (!btn) return;
      const zoomVal = btn.dataset.zoom;
      localStorage.setItem("font-zoom", zoomVal);
      applyZoom(zoomVal);
    });

    // 點擊外部關閉面板
    document.addEventListener("click", (e) => {
      if (!$zoomWidget.contains(e.target)) {
        $zoomPanel.hidden = true;
        $zoomTrigger.setAttribute("aria-expanded", "false");
      }
    });

    // 按下 Escape 鍵關閉面板
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        $zoomPanel.hidden = true;
        $zoomTrigger.setAttribute("aria-expanded", "false");
      }
    });
  }

  async function init() {
    initZoom();
    if (!navigator.onLine) isOffline = true;
    await fetchData();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  function initZoom() {
    const currentZoom = localStorage.getItem("font-zoom") || "1";
    applyZoom(currentZoom);
  }

  function applyZoom(zoomStr) {
    document.documentElement.setAttribute("data-zoom", zoomStr);
    document.documentElement.style.setProperty("--zoom-factor", zoomStr);
    
    // 更新按鈕選取狀態
    const buttons = document.querySelectorAll(".zoom-panel-btn");
    buttons.forEach(btn => {
      const active = btn.dataset.zoom === zoomStr;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active);
    });
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
      if (CONFIG.DATA_SOURCE === "json") {
        // Cloudflare Pages 模式：讀取本地 data.json
        const res = await fetch("./data.json");
        if (!res.ok) throw new Error(`data.json ${res.status}`);
        const json = await res.json();
        allRows = (json.rows || []).filter(r => r.date && r.booth_no);
        lastUpdated = json.updated_at || "";
        applyMapData(json.maps || {});
      } else {
        // GitHub Pages 模式：Google Sheets API
        const [rows, log] = await Promise.all([fetchSheet(), fetchLog()]);
        allRows = parseRows(rows);
        lastUpdated = parseLog(log);
        applyMapData({});
      }
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

  function normalizeRestaurantLayout(items) {
    const source = Array.isArray(items) && items.length ? items : DEFAULT_RESTAURANT_LAYOUT;
    return source
      .map((r) => ({
        no: Number(r.no) || 0,
        zone: r.zone || r.zone_code || "",
        name: r.name || "",
        row: Number(r.row) || 1,
      }))
      .filter((r) => r.no > 0);
  }

  function normalizeShopLayout(items) {
    const source = Array.isArray(items) && items.length ? items : DEFAULT_SHOP_LAYOUT;
    return source
      .map((s) => ({
        slotKey: s.slotKey || s.slot_key || "",
        code: s.code || "",
        name: s.name || "",
        sortOrder: Number(s.sortOrder || s.sort_order || 0),
        isActive: s.isActive !== false && s.is_active !== false,
      }))
      .filter((s) => s.slotKey && s.code);
  }

  function applyMapData(maps) {
    restaurantLayout = normalizeRestaurantLayout(maps && maps.restaurants);
    shopLayout = normalizeShopLayout(maps && maps.shops);
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
         <span class="sched-date">${escapeHtml(r.date.replace(/-/g, '/'))} (${escapeHtml(r.weekday)})</span>
         <span class="sched-booth">${escapeHtml(String(r.booth_no))}號</span>
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
      if (!$boothSearch.innerHTML) {
        $boothSearch.innerHTML = '<p class="empty-msg">目前沒有已發布的攤位資料。</p>';
      }
      if (viewMode === "map") {
        renderMap([]);
      } else {
        $boothMap.innerHTML = "";
      }
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
  // 北向朝上後的格子配置
  // Grid: 9 cols × 6 rows
  // Col 1=電梯, Col 2/4/6/8=攤位列, Col 3/7=走道, Col 5=實體牆, Col 9=右側地標
  // Row 1=北側地標, Row 2-4=主攤位區, Row 5=9號攤位/南側地標, Row 6=最南側地標
  const FLOOR_LAYOUT = [
    { no: 1,  colStart: 2, rowStart: 2 },
    { no: 2,  colStart: 2, rowStart: 3 },
    { no: 3,  colStart: 2, rowStart: 4 },
    { no: 4,  colStart: 8, rowStart: 3 },
    { no: 5,  colStart: 4, rowStart: 2 },
    { no: 6,  colStart: 4, rowStart: 3 },
    { no: 7,  colStart: 4, rowStart: 4 },
    { no: 8,  colStart: 8, rowStart: 4 },
    { no: 9,  colStart: 2, rowStart: 5 },
    { no: 10, colStart: 6, rowStart: 3 },
    { no: 11, colStart: 6, rowStart: 2 },
    { no: 12, colStart: 6, rowStart: 4 },
    { no: 13, colStart: 8, rowStart: 2 },
  ];

  // ── 餐廳配置 ──
  // Grid: 6 cols × 3 rows (row1=上排, row2=走道, row3=下排)
  const DEFAULT_RESTAURANT_LAYOUT = [
    // 上排（左→右）
    { no: 1,  zone: "A", name: "大福慧印素食",          col: 1, row: 1 },
    { no: 2,  zone: "B", name: "津辣小吃",              col: 2, row: 1 },
    { no: 3,  zone: "C", name: "外婆家",                col: 3, row: 1 },
    { no: 4,  zone: "D", name: "地中海私房料理備品區",   col: 4, row: 1 },
    { no: 5,  zone: "E", name: "豐味食堂",              col: 5, row: 1 },
    { no: 6,  zone: "F", name: "啟運美食",              col: 6, row: 1 },
    // 下排（左→右）
    { no: 12, zone: "L", name: "地中海私房料理",         col: 1, row: 3 },
    { no: 11, zone: "K", name: "壹元大餛飩",            col: 2, row: 3 },
    { no: 10, zone: "J", name: "以琳美食",              col: 3, row: 3 },
    { no: 9,  zone: "I", name: "鍋饌火鍋",              col: 4, row: 3 },
    { no: 8,  zone: "H", name: "肉羹阿姨",              col: 5, row: 3 },
    { no: 7,  zone: "G", name: "幸福咖啡",              col: 6, row: 3 },
  ];

  const DEFAULT_SHOP_LAYOUT = [
    { slotKey: "top_5", code: "5", name: "", sortOrder: 10 },
    { slotKey: "top_4", code: "4", name: "嘿啾咖啡(好食飲料店)", sortOrder: 20 },
    { slotKey: "top_3", code: "3", name: "錦秀工作室", sortOrder: 30 },
    { slotKey: "top_2", code: "2", name: "", sortOrder: 40 },
    { slotKey: "top_1", code: "1", name: "姿樺的店", sortOrder: 50 },
    { slotKey: "left_5_1", code: "5-1", name: "姿樺的店", sortOrder: 60 },
    { slotKey: "left_6", code: "6", name: "戴利百貨", sortOrder: 70 },
    { slotKey: "center_711", code: "7-11", name: "", sortOrder: 80 },
  ];

  const SHOP_SLOT_STYLES = {
    top_1: "grid-column:1;grid-row:1;",
    top_2: "grid-column:1;grid-row:2;",
    top_3: "grid-column:1;grid-row:3;",
    top_4: "grid-column:1;grid-row:4;",
    top_5: "grid-column:1;grid-row:5;",
    left_5_1: "grid-column:2;grid-row:5;",
    left_6: "grid-column:3;grid-row:5;",
    center_711: "grid-column:2/4;grid-row:1/5;",
  };

  applyMapData({});

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

  const MAP_FILTERS = [
    { key: '食品/餐飲', label: '食品/餐飲', color: '#F57C00', categories: ['食品/餐飲'] },
    { key: '生活/百貨', label: '生活/百貨', color: '#1565C0', categories: ['生活/百貨'] },
    { key: '服飾飾品', label: '服飾‧飾品', color: '#6A1B9A', categories: ['服飾/織品', '珠寶/飾品'] },
    { key: '生鮮/農產', label: '生鮮/農產', color: '#00796B', categories: ['生鮮/農產'] },
    { key: '鞋包/皮件', label: '鞋包/皮件', color: '#5D4037', categories: ['鞋包/皮件'] },
    { key: '__other', label: '其他', color: '#757575', categories: [] },
  ];

  function getMapFilterKey(cat) {
    const filter = MAP_FILTERS.find(item => item.categories.includes(cat));
    return filter ? filter.key : '__other';
  }

  function buildZoneSwitcher() {
    const zones = [
      { key: 'stall', label: '臨攤區', icon: '🏪' },
      { key: 'restaurant', label: '餐廳區', icon: '🍽️' },
      { key: 'shop', label: '販賣部', icon: '🛍️' },
    ];
    const buttons = zones.map(({ key, label, icon }) => `
      <button type="button"
              class="zone-btn${mapZone === key ? ' active' : ''}"
              data-zone-target="${key}"
              aria-pressed="${mapZone === key}">
        <span>${icon}</span> <span>${label}</span>
      </button>
    `).join('');
    return `<div class="zone-switcher" role="group" aria-label="地圖區域切換">${buttons}</div>`;
  }

  function renderMap(dayRows) {
    let html = buildZoneSwitcher();
    if (mapZone === "restaurant") {
      html += renderRestaurantMap();
    } else if (mapZone === "shop") {
      html += renderShopMap();
    } else {
      html += renderStallMap(dayRows);
    }

    html += `<div id="map-detail" class="map-detail" hidden></div>`;
    $boothMap.innerHTML = html;

    if (mapZone === "stall" && pendingMapBoothNo) {
      const card = $boothMap.querySelector(`.mc-card[data-no="${pendingMapBoothNo}"]`);
      if (card) selectStallCard(card, pendingMapBoothNo, true);
      pendingMapBoothNo = null;
    }
  }

  window.switchZone = function(zone) {
    mapZone = zone;
    pendingMapBoothNo = null;
    render();
  };

  function renderStallMap(dayRows) {
    const boothMap = {};
    dayRows.forEach(r => { boothMap[r.booth_no] = r; });
    const legendCounts = buildMapLegendCounts(dayRows);

    // 外牆 wrapper 包住整個 floor-grid
    let html = `<div class="floor-plan-wrapper"><div class="north-indicator" aria-hidden="true">北 ↑</div><div class="floor-grid">`;

    // 電梯（西側）
    html += `<div class="lm lm-elevator" style="grid-column:1;grid-row:2/5;"><span class="lm-icon">🛗</span><span>電梯</span></div>`;
    // 餐廳（北側）
    html += `<div class="lm lm-restaurant" style="grid-column:2/5;grid-row:1;" onclick="switchZone('restaurant')" title="切換至餐廳區"><span class="restaurant-badge">🍽️</span><span class="restaurant-label">餐廳區</span></div>`;
    // 7-11（南側）
    html += `<div class="lm lm-seven" style="grid-column:2/5;grid-row:6;" onclick="switchZone('shop')" title="切換至販賣部"><span class="seven-badge"><span class="n7">7</span><span class="dash">-</span><span class="n11">11</span></span><span class="seven-label">販賣部</span></div>`;
    // 喜憨兒（東南側）
    html += `<div class="lm lm-xhn" style="grid-column:8/10;grid-row:6;">🌻 喜憨兒</div>`;
    // 樓梯（東北角）
    html += `<div class="lm lm-stairs" style="grid-column:8/10;grid-row:1;">🪜 樓梯</div>`;

    // 北向朝上後，實體牆改為縱向
    html += `<div class="wall-h" style="grid-column:5;grid-row:1/7;"></div>`;

    // 攤位卡片
    FLOOR_LAYOUT.forEach(({ no, colStart, rowStart, colEnd, rowEnd }) => {
      const r = boothMap[no];
      const occupied = r && r.vendor_no;
      const catInfo = occupied && r.category ? getCat(r.category) : null;
      const mapFilterKey = occupied ? getMapFilterKey(r.category) : '';
      const filterCls = activeMapCat
        ? (occupied && mapFilterKey === activeMapCat ? ' mc-highlight' : ' mc-dimmed')
        : '';
      const cls = occupied
        ? `mc-card mc-occupied${catInfo ? ' ' + catInfo.cls : ''}${filterCls}`
        : `mc-card mc-vacant${filterCls}`;
      const vendorHtml = occupied
        ? `<div class="mc-name">${escapeHtml(r.vendor_name)}</div>`
        : `<div class="mc-name mc-empty-text">空位</div>`;
      const badgeHtml = catInfo
        ? `<div class="mc-badge">${catInfo.abbr}</div>`
        : '';
      const colStyle = colEnd ? `${colStart}/${colEnd}` : `${colStart}`;
      const rowStyle = rowEnd ? `${rowStart}/${rowEnd}` : `${rowStart}`;
      html += `
        <div class="${cls}" style="grid-column:${colStyle};grid-row:${rowStyle};"
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

    html += `</div></div>
    <p class="map-disclaimer">本圖為示意性質，空間比例及位置僅供參考</p>
    ${buildMapLegend(legendCounts)}`;

    return html;
  }

  function buildMapLegendCounts(dayRows) {
    const counts = {};
    dayRows
      .filter(r => r.vendor_no)
      .forEach(r => {
        const key = getMapFilterKey(r.category);
        counts[key] = (counts[key] || 0) + 1;
      });
    if (activeMapCat && !counts[activeMapCat]) activeMapCat = null;
    return counts;
  }

  function buildMapLegend(counts) {
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    if (total === 0) {
      return `<div class="cat-legend cat-legend-empty">今日尚無可篩選的攤商類別</div>`;
    }
    const allButton = `
      <button type="button"
              class="cat-legend-item map-filter-chip${!activeMapCat ? ' active' : ''}"
              data-map-cat=""
              aria-pressed="${!activeMapCat}">
        <span class="cat-legend-dot" style="background:#1a73e8;"></span>
        全部
        <span class="cat-legend-count">${total}</span>
      </button>`;
    const filterButtons = MAP_FILTERS
      .filter(item => counts[item.key])
      .map(item => `
        <button type="button"
                class="cat-legend-item map-filter-chip${activeMapCat === item.key ? ' active' : ''}"
                data-map-cat="${escapeHtml(item.key)}"
                style="--legend-color:${item.color};"
                aria-pressed="${activeMapCat === item.key}">
          <span class="cat-legend-dot" style="background:${item.color};"></span>
          ${item.label}
          <span class="cat-legend-count">${counts[item.key]}</span>
        </button>
      `).join('');
    return `<div class="cat-legend" aria-label="依類別篩選地圖">${allButton}${filterButtons}</div>`;
  }

  function getRestaurantColumns(layout) {
    return [
      [...layout.filter((r) => r.row === 1)].sort((a, b) => b.no - a.no),
      [...layout.filter((r) => r.row === 3)].sort((a, b) => a.no - b.no),
    ];
  }

  function renderRestaurantMap() {
    // 北向朝上後：上方為北側用餐區走道，下方為臨攤區走道
    let html = `<div class="floor-plan-wrapper rest-wrapper"><div class="north-indicator" aria-hidden="true">北 ↑</div><div class="rest-layout">`;

    html += `<div class="rest-side-label rest-side-top">走道（用餐區）</div>`;
    html += `<div class="rest-side-label rest-side-left">走道（用餐區）</div>`;

    html += `<div class="rest-stalls">`;
    getRestaurantColumns(restaurantLayout).forEach((column) => {
      html += `<div class="rest-column">`;
      column.forEach((r) => {
        html += `
          <div class="mc-card rest-card"
               onclick="restClick(event,${r.no})"
               data-no="${r.no}" data-zone="${r.zone}" data-name="${escapeHtml(r.name)}">
            <div class="rest-zone">${r.zone}區</div>
            <div class="mc-no">${r.no}號</div>
            <div class="mc-name">${escapeHtml(r.name)}</div>
          </div>`;
      });
      html += `</div>`;
    });
    html += `</div>`;

    html += `<div class="rest-side-label rest-side-right">走道（用餐區）</div>`;
    html += `<div class="rest-side-label rest-side-bottom">走道<button class="back-to-stall back-to-stall-horizontal" onclick="switchZone('stall')" title="切回臨攤區"><span>🏪</span><span class="back-label">臨攤區</span></button></div>`;

    html += `</div></div>
    <p class="map-disclaimer">本圖為示意性質，空間比例及位置僅供參考</p>`;

    return html;
  }

  function renderShopMap() {
    let html = `<div class="floor-plan-wrapper shop-wrapper"><div class="north-indicator" aria-hidden="true">北 ↑</div>`;
    html += `<div class="shop-header"><div class="shop-title">🏪 販賣部地圖</div><button class="back-to-stall back-to-stall-horizontal" onclick="switchZone('stall')" title="切回臨攤區"><span>🏪</span><span class="back-label">臨攤區</span></button></div>`;
    html += `<div class="shop-layout">`;
    html += `<div class="shop-entry-label" aria-hidden="true">門口</div>`;
    shopLayout
      .filter((s) => s.isActive)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code))
      .forEach((s) => {
        const extraClasses = s.slotKey === "center_711" ? "shop-card-large" : "";
        html += `
          <div class="mc-card shop-card${extraClasses ? ` ${extraClasses}` : ""}"
               style="${SHOP_SLOT_STYLES[s.slotKey] || ""}"
               onclick='shopClick(event,${JSON.stringify(s.code)})'
               data-code="${escapeHtml(s.code)}" data-name="${escapeHtml(s.name || "")}">
            <div class="shop-code">${escapeHtml(s.code)}</div>
            <div class="shop-name${s.name ? "" : " shop-name-empty"}">${escapeHtml(s.name || "")}</div>
          </div>`;
      });
    html += `</div></div>
    <p class="map-disclaimer">本圖為示意性質，空間比例及位置僅供參考</p>`;

    return html;
  }

  // 點擊餐廳 → 顯示詳情
  window.restClick = function(e, no) {
    const card = e.currentTarget;
    $boothMap.querySelectorAll(".mc-card.mc-selected").forEach(el => el.classList.remove("mc-selected"));
    card.classList.add("mc-selected");

    const detail = document.getElementById("map-detail");
    const name = card.dataset.name;
    const zone = card.dataset.zone;
    detail.innerHTML = `
      <div class="detail-header">🍽️ ${no}號餐廳</div>
      <div class="detail-row"><span>餐廳名稱</span><strong>${escapeHtml(name)}</strong></div>
      <div class="detail-row"><span>區域代號</span><strong>${escapeHtml(zone)}區</strong></div>
    `;
    detail.hidden = false;
    scrollIntoViewWithOffset(detail);
  };

  window.shopClick = function(e, code) {
    const card = e.currentTarget;
    $boothMap.querySelectorAll(".mc-card.mc-selected").forEach(el => el.classList.remove("mc-selected"));
    card.classList.add("mc-selected");

    const detail = document.getElementById("map-detail");
    const name = card.dataset.name;
    detail.innerHTML = `
      <div class="detail-header">🏪 ${escapeHtml(code)} 販賣部</div>
      <div class="detail-row"><span>位置碼</span><strong>${escapeHtml(code)}</strong></div>
      <div class="detail-row"><span>名稱</span><strong>${escapeHtml(name || "—")}</strong></div>
    `;
    detail.hidden = false;
    scrollIntoViewWithOffset(detail);
  };

  // 點擊攤位 → 顯示詳情（全域函數，供 onclick 呼叫）
  window.mapClick = function(e, no) {
    selectStallCard(e.currentTarget, no, true);
  };

  function selectStallCard(card, no, shouldScroll) {
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
        <div class="detail-row"><span>攤商名稱</span><strong>${escapeHtml(name)}</strong></div>
        ${cat ? `<div class="detail-row"><span>類別</span><strong>${escapeHtml(cat)}</strong></div>` : ""}
        ${prod ? `<div class="detail-row"><span>販售品項</span><strong>${escapeHtml(prod)}</strong></div>` : ""}
        ${buildScheduleHtml(futureDates)}
      `;
    }
    detail.hidden = false;
    if (shouldScroll) scrollIntoViewWithOffset(detail);
  }

  function handleMapContainerClick(e) {
    const zoneBtn = e.target.closest("[data-zone-target]");
    if (zoneBtn) {
      mapZone = zoneBtn.dataset.zoneTarget;
      pendingMapBoothNo = null;
      render();
      return;
    }

    const filterBtn = e.target.closest(".map-filter-chip[data-map-cat]");
    if (filterBtn) {
      activeMapCat = filterBtn.dataset.mapCat || null;
      pendingMapBoothNo = null;
      render();
    }
  }

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
      <div class="detail-row"><span>攤商名稱</span><strong>${escapeHtml(vendorName)}</strong></div>
      ${cat ? `<div class="detail-row"><span>類別</span><strong>${escapeHtml(cat)}</strong></div>` : ''}
      ${prod ? `<div class="detail-row"><span>販售品項</span><strong>${escapeHtml(prod)}</strong></div>` : ''}
      ${buildScheduleHtml(futureDates)}
    `;
    detail.hidden = false;
    scrollIntoViewWithOffset(detail);
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
      const schedHtml = buildSearchScheduleHtml(g.dates, '📅 擺攤日期');
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

  function buildSearchScheduleHtml(rows, title) {
    const items = rows.map(r => `
      <div class="sched-item sched-item-action">
        <span class="sched-date">${escapeHtml(r.date.replace(/-/g, '/'))} (${escapeHtml(r.weekday)})</span>
        <span class="sched-right">
          <span class="sched-booth">${escapeHtml(String(r.booth_no))}號</span>
          <button type="button"
                  class="sched-map-btn"
                  data-map-date="${escapeHtml(r.date)}"
                  data-map-booth="${r.booth_no}">
            看地圖
          </button>
        </span>
      </div>
    `).join('');
    return `<div class="detail-schedule"><div class="sched-title">${title}</div>${items}</div>`;
  }

  function handleSearchClick(e) {
    const btn = e.target.closest(".sched-map-btn");
    if (!btn) return;
    const dateStr = btn.dataset.mapDate;
    const boothNo = parseInt(btn.dataset.mapBooth, 10);
    const idx = availableDates.indexOf(dateStr);
    if (idx < 0 || !boothNo) return;
    currentIndex = idx;
    mapZone = "stall";
    activeMapCat = null;
    pendingMapBoothNo = boothNo;
    switchView("map");
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

  function scrollIntoViewWithOffset(element) {
    if (!element) return;
    const zoomVal = parseFloat(document.documentElement.style.getPropertyValue("--zoom-factor")) || 1;
    const offset = 85 * zoomVal;
    setTimeout(() => {
      const rect = element.getBoundingClientRect();
      const targetTop = window.pageYOffset + rect.bottom - window.innerHeight + offset;
      if (rect.bottom > window.innerHeight - offset) {
        window.scrollTo({
          top: Math.max(window.pageYOffset + rect.top - 20, targetTop),
          behavior: 'smooth'
        });
      }
    }, 50);
  }
})();
