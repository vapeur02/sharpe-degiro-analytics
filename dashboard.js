// dashboard.js — Sharpe extension main dashboard
// Shared constants (COLORS, CASH_IDS, etc.) and utilities are in utils.js,
// loaded before this file via dashboard.html.

const BENCHMARK_CONFIG = {
  sp500:     { key: '__SP500__',     label: 'S&P 500',       color: '#00A8E1', dash: [4, 3] },
  eurostoxx: { key: '__EUROSTOXX__', label: 'Euro Stoxx 50', color: '#F5A623', dash: [6, 3] },
  nasdaq:    { key: '__NASDAQ__',     label: 'Nasdaq 100',   color: '#A855F7', dash: [2, 3] },
};
const BENCHMARK_KEYS = new Set(Object.values(BENCHMARK_CONFIG).map(b => b.key));

/**
 * Escape a string for safe insertion into innerHTML.
 * Must be applied to any value that originates from an external API
 * (e.g. DEGIRO product names) before interpolation into an HTML template.
 * Pure computed values (numbers, hardcoded labels, normalised date strings)
 * do not need this — only untrusted API-derived strings do.
 */
function sanitize(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Diagnostic logging — flip to true when debugging calculations.
const DEBUG = false;
function dlog(...args) { if (DEBUG) console.log(...args); }

let charts = {};
let globalData = {};
let proUnlocked = false; // set in renderAll after checking license
let dragZoomState = { active: false, startX: null, currentX: null, preDragPeriod: null };

// ── Performance card: one chart, two modes ─────────────────────────────────
// 'cum'   cumulative TWR line + benchmark lines
// 'daily' per-day bars + S&P lollipops — what used to be the separate
//         "Recent Activity" card, which asked the same question on its own
//         unsynced period control.
// Daily windows are deliberately short: 900 daily bars is noise, not a chart.
const PERF_PERIODS = {
  cum:   [['6M', '6M'], ['YTD', 'YTD'], ['1Y', '1Y'], ['2Y', '2Y'], ['3Y', '3Y'], ['5Y', '5Y'], ['ALL', 'All time']],
  daily: [['1W', '1W'], ['1M', '1M'], ['6M', '6M'], ['YTD', 'YTD'], ['1Y', '1Y']],
};
const PERF_DEFAULT_PERIOD = { cum: 'ALL', daily: '1M' };
/** The window movers chips always use — they answer "what moved lately", not "over the chart window". */
const MOVERS_PERIOD = '1M';

function perfMode() { return globalData._perfMode === 'daily' ? 'daily' : 'cum'; }
function perfUnit() { return document.querySelector('#perfToggle .toggle-btn.active')?.dataset.mode || 'pct'; }
/** S&P is one setting now: the Overlays entry drives both the line and the lollipops. */
function spOverlayOn() { return (globalData.enabledBenchmarks || ['sp500']).includes('sp500'); }

document.addEventListener('DOMContentLoaded', async () => {
  await initTheme();
  document.getElementById('btnTheme').addEventListener('click', () => {
    const next = getTheme() === 'light' ? 'dark' : 'light';
    applyTheme(next);
    if (globalData.data) renderAll(globalData.data);
  });
  document.getElementById('btnRefresh').addEventListener('click', async () => {
    // Non-blocking sync: only block the UI with the loading screen when there
    // is nothing on screen yet (true first-run). Otherwise the current view
    // stays visible while the pill shows "Syncing…".
    const hasDataOnScreen = !!globalData.positions?.length;
    setStatus('loading');
    if (!hasDataOnScreen) {
      document.getElementById('loadingText').textContent = 'Refreshing...';
      showLoading();
    }
    // Reset lazy-load flags so tabs re-fetch fresh data
    const tabBar = document.querySelector('.tab-bar');
    if (tabBar) { delete tabBar.dataset.watchlistRendered; delete tabBar.dataset.insightsRendered; delete tabBar.dataset.taxRendered; delete tabBar.dataset.todayRendered; delete tabBar.dataset.dividendsRendered; }
    // Reset correlation matrix rendered flags so it re-fetches fresh data
    const corrCard = document.getElementById('correlationCard');
    if (corrCard) delete corrCard.dataset.wired;
    const corrHeatmap = document.getElementById('correlationHeatmap');
    if (corrHeatmap) delete corrHeatmap.dataset.rendered;
    const result = await chrome.runtime.sendMessage({ type: 'FETCH_ALL' });
    if (result?.error && hasDataOnScreen) {
      // Sync failed (e.g. no DEGIRO tab open) — keep the current view intact
      setStatus('idle');
      updateStalenessBanner();
      return;
    }
    const data = await chrome.runtime.sendMessage({ type: 'GET_STORED' });
    await renderAll(data);
    // If a gated tab is currently active, re-render it with fresh data
    const activeTab = document.querySelector('.tab-bar .tab-btn.active');
    const tabName = activeTab?.dataset.tab;
    if (tabName === 'watchlist') renderWatchlistTab();
    if (tabName === 'insights') renderInsightsTab();
    if (tabName === 'tax') renderTaxTab();
    if (tabName === 'today') renderTodayTab();
    if (tabName === 'dividends') renderDividendsTab();
    // Mark the tab we just re-rendered so the next click doesn't rebuild it
    if (tabBar && tabName && tabName !== 'portfolio') tabBar.dataset[tabName + 'Rendered'] = '1';
    setStatus('idle');
  });

  // Privacy toggle — hide/show all .sensitive elements
  const btnPrivacy = document.getElementById('btnPrivacy');
  btnPrivacy.addEventListener('click', () => {
    const isHidden = document.body.classList.toggle('privacy-mode');
    btnPrivacy.title = isHidden ? 'Show sensitive figures' : 'Hide sensitive figures';
    btnPrivacy.classList.toggle('active', isHidden);
  });



  // One period control for both chart modes
  document.getElementById('periodSelect').addEventListener('change', async () => {
    const sel = document.getElementById('periodSelect');
    if (sel.value !== 'CUSTOM') {
      document.getElementById('btnResetZoom').style.display = 'none';
      const customOpt = document.getElementById('optCustom');
      if (customOpt) { customOpt.disabled = true; customOpt.hidden = true; }
      dragZoomState.preDragPeriod = null;
    }
    if (globalData.positions) await refreshPerfChart();
  });

  // Chart mode: Cumulative | Daily
  document.getElementById('perfModeToggle').addEventListener('click', async e => {
    const btn = e.target.closest('.toggle-btn');
    if (!btn || btn.dataset.perfmode === perfMode()) return;
    await setPerfMode(btn.dataset.perfmode);
  });

  document.getElementById('btnResetZoom').addEventListener('click', () => {
    const periodSelect = document.getElementById('periodSelect');
    const customOpt = document.getElementById('optCustom');
    const restoreTo = dragZoomState.preDragPeriod || 'ALL';
    if (customOpt) { customOpt.disabled = true; customOpt.hidden = true; }
    periodSelect.value = restoreTo;
    dragZoomState.preDragPeriod = null;
    document.getElementById('btnResetZoom').style.display = 'none';
    periodSelect.dispatchEvent(new Event('change'));
  });

  await init();
});

// Listen for price fetch progress from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'FETCH_PROGRESS') {
    const pct = Math.round((msg.completed / msg.total) * 100);
    const bar = document.getElementById('progressBar');
    const label = document.getElementById('progressLabel');
    if (bar) bar.style.width = pct + '%';
    if (label) label.textContent = `Fetching price history... ${msg.completed}/${msg.total}`;
  }
});

async function init() {
  showLoading();
  let data = await new Promise(r => chrome.storage.local.get(null, r));
  let justFetched = false;
  if (!data.hasData) {
    document.getElementById('loadingText').textContent = 'First sync can take ~20-30s while we fetch your portfolio and price history...';
    // Try to trigger a fetch via background
    try {
      await chrome.runtime.sendMessage({ type: 'FETCH_ALL' });
      justFetched = true;
    } catch(e) {}
    data = await new Promise(r => chrome.storage.local.get(null, r));
  }
  await renderAll(data);

  // Auto-refresh in the background so figures are up to date. This runs after
  // the initial render, so the user sees cached data instantly while fresh data
  // is fetched and re-rendered silently. Skipped when the branch above already
  // fetched — a first-run user would otherwise hit DEGIRO twice back-to-back.
  if (!justFetched) {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'FETCH_ALL' });
      if (result?.ok) {
        const freshData = await new Promise(r => chrome.storage.local.get(null, r));
        await renderAll(freshData);
      }
    } catch(e) { console.warn('[Sharpe] Auto-refresh failed:', e); }
  }

  // If opened from popup via a clickable stat card, switch to the requested chart mode
  chrome.storage.local.get('popupOpenMode', ({ popupOpenMode }) => {
    if (!popupOpenMode) return;
    chrome.storage.local.remove('popupOpenMode');
    // 'proStatus' is the legacy alias for 'proModal' — both delegate to the
    // dashboard's own PRO button, which knows whether to show the license
    // modal (non-Pro) or the status modal (Pro).
    if (popupOpenMode === 'proModal' || popupOpenMode === 'proStatus') {
      document.getElementById('btnPro')?.click();
      return;
    }
    const toggleBtns = document.querySelectorAll('#perfToggle .toggle-btn');
    toggleBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === popupOpenMode));
    if (globalData.portfolioSeries) {
      drawPerformanceChart(globalData.portfolioSeries, popupOpenMode, globalData.eurSeries);
    }
  });
}

function showLoading() {
  document.getElementById('loadingScreen').style.display = 'flex';
  document.getElementById('mainContent').style.display = 'none';
}

// ── Tab bar switching ──────────────────────────────────────────────────────

function wireTabBar() {
  const bar = document.getElementById('tabBar');
  if (!bar || bar.dataset.wired) return;
  bar.dataset.wired = '1';

  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    const target = btn.dataset.tab;

    // Update active tab button
    bar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Show matching pane, hide others
    document.querySelectorAll('.tab-pane').forEach(pane => {
      pane.classList.toggle('active', pane.id === 'tab' + target.charAt(0).toUpperCase() + target.slice(1));
    });

    // Lazy-render Insights tab features on first visit
    if (target === 'insights' && !bar.dataset.insightsRendered) {
      bar.dataset.insightsRendered = '1';
      renderInsightsTab();
    }

    // Lazy-render Tax Reporting tab on first visit
    if (target === 'tax' && !bar.dataset.taxRendered) {
      bar.dataset.taxRendered = '1';
      renderTaxTab();
    }

    // Lazy-render Watchlist tab on first visit
    if (target === 'watchlist' && !bar.dataset.watchlistRendered) {
      bar.dataset.watchlistRendered = '1';
      renderWatchlistTab();
    }

    // Lazy-render Today tab on first visit
    if (target === 'today' && !bar.dataset.todayRendered) {
      bar.dataset.todayRendered = '1';
      renderTodayTab();
    }

    // Lazy-render Dividends tab on first visit
    if (target === 'dividends' && !bar.dataset.dividendsRendered) {
      bar.dataset.dividendsRendered = '1';
      renderDividendsTab();
    }
  });
}

// ── Today tab ─────────────────────────────────────────────────────────────

function getLocalTodayStr() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function fmtTodayPickerDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return new Date(y, m - 1, d).toLocaleDateString('default', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
}

function getTodayAvailableDates() {
  const fullDates = (globalData.fullWithTwr || []).map(p => p.date).filter(Boolean);
  const dates = (fullDates.length ? fullDates : (globalData.recentPerfDates || [])).slice().sort();
  return [...new Set(dates)];
}

function buildTodayReplayForDate(selectedDate, previousDate) {
  const positions = globalData.positions || [];
  const holdings = holdingsAsOf(buildHoldingSnapshots(globalData.transactions), previousDate);

  // Fallback when transaction history is sparse
  if (!Object.keys(holdings).length) {
    positions.forEach(p => {
      if (p.size > 0) holdings[String(p.id)] = p.size;
    });
  }

  const fxRates = {};
  positions.forEach(p => {
    if (p.price > 0 && p.size !== 0) fxRates[String(p.id)] = p.value / (p.price * p.size);
  });

  const histMap = globalData.priceHistories5Y || {};
  const positionById = Object.fromEntries((positions || []).map(p => [String(p.id), p]));
  const items = [];
  let totalPortValue = 0;
  let totalDayEur = 0;

  const findPriceAtOrBefore = (series, date) => {
    if (!series?.length) return null;
    let lo = 0, hi = series.length - 1, res = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (series[mid].date <= date) { res = series[mid].price; lo = mid + 1; }
      else hi = mid - 1;
    }
    return res;
  };

  Object.entries(holdings).forEach(([id, shares]) => {
    if (shares <= 0) return;
    const h = histMap[id];
    const priceToday = findPriceAtOrBefore(h, selectedDate);
    const pricePrev = findPriceAtOrBefore(h, previousDate);
    if (priceToday == null || pricePrev == null || pricePrev <= 0) return;

    const fx = fxRates[id] || 1;
    const dayEur = (priceToday - pricePrev) * shares * fx;
    const value = priceToday * shares * fx;
    const dayPct = ((priceToday - pricePrev) / pricePrev) * 100;
    const pos = positionById[id];
    totalPortValue += value;
    totalDayEur += dayEur;

    items.push({
      id,
      name: pos?.name || globalData.names?.[id] || globalData.meta?.[id]?.name || ('ID ' + id),
      currency: pos?.currency || globalData.meta?.[id]?.currency || 'EUR',
      price: priceToday,
      dayPct,
      dayEur,
      weight: 0, // assigned after total known
      contrib: 0, // assigned after total known
      totalPl: pos?.plBase ?? null,
      totalPlPct: pos?.plPct ?? null,
      value,
      size: shares,
    });
  });

  items.forEach(item => {
    item.weight = totalPortValue > 0 ? (item.value / totalPortValue) * 100 : 0;
    item.contrib = totalPortValue > 0 ? (item.dayEur / totalPortValue) * 100 : null;
  });

  return { items, totalPortValue, totalDayEur };
}

function padTodayCalPart(n) {
  return String(n).padStart(2, '0');
}

function todayCalToYmd(y, month0, d) {
  return `${y}-${padTodayCalPart(month0 + 1)}-${padTodayCalPart(d)}`;
}

function closeTodayDatePopover() {
  const pop = document.getElementById('todayDatePopover');
  const btn = document.getElementById('todayDateBtn');
  if (pop) pop.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function syncTodayCalYearSelect() {
  const sel = document.getElementById('todayCalYearSelect');
  if (!sel) return;
  const opts = globalData._todayDateOptions || [];
  let minY = Infinity;
  let maxY = -Infinity;
  opts.forEach(ds => {
    const y = parseInt(ds.slice(0, 4), 10);
    if (Number.isFinite(y)) {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  });
  const nowY = new Date().getFullYear();
  if (!Number.isFinite(minY)) {
    minY = maxY = nowY;
  }
  minY = Math.min(minY, nowY);
  maxY = Math.max(maxY, nowY);
  const vy = globalData._todayCalViewYear;
  if (Number.isFinite(vy)) {
    minY = Math.min(minY, vy);
    maxY = Math.max(maxY, vy);
  }
  const parts = [];
  for (let y = maxY; y >= minY; y--) parts.push(`<option value="${y}">${y}</option>`);
  sel.innerHTML = parts.join('');
  sel.value = String(vy);
}

function renderTodayCalendarInner() {
  const grid = document.getElementById('todayCalGrid');
  const label = document.getElementById('todayCalMonthLabel');
  if (!grid || !label) return;
  const vy = globalData._todayCalViewYear;
  const vm = globalData._todayCalViewMonth;
  if (!Number.isFinite(vy) || !Number.isFinite(vm)) return;
  const first = new Date(vy, vm, 1);
  label.textContent = first.toLocaleDateString('default', { month: 'long' });
  syncTodayCalYearSelect();
  const lastDay = new Date(vy, vm + 1, 0).getDate();
  const startWeekday = first.getDay();
  const allowed = new Set(globalData._todayDateOptions || []);
  const selected = globalData.todaySelectedDate;
  let html = '';
  for (let i = 0; i < startWeekday; i++) {
    html += '<span class="today-cal-cell--pad" aria-hidden="true"></span>';
  }
  for (let d = 1; d <= lastDay; d++) {
    const ds = todayCalToYmd(vy, vm, d);
    const ok = allowed.has(ds);
    const sel = ds === selected;
    const cls = 'today-cal-day' + (sel && ok ? ' is-selected' : '');
    html += `<button type="button" class="${cls}" data-date="${ds}"${ok ? '' : ' disabled'}>${d}</button>`;
  }
  const used = startWeekday + lastDay;
  const tail = (7 - (used % 7)) % 7;
  for (let i = 0; i < tail; i++) {
    html += '<span class="today-cal-cell--pad" aria-hidden="true"></span>';
  }
  grid.innerHTML = html;
}

function ensureTodayDateSelector(availableDates) {
  const btn = document.getElementById('todayDateBtn');
  const pop = document.getElementById('todayDatePopover');
  const nowBtn = document.getElementById('todayJumpNow');
  if (!btn) return;

  const localToday = getLocalTodayStr();
  const descDates = [...availableDates].sort((a, b) => b.localeCompare(a));
  let optionsWithToday;
  if (!descDates.length) {
    optionsWithToday = [localToday];
    btn.disabled = true;
    globalData.todaySelectedDate = localToday;
  } else {
    btn.disabled = false;
    optionsWithToday = descDates.includes(localToday) ? descDates : [localToday, ...descDates];
    const selected = globalData.todaySelectedDate;
    if (!selected || !optionsWithToday.includes(selected)) {
      globalData.todaySelectedDate = optionsWithToday[0];
    }
  }

  globalData._todayDateOptions = optionsWithToday;
  btn.textContent = fmtTodayPickerDate(globalData.todaySelectedDate);

  const syncCalendarIfOpen = () => {
    if (pop && !pop.hidden) renderTodayCalendarInner();
  };

  if (!btn.dataset.wired) {
    btn.dataset.wired = '1';
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (btn.disabled) return;
      if (pop.hidden) {
        const raw = globalData.todaySelectedDate || localToday;
        const parts = raw.split('-').map(Number);
        const y = parts[0];
        const m0 = parts[1] - 1;
        if (Number.isFinite(y) && Number.isFinite(m0) && m0 >= 0 && m0 <= 11) {
          globalData._todayCalViewYear = y;
          globalData._todayCalViewMonth = m0;
        } else {
          const t = new Date();
          globalData._todayCalViewYear = t.getFullYear();
          globalData._todayCalViewMonth = t.getMonth();
        }
        renderTodayCalendarInner();
        pop.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
      } else {
        closeTodayDatePopover();
      }
    });

    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      const p = document.getElementById('todayDatePopover');
      if (p && !p.hidden) closeTodayDatePopover();
    });
    document.addEventListener('mousedown', e => {
      const p = document.getElementById('todayDatePopover');
      if (!p || p.hidden) return;
      if (e.target.closest('.today-date-picker-wrap')) return;
      closeTodayDatePopover();
    });

    const prev = document.getElementById('todayCalPrev');
    const next = document.getElementById('todayCalNext');
    const grid = document.getElementById('todayCalGrid');
    if (prev) {
      prev.addEventListener('click', e => {
        e.stopPropagation();
        let y = globalData._todayCalViewYear;
        let m = globalData._todayCalViewMonth;
        m -= 1;
        if (m < 0) { m = 11; y -= 1; }
        globalData._todayCalViewYear = y;
        globalData._todayCalViewMonth = m;
        renderTodayCalendarInner();
      });
    }
    if (next) {
      next.addEventListener('click', e => {
        e.stopPropagation();
        let y = globalData._todayCalViewYear;
        let m = globalData._todayCalViewMonth;
        m += 1;
        if (m > 11) { m = 0; y += 1; }
        globalData._todayCalViewYear = y;
        globalData._todayCalViewMonth = m;
        renderTodayCalendarInner();
      });
    }
    if (grid) {
      grid.addEventListener('click', e => {
        const cell = e.target.closest('button[data-date]');
        if (!cell || cell.disabled) return;
        globalData.todaySelectedDate = cell.dataset.date;
        btn.textContent = fmtTodayPickerDate(globalData.todaySelectedDate);
        closeTodayDatePopover();
        renderTodayTab();
      });
    }
    const yearSel = document.getElementById('todayCalYearSelect');
    if (yearSel && !yearSel.dataset.wired) {
      yearSel.dataset.wired = '1';
      yearSel.addEventListener('change', () => {
        const y = parseInt(yearSel.value, 10);
        if (!Number.isFinite(y)) return;
        globalData._todayCalViewYear = y;
        renderTodayCalendarInner();
      });
    }
  }

  if (nowBtn && !nowBtn.dataset.wired) {
    nowBtn.dataset.wired = '1';
    nowBtn.addEventListener('click', () => {
      const today = getLocalTodayStr();
      globalData.todaySelectedDate = today;
      closeTodayDatePopover();
      renderTodayTab();
    });
  }

  syncCalendarIfOpen();
}

async function renderTodayTab() {
  const positions = globalData.positions || [];
  const tableEl = document.getElementById('todayTable');
  const tbody = document.getElementById('todayBody');
  const moversCard = document.getElementById('todayMoversCard');
  const statsCard = document.getElementById('todayStatsCard');
  const statsContent = document.getElementById('todayStatsContent');
  // Reset thead wired flag so sort re-wires on refresh
  const thead = tableEl?.querySelector('thead');
  if (thead) delete thead.dataset.wired;

  // ── Build date selection + compute items for selected day ─────────────
  const availableDates = getTodayAvailableDates();
  ensureTodayDateSelector(availableDates);
  const selectedDate = globalData.todaySelectedDate || availableDates[availableDates.length - 1] || getLocalTodayStr();
  globalData.todaySelectedDate = selectedDate;

  const isLiveDate = selectedDate === getLocalTodayStr();
  globalData.todayIsLiveDate = isLiveDate;

  let items = [];
  if (isLiveDate) {
    const perPosPL = globalData._todayPLPerPosition || {};
    const perPosTotalPL = globalData._scrapedTotalPnLPerPosition || {};
    const totalPortValue = globalData._scrapedPortfolioValue
      ?? positions.reduce((s, p) => s + p.value, 0);
    items = positions.length ? positions.map(p => {
      const dayEur = perPosPL[p.id] ?? null;
      const dayPct = (dayEur != null && p.value > 0)
        ? (dayEur / (p.value - dayEur)) * 100
        : null;
      const weight = totalPortValue > 0 ? (p.value / totalPortValue) * 100 : 0;
      const contrib = (dayEur != null && totalPortValue > 0) ? (dayEur / totalPortValue) * 100 : null;
      const scrapedTotal = perPosTotalPL[p.id] ?? null;
      const effectiveTotalPl = scrapedTotal ?? p.plBase;
      // When using scraped value, derive cost basis from it so the %
      // matches DEGIRO's own display: costBasis = currentValue − unrealizedPL
      const costBasis = p.value - (scrapedTotal ?? (p.plUnrealized ?? p.plBase));
      const effectiveTotalPlPct = costBasis > 0
        ? (effectiveTotalPl / costBasis) * 100
        : p.plPct;
      return {
        id: p.id, name: p.name || 'ID ' + p.id, currency: p.currency || 'EUR',
        price: p.price, dayPct, dayEur, weight, contrib,
        totalPl: effectiveTotalPl, totalPlPct: effectiveTotalPlPct, value: p.value, size: p.size,
      };
    }) : [];
  } else if (availableDates.length) {
    globalData.todayReplayByDate = globalData.todayReplayByDate || {};
    if (!globalData.todayReplayByDate[selectedDate]) {
      const idx = availableDates.indexOf(selectedDate);
      const prevDate = idx > 0 ? availableDates[idx - 1] : null;
      if (prevDate) globalData.todayReplayByDate[selectedDate] = buildTodayReplayForDate(selectedDate, prevDate);
      else globalData.todayReplayByDate[selectedDate] = { items: [], totalPortValue: 0, totalDayEur: 0 };
    }
    items = globalData.todayReplayByDate[selectedDate]?.items || [];
  }

  globalData._todayItems = items;

  // ── Daily Stats + Status — always visible (not pro-gated) ──────────
  renderTodayStatus(selectedDate);
  if (statsContent) renderTodayStats(statsContent, selectedDate);

  // Pro gate — stats stay visible; everything else is paywalled
  const tabPane = document.getElementById('tabToday');
  const viewToggle = document.getElementById('todayViewToggle');
  // The day total sits in the movers-card header, which the Pro overlay covers.
  // Never park a real figure behind the paywall — free users already have it in
  // the header's "Today's P&L" stat.
  if (proUnlocked) renderTodayTotal(items, selectedDate, isLiveDate);
  else document.getElementById('todayTotal').textContent = '';
  if (!proUnlocked) {
    // Remove any stale full-tab overlay from previous renders
    removeProOverlay(tabPane);

    if (moversCard) {
      moversCard.style.display = '';
      tableEl.style.display = '';
      if (viewToggle) viewToggle.style.display = 'none';
      const gb = document.getElementById('heatmapGroupBy');
      if (gb) gb.style.display = 'none';
      setTodayView('table', { render: false });
      document.getElementById('todayBody').innerHTML = [
        ['iShares Core S&P 500 ETF', '485.20', '+0.74%', '+18.50 €', '32.1%', '+0.24%'],
        ['ASML Holding', '684.20', '-1.12%', '-12.30 €', '15.4%', '-0.07%'],
        ['Schneider Electric', '229.10', '+0.53%', '+6.80 €', '11.2%', '+0.04%'],
      ].map(([n, p, dp, de, w, c]) => `<tr><td>${n}</td><td class="num">${p}</td><td class="num"><span class="${dp.startsWith('+') ? 'positive' : 'negative'}">${dp}</span></td><td class="num"><span class="${de.startsWith('+') ? 'positive' : 'negative'}">${de}</span></td><td class="num">${w}</td><td class="num"><span class="${c.startsWith('+') ? 'positive' : 'negative'}">${c}</span></td><td class="num">—</td><td class="num">—</td></tr>`).join('');
      const tableContent = document.getElementById('todayTableContent');
      if (tableContent) tableContent.classList.add('tax-blur-wrap');
    }
    const sparkCard = document.getElementById('todaySparklineCard');
    if (sparkCard) sparkCard.style.display = 'none';
    // Overlay only the movers card (below stats), not the entire tab pane
    showProOverlay(moversCard, 'Today\'s Movers');
    return;
  }

  // Remove Pro overlay and blur if previously gated
  removeProOverlay(tabPane);
  removeProOverlay(moversCard);
  {
    const tc = document.getElementById('todayTableContent');
    if (tc) tc.classList.remove('tax-blur-wrap');
  }
  if (viewToggle) viewToggle.style.display = '';

  if (!positions.length) {
    if (tableEl) tableEl.style.display = 'none';
    if (moversCard) moversCard.style.display = 'none';
    return;
  }
  if (moversCard) moversCard.style.display = '';

  // ── Intraday P&L sparkline (above table) ───────────────────────────
  renderTodaySparkline(selectedDate);

  // ── One dataset, three views — draw whichever is selected ───────────
  wireTodayViewToggle();
  setTodayView(globalData._todayView || 'table');
}

/**
 * Day total for the selected day, promoted into the card header.
 * The number was computed already (live: the scraped daily P&L that the
 * header stat uses; replay: buildTodayReplayForDate) but never displayed.
 */
function renderTodayTotal(items, selectedDate, isLiveDate) {
  const el = document.getElementById('todayTotal');
  if (!el) return;
  el.textContent = '';

  let totalEur = null, baseValue = null;
  if (isLiveDate) {
    totalEur = globalData._todayPL ?? null;
    if (totalEur == null && items.some(i => i.dayEur != null)) {
      totalEur = items.reduce((s, i) => s + (i.dayEur || 0), 0);
    }
    baseValue = globalData._scrapedPortfolioValue
      ?? (globalData.positions || []).reduce((s, p) => s + p.value, 0);
  } else {
    const replay = globalData.todayReplayByDate?.[selectedDate];
    if (replay) { totalEur = replay.totalDayEur; baseValue = replay.totalPortValue; }
  }

  if (totalEur == null || !isFinite(totalEur)) return;

  const prevValue = baseValue != null ? baseValue - totalEur : null;
  const pct = prevValue > 0 ? (totalEur / prevValue) * 100 : null;
  const cls = totalEur >= 0 ? 'positive' : 'negative';
  const sign = totalEur >= 0 ? '+' : '';

  const label = document.createElement('span');
  label.className = 'today-total-label';
  label.textContent = 'Day total';
  const value = document.createElement('span');
  value.className = 'today-total-value sensitive ' + cls;
  value.textContent = sign + fmtEur(totalEur);
  el.append(label, value);
  if (pct != null && isFinite(pct)) {
    const pctEl = document.createElement('span');
    pctEl.className = 'today-total-pct ' + cls;
    pctEl.textContent = '· ' + sign + pct.toFixed(2) + '%';
    el.appendChild(pctEl);
  }
}

/** Table / Waterfall / Heatmap are views of one array — wire the switch once. */
function wireTodayViewToggle() {
  const toggle = document.getElementById('todayViewToggle');
  if (!toggle || toggle.dataset.wired) return;
  toggle.dataset.wired = '1';
  toggle.addEventListener('click', e => {
    const btn = e.target.closest('.seg-btn');
    if (!btn || btn.disabled) return;
    setTodayView(btn.dataset.view);
  });
}

function setTodayView(view, { render = true } = {}) {
  const items = globalData._todayItems || [];
  const hasContrib = items.some(i => i.contrib != null && i.contrib !== 0);
  if (view === 'waterfall' && !hasContrib) view = 'table';
  globalData._todayView = view;

  document.querySelectorAll('#todayViewToggle .seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view);
    if (b.dataset.view === 'waterfall') {
      b.disabled = !hasContrib;
      b.title = hasContrib ? '' : 'No per-position contributions for this day';
    }
  });
  document.querySelectorAll('#todayViewBody .today-view').forEach(v => {
    v.style.display = v.dataset.view === view ? '' : 'none';
  });
  // The group-by control belongs to the heatmap only
  const groupBy = document.getElementById('heatmapGroupBy');
  if (groupBy) groupBy.style.display = view === 'heatmap' ? '' : 'none';

  if (!render) return;
  if (view === 'table') {
    const tableEl = document.getElementById('todayTable');
    if (tableEl) tableEl.style.display = '';
    renderTodayTable(items);
  } else if (view === 'waterfall') {
    drawTodayWaterfall(items.filter(i => i.contrib != null && i.contrib !== 0));
  } else {
    renderSectorHeatmap(items);
  }
}

async function renderTodaySparkline(selectedDate) {
  const card = document.getElementById('todaySparklineCard');
  if (!card) return;
  const wrap = card.querySelector('.chart-wrap');
  if (!wrap) return;
  const ensureCanvas = () => {
    let canvas = document.getElementById('todaySparklineChart');
    if (!canvas) {
      wrap.innerHTML = '<canvas id="todaySparklineChart"></canvas>';
      canvas = document.getElementById('todaySparklineChart');
    }
    return canvas;
  };
  const showEmpty = (msg) => {
    if (charts.todaySparkline) { charts.todaySparkline.destroy(); charts.todaySparkline = null; }
    wrap.innerHTML = `<div style="height:120px;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:11px">${sanitize(msg)}</div>`;
    card.style.display = '';
  };
  const localToday = getLocalTodayStr();
  if (!globalData.todayIsLiveDate || selectedDate !== localToday) {
    showEmpty('Intraday timeline is available for the live trading day only.');
    return;
  }

  let snapshots = globalData._todayPLSnapshots;
  if (!snapshots) {
    const stored = await new Promise(r => chrome.storage.local.get(['todayPLSnapshots', 'todayPLSnapshotsDate'], r));
    const todayStr = localToday;
    snapshots = (stored.todayPLSnapshotsDate === todayStr) ? (stored.todayPLSnapshots || []) : [];
  }

  if (snapshots.length < 2) { showEmpty('Collecting intraday snapshots. Refresh again later today.'); return; }
  card.style.display = '';

  const labels = snapshots.map(s => new Date(s.ts).toLocaleTimeString('default', { hour: '2-digit', minute: '2-digit' }));
  const data = snapshots.map(s => s.pl);
  const plGreen = THEME_COLORS.plGreen;
  const plRed = THEME_COLORS.plRed;
  const minV = Math.min(...data);
  const maxV = Math.max(...data);
  const span = Math.max(maxV - minV, 1e-6);
  const pad = Math.max(span * 0.08, 0.5);
  let yMin;
  let yMax;
  if (minV >= 0) {
    yMin = 0;
    yMax = maxV + pad;
  } else if (maxV <= 0) {
    yMin = minV - pad;
    yMax = 0;
  } else {
    yMin = minV - pad;
    yMax = maxV + pad;
  }

  if (charts.todaySparkline) { charts.todaySparkline.destroy(); charts.todaySparkline = null; }
  const canvas = ensureCanvas();
  if (!canvas) return;

  const segmentLineColor = (ctx) => {
    const y0 = ctx.p0.parsed.y;
    const y1 = ctx.p1.parsed.y;
    if (y0 >= 0 && y1 >= 0) return plGreen;
    if (y0 < 0 && y1 < 0) return plRed;
    return (y0 + y1) / 2 >= 0 ? plGreen : plRed;
  };

  charts.todaySparkline = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        borderColor: plGreen,
        borderWidth: 2,
        pointRadius: 3,
        pointBackgroundColor: (c) => (c.parsed.y >= 0 ? plGreen : plRed),
        pointBorderColor: (c) => (c.parsed.y >= 0 ? plGreen : plRed),
        pointHoverRadius: 5,
        fill: false,
        tension: 0.3,
        segment: { borderColor: segmentLineColor },
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...THEME_COLORS.themeTooltip(),
          callbacks: {
            label: ctx => ' ' + (ctx.parsed.y >= 0 ? '+' : '') + fmtEur(ctx.parsed.y)
          }
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: THEME_COLORS.tickColor, font: { size: 9 }, maxTicksLimit: 8 } },
        y: {
          display: true,
          min: yMin,
          max: yMax,
          border: { display: false },
          ticks: {
            color: THEME_COLORS.tickColor,
            font: { size: 9 },
            maxTicksLimit: 5,
            callback: (v) => fmtEur(v),
          },
          grid: {
            color: THEME_COLORS.gridColor,
            lineWidth: 1,
          },
        },
      },
    },
    plugins: [{
      id: 'todaySparklineZeroLine',
      afterDraw: (chart) => {
        const yS = chart.scales.y;
        if (!yS) return;
        if (0 < yS.min || 0 > yS.max) return;
        const yPx = yS.getPixelForValue(0);
        const { left, right } = chart.chartArea;
        const c = chart.ctx;
        c.save();
        c.strokeStyle = THEME_COLORS.zeroLineColor;
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(left, yPx);
        c.lineTo(right, yPx);
        c.stroke();
        c.restore();
      },
    }],
  });
}

function renderSectorHeatmap(items, groupBy) {
  const content = document.getElementById('sectorHeatmapContent');
  if (!content) return;

  if (!items?.length) { content.textContent = ''; return; }

  groupBy = groupBy || globalData._heatmapGroupBy || 'none';
  globalData._heatmapGroupBy = groupBy;

  // Sync dropdown
  const sel = document.getElementById('heatmapGroupBy');
  if (sel && sel.value !== groupBy) sel.value = groupBy;

  // Wire dropdown (once)
  if (sel && !sel.dataset.wired) {
    sel.dataset.wired = '1';
    sel.addEventListener('change', () => {
      renderSectorHeatmap(globalData._todayItems, sel.value);
    });
  }

  const positions = globalData.positions || [];

  // Color: green-to-red gradient based on dayPct, clamped to ±3%
  function heatColor(pct) {
    const clamped = Math.max(-3, Math.min(3, pct || 0));
    const t = (clamped + 3) / 6;
    if (t >= 0.5) {
      const g = (t - 0.5) * 2;
      return `rgba(42, 202, 105, ${(0.15 + g * 0.55).toFixed(2)})`;
    } else {
      const r = (0.5 - t) * 2;
      return `rgba(255, 71, 87, ${(0.15 + r * 0.55).toFixed(2)})`;
    }
  }

  // ── Squarify helpers ────────────────────────────────────────────────
  function layoutRow(row, x, y, w, h, horizontal) {
    const rowArea = row.reduce((s, r) => s + r.area, 0);
    if (horizontal) {
      const rowH = rowArea / w;
      let cx = x;
      for (const r of row) { r.x = cx; r.y = y; r.h = rowH; r.w = r.area / rowH; cx += r.w; }
    } else {
      const rowW = rowArea / h;
      let cy = y;
      for (const r of row) { r.x = x; r.y = cy; r.w = rowW; r.h = r.area / rowW; cy += r.h; }
    }
  }

  function worstRatio(row, side) {
    const rowArea = row.reduce((s, r) => s + r.area, 0);
    const thickness = rowArea / side;
    let worst = 0;
    for (const r of row) {
      const len = r.area / thickness;
      const ratio = Math.max(len / thickness, thickness / len);
      if (ratio > worst) worst = ratio;
    }
    return worst;
  }

  function squarify(rects, x, y, w, h) {
    if (rects.length === 0) return;
    if (rects.length === 1) { rects[0].x = x; rects[0].y = y; rects[0].w = w; rects[0].h = h; return; }
    const horizontal = w >= h;
    const side = horizontal ? w : h;
    let row = [rects[0]];
    let best = worstRatio(row, side);
    let i = 1;
    while (i < rects.length) {
      const candidate = [...row, rects[i]];
      const next = worstRatio(candidate, side);
      if (next <= best) { row = candidate; best = next; i++; } else break;
    }
    layoutRow(row, x, y, w, h, horizontal);
    const rowArea = row.reduce((s, r) => s + r.area, 0);
    const remaining = rects.slice(i);
    if (remaining.length) {
      if (horizontal) { const usedH = rowArea / w; squarify(remaining, x, y + usedH, w, h - usedH); }
      else { const usedW = rowArea / h; squarify(remaining, x + usedW, y, w - usedW, h); }
    }
  }

  // ── Build groups ────────────────────────────────────────────────────
  const containerW = 800, containerH = 380;
  let groups; // array of { label, items }

  if (groupBy === 'none') {
    groups = [{ label: null, items: [...items].sort((a, b) => b.weight - a.weight) }];
  } else {
    const map = {};
    items.forEach(item => {
      const pos = positions.find(p => String(p.id) === String(item.id));
      let key;
      if (groupBy === 'assetclass') key = pos ? inferAssetClass(pos) : 'Other';
      else key = pos ? inferGeo(pos) : 'Other';
      if (!map[key]) map[key] = [];
      map[key].push(item);
    });
    groups = Object.entries(map)
      .map(([label, gItems]) => ({ label, items: gItems.sort((a, b) => b.weight - a.weight), totalWeight: gItems.reduce((s, i) => s + i.weight, 0) }))
      .sort((a, b) => b.totalWeight - a.totalWeight);
  }

  // ── Two-level squarified layout ─────────────────────────────────────
  // Level 1: squarify groups into the full rectangle (like finviz sectors)
  // Level 2: squarify individual items within each group's allocated region
  const totalWeight = items.reduce((s, i) => s + Math.max(i.weight, 0.5), 0);
  const totalArea = containerW * containerH;
  const allRects = []; // { item, x, y, w, h }
  const groupRegions = []; // { label, x, y, w, h }

  if (groups.length === 1 && !groups[0].label) {
    // Flat treemap — single level, no group labels
    const rects = groups[0].items.map(item => ({ item, area: (Math.max(item.weight, 0.5) / totalWeight) * totalArea, x: 0, y: 0, w: 0, h: 0 }));
    squarify(rects, 0, 0, containerW, containerH);
    allRects.push(...rects);
  } else {
    // Level 1: squarify groups as blocks
    const groupRects = groups.map(g => {
      const gw = g.items.reduce((s, i) => s + Math.max(i.weight, 0.5), 0);
      return { group: g, area: (gw / totalWeight) * totalArea, x: 0, y: 0, w: 0, h: 0 };
    });
    squarify(groupRects, 0, 0, containerW, containerH);

    // Level 2: squarify items within each group's full region (label overlays on top)
    for (const gr of groupRects) {
      groupRegions.push({ label: gr.group.label, x: gr.x, y: gr.y, w: gr.w, h: gr.h });

      const bodyArea = gr.w * gr.h;
      const gTotalW = gr.group.items.reduce((s, i) => s + Math.max(i.weight, 0.5), 0);
      const itemRects = gr.group.items.map(item => ({
        item,
        area: (Math.max(item.weight, 0.5) / gTotalW) * bodyArea,
        x: 0, y: 0, w: 0, h: 0,
      }));
      squarify(itemRects, gr.x, gr.y, gr.w, gr.h);
      allRects.push(...itemRects);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────
  let html = `<div class="shm-container" style="width:100%;padding-bottom:${(containerH / containerW * 100).toFixed(1)}%;position:relative;">`;

  // Group region labels (positioned inside top-left of each group's region)
  for (const gr of groupRegions) {
    const left = (gr.x / containerW * 100).toFixed(2);
    const top = (gr.y / containerH * 100).toFixed(2);
    const width = (gr.w / containerW * 100).toFixed(2);
    html += `<div class="shm-group-label" style="left:${left}%;top:${top}%;width:${width}%">${sanitize(gr.label)}</div>`;
  }

  // Group region outlines (subtle border around each group)
  for (const gr of groupRegions) {
    const left = (gr.x / containerW * 100).toFixed(2);
    const top = (gr.y / containerH * 100).toFixed(2);
    const width = (gr.w / containerW * 100).toFixed(2);
    const height = (gr.h / containerH * 100).toFixed(2);
    html += `<div class="shm-group-border" style="left:${left}%;top:${top}%;width:${width}%;height:${height}%"></div>`;
  }

  // Blocks
  for (const r of allRects) {
    const sign = (r.item.dayPct ?? 0) >= 0 ? '+' : '';
    const pctText = `${sign}${(r.item.dayPct ?? 0).toFixed(1)}%`;
    const left = (r.x / containerW * 100).toFixed(2);
    const top = (r.y / containerH * 100).toFixed(2);
    const width = (r.w / containerW * 100).toFixed(2);
    const height = (r.h / containerH * 100).toFixed(2);
    const showName = r.w > 55 && r.h > 35;
    const eurVal = r.item.dayEur;
    const eurStr = eurVal != null ? `${eurVal >= 0 ? '+' : ''}${eurVal.toFixed(2)} EUR` : '';
    html += `<div class="shm-block" data-tip-name="${sanitize(r.item.name)}" data-tip-pct="${sign}${(r.item.dayPct ?? 0).toFixed(2)}%" data-tip-eur="${eurStr}" style="left:${left}%;top:${top}%;width:${width}%;height:${height}%;background:${heatColor(r.item.dayPct)}">
      ${showName ? `<span class="shb-name">${sanitize(r.item.name)}</span>` : ''}
      <span class="shb-pct">${pctText}</span>
    </div>`;
  }
  html += '</div>';
  content.innerHTML = html;

  // Custom tooltip for heatmap blocks
  let tip = document.getElementById('shmTooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'shmTooltip';
    tip.className = 'shm-tooltip';
    document.body.appendChild(tip);
  }
  // Remove old listeners by replacing the content wrapper's event target
  const container = content.querySelector('.shm-container');
  if (container) {
    container.addEventListener('mouseover', e => {
      const block = e.target.closest('.shm-block');
      if (!block) { tip.style.display = 'none'; return; }
      const name = block.dataset.tipName || '';
      const pct = block.dataset.tipPct || '';
      const eur = block.dataset.tipEur || '';
      tip.innerHTML = `<strong>${name}</strong><br>${pct}${eur ? '<br>' + eur : ''}`;
      tip.style.display = 'block';
    });
    container.addEventListener('mousemove', e => {
      if (tip.style.display === 'none') return;
      tip.style.left = (e.pageX + 12) + 'px';
      tip.style.top = (e.pageY - 10) + 'px';
    });
    container.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  }
}

function renderTodayStatus(selectedDate) {
  const el = document.getElementById('todayStatusInline');
  if (!el) return;

  // Market status: Mon-Fri 09:00-17:30 CET
  const now = new Date();
  const cet = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
  const day = cet.getDay();
  const hhmm = cet.getHours() * 100 + cet.getMinutes();
  const isOpen = day >= 1 && day <= 5 && hhmm >= 900 && hhmm <= 1730;

  // Last refreshed
  const lastFetch = globalData.data?.lastFetch;
  const refreshedText = lastFetch ? fmtAgo(lastFetch) : '—';

  el.innerHTML = `
    <span><span class="today-market-dot ${isOpen ? 'open' : 'closed'}"></span>${isOpen ? 'Open' : 'Closed'}</span>
    <span class="today-sep">·</span>
    <span>Data: ${refreshedText}</span>
  `;
}

function renderTodayTable(items, sortCol, sortDir) {
  const tbody = document.getElementById('todayBody');
  if (!tbody) return;

  sortCol = sortCol || globalData._todaySort?.col || 'dayEur';
  sortDir = sortDir || globalData._todaySort?.dir || 'desc';
  globalData._todaySort = { col: sortCol, dir: sortDir };

  const fmtChg = (v, isCurrency) => {
    if (v == null || !isFinite(v)) return '<span style="color:var(--muted)">—</span>';
    const sign = v >= 0 ? '+' : '';
    const cls = v >= 0 ? 'positive' : 'negative';
    if (isCurrency) return `<span class="${cls} sensitive">${sign}${fmtEur(v)}</span>`;
    return `<span class="${cls}">${sign}${v.toFixed(2)}%</span>`;
  };

  // Sort
  const sorted = [...items];
  sorted.sort((a, b) => {
    let va = a[sortCol], vb = b[sortCol];
    if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    va = va ?? -Infinity; vb = vb ?? -Infinity;
    return sortDir === 'asc' ? va - vb : vb - va;
  });

  // Update header arrows
  document.querySelectorAll('#todayTable thead th').forEach(th => {
    const col = th.dataset.col;
    th.classList.toggle('sort-active', col === sortCol);
    th.textContent = th.textContent.replace(/ [▲▼]$/, '');
    if (col === sortCol) th.textContent += sortDir === 'asc' ? ' ▲' : ' ▼';
  });

  tbody.innerHTML = sorted.map(item => `
    <tr data-position-id="${item.id}" style="cursor:pointer">
      <td>${sanitize(item.name)}</td>
      <td class="num">${item.price > 0 ? fmtPrice(item.price) : '—'}</td>
      <td class="num">${fmtChg(item.dayPct, false)}</td>
      <td class="num">${fmtChg(item.dayEur, true)}</td>
      <td class="num">${item.weight.toFixed(1)}%</td>
      <td class="num">${fmtChg(item.contrib, false)}</td>
      <td class="num sensitive">${fmtChg(item.totalPl, true)}</td>
      <td class="num">${fmtChg(item.totalPlPct, false)}</td>
    </tr>
  `).join('');

  // Click row → jump to Portfolio tab and expand the position's detail row
  tbody.querySelectorAll('tr[data-position-id]').forEach(tr => {
    tr.addEventListener('click', () => {
      const id = tr.dataset.positionId;
      document.querySelector('.tab-bar .tab-btn[data-tab="portfolio"]')?.click();
      expandPositionRow(id, false);
    });
  });

  // Wire sortable headers (once)
  const thead = document.getElementById('todayTable').querySelector('thead');
  if (thead && !thead.dataset.wired) {
    thead.dataset.wired = '1';
    thead.style.cursor = 'pointer';
    thead.addEventListener('click', e => {
      const th = e.target.closest('th');
      if (!th || !th.dataset.col) return;
      const col = th.dataset.col;
      const prev = globalData._todaySort || {};
      let dir;
      if (prev.col === col) {
        dir = prev.dir === 'desc' ? 'asc' : 'desc';
      } else {
        dir = col === 'name' ? 'asc' : 'desc';
      }
      renderTodayTable(globalData._todayItems || items, col, dir);
    });
  }
}

function drawTodayWaterfall(items) {
  // Sort by absolute contribution, take top 10
  const sorted = [...items].sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib));
  const top = sorted.slice(0, 10);
  const rest = sorted.slice(10);
  if (rest.length > 0) {
    const otherContrib = rest.reduce((s, i) => s + (i.contrib || 0), 0);
    top.push({ name: 'Other (' + rest.length + ')', contrib: otherContrib, dayEur: rest.reduce((s, i) => s + (i.dayEur || 0), 0) });
  }
  // Sort for display: positive at top, negative at bottom, by value
  top.sort((a, b) => b.contrib - a.contrib);

  const labels = top.map(i => {
    const n = i.name || '';
    return n.length > 25 ? n.slice(0, 23) + '…' : n;
  });
  const data = top.map(i => i.contrib);
  const colors = data.map(v => v >= 0 ? THEME_COLORS.plGreenAlpha(0.53) : THEME_COLORS.plRedAlpha(0.53));
  const borderColors = data.map(v => v >= 0 ? THEME_COLORS.plGreen : THEME_COLORS.plRed);

  if (charts.todayWaterfall) { charts.todayWaterfall.destroy(); charts.todayWaterfall = null; }
  const canvas = document.getElementById('todayWaterfallChart');
  if (!canvas) return;

  charts.todayWaterfall = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors,
        borderColor: borderColors,
        borderWidth: 1,
        borderRadius: 3,
        barPercentage: 0.7,
        categoryPercentage: 0.85,
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          ...THEME_COLORS.themeTooltip(),
          callbacks: {
            label: ctx => {
              const v = ctx.parsed.x;
              const item = top[ctx.dataIndex];
              const eurVal = item?.dayEur;
              const lines = [' ' + (v >= 0 ? '+' : '') + v.toFixed(3) + '% contribution'];
              if (eurVal != null) lines.push(' ' + (eurVal >= 0 ? '+' : '') + fmtEur(eurVal));
              return lines;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { color: THEME_COLORS.gridColor },
          ticks: { color: THEME_COLORS.tickColor, font: { size: 10 }, callback: v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%' },
        },
        y: {
          grid: { display: false },
          ticks: { color: THEME_COLORS.tickColor, font: { size: 10 } },
        }
      }
    }
  });
}

function renderTodayStats(el, selectedDate) {
  const dates = globalData.recentPerfDates || [];
  const changes = globalData.recentPerfChanges || [];
  if (!dates.length || !changes.length) {
    el.innerHTML = '<div style="padding:16px;color:var(--muted);text-align:center">Daily stats will appear after price history is loaded.</div>';
    return;
  }

  const anchor = selectedDate || dates[dates.length - 1];
  const [anchorY, anchorM] = anchor.split('-');
  const monthPrefix = anchorY + '-' + anchorM;
  const cappedDates = [];
  const cappedChanges = [];
  for (let i = 0; i < dates.length; i++) {
    if (dates[i] <= anchor) {
      cappedDates.push(dates[i]);
      cappedChanges.push(changes[i]);
    }
  }

  // Filter to selected day month (through selected day)
  const monthDates = [];
  const monthChanges = [];
  for (let i = 0; i < cappedDates.length; i++) {
    if (cappedDates[i].startsWith(monthPrefix)) {
      monthDates.push(cappedDates[i]);
      monthChanges.push(cappedChanges[i]);
    }
  }

  // Winning streak (consecutive positive days from most recent backwards)
  let streak = 0;
  for (let i = cappedChanges.length - 1; i >= 0; i--) {
    if (cappedChanges[i] > 0) streak++;
    else break;
  }

  // Best/worst day this month
  let bestDay = null, worstDay = null, bestVal = -Infinity, worstVal = Infinity;
  for (let i = 0; i < monthChanges.length; i++) {
    if (monthChanges[i] > bestVal) { bestVal = monthChanges[i]; bestDay = monthDates[i]; }
    if (monthChanges[i] < worstVal) { worstVal = monthChanges[i]; worstDay = monthDates[i]; }
  }

  // Average daily return this month
  const avgReturn = monthChanges.length > 0 ? monthChanges.reduce((s, v) => s + v, 0) / monthChanges.length : null;

  // Win rate this month
  const wins = monthChanges.filter(v => v > 0).length;
  const winRate = monthChanges.length > 0 ? (wins / monthChanges.length) * 100 : null;

  const fmtDateShort = d => {
    if (!d) return '—';
    const [y, m, dd] = d.split('-');
    return new Date(y, m - 1, dd).toLocaleDateString('default', { day: 'numeric', month: 'short' });
  };
  const fmtPctStat = v => {
    if (v == null || !isFinite(v)) return '—';
    const sign = v >= 0 ? '+' : '';
    return sign + v.toFixed(2) + '%';
  };

  const monthLabel = new Date(anchor + 'T12:00:00').toLocaleString('default', { month: 'long' });

  el.innerHTML = `
    <div class="today-stats-grid">
      <div class="today-stats-item">
        <span class="ts-label">Winning Streak</span>
        <span class="ts-value" style="color:${streak > 0 ? 'var(--green)' : 'var(--text)'}">${streak} day${streak !== 1 ? 's' : ''}</span>
        <span class="ts-detail">Consecutive green days</span>
      </div>
      <div class="today-stats-item">
        <span class="ts-label">Best Day (${monthLabel})</span>
        <span class="ts-value positive">${fmtPctStat(bestVal !== -Infinity ? bestVal : null)}</span>
        <span class="ts-detail">${fmtDateShort(bestDay)}</span>
      </div>
      <div class="today-stats-item">
        <span class="ts-label">Worst Day (${monthLabel})</span>
        <span class="ts-value negative">${fmtPctStat(worstVal !== Infinity ? worstVal : null)}</span>
        <span class="ts-detail">${fmtDateShort(worstDay)}</span>
      </div>
      <div class="today-stats-item">
        <span class="ts-label">Avg. Daily Return</span>
        <span class="ts-value ${avgReturn != null && avgReturn >= 0 ? 'positive' : 'negative'}">${fmtPctStat(avgReturn)}</span>
        <span class="ts-detail">${monthLabel} · ${monthChanges.length} trading days</span>
      </div>
      <div class="today-stats-item">
        <span class="ts-label">Win Rate</span>
        <span class="ts-value" style="color:${winRate != null && winRate >= 50 ? 'var(--green)' : 'var(--red)'}">${winRate != null ? winRate.toFixed(0) + '%' : '—'}</span>
        <span class="ts-detail">${wins}/${monthChanges.length} days positive</span>
      </div>
    </div>
  `;
}

// ── Watchlist tab ──────────────────────────────────────────────────────────

async function renderWatchlistTab() {
  const tableEl = document.getElementById('watchlistTable');
  const emptyEl = document.getElementById('watchlistEmpty');
  const chartCard = document.getElementById('watchlistChartCard');
  const tableCard = document.getElementById('watchlistTableCard');
  // Reset thead wired flag so sort re-wires with fresh data on refresh
  const thead = tableEl?.querySelector('thead');
  if (thead) delete thead.dataset.wired;

  // Pro gate — show blurred placeholder with single Pro overlay on the tab pane
  const tabPane = document.getElementById('tabWatchlist');
  if (!proUnlocked) {
    emptyEl.style.display = 'none';
    if (chartCard) {
      chartCard.style.display = '';
      const chartWrap = chartCard.querySelector('.chart-wrap');
      if (chartWrap) chartWrap.classList.add('tax-blur-wrap');
      const chartReturn = document.getElementById('wlChartReturn');
      if (chartReturn) { chartReturn.classList.add('tax-blur-wrap'); chartReturn.innerHTML = '<span class="wl-ret-value">+12.4%</span><span class="wl-ret-label">composite return</span>'; }
      const compStats = document.getElementById('wlVsPortfolioStats');
      if (compStats) compStats.style.display = 'none';
    }
    if (tableCard) {
      tableCard.style.display = '';
      tableEl.style.display = '';
      const tbody = document.getElementById('watchlistBody');
      if (tbody) {
        tbody.innerHTML = [
          ['Apple Inc.', 'USD', '187.44', '+24.3%', '18.2%', '0.72', '▲ Bullish'],
          ['ASML Holding', 'EUR', '684.20', '+31.7%', '22.5%', '0.58', '▼ Bearish'],
          ['Microsoft Corp.', 'EUR', '378.91', '+18.9%', '15.8%', '0.81', '● Neutral'],
        ].map(([n, c, p, r, v, corr, sig]) => `<tr><td><span class="wl-star">&#9733;</span>${n}</td><td>${c}</td><td class="num">${p}</td><td class="num"><span class="positive">${r}</span></td><td class="num">${v}</td><td class="num">${corr}</td><td class="num">${sig}</td></tr>`).join('');
      }
      const tableContent = document.getElementById('watchlistContent');
      if (tableContent) tableContent.classList.add('tax-blur-wrap');
    }
    showProOverlay(tabPane, 'Watchlist');
    return;
  }

  // Remove Pro overlay and blur if previously gated
  removeProOverlay(tabPane);
  if (chartCard) {
    const chartWrap = chartCard.querySelector('.chart-wrap');
    if (chartWrap) chartWrap.classList.remove('tax-blur-wrap');
    const chartReturn = document.getElementById('wlChartReturn');
    if (chartReturn) chartReturn.classList.remove('tax-blur-wrap');
  }
  if (tableCard) {
    const tableContent = document.getElementById('watchlistContent');
    if (tableContent) tableContent.classList.remove('tax-blur-wrap');
  }

  const favIds = globalData.favouriteProductIds || [];

  // Empty state
  if (favIds.length === 0) {
    if (chartCard) chartCard.style.display = 'none';
    tableEl.style.display = 'none';
    emptyEl.style.display = 'block';
    emptyEl.innerHTML = `
      <div class="wl-empty-icon">&#9734;</div>
      <div class="wl-empty-title">No favourites found</div>
      <div class="wl-empty-desc">Add products to your favourites in DEGIRO, then click Refresh to see them here.</div>`;
    return;
  }

  // Extract product metadata
  const { meta: favMeta, vwdIds: favVwdIds } = extractProductMeta(globalData.favouriteProductInfo);

  // Show loading
  emptyEl.style.display = 'block';
  emptyEl.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted)">Loading watchlist prices...</div>';
  tableEl.style.display = 'none';
  if (chartCard) chartCard.style.display = 'none';

  // Fetch price histories (5Y for full history + 1M for latest data)
  let histories = {};
  try {
    histories = await chrome.runtime.sendMessage({ type: 'FETCH_PRICE_HISTORY', vwdIds: favVwdIds, period: '5Y' });
    const shortHistories = await chrome.runtime.sendMessage({ type: 'FETCH_PRICE_HISTORY', vwdIds: favVwdIds, period: '1M' });
    Object.entries(shortHistories || {}).forEach(([id, shortData]) => {
      if (!shortData?.length) return;
      const longData = histories[id];
      if (!longData?.length) { histories[id] = shortData; return; }
      const lastLongDate = longData[longData.length - 1].date;
      const newer = shortData.filter(d => d.date > lastLongDate);
      if (newer.length) longData.push(...newer);
    });
  } catch (e) { console.warn('[Sharpe] Watchlist price fetch failed:', e); }

  // Store for period switching
  globalData.watchlistHistories = histories;
  globalData.watchlistMeta = favMeta;
  globalData.watchlistVwdIds = favVwdIds;

  // Hide loading, show content
  emptyEl.style.display = 'none';
  if (chartCard) chartCard.style.display = '';
  tableEl.style.display = '';

  // Draw chart + table for default periods
  updateWatchlistChart('1Y');
  updateWatchlistTable('1Y');

  // One period control drives the whole tab — chart, table and the open stock
  // chart. Two independent selectors just invited them to disagree.
  const periodSel = document.getElementById('watchlistPeriod');
  if (periodSel && !periodSel.dataset.wired) {
    periodSel.dataset.wired = '1';
    periodSel.addEventListener('change', () => {
      const p = periodSel.value;
      updateWatchlistChart(p);
      updateWatchlistTable(p);
      // Refresh the open stock chart with the new period
      const selId = globalData._wlSelectedId;
      const card = document.getElementById('wlStockChartCard');
      if (selId && card && card.style.display !== 'none') {
        const meta = globalData.watchlistMeta[selId] || {};
        const h = globalData.watchlistHistories[selId] || [];
        showWatchlistStockChart(selId, meta.name || 'ID ' + selId, h, p);
      }
    });
  }
}

function wlPeriodDays(period) {
  return { '1M': 31, '6M': 183, '1Y': 366, '3Y': 1096, '5Y': 1826 }[period] || 366;
}

function periodCutoffFromRefDate(refDate, period, fallbackDays = 31) {
  if (!refDate) return '';
  const ref = new Date(refDate + 'T12:00:00');
  if (!isFinite(ref.getTime())) return '';
  if (period === 'YTD') return `${ref.getFullYear()}-01-01`;
  const periodDays = { '1W': 7, '1M': 31, '3M': 92, '6M': 183, '1Y': 366, '2Y': 731, '3Y': 1096, '5Y': 1826 };
  const days = periodDays[period] || fallbackDays;
  return new Date(ref.getTime() - days * 864e5).toISOString().slice(0, 10);
}

/** Redraws the watchlist composite chart for the given period */
function updateWatchlistChart(period) {
  const histories = globalData.watchlistHistories || {};
  const favIds = globalData.favouriteProductIds || [];
  const favMeta = globalData.watchlistMeta || {};
  drawWatchlistChart(histories, favIds, favMeta, period);
}

/** Redraws the watchlist table for the given period */
function updateWatchlistTable(period, sortCol, sortDir) {
  const histories = globalData.watchlistHistories || {};
  const favIds = globalData.favouriteProductIds || [];
  const favMeta = globalData.watchlistMeta || {};
  const fallbackDays = wlPeriodDays(period);

  const items = favIds.map(id => {
    const m = favMeta[id] || {};
    const h = histories[id] || [];
    const latest = h.length ? h[h.length - 1] : null;
    const price = latest ? latest.price : null;

    // Return for selected period
    let ret = null;
    if (h.length >= 2 && price != null) {
      const cutoff = periodCutoffFromRefDate(h[h.length - 1].date, period, fallbackDays);
      const startPt = h.find(d => d.date >= cutoff);
      if (startPt) ret = ((price - startPt.price) / startPt.price) * 100;
    }

    // Volatility (annualised, from available history within period window)
    let vol = null;
    if (h.length >= 20) {
      const cutoff = periodCutoffFromRefDate(h[h.length - 1].date, period, fallbackDays);
      const windowH = h.filter(d => d.date >= cutoff);
      if (windowH.length >= 20) {
        const returns = [];
        for (let i = 1; i < windowH.length; i++) {
          if (windowH[i].price > 0 && windowH[i - 1].price > 0) {
            returns.push(Math.log(windowH[i].price / windowH[i - 1].price));
          }
        }
        if (returns.length >= 10) {
          const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
          const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
          vol = Math.sqrt(variance) * Math.sqrt(252) * 100;
        }
      }
    }

    // ── Correlation to portfolio (Pearson of daily returns) ──────────
    let corr = null;
    const portfolioDates = globalData.recentPerfDates || [];
    const portfolioChanges = globalData.recentPerfChanges || [];
    if (h.length >= 20 && portfolioDates.length >= 10) {
      // Build date→return map for this product
      const prodRetMap = {};
      for (let i = 1; i < h.length; i++) {
        if (h[i].price > 0 && h[i - 1].price > 0) {
          prodRetMap[h[i].date] = ((h[i].price - h[i - 1].price) / h[i - 1].price) * 100;
        }
      }
      // Align with portfolio dates
      const aligned = portfolioDates.map((d, i) => [prodRetMap[d] ?? null, portfolioChanges[i]]);
      const a = aligned.map(p => p[0]);
      const b = aligned.map(p => p[1]);
      corr = pearson(a, b);
    }

    // ── Momentum Signal (SMA50 vs SMA200 crossover) ──────────────
    let signal = null; // 'bullish', 'bearish', or 'neutral'
    let sma50Val = null, sma200Val = null;
    if (h.length >= 50) {
      const prices = h.map(d => d.price);
      sma50Val = prices.slice(-50).reduce((s, p) => s + p, 0) / 50;
      if (h.length >= 200) {
        sma200Val = prices.slice(-200).reduce((s, p) => s + p, 0) / 200;
        if (sma50Val > sma200Val * 1.01) signal = 'bullish';
        else if (sma50Val < sma200Val * 0.99) signal = 'bearish';
        else signal = 'neutral';
      } else {
        // Only SMA50 available — compare to current price
        if (price > sma50Val * 1.01) signal = 'bullish';
        else if (price < sma50Val * 0.99) signal = 'bearish';
        else signal = 'neutral';
      }
    }

    return { id, name: m.name || 'ID ' + id, currency: m.currency || '—', price, ret, vol, corr, signal };
  });

  // Store current table period for stock chart clicks
  globalData._wlTablePeriod = period;
  renderWatchlistTable(items, period, sortCol, sortDir);
}

function drawWatchlistChart(histories, favIds, favMeta, period) {
  const fallbackDays = wlPeriodDays(period);

  // Build a date→price map per product
  const productHistMap = {};
  const allDatesSet = new Set();
  favIds.forEach(id => {
    const h = histories[id];
    if (!h?.length) return;
    productHistMap[id] = {};
    h.forEach(d => { productHistMap[id][d.date] = d.price; allDatesSet.add(d.date); });
  });

  let allDates = [...allDatesSet].sort();
  if (allDates.length < 2) return;

  // Apply period filter
  const cutoff = periodCutoffFromRefDate(allDates[allDates.length - 1], period, fallbackDays);
  allDates = allDates.filter(d => d >= cutoff);
  if (allDates.length < 2) return;

  // Find the first price for each product WITHIN the filtered window
  const firstPrices = {};
  favIds.forEach(id => {
    const priceMap = productHistMap[id];
    if (!priceMap) return;
    for (const date of allDates) {
      if (priceMap[date] != null) { firstPrices[id] = priceMap[date]; break; }
    }
  });

  // Build per-date composite: equal-weighted average return, using fill-forward
  const lastKnown = {};
  const compositeData = allDates.map(date => {
    let sumReturn = 0, count = 0;
    favIds.forEach(id => {
      const priceMap = productHistMap[id];
      if (!priceMap || firstPrices[id] == null) return;
      const price = priceMap[date] ?? lastKnown[id];
      if (price == null) return;
      lastKnown[id] = price;
      sumReturn += ((price - firstPrices[id]) / firstPrices[id]) * 100;
      count++;
    });
    return count > 0 ? sumReturn / count : null;
  });

  // Update big return figure
  const totalReturn = compositeData[compositeData.length - 1] ?? 0;
  const retEl = document.getElementById('wlChartReturn');
  if (retEl) {
    const sign = totalReturn >= 0 ? '+' : '';
    const cls = totalReturn >= 0 ? 'positive' : 'negative';
    const periodLabel = { '1M': '1M', '6M': '6M', 'YTD': 'YTD', '1Y': '1Y', '3Y': '3Y', '5Y': '5Y' }[period] || period;
    retEl.innerHTML = `<span class="wl-ret-value ${cls}">${sign}${totalReturn.toFixed(1)}%</span><span class="wl-ret-label">Avg. return (${periodLabel})</span>`;
  }

  // Format labels — same as main chart: "Mon YYYY"
  const fmtDate = d => {
    const [y, m] = d.split('-');
    return new Date(y, m - 1).toLocaleString('default', { month: 'short', year: 'numeric' });
  };

  // Tooltip date format: full date
  const fmtDateFull = d => {
    const [y, m, dd] = d.split('-');
    return new Date(y, m - 1, dd).toLocaleDateString('default', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  const labels = allDates.map(fmtDate);

  // Destroy previous chart
  if (charts.watchlist) { charts.watchlist.destroy(); charts.watchlist = null; }
  const canvas = document.getElementById('watchlistChart');
  if (!canvas) return;

  // Bar chart (same style as the main Performance chart)
  charts.watchlist = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Watchlist',
        data: compositeData,
        backgroundColor: compositeData.map(v => v >= 0 ? THEME_COLORS.plGreenAlpha(0.2) : THEME_COLORS.plRedAlpha(0.2)),
        borderColor: compositeData.map(v => v >= 0 ? THEME_COLORS.plGreenAlpha(0.6) : THEME_COLORS.plRedAlpha(0.6)),
        borderWidth: 0,
        borderRadius: 0,
        barPercentage: 1.0,
        categoryPercentage: 1.0,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...THEME_COLORS.themeTooltip(),
          callbacks: {
            title: ctx => {
              if (!ctx?.length) return '';
              return fmtDateFull(allDates[ctx[0].dataIndex]) || '';
            },
            label: ctx => {
              const v = ctx.parsed.y;
              return ' ' + (v >= 0 ? '+' : '') + v.toFixed(1) + '% — Avg. Return';
            }
          }
        }
      },
      scales: {
        x: { grid: { color: THEME_COLORS.gridColor }, ticks: { color: THEME_COLORS.tickColor, font: { size: 10 }, maxTicksLimit: 12 } },
        y: {
          grid: { color: THEME_COLORS.gridColor },
          ticks: { color: THEME_COLORS.tickColor, font: { size: 10 }, callback: v => (v >= 0 ? '+' : '') + v.toFixed(0) + '%' },
          min: Math.min(0, Math.floor(Math.min(...compositeData.filter(v => v != null)) / 5) * 5 - 5),
        }
      }
    }
  });

  // Render comparison stats below chart
  renderWlVsPortfolio(period);
}

/** Render Watchlist vs Portfolio comparison stats below the watchlist chart */
function renderWlVsPortfolio(period) {
  const el = document.getElementById('wlVsPortfolioStats');
  if (!el) return;

  // Portfolio return: use fullWithTwr series filtered to the same period
  const fullTwr = globalData.fullWithTwr || [];
  const days = wlPeriodDays(period);
  let portfolioRet = null;
  if (fullTwr.length >= 2) {
    const cutoff = new Date(new Date(fullTwr[fullTwr.length - 1].date + 'T12:00:00').getTime() - days * 864e5).toISOString().slice(0, 10);
    const startPt = fullTwr.find(d => d.date >= cutoff);
    const endPt = fullTwr[fullTwr.length - 1];
    if (startPt && endPt && startPt.twr != null && endPt.twr != null) {
      portfolioRet = ((1 + endPt.twr / 100) / (1 + startPt.twr / 100) - 1) * 100;
    }
  }

  // Watchlist return: compute equal-weight average from histories
  const histories = globalData.watchlistHistories || {};
  const favIds = globalData.favouriteProductIds || [];
  let wlRet = null;
  const rets = [];
  favIds.forEach(id => {
    const h = histories[id];
    if (!h?.length || h.length < 2) return;
    const cutoff = new Date(new Date(h[h.length - 1].date + 'T12:00:00').getTime() - days * 864e5).toISOString().slice(0, 10);
    const startPt = h.find(d => d.date >= cutoff);
    if (startPt && startPt.price > 0) {
      rets.push(((h[h.length - 1].price - startPt.price) / startPt.price) * 100);
    }
  });
  if (rets.length > 0) wlRet = rets.reduce((s, r) => s + r, 0) / rets.length;

  if (wlRet == null && portfolioRet == null) { el.style.display = 'none'; return; }

  const fmtV = v => {
    if (v == null) return '<span style="color:var(--muted)">—</span>';
    const sign = v >= 0 ? '+' : '';
    const cls = v >= 0 ? 'positive' : 'negative';
    return `<span class="${cls}">${sign}${v.toFixed(1)}%</span>`;
  };

  const diff = (wlRet != null && portfolioRet != null) ? wlRet - portfolioRet : null;
  const periodLabel = { '1M': '1M', '6M': '6M', 'YTD': 'YTD', '1Y': '1Y', '3Y': '3Y', '5Y': '5Y' }[period] || period;

  el.innerHTML = `
    <div class="wl-comp-item"><span class="wl-comp-label">Watchlist (${periodLabel})</span><span class="wl-comp-value">${fmtV(wlRet)}</span></div>
    <div class="wl-comp-item"><span class="wl-comp-label">Portfolio (${periodLabel})</span><span class="wl-comp-value">${fmtV(portfolioRet)}</span></div>
    <div class="wl-comp-item"><span class="wl-comp-label">Difference</span><span class="wl-comp-value">${fmtV(diff)}</span></div>
  `;
  el.style.display = '';
}

function renderWatchlistTable(items, period, sortCol, sortDir) {
  const tbody = document.getElementById('watchlistBody');
  if (!tbody) return;

  // Persist sort state so it survives period changes
  sortCol = sortCol || globalData._wlSort?.col || null;
  sortDir = sortDir || globalData._wlSort?.dir || null;
  if (sortCol) globalData._wlSort = { col: sortCol, dir: sortDir };

  const periodLabel = { '1M': '1M', '6M': '6M', 'YTD': 'YTD', '1Y': '1Y', '3Y': '3Y', '5Y': '5Y' }[period] || period;

  const fmtReturn = v => {
    if (v == null || !isFinite(v)) return '<span style="color:var(--muted)">—</span>';
    const sign = v >= 0 ? '+' : '';
    const cls = v >= 0 ? 'positive' : 'negative';
    return `<span class="${cls}">${sign}${v.toFixed(1)}%</span>`;
  };

  const fmtCorr = v => {
    if (v == null) return '<span style="color:var(--muted)">—</span>';
    const cls = Math.abs(v) >= 0.6 ? 'corr-high' : 'corr-low';
    return `<span class="${cls}">${v.toFixed(2)}</span>`;
  };

  const fmtSignal = v => {
    if (!v) return '<span style="color:var(--muted)">—</span>';
    if (v === 'bullish') return '<span class="signal-bullish">▲ Bullish</span>';
    if (v === 'bearish') return '<span class="signal-bearish">▼ Bearish</span>';
    return '<span class="signal-neutral">● Neutral</span>';
  };

  // Sort items if a sort column is active
  const sorted = [...items];
  if (sortCol) {
    const signalOrder = { bullish: 3, neutral: 2, bearish: 1 };
    sorted.sort((a, b) => {
      let va = a[sortCol], vb = b[sortCol];
      // Signal column: custom order
      if (sortCol === 'signal') {
        va = signalOrder[va] ?? 0; vb = signalOrder[vb] ?? 0;
        return sortDir === 'asc' ? va - vb : vb - va;
      }
      if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      va = va ?? -Infinity; vb = vb ?? -Infinity;
      return sortDir === 'asc' ? va - vb : vb - va;
    });
  }

  // Update header arrows and Return label
  document.querySelectorAll('#watchlistTable thead th').forEach(th => {
    const col = th.dataset.col;
    th.classList.toggle('sort-active', col === sortCol);
    // Signal header has inner HTML (tooltip span) — preserve it
    if (col === 'signal') {
      const tip = th.querySelector('.th-with-tip');
      if (tip) { tip.textContent = 'Signal'; }
      // Append arrow as text node after the span
      const existing = th.lastChild;
      if (existing?.nodeType === 3) existing.remove(); // remove old arrow text node
      if (col === sortCol) th.append(sortDir === 'asc' ? ' ▲' : ' ▼');
      return;
    }
    // Strip old arrow
    th.textContent = th.textContent.replace(/ [▲▼]$/, '');
    // Set Return header label with period
    if (col === 'ret') th.textContent = `Return (${periodLabel})`;
    // Add sort arrow
    if (col === sortCol) th.textContent += sortDir === 'asc' ? ' ▲' : ' ▼';
  });

  tbody.innerHTML = sorted.map(item => `
    <tr data-wl-id="${item.id}" style="cursor:pointer">
      <td><span class="wl-star">&#9733;</span>${sanitize(item.name)}</td>
      <td>${sanitize(item.currency)}</td>
      <td class="num">${item.price != null ? fmtPrice(item.price) : '—'}</td>
      <td class="num">${fmtReturn(item.ret)}</td>
      <td class="num">${item.vol != null ? item.vol.toFixed(1) + '%' : '<span style="color:var(--muted)">—</span>'}</td>
      <td class="num">${fmtCorr(item.corr)}</td>
      <td class="num">${fmtSignal(item.signal)}</td>
    </tr>
  `).join('');

  // Click row → show individual stock price chart inline
  tbody.querySelectorAll('tr[data-wl-id]').forEach(tr => {
    tr.addEventListener('click', () => {
      const id = tr.dataset.wlId;
      const meta = globalData.watchlistMeta[id] || {};
      const h = globalData.watchlistHistories[id] || [];
      showWatchlistStockChart(id, meta.name || 'ID ' + id, h, globalData._wlTablePeriod || period);
      // Highlight selected row
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('row-selected'));
      tr.classList.add('row-selected');
    });
  });

  // Wire sortable headers (once)
  const thead = document.getElementById('watchlistTable').querySelector('thead');
  if (thead && !thead.dataset.wired) {
    thead.dataset.wired = '1';
    thead.style.cursor = 'pointer';
    thead.addEventListener('click', e => {
      const th = e.target.closest('th');
      if (!th || !th.dataset.col) return;
      const col = th.dataset.col;
      const prev = globalData._wlSort || {};
      let dir;
      if (prev.col === col) {
        dir = prev.dir === 'desc' ? 'asc' : 'desc';
      } else {
        // Default: ascending for text columns, descending for numeric
        dir = (col === 'name' || col === 'currency') ? 'asc' : 'desc';
      }
      // Re-render with current items from updateWatchlistTable
      updateWatchlistTable(globalData._wlTablePeriod || period, col, dir);
    });
  }
}

function showWatchlistStockChart(id, name, history, period) {
  // Track which stock is currently displayed so period changes can refresh it
  globalData._wlSelectedId = id;
  const card = document.getElementById('wlStockChartCard');
  const titleEl = document.getElementById('wlStockTitle');
  const canvas = document.getElementById('wlStockChart');
  const closeBtn = document.getElementById('wlStockClose');
  if (!card || !canvas) return;

  card.style.display = '';
  titleEl.textContent = name;
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Wire close button
  if (!closeBtn.dataset.wired) {
    closeBtn.dataset.wired = '1';
    closeBtn.addEventListener('click', () => {
      card.style.display = 'none';
      if (charts.wlStock) { charts.wlStock.destroy(); charts.wlStock = null; }
      document.querySelectorAll('#watchlistBody tr').forEach(r => r.classList.remove('row-selected'));
    });
  }

  // Filter history to selected period
  let filtered = [...history];
  const fallbackDays = wlPeriodDays(period);
  if (filtered.length) {
    const cutoff = periodCutoffFromRefDate(filtered[filtered.length - 1].date, period, fallbackDays);
    filtered = filtered.filter(d => d.date >= cutoff);
  }

  if (filtered.length < 2) {
    titleEl.textContent = name + ' — insufficient price data';
    return;
  }

  const prices = filtered.map(d => d.price);
  const fmtDate = d => {
    const [y, m] = d.split('-');
    return new Date(y, m - 1).toLocaleString('default', { month: 'short', year: 'numeric' });
  };
  const rawDates = filtered.map(d => d.date);
  const labels = rawDates.map(fmtDate);

  const isUp = prices[prices.length - 1] >= prices[0];
  const lineColor = isUp ? THEME_COLORS.plGreen : THEME_COLORS.plRed;
  const fillColor = isUp ? THEME_COLORS.plGreenAlpha(0.08) : THEME_COLORS.plRedAlpha(0.08);

  if (charts.wlStock) { charts.wlStock.destroy(); charts.wlStock = null; }

  charts.wlStock = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: name,
        data: prices,
        borderColor: lineColor,
        backgroundColor: fillColor,
        fill: true,
        tension: 0.2,
        pointRadius: 0,
        borderWidth: 2,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...THEME_COLORS.themeTooltip(),
          callbacks: {
            title: ctx => {
              if (!ctx || !ctx.length) return '';
              const d = rawDates[ctx[0].dataIndex];
              if (!d) return '';
              const [y, m, dd] = d.split('-');
              return new Date(y, m - 1, dd).toLocaleDateString('default', { day: 'numeric', month: 'long', year: 'numeric' });
            },
            label: ctx => ' ' + fmtPrice(ctx.parsed.y) + ' ' + (globalData.watchlistMeta?.[id]?.currency || ''),
          }
        }
      },
      scales: {
        x: { grid: { color: THEME_COLORS.gridColor }, ticks: { color: THEME_COLORS.tickColor, font: { size: 10 }, maxTicksLimit: 12 } },
        y: {
          grid: { color: THEME_COLORS.gridColor },
          ticks: { color: THEME_COLORS.tickColor, font: { size: 10 }, callback: v => fmtPrice(v) },
        }
      }
    }
  });
}

/** Render PRO-gated insight features when the Insights tab is first opened */
async function renderInsightsTab() {
  renderPulseCard();
  wireGradeCard();
  await wireCorrelationToggle();
  wireStressTestCard();
}

// ── Insight collapsible cards ──────────────────────────────────────────────

// Cards below the Pulse open collapsed to a one-line row that carries its own
// headline number, so the tab summarises before it details. State persists —
// the previous buttons collapsed to a blank bar and forgot the choice.
const INSIGHT_COLLAPSE_KEY = 'insightCollapsed';

function setInsightSummary(cardId, text) {
  const el = document.querySelector(`#${cardId} .insight-summary`);
  if (el && text) el.textContent = text;
}

function applyInsightCollapsed(card, collapsed) {
  card.classList.toggle('collapsed', collapsed);
  card.querySelector('.insight-head')?.setAttribute('aria-expanded', String(!collapsed));
}

function wireInsightCollapsibles() {
  const cards = [...document.querySelectorAll('.insight-collapsible')];
  if (!cards.length) return;

  chrome.storage.local.get(INSIGHT_COLLAPSE_KEY, res => {
    const saved = res?.[INSIGHT_COLLAPSE_KEY] || {};
    cards.forEach(card => {
      // Default collapsed; an explicitly saved choice wins.
      applyInsightCollapsed(card, saved[card.id] !== false);
    });
  });

  cards.forEach(card => {
    const head = card.querySelector('.insight-head');
    if (!head || head.dataset.wired) return;
    head.dataset.wired = '1';

    const toggle = () => {
      const collapsed = !card.classList.contains('collapsed');
      applyInsightCollapsed(card, collapsed);
      chrome.storage.local.get(INSIGHT_COLLAPSE_KEY, res => {
        const state = res?.[INSIGHT_COLLAPSE_KEY] || {};
        state[card.id] = collapsed;
        chrome.storage.local.set({ [INSIGHT_COLLAPSE_KEY]: state });
      });
    };

    head.addEventListener('click', e => {
      // The title carries its own hover tooltip on the correlation card —
      // clicking it should still toggle, but an export button should not.
      if (e.target.closest('button, a, select, input')) return;
      toggle();
    });
    head.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });
}

/** Expand a collapsed insight card (used when something navigates to it). */
function expandInsightCard(cardId) {
  const card = document.getElementById(cardId);
  if (card?.classList.contains('insight-collapsible')) {
    applyInsightCollapsed(card, false);
    chrome.storage.local.get(INSIGHT_COLLAPSE_KEY, res => {
      const state = res?.[INSIGHT_COLLAPSE_KEY] || {};
      state[cardId] = false;
      chrome.storage.local.set({ [INSIGHT_COLLAPSE_KEY]: state });
    });
  }
}

function showMain() {
  document.getElementById('loadingScreen').style.display = 'none';
  document.getElementById('mainContent').style.display = 'flex';
  const tabBar = document.getElementById('tabBar');
  if (tabBar) tabBar.style.display = 'flex';
  wireTabBar();
  wireInsightCollapsibles();
  wireTooltips();
  updateStalenessBanner();
}

// Staleness banner — one message + one clear action. Replaces the old static
// "navigate to your portfolio tab" warning. Hidden while data is fresh.
async function updateStalenessBanner(ageMs) {
  const banner = document.getElementById('portfolioWarning');
  const textEl = document.getElementById('portfolioWarningText');
  const btn = document.getElementById('portfolioWarningBtn');
  if (!banner || !textEl || !btn) return;

  if (!btn.dataset.wired) {
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      if (btn.dataset.action === 'sync') {
        document.getElementById('btnRefresh')?.click();
      } else {
        chrome.tabs.create({ url: 'https://trader.degiro.nl/trader/#/portfolio' });
      }
    });
  }

  const show = (msg, btnLabel, action) => {
    textEl.textContent = msg;
    btn.textContent = btnLabel;
    btn.dataset.action = action;
    banner.style.display = 'flex';
  };

  try {
    const stored = await chrome.storage.local.get(['lastFetch', 'hasData', 'currentUrl']);
    if (ageMs === undefined) ageMs = stored.lastFetch ? (Date.now() - stored.lastFetch) : null;

    // 1. Cached data evicted (24h privacy eviction) or never fetched,
    //    while a stale in-memory view is still on screen
    if ((!stored.hasData || ageMs === null) && globalData.positions?.length) {
      show('Your cached data expired and was cleared for privacy. Open DEGIRO to sync fresh data.',
           'Open DEGIRO Portfolio', 'open');
      return;
    }
    if (ageMs === null || ageMs < STATUS_FRESH_MS) { banner.style.display = 'none'; return; }

    const ageText = fmtAgo(Date.now() - ageMs).replace(' ago', '');

    // 2. Stale and no DEGIRO tab open at all
    const degiroPatterns = chrome.runtime.getManifest().host_permissions.filter(p => p.includes('degiro'));
    const degiroTabs = await chrome.tabs.query({ url: degiroPatterns });
    if (!degiroTabs.length) {
      show(`Data is ${ageText} old — open DEGIRO to sync.`, 'Open DEGIRO Portfolio', 'open');
      return;
    }

    // 3. Stale, DEGIRO open, but not on the portfolio page (intraday values need it)
    const currentUrl = stored.currentUrl || '';
    const onPortfolio = degiroTabs.some(t => (t.url || '').includes('#/portfolio')) || currentUrl.includes('#/portfolio');
    if (!onPortfolio) {
      show(`Data is ${ageText} old — for live figures, open your DEGIRO Portfolio tab, then sync.`,
           'Open DEGIRO Portfolio', 'open');
      return;
    }

    // 4. Stale but everything is in place — one click fixes it
    show(`Data is ${ageText} old.`, 'Sync now', 'sync');
  } catch(e) {
    banner.style.display = 'none';
  }
}

async function renderAll(data) {
  // If cached data was evicted (24h privacy eviction) while a previous render
  // is still on screen, keep the stale-but-visible view instead of blanking it.
  // The sync pill + staleness banner explain the state to the user.
  if (!data?.hasData && globalData.positions?.length) {
    updateStatusDot();
    return;
  }
  const previousEnabledBenchmarks = Array.isArray(globalData.enabledBenchmarks)
    ? globalData.enabledBenchmarks.filter(id => BENCHMARK_CONFIG[id])
    : null;
  const previousTodaySelectedDate = globalData.todaySelectedDate || null;
  const initialEnabledBenchmarks = (previousEnabledBenchmarks && previousEnabledBenchmarks.length)
    ? previousEnabledBenchmarks
    : ['sp500'];
  const { meta, vwdIds } = extractProductMeta(data.productInfo);
  const transactions = extractTransactions(data.transactions);
  const positions = extractPositions(data.portfolio, meta, transactions);
  const names = Object.fromEntries(Object.entries(meta).map(([id, m]) => [id, m.name]));
  const dividends = extractDividends(data.dividends, names);

  // Extract net cash value from portfolio — uses the canonical CASH_IDS set
  const cashValue = (() => {
    const rows = data.portfolio?.portfolio?.value || [];
    let cash = 0;
    rows.forEach(r => {
      const f = {};
      (r.value||[]).forEach(v => { f[v.name] = v.value; });
      const rowId = String(f.id || r.id || '');
      if (CASH_IDS.has(rowId)) cash += f.value || 0;
    });
    return Math.max(0, cash);
  })();

  // Today's P&L comes from DEGIRO's own DOM. The portfolio API's todayPl fields
  // are unreliable (they often carry total unrealized P&L instead of the daily
  // change), so extractPositions deliberately sets p.todayPl = null — see the
  // comment at utils.js:395. The scraped value is the only trustworthy source.
  const todayPL = typeof data.scrapedDailyPnL === 'number' ? data.scrapedDailyPnL : null;

  // Real-time values scraped from DEGIRO's DOM (if available)
  const scrapedTotalPnL = typeof data.scrapedTotalPnL === 'number' ? data.scrapedTotalPnL : null;
  const scrapedPortfolioValue = typeof data.scrapedPortfolioValue === 'number' ? data.scrapedPortfolioValue : null;

  const todayPLPerPosition = (data.scrapedDailyPnLPerPosition && typeof data.scrapedDailyPnLPerPosition === 'object')
    ? data.scrapedDailyPnLPerPosition : null;
  const totalPLPerPosition = (data.scrapedTotalPnLPerPosition && typeof data.scrapedTotalPnLPerPosition === 'object')
    ? data.scrapedTotalPnLPerPosition : null;

  globalData = { positions, dividends, transactions, vwdIds, data, _cashValue: cashValue, _todayPL: todayPL, _todayPLPerPosition: todayPLPerPosition, _scrapedTotalPnLPerPosition: totalPLPerPosition, _scrapedTotalPnL: scrapedTotalPnL, _scrapedPortfolioValue: scrapedPortfolioValue, names, meta,
    favouriteProductIds: data.favouriteProductIds || [],
    favouriteProductInfo: data.favouriteProductInfo || null,
    favouriteLists: data.favouriteLists || [],
    enabledBenchmarks: initialEnabledBenchmarks,
    todaySelectedDate: previousTodaySelectedDate,
    todayReplayByDate: {},
  };

  // ── Intraday P&L snapshot ─────────────────────────────────────────
  if (todayPL != null) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const stored = await new Promise(r => chrome.storage.local.get(['todayPLSnapshots', 'todayPLSnapshotsDate'], r));
    let snapshots = (stored.todayPLSnapshotsDate === todayStr) ? (stored.todayPLSnapshots || []) : [];
    // Time-bucket: max 1 data point per 5 minutes to prevent clustering
    // when user refreshes many times in quick succession
    const BUCKET_MS = 5 * 60 * 1000;
    const now = Date.now();
    const last = snapshots[snapshots.length - 1];
    if (last && (now - last.ts) < BUCKET_MS) {
      last.ts = now;
      last.pl = todayPL; // update existing bucket with latest value
    } else {
      snapshots.push({ ts: now, pl: todayPL });
    }
    await chrome.storage.local.set({ todayPLSnapshots: snapshots, todayPLSnapshotsDate: todayStr });
    globalData._todayPLSnapshots = snapshots;
  }

  // ── Pro status check ──
  proUnlocked = await isPro();
  wireProButton();

  updateStatusDot();

  // Zero state: new account with no positions yet
  if (positions.length === 0) {
    renderHeaderStats([]);
    showMain();
    // NOTE: the element id is 'mainContent' — looking up 'main' silently
    // returned null, so this empty state never rendered for new accounts.
    const mainEl = document.getElementById('mainContent');
    if (mainEl) {
      const zeroState = document.createElement('div');
      zeroState.style.cssText = 'text-align:center;padding:60px 24px;color:var(--muted);font-family:var(--font-display)';
      const icon = document.createElement('div'); icon.style.cssText = 'font-size:48px;margin-bottom:16px'; icon.textContent = '📊';
      const title = document.createElement('div'); title.style.cssText = 'font-size:20px;font-weight:700;color:var(--text);margin-bottom:8px'; title.textContent = 'No positions found';
      const sub = document.createElement('div'); sub.style.cssText = 'font-size:13px;line-height:1.6'; sub.textContent = 'Once you have open positions in your account, they will appear here. Make sure you are logged in and have refreshed the data.';
      zeroState.append(icon, title, sub);
      // Replace main content with zero state
      const cards = mainEl.querySelectorAll('.card');
      cards.forEach(c => c.style.display = 'none');
      mainEl.appendChild(zeroState);
    }
    return;
  }

  renderHeaderStats(positions);
  renderAllocationChart(positions);
  renderPositionsTable(positions);
  // FIFO-walk the whole transaction history once — renderMoreInfo and the
  // Pulse card read the result off globalData rather than recomputing it.
  renderClosedPositionsTable(computeClosedPositions(transactions, globalData.names, meta));
  wirePositionsTabs();
  wirePositionsFilter();
  renderMoreInfo(positions, dividends, transactions);

  // Export buttons — always shown; non-Pro clicks trigger upgrade flow
  wireExportButtons();

  // Grade, Correlation, Stress Test are now lazy-rendered
  // when the Insights tab is first opened (see renderInsightsTab)

  // Restore the chart mode before the first draw so a Daily user doesn't see the
  // cumulative chart flash first. `draw:false` — renderPerformanceChart below owns
  // the initial cumulative paint, and refreshPerfChart owns the daily one.
  let restoredMode = 'cum';
  try {
    const stored = await chrome.storage.local.get('perfMode');
    if (stored.perfMode === 'daily') restoredMode = 'daily';
  } catch (_) {}
  await setPerfMode(restoredMode, { persist: false, draw: false });

  // Cumulative chart first (it owns the 5Y fetch and the TWR series that the
  // header, Pulse and grade engine all read), then the movers window.
  await renderPerformanceChart(globalData);
  // Pulse insights need fullWithTwr + _pulseMetrics, both available by now
  renderPulseCard();
  // Re-render positions table now that priceHistories5Y is available (for volatility column)
  renderPositionsTable(positions);
  // Movers chips + the daily series the Today tab reads. Shimmer while in flight.
  document.getElementById('moversChips')?.classList.add('skeleton');
  fetchHistoriesForPeriod(vwdIds, MOVERS_PERIOD).then(async histories => {
    document.getElementById('moversChips')?.classList.remove('skeleton');
    if (!histories || !Object.keys(histories).length) return;
    renderMovers(positions, histories, MOVERS_PERIOD);
    // Compute-only pass: keeps recentPerfDates/Changes populated for the Today
    // tab and the watchlist comparison even when the chart is in cumulative mode.
    drawDailyPerf(positions, histories, MOVERS_PERIOD, { draw: false });
    if (perfMode() === 'daily') await refreshPerfChart();
  });

  showMain();
}

// ── Data extraction ────────────────────────────────────────────────


// ── Rendering ──────────────────────────────────────────────────────

function renderHeaderStats(positions) {
  const apiTotal = positions.reduce((s,p)=>s+p.value, 0);
  // Use real-time scraped values from DEGIRO's DOM when available
  const apiTotalPL = positions.reduce((s,p)=>s+p.plBase, 0);
  const totalPL = globalData._scrapedTotalPnL ?? apiTotalPL;
  // Portfolio value: prefer DEGIRO's own total (includes cash), fall back to API sum + P&L adjustment
  const total = globalData._scrapedPortfolioValue ?? (apiTotal + (totalPL - apiTotalPL));
  const costBasis = total - totalPL;
  const plPct = costBasis > 0 ? (totalPL / costBasis * 100) : 0;

  const cashValue = globalData._cashValue || 0;
  const cashPct = total > 0 ? (cashValue / (total + cashValue) * 100) : 0;

  const headerStats = document.getElementById('headerStats');
  headerStats.textContent = '';

  // Stat 1: Portfolio Value, with uninvested cash as a permanent sub-line.
  // (It used to be hidden behind a hover-swap, which nobody discovers.)
  const statPV = document.createElement('div');
  statPV.className = 'stat';
  statPV.id = 'statPortfolioValue';
  const pvLabel = document.createElement('div'); pvLabel.className = 'stat-label'; pvLabel.textContent = 'Portfolio Value';
  const pvVal = document.createElement('div'); pvVal.className = 'stat-value sensitive'; pvVal.textContent = fmtEur(total);
  const pvSub = document.createElement('div'); pvSub.className = 'stat-sub sensitive';
  pvSub.textContent = cashValue > 0 ? `${fmtEur(cashValue)} cash · ${cashPct.toFixed(1)}%` : 'fully invested';
  statPV.append(pvLabel, pvVal, pvSub);

  // Stat 2: Total P&L
  const statPL = document.createElement('div');
  statPL.className = 'stat'; statPL.dataset.chartmode = 'eur'; statPL.title = 'Click to view chart';
  const plLabel = document.createElement('div'); plLabel.className = 'stat-label'; plLabel.textContent = 'Total P&L';
  const plVal = document.createElement('div'); plVal.className = 'stat-value ' + (totalPL >= 0 ? 'positive' : 'negative') + ' sensitive';
  plVal.textContent = (totalPL >= 0 ? '+' : '') + fmtEur(totalPL);
  statPL.append(plLabel, plVal);

  // Stat 3: Return (TWR)
  const statReturn = document.createElement('div');
  statReturn.className = 'stat stat--twr'; statReturn.dataset.chartmode = 'pct'; statReturn.title = 'Click to view chart'; statReturn.id = 'statReturn';
  statReturn.dataset.tip = 'TWR = ∏(1 + rᵢ) − 1, where each sub-period return rᵢ is calculated between cash flow events. Eliminates the effect of deposits and withdrawals so only investment decisions are measured.';
  const retLabel = document.createElement('div'); retLabel.className = 'stat-label'; retLabel.id = 'statReturnLabel'; retLabel.textContent = 'Return (all-time)';
  const retVal = document.createElement('div'); retVal.className = 'stat-value ' + (plPct >= 0 ? 'positive' : 'negative'); retVal.id = 'statReturnValue';
  retVal.textContent = (plPct >= 0 ? '+' : '') + plPct.toFixed(1) + '%';
  statReturn.append(retLabel, retVal);


  // Stat 4: Positions count (the old click-to-cycle-allocation easter egg was
  // removed — it duplicated the Allocation card's own visible toggle and could
  // silently disagree with it)
  const statPos = document.createElement('div');
  statPos.className = 'stat'; statPos.id = 'statPositions';
  const posLabel = document.createElement('div'); posLabel.className = 'stat-label'; posLabel.textContent = 'Positions';
  const posVal = document.createElement('div'); posVal.className = 'stat-value'; posVal.id = 'statPositionsValue'; posVal.textContent = positions.length;
  statPos.append(posLabel, posVal);

  // Stat 5: Today's P&L — sourced from globalData._todayPL (extracted in renderAll
  // from totalPortfolio aggregate, or computed from previousClosePrice per position).
  const todayPL    = globalData._todayPL ?? null;
  const hasTodayData = todayPL != null;
  const yesterdayTotal = hasTodayData ? total - todayPL : total;
  const todayPLPct = yesterdayTotal > 0 && hasTodayData ? (todayPL / yesterdayTotal) * 100 : 0;

  // Amount and % shown together rather than swapped on hover
  const statDaily = document.createElement('div');
  statDaily.className = 'stat';
  statDaily.id = 'statDailyPL';
  const dlColorClass = !hasTodayData ? 'muted' : todayPL >= 0 ? 'positive' : 'negative';
  const dlSign       = hasTodayData && todayPL >= 0 ? '+' : '';
  const dlLabel = document.createElement('div'); dlLabel.className = 'stat-label'; dlLabel.textContent = "Today's P&L";
  const dlVal = document.createElement('div');
  dlVal.className = `stat-value sensitive ${dlColorClass}`;
  dlVal.textContent = hasTodayData ? dlSign + fmtEur(todayPL) : '—';
  const dlSub = document.createElement('div');
  dlSub.className = `stat-sub ${dlColorClass}`;
  dlSub.textContent = hasTodayData ? dlSign + todayPLPct.toFixed(2) + '%' : 'no data yet';
  statDaily.append(dlLabel, dlVal, dlSub);

  headerStats.append(statPV, statPL, statReturn, statDaily, statPos);

  // P&L clickable → switch to EUR chart
  document.getElementById('headerStats').querySelector('[data-chartmode="eur"]')?.addEventListener('click', () => {
    document.querySelectorAll('#perfToggle .toggle-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === 'eur');
    });
    drawPerformanceChart(globalData.portfolioSeries, 'eur', globalData.eurSeries);
  });

  // Return stat clickable → switch to % chart
  document.getElementById('statReturn')?.addEventListener('click', () => {
    document.querySelectorAll('#perfToggle .toggle-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === 'pct');
    });
    drawPerformanceChart(globalData.portfolioSeries, 'pct', globalData.eurSeries);
  });

}

// Body-level floating tooltip — escapes sticky/stacking-context clipping.
// One singleton reused by all callers.
function getFloatingTip() {
  let tip = document.getElementById('_floatingTip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = '_floatingTip';
    tip.className = 'floating-tip';
    document.body.appendChild(tip);
  }
  return tip;
}

// ── Tooltips ───────────────────────────────────────────────────────────────
// One delegated handler serves every element carrying a `data-tip` attribute.
// This replaces four separate CSS ::after implementations (metric card, perf badge,
// more-info stat, table header), which each re-declared the same box styling and
// clipped at their container's edge. Position is computed against the viewport,
// so tips can't be cut off by a sticky header or an overflow:hidden card.
// (The correlation matrix keeps its own cursor-following tooltip — that one
// shows dynamic per-cell content rather than a static string.)
function positionFloatingTip(target) {
  const tip = getFloatingTip();
  const rect = target.getBoundingClientRect();
  tip.style.display = 'block';
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  // Prefer above the element; drop below when there isn't room
  let top = rect.top - th - 8;
  if (top < 4) top = Math.min(rect.bottom + 8, vh - th - 4);
  let left = rect.left;
  if (left + tw > vw - 8) left = vw - tw - 8;
  tip.style.top = Math.max(4, top) + 'px';
  tip.style.left = Math.max(4, left) + 'px';
}

function wireTooltips() {
  if (document.body.dataset.tipsWired) return;
  document.body.dataset.tipsWired = '1';
  const hide = () => { const t = document.getElementById('_floatingTip'); if (t) t.style.display = 'none'; };
  document.addEventListener('mouseover', e => {
    const target = e.target.closest?.('[data-tip]');
    if (!target) return;
    const text = target.dataset.tip;
    if (!text) return;
    const tip = getFloatingTip();
    tip.textContent = text;   // textContent — never interpret tip text as HTML
    positionFloatingTip(target);
  });
  document.addEventListener('mouseout', e => {
    if (e.target.closest?.('[data-tip]')) hide();
  });
  // A tip anchored to a moving/scrolling element would otherwise stay behind
  window.addEventListener('scroll', hide, true);
}

function updateHeaderReturn() {
  const periodReturn = globalData.periodReturn ?? 0;
  const periodLabel = globalData.periodLabel || '5Y';
  const labelMap = { '6M':'6M Return', 'YTD':'YTD Return', '1Y':'1Y Return', '2Y':'2Y Return', '3Y':'3Y Return', '5Y':'5Y Return', 'ALL':'Return (all-time)' };
  const el = document.getElementById('statReturnValue');
  const lbl = document.getElementById('statReturnLabel');

  const twrText = (periodReturn >= 0 ? '+' : '') + periodReturn.toFixed(1) + '%';
  if (el) {
    el.textContent = twrText;
    el.className = 'stat-value ' + (periodReturn >= 0 ? 'positive' : 'negative');
    el.title = '';

    // Replace node to clear stale listeners
    const fresh = el.cloneNode(true);
    el.parentNode.replaceChild(fresh, el);
    const elFresh = document.getElementById('statReturnValue');

    if (periodLabel === 'ALL' && globalData.firstTxDate) {
      const startDate = new Date(globalData.firstTxDate + 'T12:00:00');
      const years = (Date.now() - startDate) / (365.25 * 24 * 3600 * 1000);
      if (years > 0.1) {
        const annualised = (Math.pow(1 + periodReturn / 100, 1 / years) - 1) * 100;
        const annText = (annualised >= 0 ? '+' : '') + annualised.toFixed(1) + '%  /yr';
        elFresh.style.cursor = 'default';
        elFresh.addEventListener('mouseenter', () => { elFresh.textContent = annText; });
        elFresh.addEventListener('mouseleave', () => { elFresh.textContent = twrText; });
      }
    }
  }
  if (lbl) lbl.textContent = labelMap[periodLabel] || 'Return';

  // The Return stat's data-tip is served by the delegated tooltip handler
  // (wireTooltips) like every other [data-tip] element.
}


async function renderPerformanceChart({ positions, transactions, vwdIds }) {
  const period = document.getElementById('periodSelect').value;

  // Guard: nothing to render without positions
  if (!positions || positions.length === 0) {
    document.getElementById('loadingText').textContent = 'No active positions found.';
    showMain();
    return;
  }

  document.getElementById('loadingText').textContent = 'Loading price history...';
  const pb = document.getElementById('progressBar');
  const pl = document.getElementById('progressLabel');
  if (pb) pb.style.width = '0%';
  if (pl) pl.textContent = '';

  // Get first transaction date to anchor the chart
  const firstTxDate = transactions.map(t => t.date).filter(Boolean).sort()[0] || '2021-01-01';

  // Fetch all price histories via background service worker (which can access charting.vwdservices.com)
  // Always fetch 5Y for TWR — we need full history back to first transaction (2021)
  // The display period only controls what date range to show, not what to calculate
  const allHistories = await chrome.runtime.sendMessage({ type: 'FETCH_PRICE_HISTORY', vwdIds, period: '5Y' });

  // VWD's long-period (5Y) data often lags by 1–2 trading days compared to shorter
  // periods. Fetch 1M as well and merge any newer data points into the 5Y histories
  // so the latest trading days are not missing from charts.
  const shortHistories = await chrome.runtime.sendMessage({ type: 'FETCH_PRICE_HISTORY', vwdIds, period: '1M' });
  Object.entries(shortHistories).forEach(([id, shortData]) => {
    if (!shortData?.length) return;
    const longData = allHistories[id];
    if (!longData?.length) { allHistories[id] = shortData; return; }
    const lastLongDate = longData[longData.length - 1].date;
    const newer = shortData.filter(d => d.date > lastLongDate);
    if (newer.length) {
      longData.push(...newer);
      dlog(`[Perf] Merged ${newer.length} newer points for ${id} (up to ${newer[newer.length-1].date})`);
    }
  });

  // Extract benchmark data and separate from position price histories
  const benchmarkFullData = {}; // key -> full data array
  const benchmarkData = {};     // key -> filtered data (from firstTxDate)
  const priceHistories = {};
  Object.entries(allHistories).forEach(([id, data]) => {
    if (BENCHMARK_KEYS.has(id)) {
      benchmarkFullData[id] = data || [];
      benchmarkData[id] = (data || []).filter(d => d.date >= firstTxDate);
    } else {
      priceHistories[id] = data;
    }
  });
  // Store full 5Y histories so movers can slice them by period without re-fetching
  globalData.priceHistories5Y = priceHistories;
  globalData.benchmarkFullData = benchmarkFullData;
  globalData.benchmarkData = benchmarkData;

  // Backward compat: keep spyData / spyFullData references for insight bar calculations
  const spyData = benchmarkData['__SP500__'] || [];
  globalData.spyFullData = benchmarkFullData['__SP500__'] || [];
  dlog('[Perf] Benchmarks loaded:', Object.keys(benchmarkData).map(k => `${k}: ${benchmarkData[k].length} pts`).join(', '));

  const now = new Date();
  const periodDays = period === '6M' ? 182 : period === '1Y' ? 365 : period === '2Y' ? 730 : period === '3Y' ? 1095 : 1825;
  // Use local date offset (not UTC) to avoid timezone-induced off-by-one on period boundaries
  const periodStartMs = Date.now() - periodDays * 864e5;
  const periodStartDate = new Date(periodStartMs);
  const periodStart = new Date(periodStartMs - periodStartDate.getTimezoneOffset() * 60000).toISOString().slice(0,10);
  const ytdStart = new Date(now.getFullYear(), 0, 1);
  const ytdStartLocal = new Date(ytdStart.getTime() - ytdStart.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const chartStartRaw = (period === '5Y' || period === 'ALL')
    ? firstTxDate
    : (period === 'YTD' ? ytdStartLocal : periodStart);
  const chartStart = chartStartRaw > firstTxDate ? chartStartRaw : firstTxDate;
  dlog(`[Perf] period=${period} periodStart=${periodStart} firstTxDate=${firstTxDate} chartStart=${chartStart}`);

  // Binary search price lookup
  const getPrice = (id, date) => {
    const h = priceHistories[id];
    if (!h?.length) return null;
    let lo = 0, hi = h.length - 1, res = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (h[mid].date <= date) { res = h[mid].price; lo = mid + 1; }
      else hi = mid - 1;
    }
    return res;
  };

  // FX rate map: derive a static EUR/native rate per product from current positions.
  // VWD prices are in each instrument's native currency. For mixed-currency portfolios,
  // we convert to EUR so the portfolio total isn't a meaningless sum of different currencies.
  // A static (current) FX rate is used because we don't have historical FX data.
  const fxRates = {};
  positions.forEach(p => {
    if (p.price > 0 && p.size !== 0) {
      fxRates[p.id] = p.value / (p.price * p.size);
    }
  });

  // Get portfolio value on a given date using historical holdings
  // Per-position last known price cache for fill-forward
  const lastKnownPrice = {};
  const getPortfolioValue = (date, holdingsSnapshot) => {
    let total = 0;
    const entries = Object.entries(holdingsSnapshot).filter(([, s]) => s > 0);
    if (!entries.length) return null;
    let anyPriced = false;
    for (const [id, shares] of entries) {
      const fx = fxRates[id] || 1; // EUR products ≈ 1.0, non-EUR converted
      const price = getPrice(id, date);
      if (price) {
        lastKnownPrice[id] = price; // update fill-forward cache
        total += price * shares * fx;
        anyPriced = true;
      } else if (lastKnownPrice[id]) {
        // Fill forward: use last known price rather than dropping the date
        total += lastKnownPrice[id] * shares * fx;
        anyPriced = true;
      }
      // If truly no price ever seen for this id, skip it (new position not yet priced)
    }
    return anyPriced ? total : null;
  };

  // Build sorted transactions with date-only strings
  const sortedTx = [...transactions]
    .map(t => ({ ...t, date: (t.date||'').slice(0,10) }))
    .filter(t => t.date)
    .sort((a,b) => a.date.localeCompare(b.date));

  // Get all unique trading dates from price histories (within full history)
  const allTradingDates = [...new Set(
    Object.values(priceHistories).flatMap(h => h.map(d => d.date))
  )].filter(d => d >= firstTxDate).sort();

  // Build holdings snapshot at each transaction date
  const holdingsAtDate = {};
  const runningHoldings = {};
  sortedTx.forEach(tx => {
    const id = String(tx.productId);
    if (!runningHoldings[id]) runningHoldings[id] = 0;
    runningHoldings[id] += tx.buysell === 'B' ? Math.abs(tx.quantity) : -Math.abs(tx.quantity);
    if (runningHoldings[id] < 0.001) delete runningHoldings[id];
    holdingsAtDate[tx.date] = { ...runningHoldings };
  });

  // TWR: sub-period chaining
  // Any buy or sell is an external cash flow event; we strip it out by closing
  // the sub-period just before the transaction and opening a new one after.
  //
  // KEY FIX: Some transaction dates have no price data (e.g. a Friday not in
  // the VWD cache). Those transactions get "absorbed" into the next priced date.
  // We detect this by flagging each series entry with `hasTx` (any tx since the
  // last priced date). When `hasTx` is true:
  //   equityBefore = full_series[i-1].value  (prev day: computed with OLD holdings)
  //   spStart      = full_series[i].value    (today: computed with NEW holdings)
  // This is exactly correct: prev-day value used OLD holdings, today uses NEW ones.
  // Using the cached `getPrice` binary search means fill-forward is already built in.

  let currentHoldings = {};
  let txIdx = 0;
  const fullPortfolioSeries = [];

  allTradingDates.forEach(date => {
    let hasTx = false;
    while (txIdx < sortedTx.length && sortedTx[txIdx].date <= date) {
      const tx = sortedTx[txIdx];
      const id = String(tx.productId);
      if (!currentHoldings[id]) currentHoldings[id] = 0;
      currentHoldings[id] += tx.buysell === 'B' ? Math.abs(tx.quantity) : -Math.abs(tx.quantity);
      if (currentHoldings[id] < 0.001) delete currentHoldings[id];
      // Seed fill-forward cache with tx price so the position has a value immediately,
      // even before VWD price data arrives. Without this, the portfolio value would
      // exclude the position for days/weeks, then spike when VWD data first appears.
      if (tx.buysell === 'B' && tx.price > 0 && !lastKnownPrice[id]) {
        lastKnownPrice[id] = tx.price;
      }
      hasTx = true;
      txIdx++;
    }
    const value = getPortfolioValue(date, currentHoldings);
    if (value != null && value > 0) fullPortfolioSeries.push({ date, value, hasTx });
  });

  const twrByDate = {};
  if (fullPortfolioSeries.length === 0) {
    document.getElementById('perfSubtitle').textContent = 'Historical price data unavailable';
    showMain();
    return;
  }

  let cumFactor = 1;
  let spStart = fullPortfolioSeries[0].value;

  for (let i = 0; i < fullPortfolioSeries.length; i++) {
    const { date, value, hasTx } = fullPortfolioSeries[i];

    if (hasTx && i > 0) {
      const equityBefore = fullPortfolioSeries[i - 1].value;
      const ratio = (spStart > 0 && equityBefore > 0) ? equityBefore / spStart : 1;
      if (spStart > 0 && equityBefore > 0) cumFactor *= ratio;
      dlog(`[TWR] boundary ${fullPortfolioSeries[i-1].date}→${date}: eqBefore=${equityBefore.toFixed(0)} spStart=${spStart.toFixed(0)} ratio=${ratio.toFixed(4)} cumFactor=${cumFactor.toFixed(4)} newSpStart=${value.toFixed(0)}`);
      // Guard: if portfolio was fully liquidated (spStart = 0), reset baseline.
      // Without this, the next purchase would divide by zero → Infinity/NaN.
      spStart = value > 0 ? value : spStart;
    }

    // Guard against division by zero if spStart is still 0 (e.g. first entry had no value)
    twrByDate[date] = (spStart > 0 && isFinite(value / spStart)) ? (cumFactor * (value / spStart) - 1) * 100 : 0;
  }


  // Build filtered series for display period — no re-normalization
  // Bars always show absolute TWR since inception; period just zooms the window
  const fullWithTwr = fullPortfolioSeries.map(d => ({
    ...d,
    twr: twrByDate[d.date] ?? 0
  }));

  // Compute all-time Sharpe here from the full (unfiltered) series and store it on
  // globalData ONCE. drawPerformanceChart must never overwrite this — it only has access
  // to the period-sliced window, which would produce a period-specific Sharpe.
  try {
    const allTimeSharpe = computeSharpeFromTwrSeries(fullWithTwr);
    if (allTimeSharpe != null) globalData.insightSharpe = allTimeSharpe;
  } catch(e) { /* leave unchanged */ }

  const filteredFull = fullWithTwr.filter(d => d.date >= chartStart);
  dlog(`[Perf] filteredFull: ${filteredFull.length} points, first=${filteredFull[0]?.date} last=${filteredFull[filteredFull.length-1]?.date}`);

  // Period gain = change within the visible window (for header/subtitle info only)
  const twrAtWindowStart = filteredFull[0]?.twr ?? 0;
  const twrAtWindowEnd   = filteredFull[filteredFull.length-1]?.twr ?? 0;
  const periodGain = ((1 + twrAtWindowEnd / 100) / (1 + twrAtWindowStart / 100) - 1) * 100;

  // filteredSeries has twr = absolute from inception; twrDisplay = same (no reset)
  const filteredSeries = filteredFull.map(d => ({ ...d, twrDisplay: d.twr }));

  const eurSeries = filteredSeries;
  dlog('[Perf] TWR points:', filteredSeries.length, 'final TWR:', twrAtWindowEnd.toFixed(1)+'%', 'period gain:', periodGain.toFixed(1)+'%');

  if (filteredSeries.length === 0 && spyData.length === 0) {
    document.getElementById('perfSubtitle').textContent = 'Historical price data unavailable';
    showMain();
    return;
  }

  // Store for toggle redraw
  globalData.portfolioSeries = filteredSeries;
  globalData.fullPortfolioSeries = fullPortfolioSeries; // full history for Sharpe calculation
  globalData.fullWithTwr = fullWithTwr; // full history with TWR for drag-zoom
  globalData.spyData = spyData; // backward compat for insight bar
  if (!Array.isArray(globalData.enabledBenchmarks) || !globalData.enabledBenchmarks.length) {
    globalData.enabledBenchmarks = ['sp500'];
  }
  globalData.firstTxDate = firstTxDate;
  // portfolioStartDate = first day the portfolio had a computable value.
  // TWR starts at 0% from this date, so the S&P must be anchored here too.
  globalData.portfolioStartDate = fullPortfolioSeries[0]?.date || firstTxDate;

  // Wire up % / € toggle
  const toggle = document.getElementById('perfToggle');
  if (toggle && !toggle.dataset.wired) {
    toggle.dataset.wired = '1';
    toggle.addEventListener('click', e => {
      const btn = e.target.closest('.toggle-btn');
      if (!btn) return;
      toggle.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      drawPerformanceChart(globalData.portfolioSeries, btn.dataset.mode, globalData.eurSeries);
    });
  }

  // ── Overlays menu ────────────────────────────────────────────────────────
  // One menu owns everything drawn over the chart: the three benchmarks and the
  // trade markers. It replaces the Benchmarks dropdown, the standalone "⇅ Trades"
  // button, the legend row, and the duplicate "vs S&P 500" chip that used to sit
  // on the second card — the S&P entry now drives both the line and the lollipops.
  const bmWrap = document.getElementById('bmDropdownWrap');
  const bmBtn  = document.getElementById('bmDropdownBtn');
  const bmMenu = document.getElementById('bmDropdownMenu');
  if (bmMenu && !bmMenu.dataset.wired) {
    bmMenu.dataset.wired = '1';
    const syncMenu = () => {
      bmMenu.querySelectorAll('.bm-dropdown-item').forEach(item => {
        if (item.dataset.overlay === 'trades') item.classList.toggle('active', !!globalData.showTrades);
        else item.classList.toggle('active', (globalData.enabledBenchmarks || []).includes(item.dataset.benchmark));
      });
    };
    // Restore saved selection from storage
    chrome.storage.local.get(['enabledBenchmarks', 'showTrades'], result => {
      const saved = result.enabledBenchmarks;
      if (saved && Array.isArray(saved)) {
        // Migrate old msciWorld → nasdaq
        const migrated = saved.map(id => id === 'msciWorld' ? 'nasdaq' : id).filter(id => BENCHMARK_CONFIG[id]);
        globalData.enabledBenchmarks = migrated;
      }
      if (result.showTrades) globalData.showTrades = true;
      syncMenu();
      redrawPerf();
    });
    syncMenu();
    // Toggle dropdown open/close
    bmBtn.addEventListener('click', e => {
      e.stopPropagation();
      bmWrap.classList.toggle('open');
    });
    // Close on outside click
    document.addEventListener('click', e => {
      if (!bmWrap.contains(e.target)) bmWrap.classList.remove('open');
    });
    // Toggle an individual overlay
    bmMenu.addEventListener('click', e => {
      const item = e.target.closest('.bm-dropdown-item');
      if (!item) return;
      e.stopPropagation();
      const isOn = item.classList.toggle('active');
      if (item.dataset.overlay === 'trades') {
        globalData.showTrades = isOn;
        chrome.storage.local.set({ showTrades: isOn });
      } else {
        globalData.enabledBenchmarks = [...bmMenu.querySelectorAll('.bm-dropdown-item[data-benchmark].active')]
          .map(i => i.dataset.benchmark);
        chrome.storage.local.set({ enabledBenchmarks: globalData.enabledBenchmarks });
      }
      redrawPerf();
    });
  }

  globalData.eurSeries = eurSeries;
  globalData.periodReturn = periodGain;
  globalData.periodLabel = period;
  updateHeaderReturn();
  const activeMode = document.querySelector('#perfToggle .toggle-btn.active')?.dataset.mode || 'pct';
  drawPerformanceChart(filteredSeries, activeMode, eurSeries);
}

// --- Drag-to-zoom: native DOM events + overlay div ---
// Uses a lightweight positioned div for the selection rectangle (no canvas redraws
// during drag) and defers the zoom action via setTimeout so Chart.js is not
// destroyed mid-event-processing.

function applyDragZoom(startIdx, endIdx) {
  if (perfMode() !== 'cum') return;
  const currentSeries = globalData.portfolioSeries;
  if (!currentSeries || startIdx >= endIdx) return;

  const startDate = currentSeries[startIdx]?.date;
  const endDate = currentSeries[endIdx]?.date;
  if (!startDate || !endDate) return;

  const periodSelect = document.getElementById('periodSelect');
  if (periodSelect.value !== 'CUSTOM') {
    dragZoomState.preDragPeriod = periodSelect.value;
  }

  const fullSeries = globalData.fullWithTwr;
  if (!fullSeries) return;
  const zoomedSeries = fullSeries
    .filter(d => d.date >= startDate && d.date <= endDate)
    .map(d => ({ ...d, twrDisplay: d.twr }));

  if (zoomedSeries.length < 2) return;

  globalData.portfolioSeries = zoomedSeries;
  globalData.eurSeries = zoomedSeries;

  const customOpt = document.getElementById('optCustom');
  if (!customOpt) return; // daily mode has no Custom slot
  customOpt.disabled = false;
  customOpt.hidden = false;
  periodSelect.value = 'CUSTOM';

  document.getElementById('btnResetZoom').style.display = '';

  const activeMode = document.querySelector('#perfToggle .toggle-btn.active')?.dataset.mode || 'pct';
  drawPerformanceChart(zoomedSeries, activeMode, zoomedSeries);
}

function initDragZoom(canvas) {
  // Avoid double-init
  if (canvas._dragZoomInit) return;
  canvas._dragZoomInit = true;

  const wrap = canvas.closest('.chart-wrap');

  // Create overlay div for selection highlight
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:absolute;top:0;left:0;height:100%;pointer-events:none;'
    + 'background:' + THEME_COLORS.plGreenAlpha(0.1) + ';border-left:1px dashed ' + THEME_COLORS.plGreenAlpha(0.5) + ';'
    + 'border-right:1px dashed ' + THEME_COLORS.plGreenAlpha(0.5) + ';display:none;z-index:5;';
  wrap.appendChild(overlay);

  let startX = null;

  canvas.addEventListener('mousedown', e => {
    const chart = charts.performance;
    if (!chart || perfMode() !== 'cum') return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const area = chart.chartArea;
    if (x >= area.left && x <= area.right) {
      startX = x;
      dragZoomState.active = true;
      overlay.style.display = 'block';
      overlay.style.left = x + 'px';
      overlay.style.width = '0px';
    }
  });

  // Use document-level listeners so dragging beyond the canvas still works
  document.addEventListener('mousemove', e => {
    if (startX === null) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const chart = charts.performance;
    if (!chart) return;
    const area = chart.chartArea;
    const clampedX = Math.max(area.left, Math.min(area.right, x));
    const left = Math.min(startX, clampedX);
    const width = Math.abs(clampedX - startX);
    overlay.style.left = left + 'px';
    overlay.style.width = width + 'px';
  });

  document.addEventListener('mouseup', e => {
    if (startX === null) return;
    overlay.style.display = 'none';
    dragZoomState.active = false;

    const chart = charts.performance;
    if (!chart) { startX = null; return; }

    const rect = canvas.getBoundingClientRect();
    const endX = e.clientX - rect.left;
    const area = chart.chartArea;
    const clampedEnd = Math.max(area.left, Math.min(area.right, endX));

    const minX = Math.min(startX, clampedEnd);
    const maxX = Math.max(startX, clampedEnd);
    startX = null;

    if (maxX - minX < 10) return; // click, not drag

    const startIdx = Math.max(0, Math.min(chart.data.labels.length - 1,
      Math.round(chart.scales.x.getValueForPixel(minX))));
    const endIdx = Math.max(0, Math.min(chart.data.labels.length - 1,
      Math.round(chart.scales.x.getValueForPixel(maxX))));

    if (startIdx >= endIdx) return;

    // Defer zoom so Chart.js isn't destroyed mid-event
    setTimeout(() => applyDragZoom(startIdx, endIdx), 0);
  });
}

// ── Performance card mode machinery ────────────────────────────────────────

/**
 * Rebuild the period <select> for the active mode, preserving the user's last
 * choice per mode. Daily windows stop at 1Y because a bar per trading day over
 * "all time" is ~900 bars of noise.
 */
function applyPerfPeriodOptions(mode) {
  const sel = document.getElementById('periodSelect');
  if (!sel) return;
  const remembered = mode === 'daily' ? globalData._dailyPeriod : globalData._cumPeriod;
  const want = remembered || PERF_DEFAULT_PERIOD[mode];
  sel.textContent = '';
  PERF_PERIODS[mode].forEach(([value, label]) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    sel.appendChild(opt);
  });
  if (mode === 'cum') {
    // Drag-zoom parks a synthetic "Custom" entry here
    const custom = document.createElement('option');
    custom.value = 'CUSTOM';
    custom.id = 'optCustom';
    custom.textContent = 'Custom';
    custom.disabled = true;
    custom.hidden = true;
    sel.appendChild(custom);
  }
  sel.value = [...sel.options].some(o => o.value === want) ? want : PERF_DEFAULT_PERIOD[mode];
}

/** Switch the chart between cumulative and daily. Persisted across sessions. */
async function setPerfMode(mode, { persist = true, draw = true } = {}) {
  mode = mode === 'daily' ? 'daily' : 'cum';
  globalData._perfMode = mode;

  document.querySelectorAll('#perfModeToggle .toggle-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.perfmode === mode);
  });
  // The %/€ switch is meaningless for a daily series (there is no € equivalent
  // of "today's percentage move"), so it hides rather than sitting there inert.
  const unitToggle = document.getElementById('perfToggle');
  if (unitToggle) unitToggle.style.display = mode === 'daily' ? 'none' : '';
  // Trade markers are a cumulative-line overlay; same rule — hide, don't disable.
  const tradesItem = document.querySelector('#bmDropdownMenu [data-overlay="trades"]');
  const tradesSep = document.querySelector('#bmDropdownMenu .bm-dropdown-sep');
  if (tradesItem) tradesItem.style.display = mode === 'daily' ? 'none' : '';
  if (tradesSep) tradesSep.style.display = mode === 'daily' ? 'none' : '';
  // Zoom belongs to the cumulative view only
  if (mode === 'daily') {
    const reset = document.getElementById('btnResetZoom');
    if (reset) reset.style.display = 'none';
    dragZoomState.preDragPeriod = null;
  }

  applyPerfPeriodOptions(mode);
  if (persist) chrome.storage.local.set({ perfMode: mode }).catch(() => {});
  if (draw) await refreshPerfChart();
}

/** Draw whichever mode is active for the currently selected period. */
async function refreshPerfChart() {
  if (!globalData.positions?.length) return;
  const period = document.getElementById('periodSelect')?.value || PERF_DEFAULT_PERIOD[perfMode()];
  if (perfMode() === 'daily') {
    globalData._dailyPeriod = period;
    const histories = await fetchHistoriesForPeriod(globalData.vwdIds, period);
    drawDailyPerf(globalData.positions, histories, period);
  } else {
    globalData._cumPeriod = period;
    await renderPerformanceChart(globalData);
  }
}

/** Redraw the active mode from data already in memory (overlay toggles, theme). */
function redrawPerf() {
  if (perfMode() === 'daily') {
    const args = globalData._lastDailyArgs;
    if (args) drawDailyPerf(...args);
  } else if (globalData.portfolioSeries) {
    drawPerformanceChart(globalData.portfolioSeries, perfUnit(), globalData.eurSeries);
  }
}

/**
 * The one metric line under the chart. Replaces five bordered cards behind a
 * lightbulb toggle — same numbers, one row. Each figure carries its own short
 * hover description, so the explanation stays next to the number it explains.
 * `items` is [{ label, value, cls, tip }]; `note` is an optional italic caveat.
 */
function renderPerfFootline(items, note) {
  const el = document.getElementById('perfFootline');
  if (!el) return;
  el.textContent = '';
  items.forEach((it, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'pf-sep';
      sep.textContent = '·';
      el.appendChild(sep);
    }
    const span = document.createElement('span');
    span.className = 'pf-item';
    if (it.tip) span.dataset.tip = it.tip;
    span.appendChild(document.createTextNode(it.label + ' '));
    const b = document.createElement('b');
    if (it.cls) b.className = it.cls;
    b.textContent = it.value;
    span.appendChild(b);
    el.appendChild(span);
  });
  if (note) {
    const sep = document.createElement('span');
    sep.className = 'pf-sep';
    sep.textContent = '·';
    const n = document.createElement('span');
    n.className = 'pf-note';
    n.textContent = note;
    el.append(sep, n);
  }
}

function drawPerformanceChart(twrSeries, mode, eurSeries) {
  if (!twrSeries.length) return;

  const isPct = mode === 'pct';
  const displaySeries = isPct ? twrSeries : (eurSeries || twrSeries);
  const windowBaseTwr = twrSeries[0]?.twr ?? 0;
  dlog(`[DRAW] twr[0]=${twrSeries[0]?.twr?.toFixed(2)} twr[-1]=${twrSeries[twrSeries.length-1]?.twr?.toFixed(2)} windowBaseTwr=${windowBaseTwr?.toFixed(2)} n=${twrSeries.length}`);

  const fmtDate = d => {
    const [y,m] = d.split('-');
    return new Date(y,m-1).toLocaleString('default',{month:'short',year:'numeric'});
  };

  // Benchmark baseline anchored to SAME date as portfolio TWR = 0%.
  const portfolioStart = globalData.portfolioStartDate || globalData.firstTxDate || '2021-01-01';
  // Keep backward-compat references for insight bar (uses S&P 500 only)
  const fullSpyData = globalData.spyFullData || [];
  const inceptionSpyEntry = fullSpyData.find(d => d.date >= portfolioStart);
  const spyBase = inceptionSpyEntry ? inceptionSpyEntry.price : (fullSpyData[0]?.price || 1);
  dlog('[SPY] portfolioStart:', portfolioStart, 'spyBase date:', inceptionSpyEntry?.date, 'spyBase price:', spyBase?.toFixed(2));

  // Subtitle: show period gain (change within the visible window) — not absolute
  const periodReturn = twrSeries[twrSeries.length-1]?.twr - (twrSeries[0]?.twr ?? 0);
  const allTimeTwr = twrSeries[twrSeries.length-1]?.twr ?? 0;
  const periodLabel = document.getElementById('periodSelect')?.options[document.getElementById('periodSelect')?.selectedIndex]?.text || '';
  // Subtitle carries the window's return rather than restating the title.
  // Chain-linked, matching the annualised figure below — not a TWR level difference.
  const subtitleEl = document.getElementById('perfSubtitle');
  if (subtitleEl) {
    const windowLabel = periodLabel === 'All time' ? 'all time' : periodLabel;
    if (isPct) {
      const f = twrSeries[0]?.twr ?? 0;
      const l = twrSeries[twrSeries.length - 1]?.twr ?? 0;
      const windowReturn = ((1 + l / 100) / (1 + f / 100) - 1) * 100;
      subtitleEl.textContent = `${windowReturn >= 0 ? '+' : ''}${windowReturn.toFixed(1)}% over ${windowLabel}`;
      subtitleEl.className = 'card-subtitle ' + (windowReturn >= 0 ? 'positive' : 'negative');
    } else {
      subtitleEl.textContent = `${windowLabel} window`;
      subtitleEl.className = 'card-subtitle';
    }
  }

  // ── Performance metrics (rendered as the footer line) ────────────
  {
    try {
    // Max drawdown within the visible window
    let peak = -Infinity, maxDD = 0;
    for (const d of twrSeries) {
      if (d.twr > peak) peak = d.twr;
      const dd = peak - d.twr;
      if (dd > maxDD) maxDD = dd;
    }

    // Annualised return for the current timeframe
    // Use chain-linked formula (same as periodGain in header) — NOT simple TWR level difference
    const firstTwr = twrSeries[0]?.twr ?? 0;
    const lastTwr  = twrSeries[twrSeries.length - 1]?.twr ?? 0;
    const periodReturnDecimal = (1 + lastTwr / 100) / (1 + firstTwr / 100) - 1;
    const firstDate = twrSeries[0]?.date;
    const lastDate  = twrSeries[twrSeries.length - 1]?.date;
    let annualisedStr = '—';
    let annualisedPct = null;
    if (firstDate && lastDate && firstDate !== lastDate) {
      const days = (new Date(lastDate + 'T12:00:00') - new Date(firstDate + 'T12:00:00')) / (1000 * 60 * 60 * 24);
      const years = days / 365.25;
      if (years >= 0.08) {
        const annualised = (Math.pow(1 + periodReturnDecimal, 1 / years) - 1) * 100;
        annualisedPct = annualised;
        const sign = annualised >= 0 ? '+' : '';
        annualisedStr = `${sign}${annualised.toFixed(1)}%`;
      }
    }
    const annualisedClass = annualisedStr !== '—' && parseFloat(annualisedStr) >= 0 ? 'positive' : 'negative';

    const ddClass = maxDD > 0 ? 'negative' : '';
    const ddStr = `-${maxDD.toFixed(1)}%`;

    // Beta & Alpha vs S&P 500 — computed from monthly returns within the visible window
    const spyPriceMap = {};
    const spySource = globalData.spyFullData && globalData.spyFullData.length ? globalData.spyFullData : [];
    spySource.forEach(s => { if (s && s.date) spyPriceMap[s.date] = s.price; });

    // Sample monthly returns: step through twrSeries by ~21 trading days
    const step = 21;
    const portReturns = [], spyReturns = [];
    for (let i = step; i < twrSeries.length; i += step) {
      const prev = twrSeries[i - step];
      const curr = twrSeries[i];
      const pr = (curr.twr - prev.twr) / (100 + prev.twr);
      portReturns.push(pr);
      let pPrev = null, pCurr = null;
      for (let j = i - step; j <= i && j < twrSeries.length; j++) {
        const p = spyPriceMap[twrSeries[j].date];
        if (p) { if (j <= i - step + 2) pPrev = p; pCurr = p; }
      }
      spyReturns.push(pPrev && pCurr ? (pCurr - pPrev) / pPrev : null);
    }

    let betaStr = '—', alphaStr = '—';
    let betaVal = null;
    const validPairs = portReturns.map((p, i) => [p, spyReturns[i]]).filter(([p, s]) => s !== null && isFinite(p) && isFinite(s));
    if (validPairs.length >= 6) {
      const n = validPairs.length;
      const meanP = validPairs.reduce((s, [p]) => s + p, 0) / n;
      const meanS = validPairs.reduce((s, [, sp]) => s + sp, 0) / n;
      let cov = 0, varS = 0;
      for (const [p, s] of validPairs) { cov += (p - meanP) * (s - meanS); varS += (s - meanS) ** 2; }
      if (varS > 0) {
        betaVal = cov / varS;
        betaStr = betaVal.toFixed(2);
        if (annualisedPct !== null) {
          const days = (new Date(lastDate + 'T12:00:00') - new Date(firstDate + 'T12:00:00')) / (1000 * 60 * 60 * 24);
          const years = days / 365.25;
          const spyStart = spyPriceMap[twrSeries[0]?.date] || spySource.find(d => d.date >= firstDate)?.price;
          const lastTwrDate = twrSeries[twrSeries.length - 1]?.date;
          const spyEnd = spyPriceMap[lastTwrDate] || [...spySource].reverse().find(d => d.date <= lastTwrDate)?.price;
          if (spyStart && spyEnd && years >= 0.08) {
            const spyAnn = (Math.pow(spyEnd / spyStart, 1 / years) - 1) * 100;
            const alpha  = annualisedPct - betaVal * spyAnn;
            alphaStr = `${alpha >= 0 ? '+' : ''}${alpha.toFixed(1)}%`;
          }
        }
      }
    }
    const betaClass = betaVal !== null ? (betaVal > 1.2 ? 'negative' : betaVal < 0.8 ? 'positive' : '') : '';
    const alphaClass = alphaStr !== '—' ? (parseFloat(alphaStr) >= 0 ? 'positive' : 'negative') : '';

    // Sharpe ratio for the selected timeframe
    // Use daily TWR-derived returns — strips out cash flows (deposits/withdrawals).
    // Also filter out zero-return days caused by fill-forward pricing (stale prices),
    // as these are data gaps not actual flat performance and would distort volatility.
    let sharpeStr = '—';
    let sharpeClass = '';
    try {
      const RF_DAILY = Math.pow(1.03, 1 / 252) - 1;
      const dailyReturns = [];
      for (let i = 1; i < twrSeries.length; i++) {
        const prev = 1 + twrSeries[i - 1].twr / 100;
        const curr = 1 + twrSeries[i].twr / 100;
        if (prev > 0) {
          const r = curr / prev - 1;
          if (r !== 0) dailyReturns.push(r); // skip fill-forward flat days
        }
      }
      if (dailyReturns.length >= 20) {
        const n = dailyReturns.length;
        const mean = dailyReturns.reduce((s, r) => s + r, 0) / n;
        const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
        const std = Math.sqrt(variance);
        if (std > 0) {
          const sharpe = ((mean - RF_DAILY) / std) * Math.sqrt(252);
          sharpeStr = sharpe.toFixed(2);
          sharpeClass = sharpe >= 1 ? 'positive' : sharpe < 0 ? 'negative' : '';
          // NOTE: intentionally NOT writing to globalData.insightSharpe here.
          // The all-time Sharpe is computed once in renderPerformanceChart from the
          // full unfiltered series. Overwriting it here would corrupt the grade engine
          // with a period-specific value whenever the user changes the chart window.
        }
      }
    } catch(e) { /* leave as — */ }

    // One line, but each figure keeps its own short hover description — the
    // explanation belongs next to the number, not behind a shared popover.
    renderPerfFootline([
      { label: 'Annualised', value: annualisedStr, cls: annualisedStr !== '—' ? annualisedClass : '',
        tip: 'The return over the visible window, scaled to a yearly rate.' },
      { label: 'Max DD', value: ddStr, cls: ddClass,
        tip: 'Max drawdown — the largest peak-to-trough fall inside this window.' },
      { label: 'β', value: betaStr, cls: betaClass,
        tip: 'Beta vs S&P 500 — how much you move when the index moves. Above 1 is more volatile than the market, below 1 more stable.' },
      { label: 'α', value: alphaStr, cls: alphaClass,
        tip: 'Alpha vs S&P 500 — annualised return above what your beta-adjusted index exposure would predict.' },
      { label: 'Sharpe', value: sharpeStr, cls: sharpeClass,
        tip: 'Sharpe ratio — return per unit of risk, annualised. Above 1 is good, above 2 is great.' },
    ]);
    } catch(e) {
      console.warn('[Sharpe] Metric line error:', e);
      renderPerfFootline([]);
    }
  }

  // Bars = absolute cumulative TWR since inception.
  // The period selector zooms the x-axis window only — it does NOT re-zero the y-axis.
  // This preserves the shape of the portfolio trajectory accurately.
  // The header and insight cards show the period-specific gain separately.
  const portValues = isPct
    ? twrSeries.map(d => d.twr)
    : eurSeries.map(d => d.value);
  const barData = portValues;

  // Benchmark lines: absolute % return since inception, anchored to same start date as portfolio
  const enabledBenchmarks = globalData.enabledBenchmarks || ['sp500'];
  const benchmarkDatasets = [];
  for (const bmId of enabledBenchmarks) {
    const cfg = BENCHMARK_CONFIG[bmId];
    if (!cfg) continue;
    const fullData = (globalData.benchmarkFullData || {})[cfg.key] || [];
    if (!fullData.length) continue;
    const baseEntry = fullData.find(d => d.date >= portfolioStart);
    const base = baseEntry ? baseEntry.price : (fullData[0]?.price || 1);
    const priceMap = {};
    fullData.forEach(d => { priceMap[d.date] = d.price; });
    let lastPrice = null;
    const lineData = twrSeries.map(pd => {
      if (priceMap[pd.date]) lastPrice = priceMap[pd.date];
      return lastPrice ? ((lastPrice / base) - 1) * 100 : null;
    });
    if (lineData.some(v => v !== null)) {
      benchmarkDatasets.push({
        type: 'line', label: cfg.label, data: lineData,
        borderColor: cfg.color, backgroundColor: 'transparent', fill: false,
        tension: 0.2, pointRadius: 0, borderWidth: 2, borderDash: cfg.dash
      });
    }
  }

  // No legend row: a checked entry in the Overlays menu already carries its own
  // colour swatch, and a legend naming a single line never earned its 22px.

  // Keep S&P final return log for backward compat
  const spyMap = {};
  fullSpyData.forEach(s => { spyMap[s.date] = s.price; });
  let lastSpyPrice = null;
  twrSeries.forEach(pd => { if (spyMap[pd.date]) lastSpyPrice = spyMap[pd.date]; });
  const spyFinalReturn = lastSpyPrice ? ((lastSpyPrice / spyBase) - 1) * 100 : null;
  dlog(`[CHART] All-time portfolio TWR: ${allTimeTwr.toFixed(1)}% | S&P since ${portfolioStart}: ${spyFinalReturn?.toFixed(1)}% | Period (${periodLabel}): ${periodReturn.toFixed(1)}%`);

  // Draw vertical lines at each trade date using a custom afterDraw plugin.
  // This is more reliable than scatter on a category axis.
  // Each line is color-coded: green = buy, red = sell.
  // A label at the top shows product name(s) + qty.
  let tradePlugin = null;
  if (globalData.showTrades) {
    const transactions = globalData.transactions || [];
    const names       = globalData.names || {};

    // Group transactions by date+direction, collecting product labels.
    // Only include trades within the visible chart window — trades outside
    // the current period would snap to the edges and show misleadingly.
    const chartStartDate = twrSeries[0]?.date || '';
    const chartEndDate   = twrSeries[twrSeries.length - 1]?.date || '';
    const grouped = {};
    transactions.forEach(tx => {
      if (!tx.date) return;
      if (tx.date < chartStartDate || tx.date > chartEndDate) return;
      const key = `${tx.date}_${tx.buysell}`;
      if (!grouped[key]) grouped[key] = { date: tx.date, buysell: tx.buysell, txs: [] };
      const name = names[tx.productId] || `ID ${tx.productId}`;
      const shortName = name.replace(/iShares|UCITS ETF|Acc|EUR|USD/g, '').trim().split(/\s+/).slice(0,3).join(' ');
      const sign = tx.buysell === 'B' ? '▲' : '▼';
      grouped[key].txs.push(`${sign} ${Math.abs(tx.quantity).toFixed(0)}× ${shortName}`);
    });

    // Map each grouped event to the nearest twrSeries index
    const rawEvents = Object.values(grouped).map(g => {
      let bestIdx = -1;
      for (let i = 0; i < twrSeries.length; i++) {
        if (twrSeries[i].date <= g.date) bestIdx = i;
        else break;
      }
      if (bestIdx === -1) bestIdx = 0;
      return { idx: bestIdx, buysell: g.buysell, lines: g.txs, date: g.date };
    });

    // Merge all events at the same idx into one combined popup (prevents text overlap
    // when a buy and sell land on the same day / same chart position)
    const byIdx = {};
    rawEvents.forEach(ev => {
      if (!byIdx[ev.idx]) byIdx[ev.idx] = { idx: ev.idx, entries: [] };
      byIdx[ev.idx].entries.push({ buysell: ev.buysell, lines: ev.lines, date: ev.date });
    });
    // tradeEvents: one entry per unique x-position, with all lines for that day
    const tradeEvents = Object.values(byIdx);

    tradePlugin = {
      id: 'tradeLines',
      _hoverX: null,
      afterEvent(chart, args) {
        const e = args.event;
        if (e.type === 'mousemove') {
          this._hoverX = e.x;
          chart.draw();
        } else if (e.type === 'mouseout') {
          this._hoverX = null;
          chart.draw();
        }
      },
      afterDraw(chart) {
        const ctx2 = chart.ctx;
        const xAxis = chart.scales.x;
        const yAxis = chart.scales.y;
        const top = yAxis.top;
        const bottom = yAxis.bottom;
        const hoverX = this._hoverX;
        const HOVER_RADIUS = 30; // px — detection zone per line

        // Find the single closest event to the cursor (prevents multi-popup overlap)
        let closestEv = null, closestDist = Infinity;
        if (hoverX !== null) {
          tradeEvents.forEach(ev => {
            const xPixel = xAxis.getPixelForValue(ev.idx);
            if (xPixel === undefined || isNaN(xPixel)) return;
            const dist = Math.abs(hoverX - xPixel);
            if (dist <= HOVER_RADIUS && dist < closestDist) {
              closestDist = dist;
              closestEv = ev;
            }
          });
        }

        tradeEvents.forEach(ev => {
          const xPixel = xAxis.getPixelForValue(ev.idx);
          if (xPixel === undefined || isNaN(xPixel)) return;

          const isHovered = ev === closestEv;

          // Dominant colour: yellow for mixed buy+sell day, green/red otherwise
          const hasBuy  = ev.entries.some(e => e.buysell === 'B');
          const hasSell = ev.entries.some(e => e.buysell === 'S');
          const lineColor = hasBuy && hasSell ? '#ffd60a' : hasBuy ? THEME_COLORS.plGreen : THEME_COLORS.plRed;

          ctx2.save();

          // Vertical dashed line — always visible
          ctx2.beginPath();
          ctx2.setLineDash([3, 3]);
          ctx2.strokeStyle = isHovered ? lineColor + 'ff' : lineColor + '99';
          ctx2.lineWidth = isHovered ? 2 : 1.5;
          ctx2.moveTo(xPixel, top);
          ctx2.lineTo(xPixel, bottom);
          ctx2.stroke();

          // Circle at top — always visible
          ctx2.beginPath();
          ctx2.setLineDash([]);
          ctx2.arc(xPixel, top + 6, isHovered ? 5 : 4, 0, Math.PI * 2);
          ctx2.fillStyle = lineColor;
          ctx2.fill();

          // Popup — only for the single nearest hovered event
          if (isHovered) {
            ctx2.save();
            ctx2.font = '10px DM Mono, monospace';

            // Flatten all entries into coloured lines with separators between groups
            const popupLines = [];
            ev.entries.forEach((entry, ei) => {
              if (ei > 0) popupLines.push({ text: '─────────────', color: THEME_COLORS.annotationLine });
              entry.lines.forEach(l => {
                popupLines.push({ text: l, color: l.startsWith('▲') ? THEME_COLORS.plGreen : THEME_COLORS.plRed });
              });
            });

            const lineH = 15;
            const padX = 8, padY = 6;
            const maxW = Math.max(...popupLines.map(l => ctx2.measureText(l.text).width));
            const boxW = maxW + padX * 2;
            const boxH = popupLines.length * lineH + padY * 2;

            // Position right of line, flip left if near right edge
            const chartRight = xAxis.right;
            const boxX = (xPixel + 16 + boxW < chartRight) ? xPixel + 16 : xPixel - 16 - boxW;
            const boxY = top + 10;

            // Background pill
            ctx2.fillStyle = THEME_COLORS.annotationBg;
            ctx2.strokeStyle = lineColor + 'aa';
            ctx2.lineWidth = 1;
            ctx2.setLineDash([]);
            ctx2.beginPath();
            ctx2.roundRect(boxX, boxY, boxW, boxH, 5);
            ctx2.fill();
            ctx2.stroke();

            // Text lines
            popupLines.forEach((line, i) => {
              ctx2.fillStyle = line.color;
              ctx2.fillText(line.text, boxX + padX, boxY + padY + (i + 1) * lineH - 3);
            });

            ctx2.restore();
          }

          ctx2.restore();
        });
      }
    };
  }

  if (charts.performance) charts.performance.destroy();
  charts.performance = new Chart(document.getElementById('performanceChart'), {
    type: isPct ? 'bar' : 'line',
    data: {
      labels: displaySeries.map(d => fmtDate(d.date)),
      datasets: [
        isPct ? {
          type: 'bar',
          label: 'My Portfolio',
          data: barData,
          backgroundColor: barData.map(v => v >= 0 ? THEME_COLORS.plGreenAlpha(0.2) : THEME_COLORS.plRedAlpha(0.2)),
          borderColor: barData.map(v => v >= 0 ? THEME_COLORS.plGreenAlpha(0.6) : THEME_COLORS.plRedAlpha(0.6)),
          borderWidth: 0,
          borderRadius: 0,
          barPercentage: 1.0,
          categoryPercentage: 1.0,
        } : {
          type: 'line',
          label: 'My Portfolio',
          data: barData,
          borderColor: THEME_COLORS.plGreen,
          backgroundColor: THEME_COLORS.plGreenAlpha(0.08),
          fill: true,
          tension: 0.2,
          pointRadius: 0,
          borderWidth: 2,
        },
        ...(isPct ? benchmarkDatasets : [])
      ]
    },
    plugins: [tradePlugin].filter(Boolean),
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { right: 2 } },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { filter: () => !dragZoomState.active, ...THEME_COLORS.themeTooltip(),
          callbacks: {
            title: ctx => {
              if (!ctx || !ctx.length) return '';
              const idx = ctx[0].dataIndex;
              const rawDate = isPct ? twrSeries[idx]?.date : eurSeries[idx]?.date;
              if (rawDate) {
                const [y,m,dd2] = rawDate.split('-');
                return new Date(y,m-1,dd2).toLocaleDateString('default',{day:'numeric',month:'short',year:'numeric'});
              }
              return ctx[0].label;
            },
            label: ctx => isPct
              ? ' '+(ctx.parsed.y>=0?'+':'')+ctx.parsed.y.toFixed(1)+'% — '+ctx.dataset.label
              : ' '+fmtEur(ctx.parsed.y)+' — '+ctx.dataset.label
          } }
      },
      scales: {
        x: { offset: true, grid: { color: THEME_COLORS.gridColor }, ticks: { color: THEME_COLORS.tickColor, font: { size: 10 }, maxTicksLimit: 12 } },
        y: {
          grid: { color: THEME_COLORS.gridColor },
          ticks: { color: THEME_COLORS.tickColor, font: { size: 10 },
            callback: isPct ? v => (v>=0?'+':'')+v.toFixed(0)+'%' : v => '€'+Math.round(v/1000)+'k' },
          // Y-axis scaling: anchor to 0 for long periods; auto-scale for short periods
          ...(isPct ? (() => {
            const selPeriod = document.getElementById('periodSelect').value;
            const longPeriods = new Set(['ALL', '5Y', '3Y']);
            const validData = barData.filter(v => v != null);
            const dataMin = Math.min(...validData);
            const dataMax = Math.max(...validData);
            const range = dataMax - dataMin;
            const padding = Math.max(range * 0.1, 2);
            if (longPeriods.has(selPeriod)) {
              return { min: Math.min(0, Math.floor(dataMin / 5) * 5 - 5) };
            } else {
              return { min: Math.floor((dataMin - padding) / 5) * 5 };
            }
          })() : {})
        }
      }
    }
  });
  globalData.perfChart = charts.performance;
  initDragZoom(document.getElementById('performanceChart'));
}

function fetchHistoriesForPeriod(vwdIds, period) {
  // Reuse the 5Y price history already fetched by renderPerformanceChart.
  // Slicing client-side avoids extra VWD fetches which use inconsistent period
  // format strings (P6M, 1Y) and can fail silently or return wrong ranges.
  const full = globalData.priceHistories5Y || {};
  if (!Object.keys(full).length) {
    // 5Y data not ready yet — fall back to a real fetch
    return chrome.runtime.sendMessage({ type: 'FETCH_PRICE_HISTORY', vwdIds, period });
  }

  if (!['1W', '1M', '6M', 'YTD', '1Y', '2Y', '3Y', '5Y'].includes(period)) return Promise.resolve(full); // unknown period — return everything

  // Find the last date across all histories (latest market close)
  let lastDate = '';
  Object.values(full).forEach(h => {
    if (h.length) {
      const d = h[h.length - 1].date;
      if (d > lastDate) lastDate = d;
    }
  });
  const cutoff = lastDate ? periodCutoffFromRefDate(lastDate, period) : '';

  const sliced = {};
  Object.entries(full).forEach(([id, h]) => {
    const s = cutoff ? h.filter(d => d.date >= cutoff) : h;
    if (s.length) sliced[id] = s;
  });
  return Promise.resolve(sliced);
}

/**
 * Movers, as chips in the Positions card header. They were six stacked tiles on
 * a card ~567px above the table, and clicking one only ever scrolled you down to
 * the row and expanded it — which is exactly what the chips still do. The window
 * is fixed at MOVERS_PERIOD: "what moved lately" is not the chart's window.
 */
function renderMovers(positions, histories, period) {
  const el = document.getElementById('moversChips');
  if (!el) return;
  el.classList.remove('skeleton');
  el.textContent = '';

  // Use the last date present in the price data as the reference point —
  // this ensures the period window ends at the latest market close, not "today"
  // (which may be a weekend or pre-market and have no price data yet).
  const allDates = positions
    .filter(p => histories[p.id]?.length)
    .flatMap(p => histories[p.id].map(d => d.date));
  const lastDataDate = allDates.length ? [...allDates].sort().pop() : new Date().toISOString().slice(0,10);

  const cutoff = periodCutoffFromRefDate(lastDataDate, period);

  const all = positions
    .filter(p => p.value > 0 && histories[p.id]?.length >= 2)
    .map(p => {
      const h = histories[p.id].filter(d => d.date >= cutoff);
      if (h.length < 2) return null;
      const latest = h[h.length - 1].price;
      const oldest = h[0].price;
      const pct = ((latest - oldest) / oldest) * 100;
      return { ...p, pct };
    })
    .filter(p => p && isFinite(p.pct))
    .sort((a, b) => b.pct - a.pct);

  // Up to 3 gainers and 3 losers, best first then worst first. When one side is
  // short the other fills in, so the row is always as informative as the data allows.
  const gainers = all.filter(p => p.pct >= 0);
  const losers  = all.filter(p => p.pct <  0).reverse(); // worst first
  let topUp, topDown;
  if (gainers.length >= 3 && losers.length >= 3) {
    topUp = gainers.slice(0, 3); topDown = losers.slice(0, 3);
  } else if (gainers.length < 3) {
    topUp = gainers.slice(0, 3);
    topDown = losers.slice(0, 6 - topUp.length);
  } else {
    topDown = losers.slice(0, 3);
    topUp = gainers.slice(0, 6 - topDown.length);
  }
  const movers = [...topUp, ...topDown];
  if (!movers.length) return;

  const label = document.createElement('span');
  label.className = 'movers-chips-label';
  label.textContent = period + ' movers';
  el.appendChild(label);

  movers.forEach(p => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'mover-chip';
    // Direction is carried by the signed, coloured number alone — the old tiles
    // said it three times (arrow, colour, sign).
    const name = p.name || 'ID ' + p.id;
    chip.title = name + ' \u00b7 ' + period + ' price return';
    chip.appendChild(document.createTextNode(name.length > 16 ? name.slice(0, 15) + '\u2026' : name));
    const pct = document.createElement('b');
    pct.className = p.pct >= 0 ? 'positive' : 'negative';
    pct.textContent = ' ' + (p.pct >= 0 ? '+' : '') + p.pct.toFixed(1) + '%';
    chip.appendChild(pct);
    chip.addEventListener('click', () => {
      const row = document.querySelector(`#positionsBody tr[data-position-id="${p.id}"]`);
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      expandPositionRow(p.id, false, { scroll: false });
    });
    el.appendChild(chip);
  });
}


/**
 * The "Daily" mode of the Performance card: one bar per trading day, with S&P 500
 * lollipops when that overlay is on. This used to be a second chart on its own
 * card ("Recent Activity") with its own period control that never synced with
 * the one above it.
 */
function drawDailyPerf(positions, histories, period, { draw = true } = {}) {
  const canvas = document.getElementById('performanceChart');
  if (!canvas) return;
  if (draw) {
    globalData._lastDailyArgs = [positions, histories, period];
    if (charts.performance) { charts.performance.destroy(); charts.performance = null; }
  }

  // Only positions that have at least 2 price data points in the supplied histories
  const activePosns = positions.filter(p => p.value > 0 && histories[p.id]?.length >= 2);
  if (!activePosns.length) return;

  // ── Build price maps (id -> date -> price) ────────────────────────────────
  const priceMap = {}; // id -> { date -> price }
  activePosns.forEach(p => {
    const m = {};
    histories[p.id].forEach(d => { m[d.date] = d.price; });
    priceMap[p.id] = m;
  });

  // Sorted union of all dates that appear in price data
  const allDates = [...new Set(
    activePosns.flatMap(p => Object.keys(priceMap[p.id]))
  )].sort();

  if (allDates.length < 2) return;

  // Share count per position on each date, replayed from the transaction log
  // (see buildHoldingSnapshots in utils.js for why today's sizes can't be used).
  const txSnapshots = buildHoldingSnapshots(globalData.transactions);

  // Fallback to today's sizes when no transaction history is available
  const todaySizes = {};
  activePosns.forEach(p => { todaySizes[String(p.id)] = p.size; });

  const getHoldings = txSnapshots.length
    ? (date) => holdingsAsOf(txSnapshots, date)
    : () => todaySizes;

  // ── Compute daily portfolio % change for each trading day ─────────────────
  //
  // daily % = (portfolioValue(today) − portfolioValue(yesterday)) / portfolioValue(yesterday) × 100
  // Both values are converted to EUR using the static FX rate derived from
  // current positions (same approach as the main perf chart).

  // Build FX rate map: native currency → EUR conversion factor per position
  const fxRates = {};
  activePosns.forEach(p => {
    if (p.price > 0 && p.size !== 0) {
      fxRates[String(p.id)] = p.value / (p.price * p.size);
    }
  });

  // Pre-seed lastKnown prices from the full 5Y history so the first bar
  // in short periods (1W, 1M) doesn't suffer from missing positions.
  // Without this, positions whose first price in the sliced window is on
  // day 2+ would be excluded from day 1's valuation, causing a fake jump.
  const lastKnown = {};
  if (allDates.length > 0) {
    const firstDate = allDates[0];
    const full5Y = globalData.priceHistories5Y || {};
    activePosns.forEach(p => {
      const h = full5Y[p.id];
      if (!h || !h.length) return;
      // Binary search for the last price on or before firstDate
      let lo = 0, hi = h.length - 1, best = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (h[mid].date <= firstDate) { best = h[mid]; lo = mid + 1; }
        else hi = mid - 1;
      }
      if (best) lastKnown[String(p.id)] = best.price;
    });
  }

  // Portfolio value in EUR on a given date
  const portfolioValueOnDate = (date, holdings) => {
    let total = 0;
    let anyPriced = false;
    for (const [id, shares] of Object.entries(holdings)) {
      if (shares <= 0) continue;
      const fx = fxRates[id] || 1;
      const price = priceMap[id]?.[date];
      if (price) {
        lastKnown[id] = price;
        total += price * shares * fx;
        anyPriced = true;
      } else if (lastKnown[id]) {
        total += lastKnown[id] * shares * fx;
        anyPriced = true;
      }
    }
    return anyPriced ? total : null;
  };

  const barDates = [];
  const dailyChangePct = [];

  // Today's date (local) — used to detect whether the last bar is today
  const localToday = (() => {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  })();

  // Scraped today P&L from DEGIRO's own DOM — the only reliable intraday figure.
  const scrapedTodayPL    = globalData._todayPL;
  const scrapedPortValue  = globalData._scrapedPortfolioValue;
  const scrapedTodayPct   = (scrapedTodayPL != null && scrapedPortValue != null && scrapedPortValue > 0)
    ? (scrapedTodayPL / (scrapedPortValue - scrapedTodayPL)) * 100
    : null;

  for (let i = 1; i < allDates.length; i++) {
    const today = allDates[i];
    const yest  = allDates[i - 1];

    // For today's bar: use the scraped DEGIRO figure when available.
    if (today === localToday && scrapedTodayPct != null) {
      barDates.push(today);
      dailyChangePct.push(scrapedTodayPct);
      continue;
    }

    // Use yesterday's holdings for both values — captures the return from price
    // movement only, not from new cash added via buys/sells on this day.
    const holdings = getHoldings(yest);
    const valToday = portfolioValueOnDate(today, holdings);
    const valYest  = portfolioValueOnDate(yest, holdings);

    if (valToday != null && valYest != null && valYest > 0) {
      barDates.push(today);
      dailyChangePct.push((valToday - valYest) / valYest * 100);
    }
  }

  if (barDates.length < 1) return;

  // The Today tab and the watchlist comparison read this series, and they want a
  // stable ~1-month window regardless of what the chart is currently showing —
  // so only the canonical baseline pass writes it.
  if (!draw || period === MOVERS_PERIOD) {
    globalData.recentPerfDates = barDates;
    globalData.recentPerfChanges = dailyChangePct;
  }
  if (!draw) return;

  // ── S&P 500 daily % changes for the same dates ────────────────────────
  let spDailyChangePct = [];
  let hasSp = false;
  let spCompoundPct = null;
  const spColor = BENCHMARK_CONFIG.sp500.color; // the S&P's own data colour
  const wantSp = spOverlayOn();

  if (wantSp) {
    const spData = globalData.benchmarkFullData?.['__SP500__'] || [];
    if (!spData.length && !globalData._spBenchmarkRetried) {
      // Benchmark series missing (e.g. a transient VWD failure that got cached) —
      // fetch benchmarks alone once and re-render when they arrive. An empty
      // vwdIds map is valid: the background appends benchmarks to every response.
      globalData._spBenchmarkRetried = true;
      chrome.runtime.sendMessage({ type: 'FETCH_PRICE_HISTORY', vwdIds: {}, period: '5Y' }).then(resp => {
        if (resp?.['__SP500__']?.length) {
          globalData.benchmarkFullData = { ...(globalData.benchmarkFullData || {}), ...resp };
          if (perfMode() === 'daily') redrawPerf();
        }
      }).catch(() => {});
    }
    const spSorted = spData.slice().sort((a, b) => a.date.localeCompare(b.date));
    const spDates = spSorted.map(d => d.date);

    spDailyChangePct = barDates.map(date => {
      let lo = 0, hi = spDates.length - 1, today = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (spDates[mid] <= date) { today = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      if (today < 1) return null;
      const pToday = spSorted[today].price;
      const pYest = spSorted[today - 1].price;
      if (pToday > 0 && pYest > 0) return (pToday - pYest) / pYest * 100;
      return null;
    });
    hasSp = spDailyChangePct.some(v => v != null);
    if (hasSp) {
      const spCompoundReturn = spDailyChangePct.reduce((acc, r) => acc * (1 + (r || 0) / 100), 1);
      spCompoundPct = (spCompoundReturn - 1) * 100;
    }
  }

  const fmtDate = d => {
    const [y, m, dd] = d.split('-');
    return new Date(y, m - 1, dd).toLocaleDateString('default', { day: 'numeric', month: 'short' });
  };

  // Compound return over the window
  const compoundReturn = dailyChangePct.reduce((acc, r) => acc * (1 + r / 100), 1);
  const compoundPct = (compoundReturn - 1) * 100;

  // ── Subtitle + footer line ───────────────────────────────────────────────
  // The "You +x% / S&P +x%" badges that used to float over the second chart are
  // this line; the up/down day split replaces the subtitle that restated the title.
  const upDays = dailyChangePct.filter(v => v > 0).length;
  const downDays = dailyChangePct.filter(v => v < 0).length;
  const subtitleEl = document.getElementById('perfSubtitle');
  if (subtitleEl) {
    subtitleEl.textContent = `${compoundPct >= 0 ? '+' : ''}${compoundPct.toFixed(2)}% over ${period} · ${upDays} up days, ${downDays} down`;
    subtitleEl.className = 'card-subtitle ' + (compoundPct >= 0 ? 'positive' : 'negative');
  }

  const best = dailyChangePct.length ? Math.max(...dailyChangePct) : null;
  const worst = dailyChangePct.length ? Math.min(...dailyChangePct) : null;
  const sgn = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  const footItems = [
    { label: 'You', value: sgn(compoundPct), cls: compoundPct >= 0 ? 'positive' : 'negative',
      tip: 'Your daily changes compounded over this window. Buys and sells are excluded \u2014 only price movement counts.' },
  ];
  if (hasSp && spCompoundPct != null) {
    footItems.push({ label: 'S&P 500', value: sgn(spCompoundPct), cls: '',
      tip: 'The index over exactly the same trading days, compounded the same way.' });
    const delta = compoundPct - spCompoundPct;
    footItems.push({ label: '\u0394', value: (delta >= 0 ? '+' : '') + delta.toFixed(2) + 'pp', cls: delta >= 0 ? 'positive' : 'negative',
      tip: 'Your return minus the index, in percentage points.' });
  }
  if (best != null)  footItems.push({ label: 'Best day',  value: sgn(best),  cls: best >= 0 ? 'positive' : 'negative',
    tip: 'The strongest single day in this window.' });
  if (worst != null) footItems.push({ label: 'Worst',     value: sgn(worst), cls: worst >= 0 ? 'positive' : 'negative',
    tip: 'The weakest single day in this window.' });
  renderPerfFootline(
    footItems,
    (!hasSp && wantSp) ? 'S&P 500 data unavailable \u2014 retrying on next sync' : null
  );

  // Build datasets — portfolio bars + hidden S&P scatter for tooltip
  const datasets = [{
    label: 'Portfolio',
    data: dailyChangePct,
    backgroundColor: dailyChangePct.map(v => v >= 0 ? THEME_COLORS.plGreenAlpha(0.33) : THEME_COLORS.plRedAlpha(0.33)),
    borderColor:     dailyChangePct.map(v => v >= 0 ? THEME_COLORS.plGreen : THEME_COLORS.plRed),
    borderWidth: 1,
    borderRadius: 2,
    barPercentage: 0.8,
    categoryPercentage: 0.85,
  }];

  // Hidden dataset so S&P values appear in the tooltip
  if (hasSp) {
    datasets.push({
      label: 'S&P 500',
      data: spDailyChangePct,
      type: 'bar',
      hidden: true,
    });
  }

  // Lollipop plugin — draws stem + circle for each S&P data point
  const lollipopPlugin = {
    id: 'spLollipop',
    afterDatasetsDraw(chart) {
      if (!hasSp) return;
      const ctx2 = chart.ctx;
      const yScale = chart.scales.y;
      const xScale = chart.scales.x;
      const zeroY = yScale.getPixelForValue(0);
      const n = spDailyChangePct.filter(v => v != null).length;
      // Scale down for crowded timeframes
      const opacity = n > 120 ? 0.25 : n > 60 ? 0.4 : n > 30 ? 0.6 : 1;
      const radius = n > 120 ? 1.5 : n > 60 ? 2 : n > 30 ? 2.5 : 3.5;
      const stemW = n > 60 ? 0.75 : n > 30 ? 1 : 1.5;
      const opHex = Math.round(opacity * 255).toString(16).padStart(2, '0');
      ctx2.save();
      ctx2.globalAlpha = opacity;
      for (let i = 0; i < spDailyChangePct.length; i++) {
        const val = spDailyChangePct[i];
        if (val == null) continue;
        const x = xScale.getPixelForValue(i);
        const y = yScale.getPixelForValue(val);
        // Stem
        ctx2.beginPath();
        ctx2.strokeStyle = spColor + '88';
        ctx2.lineWidth = stemW;
        ctx2.moveTo(x, zeroY);
        ctx2.lineTo(x, y);
        ctx2.stroke();
        // Circle
        ctx2.beginPath();
        ctx2.arc(x, y, radius, 0, Math.PI * 2);
        ctx2.fillStyle = spColor;
        ctx2.fill();
      }
      ctx2.restore();
    }
  };

  charts.performance = new Chart(canvas, {
    type: 'bar',
    plugins: [lollipopPlugin],
    data: {
      labels: barDates.map(fmtDate),
      datasets
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          ...THEME_COLORS.themeTooltip(),
          filter: item => !item.dataset.hidden,
          callbacks: {
            label: ctx => {
              const v = ctx.parsed.y;
              if (v == null) return '';
              return ' Portfolio: ' + (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
            },
            afterBody: hasSp ? (items) => {
              const idx = items[0]?.dataIndex;
              if (idx == null) return '';
              const sp = spDailyChangePct[idx];
              if (sp == null) return '';
              const lines = [' S&P 500: ' + (sp >= 0 ? '+' : '') + sp.toFixed(2) + '%'];
              const port = dailyChangePct[idx];
              if (port != null) {
                const d = port - sp;
                lines.push(' Δ vs S&P: ' + (d >= 0 ? '+' : '') + d.toFixed(2) + '%');
              }
              return lines;
            } : undefined
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: THEME_COLORS.tickColor, font: { size: 10 }, maxTicksLimit: 12 } },
        y: { grid: { color: THEME_COLORS.gridColor }, ticks: { color: THEME_COLORS.tickColor, font: { size: 10 }, callback: v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%' } }
      }
    }
  });
}


function parseVwdSeries(json) {
  // VWD format: {start: "YYYY-MM-DDT...", series: [{times: "start/P1D", data: [[dayOffset, price], ...]}]}
  try {
    const series = json.series || [];
    const priceSeries = series.find(s => s.data);
    if (!priceSeries?.data) return [];
    const startDate = new Date(json.start);
    return priceSeries.data.map(([offset, price]) => {
      const d = new Date(startDate);
      d.setDate(d.getDate() + offset);
      const yyyy = d.getFullYear();
      const mm   = String(d.getMonth() + 1).padStart(2, '0');
      const dd   = String(d.getDate()).padStart(2, '0');
      return { date: `${yyyy}-${mm}-${dd}`, price };
    }).filter(d => d.price != null);
  } catch(e) { console.warn('parseVwdSeries error:', e); return []; }
}

// inferGeo(position) and inferAssetClass(position) are defined in utils.js

function renderAllocationChart(positions) {
  if (!positions.length) return;

  // Inject toggle buttons if not already present
  const cardHeader = document.querySelector('#allocationChart')?.closest('.card')?.querySelector('.card-header');
  if (cardHeader && !cardHeader.querySelector('.alloc-toggle')) {
    const toggles = document.createElement('div');
    toggles.className = 'alloc-toggle';
    [['position','Holdings'],['currency','Currency'],['geography','Geography'],['assetclass','Asset Class']].forEach(([m, label], i) => {
      const btn = document.createElement('button');
      btn.className = 'toggle-btn' + (i === 0 ? ' active' : '');
      btn.dataset.mode = m;
      btn.textContent = label;
      toggles.appendChild(btn);
    });
    cardHeader.appendChild(toggles);
    toggles.addEventListener('click', e => {
      const btn = e.target.closest('.toggle-btn');
      if (!btn) return;
      toggles.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      // Read from globalData so the handler survives refreshes with fresh positions
      drawAllocationChart(globalData.positions || positions, btn.dataset.mode);
    });
  }

  drawAllocationChart(positions, 'position');
}

const ALLOC_HOLDINGS_CAP = 12; // matches COLORS.length — no color reuse

function drawAllocationChart(positions, mode) {
  positions = positions.filter(p => p.value > 0);
  globalData._allocMode = mode;
  globalData._allocDrill = null;

  // Build groups: [{label, value, color, drillable}]
  let entries;
  if (mode === 'position') {
    const sorted = [...positions].sort((a, b) => b.value - a.value);
    const top = sorted.slice(0, ALLOC_HOLDINGS_CAP);
    entries = top.map((p, i) => ({ label: p.name || 'ID ' + p.id, value: p.value, color: COLORS[i % COLORS.length], drillable: false }));
    const rest = sorted.slice(ALLOC_HOLDINGS_CAP);
    if (rest.length) {
      entries.push({ label: `Others (${rest.length})`, value: rest.reduce((s, p) => s + p.value, 0), color: null, drillable: false });
    }
  } else {
    const map = {};
    positions.forEach(p => {
      const k = mode === 'currency' ? p.currency : mode === 'geography' ? inferGeo(p) : inferAssetClass(p);
      map[k] = (map[k] || 0) + p.value;
    });
    if (mode === 'assetclass') {
      // Add cash from FLATEX_EUR and EUR rows — has no member holdings, so not drillable
      const cashValue = globalData._cashValue || 0;
      if (cashValue > 0) map['Cash'] = (map['Cash'] || 0) + cashValue;
    }
    const sorted = Object.entries(map).sort((a, b) => b[1] - a[1]);
    entries = sorted.map(([k, v], i) => ({ label: k, value: v, color: COLORS[i % COLORS.length], drillable: k !== 'Cash' }));
  }

  const grand = entries.reduce((s, e) => s + e.value, 0);
  renderAllocRows(entries, { stackTotal: grand, pctTotal: grand, mode, drill: null });
  renderAllocCallout(positions);
}

/** Drill into one currency/geography/asset-class group: list its member holdings. */
function drawAllocDrill(mode, group) {
  const positions = (globalData.positions || []).filter(p => p.value > 0);
  const members = positions.filter(p => {
    if (mode === 'currency') return p.currency === group;
    if (mode === 'geography') return inferGeo(p) === group;
    return inferAssetClass(p) === group;
  }).sort((a, b) => b.value - a.value);
  if (!members.length) return;

  globalData._allocDrill = group;
  const totalAll = positions.reduce((s, p) => s + p.value, 0);
  const groupTotal = members.reduce((s, p) => s + p.value, 0);
  const entries = members.map(p => ({ label: p.name || 'ID ' + p.id, value: p.value, color: positionColor(p.id), drillable: false }));
  renderAllocRows(entries, {
    stackTotal: groupTotal,  // stack bar shows the group's own composition
    pctTotal: totalAll,      // row percentages stay relative to the whole portfolio
    mode,
    drill: group,
    drillTitle: `${group} · ${(totalAll > 0 ? groupTotal / totalAll * 100 : 0).toFixed(1)}% of portfolio`,
  });
}

function renderAllocRows(entries, ctx) {
  const stack = document.getElementById('allocStackBar');
  const rows = document.getElementById('allocationLegend');
  const drillHead = document.getElementById('allocDrillHead');
  if (!stack || !rows || !drillHead) return;

  // Segmented 100% bar
  stack.textContent = '';
  entries.forEach(e => {
    const seg = document.createElement('span');
    seg.className = 'alloc-seg';
    seg.style.width = (ctx.stackTotal > 0 ? e.value / ctx.stackTotal * 100 : 0) + '%';
    seg.style.background = e.color || 'var(--dim)';
    seg.title = `${e.label} · ${(ctx.stackTotal > 0 ? e.value / ctx.stackTotal * 100 : 0).toFixed(1)}%`;
    stack.appendChild(seg);
  });

  // Drill-down header with back button
  drillHead.textContent = '';
  if (ctx.drill) {
    drillHead.style.display = 'flex';
    const back = document.createElement('button');
    back.className = 'btn btn--sm alloc-back';
    back.textContent = '← Back';
    back.addEventListener('click', () => drawAllocationChart(globalData.positions || [], ctx.mode));
    const title = document.createElement('span');
    title.className = 'alloc-drill-title';
    title.textContent = ctx.drillTitle || ctx.drill;
    drillHead.append(back, title);
  } else {
    drillHead.style.display = 'none';
  }

  // Ranked rows with proportional bars — no clipping, all groups visible
  rows.textContent = '';
  const maxVal = entries.reduce((m, e) => Math.max(m, e.value), 0);
  entries.forEach(e => {
    const row = document.createElement('div');
    row.className = 'alloc-row' + (e.drillable ? ' alloc-row--drillable' : '');
    const dot = document.createElement('span'); dot.className = 'legend-dot'; dot.style.background = e.color || 'var(--dim)';
    const name = document.createElement('span'); name.className = 'alloc-row-name'; name.textContent = e.label;
    if (e.drillable) name.title = 'Show holdings in ' + e.label;
    const barWrap = document.createElement('span'); barWrap.className = 'alloc-row-bar-wrap';
    const bar = document.createElement('span'); bar.className = 'alloc-row-bar';
    bar.style.width = (maxVal > 0 ? e.value / maxVal * 100 : 0) + '%';
    bar.style.background = e.color || 'var(--dim)';
    barWrap.appendChild(bar);
    const pct = document.createElement('span'); pct.className = 'alloc-row-pct'; pct.textContent = (ctx.pctTotal > 0 ? e.value / ctx.pctTotal * 100 : 0).toFixed(1) + '%';
    const chev = document.createElement('span'); chev.className = 'alloc-row-chev'; chev.textContent = e.drillable ? '›' : '';
    row.append(dot, name, barWrap, pct, chev);
    if (e.drillable) row.addEventListener('click', () => drawAllocDrill(ctx.mode, e.label));
    rows.appendChild(row);
  });
}

/** Concentration callout — shown when the top-3 holdings exceed 50% of invested value. */
function renderAllocCallout(positions) {
  const el = document.getElementById('allocCallout');
  if (!el) return;
  const total = positions.reduce((s, p) => s + p.value, 0);
  const top3 = [...positions].sort((a, b) => b.value - a.value).slice(0, 3);
  const w = total > 0 ? top3.reduce((s, p) => s + p.value, 0) / total * 100 : 0;
  if (positions.length >= 3 && w > 50) {
    el.style.display = '';
    el.textContent = `⚠ Top 3 holdings are ${w.toFixed(1)}% of your portfolio — review how correlated they are ↗`;
    if (!el.dataset.wired) {
      el.dataset.wired = '1';
      el.addEventListener('click', () => navigateToCard('insights', 'correlationCard'));
    }
  } else {
    el.style.display = 'none';
  }
}



// Renders the monthly dividend bar chart from a pre-bucketed, zero-filled
// {YYYY-MM: eur} map (see computeDividendStats).
function renderDividendChart(byMonth) {
  const canvas = document.getElementById('dividendChart');
  if (!canvas) return;
  const months = Object.keys(byMonth).sort();
  if (!months.length) return;
  if (charts.dividend) charts.dividend.destroy();
  charts.dividend = new Chart(canvas, {
    type: 'bar',
    data: { labels: months.map(fmtMonth), datasets: [{ data: months.map(m => byMonth[m]), backgroundColor: THEME_COLORS.plGreenAlpha(0.2), borderColor: THEME_COLORS.plGreen, borderWidth: 1, borderRadius: 3 }] },
    options: miniChartOptions(v => fmtPrice(v) + ' €')
  });
}

// Annualised volatility for a single position (std dev of daily log returns × √252)
function computePositionVolatility(positionId) {
  const hist = (globalData.priceHistories5Y || {})[positionId];
  if (!hist || hist.length < 20) return null;
  const returns = [];
  for (let i = 1; i < hist.length; i++) {
    if (hist[i].price > 0 && hist[i - 1].price > 0) {
      returns.push(Math.log(hist[i].price / hist[i - 1].price));
    }
  }
  if (returns.length < 10) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100; // annualised %
}

// ── Positions table helpers ────────────────────────────────────────────────

function hashId(id) {
  const s = String(id);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

// Stable per-position color (unlike row-index colors, survives re-sorting)
function positionColor(id) {
  return COLORS[hashId(id) % COLORS.length];
}

function positionMonogram(name) {
  const words = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return String(words[0] || '?').slice(0, 2).toUpperCase();
}

// 30-day price slice from the already-fetched 5Y histories. Null when the
// position has no market data yet (same gap as the volatility metric).
function compute30d(positionId) {
  const hist = (globalData.priceHistories5Y || {})[positionId];
  if (!hist || hist.length < 2) return null;
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const slice = hist.filter(d => d.date >= cutoff && d.price > 0);
  if (slice.length < 2) return null;
  const pct = (slice[slice.length - 1].price / slice[0].price - 1) * 100;
  return { pct, series: slice.map(d => d.price) };
}

// Inline SVG sparkline — deliberately not Chart.js: dozens of canvas charts
// rebuilt on every sort/filter/refresh would be far too heavy.
function sparklineSVG(series, pct, w = 72, h = 22) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.classList.add('pos-spark');
  const min = Math.min(...series), max = Math.max(...series);
  const span = max - min || 1;
  const pad = 2;
  const step = (w - pad * 2) / (series.length - 1);
  const pts = series.map((v, i) =>
    `${(pad + i * step).toFixed(1)},${(h - pad - ((v - min) / span) * (h - pad * 2)).toFixed(1)}`
  ).join(' ');
  const line = document.createElementNS(NS, 'polyline');
  line.setAttribute('points', pts);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', pct >= 0 ? THEME_COLORS.plGreen : THEME_COLORS.plRed);
  line.setAttribute('stroke-width', '1.5');
  line.setAttribute('stroke-linecap', 'round');
  line.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(line);
  return svg;
}

// Quick-filter over both tables. The input element is the source of truth so
// the filter survives full re-renders (renderAll replaces globalData).
function currentPositionsFilter() {
  return (document.getElementById('positionsFilter')?.value || '').trim().toLowerCase();
}

function wirePositionsFilter() {
  const input = document.getElementById('positionsFilter');
  if (!input || input.dataset.wired) return;
  input.dataset.wired = '1';
  input.addEventListener('input', () => {
    renderPositionsTable(globalData.positions || []);
    if (globalData.closedPositions) renderClosedPositionsTable(globalData.closedPositions);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      input.value = '';
      input.dispatchEvent(new Event('input'));
      input.blur();
    }
  });
  // "/" focuses the filter from anywhere on the Portfolio tab
  document.addEventListener('keydown', e => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (!document.getElementById('tabPortfolio')?.classList.contains('active')) return;
    e.preventDefault();
    input.focus();
  });
}

function renderPositionsTable(positions, sortCol, sortDir) {
  // Determine sort state — default: value descending
  sortCol = sortCol || globalData._posSort?.col || 'value';
  sortDir = sortDir || globalData._posSort?.dir || 'desc';
  globalData._posSort = { col: sortCol, dir: sortDir };

  // If an open-table detail row is expanded, its chart canvas lives inside
  // this tbody — destroy the Chart.js instances before wiping the DOM.
  const expanded = globalData._posExpanded;
  if (expanded && !expanded.isClosed) {
    if (charts.stockChart) { charts.stockChart.destroy(); charts.stockChart = null; }
    if (charts.stockChartPlaceholder) { charts.stockChartPlaceholder.destroy(); charts.stockChartPlaceholder = null; }
  }

  // Quick-filter — applied to a local copy, never mutates globalData.positions
  const q = currentPositionsFilter();
  const visible = q
    ? positions.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.isin || '').toLowerCase().includes(q) ||
        (p.currency || '').toLowerCase().includes(q))
    : positions;

  // Pre-compute volatility (detail row) and 30-day sparkline data
  const volCache = {};
  const sparkCache = {};
  positions.forEach(p => {
    volCache[p.id] = computePositionVolatility(p.id);
    sparkCache[p.id] = compute30d(p.id);
  });
  globalData._volCache = volCache;

  const totalValue = positions.reduce((s, p) => s + p.value, 0);
  const maxValue = positions.reduce((m, p) => Math.max(m, p.value), 0);

  // Total portfolio cost basis for return-contribution (shown in detail row)
  const totalCostBasis = positions.reduce((s, p) => {
    const unrealized = p.plUnrealized ?? p.plBase;
    return s + (p.value - unrealized);
  }, 0);
  globalData._totalCostBasis = totalCostBasis;

  const valueOf = (p, col) => {
    const unrealized = p.plUnrealized ?? p.plBase;
    const costBasis = p.value - unrealized;
    const plPct = costBasis > 0 ? (unrealized / costBasis * 100) : 0;
    switch (col) {
      case 'name':   return (p.name || 'ID ' + p.id).toLowerCase();
      case 'weight': return p.value;
      case 'spark':  return sparkCache[p.id]?.pct ?? -1e9;
      case 'price':  return p.price;
      case 'value':  return p.value;
      case 'pl':     return p.plBase;
      case 'plpct':  return plPct;
      default:       return p.value;
    }
  };

  const sorted = [...visible].sort((a, b) => {
    const av = valueOf(a, sortCol), bv = valueOf(b, sortCol);
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  // Update header arrows
  document.querySelectorAll('#positionsTable thead th').forEach(th => {
    const col = th.dataset.col;
    th.classList.toggle('sort-active', col === sortCol);
    th.textContent = th.textContent.replace(/ [▲▼]$/, '');
    if (col === sortCol) th.textContent += sortDir === 'asc' ? ' ▲' : ' ▼';
  });

  const tbody = document.getElementById('positionsBody');
  tbody.textContent = '';

  if (!sorted.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.style.cssText = 'text-align:center;color:var(--muted);padding:32px;font-size:13px';
    td.textContent = q ? `No positions match "${document.getElementById('positionsFilter')?.value || ''}".` : 'No open positions.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  sorted.forEach(p => {
    const pl = p.plBase;
    const unrealized = p.plUnrealized ?? p.plBase;
    const costBasis = p.value - unrealized;
    const plPct = costBasis > 0 ? (unrealized / costBasis * 100) : 0;

    const tr = document.createElement('tr');
    tr.className = 'pos-row';
    tr.dataset.positionId = p.id;
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => togglePositionDetail(p, false));

    // Name: monogram chip + name + sub-line (ISIN · CCY · shares)
    const tdName = document.createElement('td'); tdName.className = 'td-name';
    const chip = document.createElement('span');
    chip.className = 'pos-chip';
    const c = positionColor(p.id);
    chip.style.color = c;
    chip.style.background = `color-mix(in srgb, ${c} 16%, transparent)`;
    chip.textContent = positionMonogram(p.name);
    const nameWrap = document.createElement('span'); nameWrap.className = 'pos-name-wrap';
    const nameEl = document.createElement('span'); nameEl.className = 'pos-name'; nameEl.textContent = p.name || 'ID ' + p.id;
    const sub = document.createElement('span'); sub.className = 'pos-sub';
    sub.textContent = [p.isin, p.currency, p.size + ' sh'].filter(Boolean).join(' · ');
    nameWrap.append(nameEl, sub);
    tdName.append(chip, nameWrap);

    // Weight: pct + bar scaled to the largest holding
    const weight = totalValue > 0 ? p.value / totalValue * 100 : 0;
    const tdWeight = document.createElement('td'); tdWeight.className = 'td-weight';
    const wPct = document.createElement('span'); wPct.className = 'weight-pct'; wPct.textContent = weight.toFixed(1) + '%';
    const wWrap = document.createElement('span'); wWrap.className = 'weight-bar-wrap';
    const wBar = document.createElement('span'); wBar.className = 'weight-bar';
    wBar.style.width = (maxValue > 0 ? p.value / maxValue * 100 : 0).toFixed(1) + '%';
    wWrap.appendChild(wBar);
    tdWeight.append(wPct, wWrap);

    // 30-day sparkline ("—" until price history is loaded; renderAll re-renders)
    const tdSpark = document.createElement('td'); tdSpark.className = 'td-spark';
    const spark = sparkCache[p.id];
    if (spark) {
      tdSpark.appendChild(sparklineSVG(spark.series, spark.pct));
    } else {
      const none = document.createElement('span'); none.className = 'spark-none'; none.textContent = '—';
      tdSpark.appendChild(none);
    }

    const tdPrice = document.createElement('td'); tdPrice.textContent = fmtPrice(p.price);
    const tdValue = document.createElement('td'); tdValue.className = 'td-value sensitive'; tdValue.textContent = fmtEur(p.value);
    const tdPL = document.createElement('td'); tdPL.className = (pl >= 0 ? 'positive' : 'negative') + ' sensitive';
    tdPL.textContent = (pl >= 0 ? '+' : '') + fmtEur(pl);
    const tdPLPct = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = 'pl-pill sensitive ' + (plPct >= 0 ? 'positive' : 'negative');
    pill.textContent = (plPct >= 0 ? '+' : '') + plPct.toFixed(1) + '%';
    tdPLPct.appendChild(pill);

    tr.append(tdName, tdWeight, tdSpark, tdPrice, tdValue, tdPL, tdPLPct);
    tbody.appendChild(tr);
  });

  // Wire header clicks (only once)
  const thead = document.querySelector('#positionsTable thead');
  if (thead && !thead.dataset.wired) {
    thead.dataset.wired = '1';
    thead.addEventListener('click', e => {
      const th = e.target.closest('th[data-col]');
      if (!th) return;
      const col = th.dataset.col;
      const cur = globalData._posSort;
      const dir = (cur.col === col && cur.dir === 'desc') ? 'asc' : 'desc';
      renderPositionsTable(globalData.positions, col, dir);
    });
  }

  // Re-attach the expanded detail row after a re-render (sort/filter/theme).
  // If the row is currently filtered out, keep the state so it re-expands
  // when the filter is cleared.
  if (expanded && !expanded.isClosed) {
    const pos = positions.find(p => p.id === expanded.id);
    const anchor = tbody.querySelector(`tr[data-position-id="${CSS.escape(String(expanded.id))}"]`);
    if (pos && anchor) openPositionDetail(pos, false, { scroll: false });
  }
}


/**
 * Compute realized P&L for fully-closed positions using FIFO cost basis.
 * A position is "closed" if net quantity from all transactions rounds to 0.
 * Returns array of { id, name, currency, totalSold, avgBuyPrice, avgSellPrice, realizedPL, plPct }
 *
 * KNOWN LIMITATION — Stock Splits:
 * DEGIRO's transaction API does not retroactively adjust quantities for stock splits.
 * Example: bought 10 shares pre-split → stock splits 10-for-1 → sold 100 shares post-split.
 * The FIFO queue sees net qty = 10 − 100 = −90, so the position never appears as "closed"
 * and P&L will be wrong. This cannot be fixed without a separate split-history source.
 * Affected tickers historically: TSLA, AAPL, NVDA, AMZN, GOOGL and others.
 * If a user reports a missing or incorrect closed position, a stock split is the likely cause.
 */
// computeClosedPositions is now in utils.js (shared with popup.js)

function renderClosedPositionsTable(closedPositions, sortCol, sortDir) {
  globalData.closedPositions = closedPositions;
  sortCol = sortCol || globalData._closedSort?.col || 'pl';
  sortDir = sortDir || globalData._closedSort?.dir || 'desc';
  globalData._closedSort = { col: sortCol, dir: sortDir };

  // A closed-table detail row holds the chart canvas — destroy before wiping DOM
  const expanded = globalData._posExpanded;
  if (expanded && expanded.isClosed) {
    if (charts.stockChart) { charts.stockChart.destroy(); charts.stockChart = null; }
    if (charts.stockChartPlaceholder) { charts.stockChartPlaceholder.destroy(); charts.stockChartPlaceholder = null; }
  }

  // Quick-filter shared with the open table (closed items have no ISIN)
  const q = currentPositionsFilter();
  const visibleClosed = q
    ? closedPositions.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.currency || '').toLowerCase().includes(q))
    : closedPositions;

  const valueOf = (p, col) => {
    switch (col) {
      case 'name':     return p.name.toLowerCase();
      case 'currency': return p.currency;
      case 'sold':     return p.totalSold;
      case 'avgBuy':   return p.avgBuyPrice;
      case 'avgSell':  return p.avgSellPrice;
      case 'pl':       return p.realizedPL;
      case 'plpct':    return p.plPct;
      default:         return p.realizedPL;
    }
  };

  const sorted = [...visibleClosed].sort((a, b) => {
    const av = valueOf(a, sortCol), bv = valueOf(b, sortCol);
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  document.querySelectorAll('#closedPositionsTable thead th').forEach(th => {
    const col = th.dataset.col;
    th.classList.toggle('sort-active', col === sortCol);
    th.textContent = th.textContent.replace(/ [▲▼]$/, '');
    if (col === sortCol) th.textContent += sortDir === 'asc' ? ' ▲' : ' ▼';
  });

  const tbody = document.getElementById('closedPositionsBody');
  if (!tbody) return;
  tbody.textContent = '';

  if (sorted.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.style.cssText = 'text-align:center;color:var(--muted);padding:32px;font-size:13px';
    td.textContent = q ? `No closed positions match "${document.getElementById('positionsFilter')?.value || ''}".`
                       : 'No fully closed positions found in transaction history.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  sorted.forEach(p => {
    const plClass    = p.realizedPL >= 0 ? 'positive' : 'negative';
    const plPctClass = p.plPct >= 0 ? 'positive' : 'negative';
    const tr = document.createElement('tr');
    tr.className = 'pos-row';
    tr.dataset.positionId = p.id;
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => togglePositionDetail(p, true));

    const tdName = document.createElement('td'); tdName.className = 'td-name';
    const dot = document.createElement('span');
    dot.style.cssText = 'display:inline-block;width:8px;height:8px;border-radius:50%;background:' + positionColor(p.id) + ';margin-right:8px';
    tdName.appendChild(dot);
    tdName.appendChild(document.createTextNode(p.name));
    if (p.isPartial) {
      const badge = document.createElement('span');
      badge.textContent = 'partial';
      badge.style.cssText = 'margin-left:7px;font-size:9px;padding:1px 5px;border-radius:3px;background:color-mix(in srgb, var(--accent) 13%, transparent);color:var(--accent);border:1px solid color-mix(in srgb, var(--accent) 27%, transparent);vertical-align:middle;font-family:var(--font-mono)';
      tdName.appendChild(badge);
    }

    const tdCurr  = document.createElement('td'); tdCurr.className = 'td-currency'; tdCurr.textContent = p.currency;
    const tdSold  = document.createElement('td'); tdSold.textContent = p.totalSold.toFixed(0);
    const tdBuy   = document.createElement('td'); tdBuy.textContent = fmtEur(p.avgBuyPrice);
    const tdSell  = document.createElement('td'); tdSell.textContent = fmtEur(p.avgSellPrice);
    const tdPL    = document.createElement('td'); tdPL.className    = plClass    + ' sensitive'; tdPL.textContent = (p.realizedPL >= 0 ? '+' : '') + fmtEur(p.realizedPL);
    const tdPLPct = document.createElement('td'); tdPLPct.className = plPctClass + ' sensitive'; tdPLPct.textContent = (p.plPct >= 0 ? '+' : '') + p.plPct.toFixed(1) + '%';

    tr.append(tdName, tdCurr, tdSold, tdBuy, tdSell, tdPL, tdPLPct);
    tbody.appendChild(tr);
  });

  const thead = document.querySelector('#closedPositionsTable thead');
  if (thead && !thead.dataset.wired) {
    thead.dataset.wired = '1';
    thead.addEventListener('click', e => {
      const th = e.target.closest('th[data-col]');
      if (!th) return;
      const col = th.dataset.col;
      const cur = globalData._closedSort;
      const dir = (cur.col === col && cur.dir === 'desc') ? 'asc' : 'desc';
      renderClosedPositionsTable(globalData.closedPositions, col, dir);
    });
  }

  // Re-attach the expanded detail row after a re-render
  if (expanded && expanded.isClosed) {
    const pos = closedPositions.find(p => p.id === expanded.id);
    const anchor = tbody.querySelector(`tr[data-position-id="${CSS.escape(String(expanded.id))}"]`);
    if (pos && anchor) openPositionDetail(pos, true, { scroll: false });
  }
}

function wirePositionsTabs() {
  const toggle = document.getElementById('positionsTabToggle');
  if (!toggle || toggle.dataset.wired) return;
  toggle.dataset.wired = '1';
  toggle.addEventListener('click', e => {
    const btn = e.target.closest('.toggle-btn');
    if (!btn) return;
    toggle.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const isOpen = btn.dataset.tab === 'open';
    document.getElementById('positionsTable').style.display       = isOpen ? '' : 'none';
    document.getElementById('closedPositionsTable').style.display = isOpen ? 'none' : '';
    // Any expanded detail row belongs to the tab we're leaving — collapse it
    collapsePositionDetail();
  });
}

// ── Expandable position detail row ──────────────────────────────────────────
// Replaces the old #stockChartContainer that rendered below the whole table.

function collapsePositionDetail() {
  document.querySelectorAll('tr.pos-detail-row').forEach(tr => tr.remove());
  document.querySelectorAll('tr.pos-row--expanded').forEach(tr => tr.classList.remove('pos-row--expanded'));
  if (charts.stockChart) { charts.stockChart.destroy(); charts.stockChart = null; }
  if (charts.stockChartPlaceholder) { charts.stockChartPlaceholder.destroy(); charts.stockChartPlaceholder = null; }
  globalData._posExpanded = null;
}

function togglePositionDetail(p, isClosed) {
  const exp = globalData._posExpanded;
  if (exp && exp.id === p.id && exp.isClosed === !!isClosed) {
    collapsePositionDetail();
    return;
  }
  openPositionDetail(p, isClosed, { scroll: true });
}

function openPositionDetail(p, isClosed, { scroll = true } = {}) {
  collapsePositionDetail();
  const bodyId = isClosed ? 'closedPositionsBody' : 'positionsBody';
  const anchor = document.querySelector(`#${bodyId} tr[data-position-id="${CSS.escape(String(p.id))}"]`);
  if (!anchor) return;
  globalData._posExpanded = { id: p.id, isClosed: !!isClosed };
  anchor.classList.add('pos-row--expanded');
  const detailTr = buildPositionDetailRow(p, isClosed);
  anchor.after(detailTr);
  if (scroll) detailTr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const chartWrap = detailTr.querySelector('.pos-detail-chart');
  const metaEl = detailTr.querySelector('.stock-chart-meta');
  renderDetailStockChart(chartWrap, metaEl, p, isClosed);
}

/** Entry point for external callers (Today tab, Big Movers). */
function expandPositionRow(positionId, isClosed = false, { scroll = true } = {}) {
  const list = isClosed ? globalData.closedPositions : globalData.positions;
  const p = (list || []).find(x => String(x.id) === String(positionId));
  if (!p) return;
  // Make sure the matching open/closed sub-table is the visible one
  const toggle = document.getElementById('positionsTabToggle');
  const wantTab = isClosed ? 'closed' : 'open';
  const activeBtn = toggle?.querySelector('.toggle-btn.active');
  if (activeBtn && activeBtn.dataset.tab !== wantTab) {
    toggle.querySelector(`.toggle-btn[data-tab="${wantTab}"]`)?.click();
  }
  openPositionDetail(p, isClosed, { scroll });
}

function buildPositionDetailRow(p, isClosed) {
  const tr = document.createElement('tr');
  tr.className = 'pos-detail-row';
  // Clicks inside the detail row must not toggle the anchor row
  tr.addEventListener('click', e => e.stopPropagation());
  const td = document.createElement('td');
  td.colSpan = 7;
  const wrap = document.createElement('div');
  wrap.className = 'pos-detail';

  const grid = document.createElement('div');
  grid.className = 'pos-detail-grid';
  const addStat = (label, value, cls) => {
    const box = document.createElement('div');
    box.className = 'pos-detail-stat';
    const l = document.createElement('div'); l.className = 'pos-detail-label'; l.textContent = label;
    const v = document.createElement('div'); v.className = 'pos-detail-value' + (cls ? ' ' + cls : ''); v.textContent = value;
    box.append(l, v);
    grid.appendChild(box);
  };

  if (!isClosed) {
    const unrealized = p.plUnrealized ?? p.plBase;
    addStat('Avg cost', p.breakEvenPrice != null ? fmtPrice(p.breakEvenPrice) + ' ' + p.currency : '—');
    addStat('Shares', String(p.size));
    const dayPl = globalData._todayPLPerPosition?.[p.id];
    if (typeof dayPl === 'number') {
      addStat('Day P&L', (dayPl >= 0 ? '+' : '') + fmtEur(dayPl), (dayPl >= 0 ? 'positive' : 'negative') + ' sensitive');
    }
    const totalCostBasis = globalData._totalCostBasis || 0;
    const attrib = totalCostBasis > 0 ? unrealized / totalCostBasis * 100 : 0;
    addStat('Return contribution', (attrib >= 0 ? '+' : '') + attrib.toFixed(2) + '%', (attrib >= 0 ? 'positive' : 'negative') + ' sensitive');
    const vol = (globalData._volCache || {})[p.id] ?? computePositionVolatility(p.id);
    addStat('Volatility (ann.)', vol != null ? vol.toFixed(1) + '%' : '—');
  } else {
    addStat('Shares sold', p.totalSold.toFixed(0));
    addStat('Avg buy', fmtEur(p.avgBuyPrice));
    addStat('Avg sell', fmtEur(p.avgSellPrice));
    addStat('Realized P&L', (p.realizedPL >= 0 ? '+' : '') + fmtEur(p.realizedPL), (p.realizedPL >= 0 ? 'positive' : 'negative') + ' sensitive');
    if (p.realizedFxPL) {
      addStat('of which FX', (p.realizedFxPL >= 0 ? '+' : '') + fmtEur(p.realizedFxPL), (p.realizedFxPL >= 0 ? 'positive' : 'negative') + ' sensitive');
    }
  }

  const actions = document.createElement('div');
  actions.className = 'pos-detail-actions';
  if (!isClosed && p.isin) {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn--sm';
    copyBtn.textContent = 'Copy ISIN';
    copyBtn.addEventListener('click', e => {
      e.stopPropagation();
      navigator.clipboard?.writeText(p.isin).then(() => {
        copyBtn.textContent = 'Copied ✓';
        setTimeout(() => { copyBtn.textContent = 'Copy ISIN'; }, 1500);
      }).catch(() => {});
    });
    actions.appendChild(copyBtn);
  }
  // Close control sits in the row's top-right corner (standard dismiss position)
  // rather than inline with the actions.
  const closeBtn = document.createElement('button');
  closeBtn.className = 'pos-detail-close';
  closeBtn.type = 'button';
  closeBtn.title = 'Close';
  closeBtn.setAttribute('aria-label', 'Close position details');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', e => { e.stopPropagation(); collapsePositionDetail(); });

  const meta = document.createElement('div');
  meta.className = 'stock-chart-meta';
  const chartWrap = document.createElement('div');
  chartWrap.className = 'chart-wrap pos-detail-chart';
  const canvas = document.createElement('canvas');
  chartWrap.appendChild(canvas);

  // Close first in DOM order so keyboard users reach the dismiss control early.
  // The actions row is skipped when empty (closed positions have no Copy ISIN),
  // which would otherwise leave a gap above the chart.
  wrap.append(closeBtn, grid);
  if (actions.children.length) wrap.appendChild(actions);
  wrap.append(meta, chartWrap);
  td.appendChild(wrap);
  tr.appendChild(td);
  return tr;
}

async function renderDetailStockChart(chartWrap, metaEl, position, isClosed) {
  if (!chartWrap || !metaEl) return;

  // Pro gate — blurred placeholder chart with upgrade overlay, inside the row
  if (!proUnlocked) {
    metaEl.textContent = 'Price history since your first buy';
    const blurInner = document.createElement('div');
    blurInner.className = 'stock-chart-blur-wrap';
    blurInner.style.height = '100%';
    const phCanvas = document.createElement('canvas');
    blurInner.appendChild(phCanvas);
    chartWrap.textContent = '';
    chartWrap.appendChild(blurInner);

    // Generate a realistic-looking fake price series
    const placeholderPrices = (() => {
      const pts = 120;
      const data = [];
      let v = 150 + Math.random() * 50;
      for (let i = 0; i < pts; i++) {
        v = Math.max(50, v + (Math.random() - 0.47) * 6);
        data.push(parseFloat(v.toFixed(2)));
      }
      return data;
    })();
    const isUp = placeholderPrices[placeholderPrices.length - 1] >= placeholderPrices[0];
    const lineColor = isUp ? THEME_COLORS.plGreen : THEME_COLORS.plRed;
    const fillColor = isUp ? THEME_COLORS.plGreenAlpha(0.08) : THEME_COLORS.plRedAlpha(0.08);

    if (charts.stockChartPlaceholder) { charts.stockChartPlaceholder.destroy(); }
    charts.stockChartPlaceholder = new Chart(phCanvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: placeholderPrices.map((_, i) => i),
        datasets: [{ data: placeholderPrices, borderColor: lineColor, backgroundColor: fillColor, fill: true, borderWidth: 1.5, pointRadius: 0, tension: 0.3 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { display: false },
          y: { display: false }
        }
      }
    });
    showProOverlay(chartWrap, 'Stock Price Charts');
    return;
  }

  const canvas = chartWrap.querySelector('canvas');
  if (!canvas) return;
  metaEl.textContent = 'Loading price history…';

  // The fetch below is async — the user may collapse this row or expand
  // another one while it's in flight. Abort before painting stale data.
  const stillCurrent = () =>
    canvas.isConnected &&
    globalData._posExpanded?.id === position.id &&
    globalData._posExpanded?.isClosed === !!isClosed;

  // Find first buy and last sell dates from transactions
  const txs = globalData.transactions || [];
  const buys  = txs.filter(tx => tx.productId === position.id && tx.buysell === 'B');
  const sells = txs.filter(tx => tx.productId === position.id && tx.buysell === 'S');
  const firstBuyDate = buys.length  > 0 ? buys[0].date                    : null;
  const lastSellDate = sells.length > 0 ? sells[sells.length - 1].date    : null;
  // For closed positions cap chart at last sell; open positions show through today
  const chartEndDate = isClosed && lastSellDate ? lastSellDate : null;

  // Fetch price history for this single stock (check portfolio vwdIds, then watchlist)
  const vwdEntry = globalData.vwdIds?.[position.id] || globalData.watchlistVwdIds?.[position.id];
  if (!vwdEntry) {
    metaEl.textContent = 'Chart not available — no market data identifier for this product.';
    return;
  }

  // Try progressively longer periods until we get data that covers the buy date.
  // Start with the best guess based on holding time, escalate if the VWD API
  // returns nothing or doesn't reach back far enough.
  const periodLadder = ['1M', '6M', '1Y', '2Y', '3Y', '5Y'];
  let startIdx = 0;
  if (firstBuyDate) {
    const endMs = isClosed && lastSellDate ? new Date(lastSellDate + 'T12:00:00').getTime() : Date.now();
    const holdingDays = Math.ceil((endMs - new Date(firstBuyDate + 'T12:00:00').getTime()) / 86400000);
    if (holdingDays <= 30)        startIdx = 0;
    else if (holdingDays <= 180)  startIdx = 1;
    else if (holdingDays <= 365)  startIdx = 2;
    else if (holdingDays <= 730)  startIdx = 3;
    else if (holdingDays <= 1095) startIdx = 4;
    else                          startIdx = 5;
  }

  let priceData = null;
  for (let pi = startIdx; pi < periodLadder.length; pi++) {
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'FETCH_PRICE_HISTORY',
        vwdIds: { [position.id]: vwdEntry },
        period: periodLadder[pi]
      });
      const d = resp?.[position.id];
      if (d && d.length > 0) {
        priceData = d;
        // If data starts on or before first buy, we have enough coverage
        if (!firstBuyDate || d[0].date <= firstBuyDate) break;
        // Otherwise keep escalating to get older data
      }
    } catch(e) { /* try next period */ }
  }

  // User may have collapsed or switched rows while the fetch was in flight
  if (!stillCurrent()) return;

  if (!priceData || priceData.length === 0) {
    metaEl.textContent = 'Chart not available — price history could not be loaded.';
    return;
  }

  // Filter to dates on or after first buy
  let filtered = priceData;
  if (firstBuyDate) {
    filtered = priceData.filter(d => d.date >= firstBuyDate);
    if (filtered.length === 0) filtered = priceData;
  }
  // For closed positions, cap at last sell date
  if (chartEndDate) {
    const capped = filtered.filter(d => d.date <= chartEndDate);
    if (capped.length > 0) filtered = capped;
  }

  const labels = filtered.map(d => d.date);
  const prices = filtered.map(d => d.price);

  // Compute stats
  const firstPrice = prices[0];
  const lastPrice  = prices[prices.length - 1];
  const pricePL    = lastPrice - firstPrice;
  const pricePLPct = firstPrice > 0 ? ((lastPrice / firstPrice - 1) * 100) : 0;
  const isUp       = pricePL >= 0;
  const lineColor  = isUp ? THEME_COLORS.plGreen : THEME_COLORS.plRed;
  const fillColor  = isUp ? THEME_COLORS.plGreenAlpha(0.08) : THEME_COLORS.plRedAlpha(0.08);

  // Build meta line
  const currencySymbol = position.currency === 'USD' ? '$' : position.currency === 'GBP' ? '£' : position.currency === 'EUR' ? '€' : position.currency + ' ';
  const plSign = pricePL >= 0 ? '+' : '';
  if (isClosed && firstBuyDate && lastSellDate) {
    const realizedPL    = position.realizedPL ?? 0;
    const realizedSign  = realizedPL >= 0 ? '+' : '';
    const realizedColor = realizedPL >= 0 ? THEME_COLORS.plGreen : THEME_COLORS.plRed;
    const plPctStr      = position.plPct != null ? ` (${realizedSign}${position.plPct.toFixed(1)}%)` : '';
    metaEl.innerHTML =
      `<span style="color:var(--text-muted)">Closed · ${firstBuyDate} → ${lastSellDate}</span>` +
      `<span style="color:${realizedColor};margin-left:12px">Realized: ${realizedSign}${fmtEur(realizedPL)}${plPctStr}</span>` +
      `<span style="color:var(--text-muted);margin-left:12px">Price: ${currencySymbol}${lastPrice.toFixed(2)} (${plSign}${pricePLPct.toFixed(1)}% over period)</span>`;
  } else {
    metaEl.innerHTML =
      `<span style="color:var(--text)">${currencySymbol}${lastPrice.toFixed(2)}</span>` +
      `<span style="color:${lineColor};margin-left:12px">${plSign}${pricePL.toFixed(2)} (${plSign}${pricePLPct.toFixed(1)}%)</span>` +
      `<span style="color:var(--muted);margin-left:12px">${firstBuyDate ? 'Since ' + firstBuyDate : 'All available data'}</span>`;
  }

  // Build buy/sell markers
  const buyAnnotations = buys.map(tx => ({
    date: tx.date, price: tx.price, type: 'B', qty: Math.abs(tx.quantity)
  }));
  const sellAnnotations = sells.map(tx => ({
    date: tx.date, price: tx.price, type: 'S', qty: Math.abs(tx.quantity)
  }));
  const allAnnotations = [...buyAnnotations, ...sellAnnotations];

  // Destroy previous chart
  if (charts.stockChart) { charts.stockChart.destroy(); charts.stockChart = null; }

  // Build datasets
  const datasets = [{
    data: prices,
    borderColor: lineColor,
    backgroundColor: fillColor,
    fill: true,
    borderWidth: 1.5,
    pointRadius: 0,
    pointHitRadius: 6,
    tension: 0.15,
  }];

  // Add buy/sell marker datasets
  const buyPoints = new Array(labels.length).fill(null);
  const sellPoints = new Array(labels.length).fill(null);
  allAnnotations.forEach(ann => {
    const idx = labels.indexOf(ann.date);
    if (idx === -1) return;
    // Use the actual chart price for the Y coordinate so dots sit on the line
    if (ann.type === 'B') buyPoints[idx] = prices[idx];
    else sellPoints[idx] = prices[idx];
  });

  if (buyPoints.some(v => v !== null)) {
    datasets.push({
      data: buyPoints,
      borderColor: THEME_COLORS.plGreen,
      backgroundColor: THEME_COLORS.plGreen,
      pointRadius: 5,
      pointStyle: 'triangle',
      showLine: false,
      label: 'Buy',
    });
  }
  if (sellPoints.some(v => v !== null)) {
    datasets.push({
      data: sellPoints,
      borderColor: THEME_COLORS.plRed,
      backgroundColor: THEME_COLORS.plRed,
      pointRadius: 5,
      pointStyle: 'triangle',
      rotation: 180,
      showLine: false,
      label: 'Sell',
    });
  }

  // Format dates the same way as the Performance chart: "Sept 2025"
  const fmtStockDate = d => {
    const [y, m] = d.split('-');
    return new Date(y, m - 1).toLocaleString('default', { month: 'short', year: 'numeric' });
  };
  // Tick labels: only show when the month/year string changes, to avoid crowding
  let lastTickLabel = '';
  const tickLabels = labels.map(d => {
    const lbl = fmtStockDate(d);
    if (lbl === lastTickLabel) return null;
    lastTickLabel = lbl;
    return lbl;
  });

  charts.stockChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...THEME_COLORS.themeTooltip(),
          callbacks: {
            title: ctx => {
              const d = labels[ctx[0]?.dataIndex];
              return d ? fmtStockDate(d) : '';
            },
            label: ctx => {
              if (ctx.datasetIndex === 0) return ` ${currencySymbol}${ctx.parsed.y.toFixed(2)}`;
              // Buy/sell marker tooltip
              const ann = allAnnotations.find(a => a.date === labels[ctx.dataIndex]);
              if (ann) return ` ${ann.type === 'B' ? '▲ Buy' : '▼ Sell'}: ${ann.qty} shares @ ${currencySymbol}${ann.price.toFixed(2)}`;
              return null;
            },
            filter: ctx => ctx.parsed.y !== null,
          }
        }
      },
      scales: {
        x: {
          grid: { color: THEME_COLORS.gridColor },
          ticks: {
            color: THEME_COLORS.tickColor, font: { size: 10 }, maxTicksLimit: 10,
            callback: function(val) { return tickLabels[val] || null; }
          }
        },
        y: {
          grid: { color: THEME_COLORS.gridColor },
          ticks: {
            color: THEME_COLORS.tickColor, font: { size: 10 },
            callback: v => currencySymbol + v.toFixed(2)
          }
        }
      }
    }
  });
}

function miniChartOptions(yFmt) {
  // Tooltip honors the same formatter as the y-axis so hover values never
  // show a different precision/unit than the axis (e.g. dividends in cents).
  const fmt = yFmt || (v => fmtEur(v));
  return {
    responsive:true, maintainAspectRatio:false,
    interaction: { mode:'index', intersect:false },
    plugins: { legend:{display:false}, tooltip:{...THEME_COLORS.themeTooltip(),callbacks:{label:ctx=>' '+fmt(ctx.parsed.y)}} },
    scales: {
      x:{grid:{color:THEME_COLORS.gridColor},ticks:{color:THEME_COLORS.tickColor,font:{size:10},maxTicksLimit:8}},
      y:{grid:{color:THEME_COLORS.gridColor},ticks:{color:THEME_COLORS.tickColor,font:{size:10},callback:yFmt||null}}
    }
  };
}

function renderMoreInfo(positions, dividends, transactions) {
  const grid = document.getElementById('moreInfoGrid');
  const note = document.getElementById('moreInfoNote');
  if (!grid) return;
  grid.textContent = '';
  if (note) note.textContent = '';

  // ── 1. Total dividends all time ──────────────────────────────────
  const totalDividends = sumDividends(dividends);

  // ── 2 & 3. FX effect and realized gains ──
  // renderClosedPositionsTable (called earlier in renderAll) already stored the
  // FIFO result; recompute only if renderMoreInfo is ever driven independently.
  const closedForGain = globalData.closedPositions
    || computeClosedPositions(transactions, globalData.names, globalData.meta || {});
  // Shared with the popup via utils.js so both surfaces report the same numbers
  const { unrealizedFxPL, realizedFxPL, totalFxPL, fxPositions, closedFxCount } =
    computeFxEffect(positions, closedForGain);
  const totalRealized = sumRealized(closedForGain);

  const makeStat = (label, value, sub, colorClass, tooltip, chartKey) => {
    const stat = document.createElement('div');
    stat.className = 'more-info-stat' + (tooltip ? ' more-info-stat--tip' : '') + (chartKey ? ' more-info-stat--clickable' : '');
    if (tooltip) stat.dataset.tip = tooltip;
    if (chartKey) stat.dataset.chartKey = chartKey;
    const lbl = document.createElement('div'); lbl.className = 'more-info-stat-label'; lbl.textContent = label;
    const val = document.createElement('div');
    val.className = 'more-info-stat-value sensitive' + (colorClass ? ' ' + colorClass : '');
    val.textContent = value;
    stat.append(lbl, val);
    if (sub) {
      const subEl = document.createElement('div'); subEl.className = 'more-info-stat-sub'; subEl.textContent = sub;
      stat.appendChild(subEl);
    }
    return stat;
  };

  // ── Build cumulative time-series data for charts ──

  // Dividends cumulative (sorted chronologically)
  const divSorted = [...dividends].sort((a, b) => a.date.localeCompare(b.date));
  const divSeries = [];
  let divCum = 0;
  divSorted.forEach(d => { divCum += d.amountEUR || 0; divSeries.push({ date: d.date, value: divCum }); });

  // Fees cumulative (from raw transactions, sorted by date)
  const rawTx = globalData.data?.transactions?.data || [];
  let totalFees = 0, txFees = 0, fxFees = 0;
  const feeTxSorted = rawTx
    .map(t => ({
      date: normalizeDate(t.date),
      fee: txFeeEur(t),
      txFee: Math.abs(parseFloat(t.totalFeesInBaseCurrency) || 0),
      fxFee: Math.abs(parseFloat(t.autoFxFeeInBaseCurrency) || 0),
    }))
    .filter(t => t.date)
    .sort((a, b) => a.date.localeCompare(b.date));
  const feeSeries = [];
  let feeCum = 0;
  feeTxSorted.forEach(t => {
    feeCum += t.fee;
    txFees += t.txFee;
    fxFees += t.fxFee;
    feeSeries.push({ date: t.date, value: feeCum });
  });
  totalFees = txFees + fxFees;

  // Stash totals for the Portfolio Pulse card so it never recomputes them
  globalData._pulseMetrics = { totalDividends, totalFxPL, unrealizedFxPL, realizedFxPL, totalFees, totalRealized };

  // Realized gains cumulative — mirrors computeClosedPositions FIFO exactly
  // Walk each product's transactions independently, collect per-sell gain events, then sort by date
  // Per-sell gain events come from the same canonical FIFO walk that produced
  // closedForGain (utils.js computeClosedPositions) — no second implementation.
  const gainEvents = closedForGain.gainEvents || [];
  const gainSeries = [];
  let gainCum = 0;
  gainEvents.forEach(e => { gainCum += e.gain; gainSeries.push({ date: e.date, value: gainCum }); });

  // Store series for chart rendering
  const chartData = {
    dividends: divSeries,
    fees: feeSeries,
    realized: gainSeries,
  };

  // Dividends stat — the sub-line carries the trailing-12-month figure that
  // used to be repeated as a Pulse row directly below this tile.
  const divCutoff = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  let divTtm = 0, divTtmCount = 0;
  dividends.forEach(d => { if (d.date >= divCutoff) { divTtm += d.amountEUR || 0; divTtmCount++; } });
  const divSub = dividends.length === 0
    ? 'No dividend history found'
    : divTtm > 0
      ? `${fmtEur(divTtm)} in the last 12 months · ${divTtmCount} payment${divTtmCount === 1 ? '' : 's'}`
      : `${dividends.length} payments · gross before tax`;
  grid.appendChild(makeStat(
    'Dividends received',
    (totalDividends >= 0 ? '+' : '') + fmtEur(totalDividends),
    divSub,
    totalDividends > 0 ? 'positive' : '',
    null,
    divSeries.length > 1 ? 'dividends' : null
  ));

  // Currency effect stat — no time series available, not clickable.
  // Sub-line carries the non-EUR exposure that used to be a separate Pulse row.
  const fxTooltip = 'Impact of exchange rate movements separate from product performance. Includes both open and closed positions.';
  const fxClass = totalFxPL >= 0 ? 'positive' : 'negative';
  const portValueForRatios = globalData._scrapedPortfolioValue
    || positions.reduce((s, p) => s + p.value, 0);
  const nonEurValue = positions.filter(p => p.currency !== 'EUR').reduce((s, p) => s + p.value, 0);
  const fxWeight = portValueForRatios > 0 ? nonEurValue / portValueForRatios * 100 : 0;
  const fxSub = (fxPositions > 0 || closedFxCount > 0)
    ? (fxWeight > 0
        ? `${fxWeight.toFixed(0)}% of the portfolio is non-EUR · all-time`
        : 'Open + closed positions · all-time')
    : 'No non-EUR positions';
  grid.appendChild(makeStat(
    'Currency effect',
    (totalFxPL >= 0 ? '+' : '') + fmtEur(totalFxPL),
    fxSub,
    fxClass,
    fxTooltip
  ));

  // Realized gains stat
  grid.appendChild(makeStat(
    'Realized gains',
    (totalRealized >= 0 ? '+' : '') + fmtEur(totalRealized),
    'From fully or partially sold positions',
    totalRealized >= 0 ? 'positive' : 'negative',
    null,
    gainSeries.length > 1 ? 'realized' : null
  ));

  // Fees stat — % of P&L rendered as a small inline badge, not at headline font size
  const feeBreakdownParts = [];
  if (txFees > 0) feeBreakdownParts.push(`${fmtEur(txFees)} commissions`);
  if (fxFees > 0) feeBreakdownParts.push(`${fmtEur(fxFees)} FX fees`);
  // Fees as a share of portfolio value \u2014 the verdict that used to be its own
  // Pulse row, on the tile that already shows the amount.
  const feePctOfValue = portValueForRatios > 0 ? totalFees / portValueForRatios * 100 : null;
  if (feePctOfValue != null && totalFees > 0) {
    feeBreakdownParts.push(`${feePctOfValue.toFixed(2)}% of portfolio value`);
  }
  const feeSub = feeBreakdownParts.length > 0 ? feeBreakdownParts.join(' \u00b7 ') : 'All-time \u00b7 across all trades';

  // Fee impact as % of P&L — scraped value preferred, falls back to sum of open position P&L
  const totalPLForFeeImpact = (() => {
    if (typeof globalData._scrapedTotalPnL === 'number') return globalData._scrapedTotalPnL;
    return (globalData.positions || []).reduce((s, p) => s + (p.pl || 0), 0);
  })();

  const feeStat = makeStat(
    'Total fees paid',
    totalFees > 0 ? '-' + fmtEur(totalFees) : fmtEur(0),
    feeSub,
    totalFees > 0 ? 'negative' : '',
    null,
    feeSeries.length > 1 ? 'fees' : null
  );

  if (totalFees > 0 && totalPLForFeeImpact > 0) {
    const feeImpactPct = (totalFees / totalPLForFeeImpact) * 100;
    const badge = document.createElement('span');
    badge.textContent = feeImpactPct.toFixed(1) + '% of P&L';
    badge.style.cssText = 'font-family:var(--font-mono);font-size:11px;font-weight:400;color:var(--muted);margin-left:8px;opacity:0.8;vertical-align:middle;';
    feeStat.querySelector('.more-info-stat-value').appendChild(badge);
  }

  grid.appendChild(feeStat);

  // ── Wire clickable stats to show cumulative chart ──
  const chartWrap = document.getElementById('moreInfoChartWrap');
  const chartCanvas = document.getElementById('moreInfoChart');
  let activeKey = null;

  grid.addEventListener('click', (e) => {
    const stat = e.target.closest('.more-info-stat--clickable');
    if (!stat) return;
    const key = stat.dataset.chartKey;
    if (!key || !chartData[key] || chartData[key].length < 2) return;

    // Toggle: clicking same stat again hides the chart
    if (activeKey === key) {
      chartWrap.style.display = 'none';
      activeKey = null;
      grid.querySelectorAll('.more-info-stat--clickable').forEach(s => s.classList.remove('more-info-stat--active'));
      return;
    }

    activeKey = key;
    grid.querySelectorAll('.more-info-stat--clickable').forEach(s => s.classList.remove('more-info-stat--active'));
    stat.classList.add('more-info-stat--active');
    chartWrap.style.display = 'block';

    const series = chartData[key];
    const labels = series.map(d => d.date);
    const values = series.map(d => d.value);
    const lastVal = values[values.length - 1];
    const isPositive = key === 'fees' ? false : lastVal >= 0;
    const lineColor = isPositive ? THEME_COLORS.plGreen : THEME_COLORS.plRed;
    const fillColor = isPositive ? THEME_COLORS.plGreenAlpha(0.08) : THEME_COLORS.plRedAlpha(0.08);

    // Date formatting — same style as stock charts
    const fmtDate = d => {
      const [y, m] = d.split('-');
      return new Date(y, m - 1).toLocaleString('default', { month: 'short', year: 'numeric' });
    };
    let lastTickLabel = '';
    const tickLabels = labels.map(d => {
      const lbl = fmtDate(d);
      if (lbl === lastTickLabel) return null;
      lastTickLabel = lbl;
      return lbl;
    });

    if (charts.moreInfoChart) { charts.moreInfoChart.destroy(); charts.moreInfoChart = null; }

    charts.moreInfoChart = new Chart(chartCanvas.getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: values,
          borderColor: lineColor,
          backgroundColor: fillColor,
          fill: true,
          borderWidth: 1.5,
          pointRadius: 0,
          pointHitRadius: 6,
          tension: 0.15,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            ...THEME_COLORS.themeTooltip(),
            callbacks: {
              title: ctx => { const d = labels[ctx[0]?.dataIndex]; return d ? fmtDate(d) : ''; },
              label: ctx => ` ${key === 'fees' ? '-' : ''}${fmtEur(Math.abs(ctx.parsed.y))}`,
            }
          }
        },
        scales: {
          x: {
            grid: { color: THEME_COLORS.gridColor },
            ticks: { color: THEME_COLORS.tickColor, font: { size: 10 }, maxTicksLimit: 8, callback: function(val) { return tickLabels[val] || null; } }
          },
          y: {
            grid: { color: THEME_COLORS.gridColor },
            ticks: {
              color: THEME_COLORS.tickColor, font: { size: 10 },
              callback: v => (key === 'fees' ? '-' : '') + fmtEur(Math.abs(v))
            }
          }
        }
      }
    });
  });

}

/**
 * Compute annualised Sharpe ratio from portfolioSeries and update the stat card.
 * Called after renderPerformanceChart so portfolioSeries is available.
 *
 * Sharpe = (meanDailyReturn - dailyRfRate) / stdDailyReturn × √252
 *
 * Uses trailing 1 year (252 trading days) of daily portfolio values.
 * Risk-free rate: ECB deposit rate ≈ 3.0% p.a. (reasonable for 2024-25).
 */
// ── Portfolio Pulse ────────────────────────────────────────────────────────

/**
 * Annualised Sharpe ratio from a TWR series [{twr}] at a 3% risk-free rate.
 * Returns null when there are fewer than 20 usable daily returns or zero variance.
 */
function computeSharpeFromTwrSeries(series) {
  if (!series || series.length < 2) return null;
  const RF_DAILY = Math.pow(1.03, 1 / 252) - 1;
  const returns = [];
  for (let i = 1; i < series.length; i++) {
    const prev = 1 + series[i - 1].twr / 100;
    const curr = 1 + series[i].twr / 100;
    if (prev > 0) {
      const r = curr / prev - 1;
      if (r !== 0) returns.push(r);
    }
  }
  if (returns.length < 20) return null;
  const n = returns.length;
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);
  if (std <= 0) return null;
  return ((mean - RF_DAILY) / std) * Math.sqrt(252);
}

/**
 * Rule-based plain-language insights over data that is already computed.
 * Pure function: no fetches, no DOM, no side effects. Every rule skips
 * gracefully when its inputs are missing. Body is an array of parts:
 * plain strings, or {sensitive: string} for money values (privacy mode).
 * Returns at most 6 insights, most severe first.
 */
function computePulseInsights(gd) {
  const out = [];
  const positions = gd.positions || [];
  const totalValue = positions.reduce((s, p) => s + p.value, 0);
  const pm = gd._pulseMetrics;

  // 1. Concentration — top-3 holdings weight
  if (positions.length >= 3 && totalValue > 0) {
    const top3 = [...positions].sort((a, b) => b.value - a.value).slice(0, 3);
    const w = top3.reduce((s, p) => s + p.value, 0) / totalValue * 100;
    // Optional enrichment: only reads a value the Pro correlation matrix may
    // have already computed — never triggers that fetch itself.
    const wacHigh = gd.insightWAC != null && gd.insightWAC > 0.6;
    const corrAction = { label: 'View correlation', targetTab: 'insights', targetCardId: 'correlationCard' };
    if (w > 60) {
      out.push({ severity: 'warn', title: 'Concentrated portfolio',
        body: [`Your top 3 holdings make up ${w.toFixed(0)}% of the portfolio.` +
          (wacHigh ? ` They also move together — average correlation is +${gd.insightWAC.toFixed(2)}.`
                   : ' A setback in one of them moves the whole portfolio.')],
        action: corrAction });
    } else if (w >= 50) {
      out.push({ severity: 'info', title: 'Concentration is elevated',
        body: [`Your top 3 holdings are ${w.toFixed(0)}% of the portfolio.`], action: corrAction });
    } else if (w < 30 && positions.length >= 8) {
      out.push({ severity: 'good', title: 'Well spread',
        body: [`No dominant position — your top 3 holdings are only ${w.toFixed(0)}% of the portfolio.`], action: null });
    }
  }

  // 2. Sharpe trend — now vs ~3 months ago
  const full = gd.fullWithTwr;
  if (full?.length >= 200 && gd.insightSharpe != null) {
    const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const pastSharpe = computeSharpeFromTwrSeries(full.filter(p => p.date <= cutoff));
    if (pastSharpe != null) {
      const delta = gd.insightSharpe - pastSharpe;
      const metricsAction = { label: 'Performance', targetTab: 'portfolio', targetCardId: null };
      if (delta >= 0.2) {
        out.push({ severity: 'good', title: 'Risk-adjusted returns improving',
          body: [`Sharpe ratio is ${gd.insightSharpe.toFixed(2)}, up from ${pastSharpe.toFixed(2)} three months ago — you are earning more return per unit of volatility.`],
          action: metricsAction });
      } else if (delta <= -0.2) {
        out.push({ severity: 'warn', title: 'Risk-adjusted returns deteriorating',
          body: [`Sharpe ratio fell to ${gd.insightSharpe.toFixed(2)} from ${pastSharpe.toFixed(2)} three months ago — more volatility for the same return.`],
          action: metricsAction });
      }
    }
  }

  // FX exposure, fee ratio and trailing-12-month dividends used to be rows 3, 4
  // and 6 here. Each restated a stat tile sitting directly below, with an action
  // link that scrolled to something already on screen — so each now lives as a
  // sub-line on its own tile (see renderMoreInfo) and Pulse keeps only the
  // observations no tile carries.

  // 3. Drawdown / all-time high (informational, never a warning)
  if (full?.length >= 60) {
    let peak = -Infinity, peakDate = null;
    full.forEach(p => { const g = 1 + p.twr / 100; if (g > peak) { peak = g; peakDate = p.date; } });
    const lastG = 1 + full[full.length - 1].twr / 100;
    const dd = peak > 0 ? (peak - lastG) / peak * 100 : null;
    const perfAction = { label: 'Performance', targetTab: 'portfolio', targetCardId: null };
    if (dd != null && dd < 0.5) {
      out.push({ severity: 'good', title: 'At an all-time high',
        body: ['Your time-weighted return has never been higher than it is now.'], action: perfAction });
    } else if (dd != null && dd > 15 && peakDate) {
      const peakLabel = new Date(peakDate + 'T12:00:00').toLocaleDateString('default', { month: 'short', year: 'numeric' });
      out.push({ severity: 'info', title: 'Below the previous peak',
        body: [`The portfolio is ${dd.toFixed(0)}% below its high-water mark from ${peakLabel}.`], action: perfAction });
    }
  }

  const rank = { warn: 0, info: 1, good: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 6);
}

/** Switch to a tab through the real tab button (keeps lazy-render semantics), then scroll to a card. */
function navigateToCard(tab, cardId) {
  document.querySelector(`.tab-bar .tab-btn[data-tab="${tab}"]`)?.click();
  if (!cardId) return;
  expandInsightCard(cardId);
  requestAnimationFrame(() => document.getElementById(cardId)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function renderPulseCard() {
  const card = document.getElementById('pulseCard');
  const list = document.getElementById('pulseList');
  if (!card || !list) return;
  const insights = globalData.positions?.length ? computePulseInsights(globalData) : [];
  list.textContent = '';
  // The card also holds the stat tiles now, so it stays put — only the
  // observation list comes and goes.
  list.style.display = insights.length ? '' : 'none';
  if (!insights.length) return;
  insights.forEach(ins => {
    const row = document.createElement('div');
    row.className = `pulse-row pulse-row--${ins.severity}`;
    const stripe = document.createElement('div'); stripe.className = 'pulse-stripe';
    const text = document.createElement('div'); text.className = 'pulse-text';
    const title = document.createElement('div'); title.className = 'pulse-title'; title.textContent = ins.title;
    const body = document.createElement('div'); body.className = 'pulse-body';
    ins.body.forEach(part => {
      if (typeof part === 'string') {
        body.appendChild(document.createTextNode(part));
      } else {
        const s = document.createElement('span'); s.className = 'sensitive'; s.textContent = part.sensitive;
        body.appendChild(s);
      }
    });
    text.append(title, body);
    row.append(stripe, text);
    if (ins.action) {
      const btn = document.createElement('button');
      btn.className = 'pulse-action';
      btn.textContent = ins.action.label + ' →';
      btn.addEventListener('click', () => navigateToCard(ins.action.targetTab, ins.action.targetCardId));
      row.appendChild(btn);
    }
    list.appendChild(row);
  });
}

const STATUS_FRESH_MS = 30 * 60 * 1000; // 30 minutes

let _syncing = false; // true while a sync is in flight

// Single entry point for all call sites: 'loading' marks a sync in flight,
// anything else re-derives the light's colour from lastFetch.
function setStatus(s) {
  _syncing = (s === 'loading');
  updateStatusDot();
}

/** Human-readable elapsed time since an epoch-ms timestamp. */
function fmtAgo(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const hours = Math.round(mins / 60);
  if (hours < 48) return hours + 'h ago';
  return Math.round(hours / 24) + ' days ago';
}

async function updateStatusDot() {
  const dot = document.getElementById('statusDot');
  if (!dot) return;
  if (_syncing) { dot.className = 'status-dot loading'; return; }
  const { lastFetch } = await chrome.storage.local.get('lastFetch');
  const btn = document.getElementById('btnRefresh');
  if (!lastFetch) {
    dot.className = 'status-dot stale';
    if (btn) btn.title = 'Not synced yet';
    updateStalenessBanner(null);
    return;
  }
  const age = Date.now() - lastFetch;
  dot.className = 'status-dot ' + (age < STATUS_FRESH_MS ? 'fresh' : 'stale');
  // Freshness detail lives in the button tooltip — no extra chrome in the header
  if (btn) btn.title = 'Synced ' + fmtAgo(lastFetch) + ' · ' + new Date(lastFetch).toLocaleString();
  updateStalenessBanner(age);
}

// Re-check freshness every 30s so the light turns red without a page reload
setInterval(updateStatusDot, 30 * 1000);
// fmtEur, fmtMonth, normalizeDate, inferGeo, inferAssetClass etc. are in utils.js

// ── Correlation Matrix ─────────────────────────────────────────────────────

async function renderCorrelationMatrix(positions, vwdIds, names) {
  const wrap = document.getElementById('correlationHeatmap');
  if (!wrap) return;

  // Filter to open positions that have a vwdId
  // NOTE: positions use `size` (not `qty`) for share count — see extractPositions() in utils.js
  const openIds = positions
    .filter(p => p.size > 0 && vwdIds[p.id])
    .map(p => p.id);

  if (openIds.length < 2) {
    wrap.innerHTML = '<p style="color:var(--muted);font-size:12px;padding:12px 0;">Need at least 2 open positions to show a correlation matrix.</p>';
    return;
  }

  wrap.innerHTML = '<p style="color:var(--muted);font-size:11px;padding:8px 0;">Loading price histories…</p>';

  // Fetch full 5Y history (same cache used by performance chart — free hit)
  const histories = await chrome.runtime.sendMessage({ type: 'FETCH_PRICE_HISTORY', vwdIds, period: '5Y' });

  // Build aligned daily-return series for each position
  // 1. Collect all dates across all positions
  const dateSet = new Set();
  const rawPrices = {}; // id -> Map(date -> price)
  for (const id of openIds) {
    const series = histories[id];
    if (!series || series.length < 5) continue;
    rawPrices[id] = new Map(series.map(d => [d.date, d.price]));
    series.forEach(d => dateSet.add(d.date));
  }

  const validIds = openIds.filter(id => rawPrices[id]);
  if (validIds.length < 2) {
    wrap.innerHTML = '<p style="color:var(--muted);font-size:12px;padding:12px 0;">Not enough price history available to compute correlations.</p>';
    return;
  }

  // 2. Sort all dates, compute daily returns per asset
  const allDates = [...dateSet].sort();
  const returns = {}; // id -> number[]
  for (const id of validIds) {
    const priceMap = rawPrices[id];
    const ret = [];
    for (let i = 1; i < allDates.length; i++) {
      const prev = priceMap.get(allDates[i - 1]);
      const curr = priceMap.get(allDates[i]);
      if (prev != null && curr != null && prev > 0) {
        ret.push(curr / prev - 1);
      } else {
        ret.push(null); // mark as missing
      }
    }
    returns[id] = ret;
  }

  // 3. Compute Pearson correlation for each pair using only dates where both have data
  // pearson() is now a global utility in utils.js
  const matrix = {}; // matrix[idA][idB] = corr
  for (const a of validIds) {
    matrix[a] = {};
    for (const b of validIds) {
      matrix[a][b] = a === b ? 1.0 : pearson(returns[a], returns[b]);
    }
  }

  // 4. Color scale: -1 = vivid green, 0 = dark neutral, +1 = vivid red
  //    Uses a power curve (t^0.6) so mid-range values already show real colour
  //    instead of fading into the dark background.
  //    Endpoints: +1 → #E05252 (bright red)  -1 → #2ECC71 (bright green)
  function corrColor(v) {
    if (v === null) return 'var(--bg3)';
    const c = Math.max(-1, Math.min(1, v));
    const absC = Math.abs(c);
    const t = Math.pow(absC, 0.6); // push saturation harder at mid-range
    const [nr, ng, nb] = THEME_COLORS.corrNeutral;
    if (c >= 0) {
      // neutral → vivid red (#E05252)
      return `rgb(${Math.round(nr + t * (224 - nr))},${Math.round(ng + t * (82 - ng))},${Math.round(nb + t * (82 - nb))})`;
    } else {
      // neutral → vivid green (#2ECC71)
      return `rgb(${Math.round(nr + t * (46 - nr))},${Math.round(ng + t * (204 - ng))},${Math.round(nb + t * (113 - nb))})`;
    }
  }

  function textColor(v) {
    if (v === null) return 'var(--muted)';
    return Math.abs(v) > 0.15 ? (isLight() ? '#111827' : '#F5F7FA') : (isLight() ? '#4B5563' : '#C0C8D4');
  }

  // 5. Build table
  const fullName = id => names[id] || id;

  // Smart algorithmic abbreviation — strips ETF boilerplate (provider names, UCITS, currency
  // codes, Acc/Dist suffixes) to expose the meaningful core descriptor.
  // No hardcoded per-asset lookup: purely pattern-based so it works for any portfolio.
  function abbreviate(raw) {
    if (!raw) return '';
    let s = raw.trim();
    // Strip leading fund-provider prefixes (common across EU/US markets)
    s = s.replace(/^(iShares(\s+Core)?|Vanguard|SPDR|Xtrackers|Amundi(\s+IS)?|Lyxor|WisdomTree|Invesco|Franklin(\s+Templeton)?|PIMCO|Fidelity|BlackRock|Northern\s+Trust|DWS|HSBC|L&G|Legal\s+&\s+General|Ossiam|Tabula|VanEck|First\s+Trust|Global\s+X|Direxion|ProShares|ARK|Grayscale)\s+/i, '');
    // Strip trailing boilerplate: UCITS ETF / ETF, then optional currency + Acc/Dist
    s = s.replace(/\s+(UCITS\s+ETF|UCITS|ETF)(\s+(\w{2,3}|\(\w+\)))*\s*$/i, '');
    s = s.replace(/\s+\((Acc|Dist|Hedged|H)\)\s*$/i, '');
    s = s.replace(/\s+(USD|EUR|GBP|CHF|JPY|NOK|SEK|DKK)\s*$/i, '');
    s = s.trim();
    return s || raw.trim();
  }

  const table = document.createElement('table');
  table.className = 'correlation-table';

  // Header row
  const thead = table.createTHead();
  const headerRow = thead.insertRow();
  // Empty corner cell (sits above the row-label column)
  const corner = document.createElement('th');
  corner.className = 'row-label';
  headerRow.appendChild(corner);
  for (const id of validIds) {
    const th = document.createElement('th');
    th.className = 'col-header-cell';
    // Wrapper div sets the height; inner span is rotated -45°
    const outer = document.createElement('div');
    outer.className = 'col-label-outer';
    const label = document.createElement('span');
    label.className = 'col-label-text';
    label.textContent = abbreviate(fullName(id));
    label.title = fullName(id);
    outer.appendChild(label);
    th.appendChild(outer);
    headerRow.appendChild(th);
  }

  // Data rows
  const tbody = table.createTBody();
  for (const rowId of validIds) {
    const tr = tbody.insertRow();
    // Row label — same abbreviation logic, full name on hover
    const th = document.createElement('th');
    th.className = 'row-label';
    th.textContent = abbreviate(fullName(rowId));
    th.title = fullName(rowId);
    tr.appendChild(th);

    for (const colId of validIds) {
      const td = tr.insertCell();
      const v = matrix[rowId][colId];
      td.style.background = corrColor(v);
      td.style.color = textColor(v);
      td.textContent = v !== null ? v.toFixed(2) : '—';
      if (rowId === colId) td.classList.add('corr-diag');

      // Tooltip data — use abbreviated names for readability
      td.dataset.rowName = abbreviate(fullName(rowId));
      td.dataset.colName = abbreviate(fullName(colId));
      td.dataset.corr    = v !== null ? v.toFixed(4) : 'N/A';
    }
  }

  wrap.innerHTML = '';
  wrap.appendChild(table);

  // 6. Summary stat boxes — WAC + PCA side by side
  const posMap = {}; // id → position object
  for (const p of positions) posMap[p.id] = p;
  const totalValue = validIds.reduce((s, id) => s + (posMap[id]?.value || 0), 0);

  if (totalValue > 0 && validIds.length >= 2) {
    // Grid container for the two stat boxes
    const statsGrid = document.createElement('div');
    statsGrid.className = 'corr-stats-grid';

    // ── WAC ────────────────────────────────────────────────────────
    //    WAC = Σ(wi × wj × ρij) / Σ(wi × wj) for all i ≠ j
    let wacNum = 0, wacDen = 0;
    for (let i = 0; i < validIds.length; i++) {
      const wi = (posMap[validIds[i]]?.value || 0) / totalValue;
      for (let j = i + 1; j < validIds.length; j++) {
        const wj = (posMap[validIds[j]]?.value || 0) / totalValue;
        const rho = matrix[validIds[i]][validIds[j]];
        if (rho !== null) {
          const w = wi * wj;
          wacNum += w * rho;
          wacDen += w;
        }
      }
    }
    const wac = wacDen > 0 ? wacNum / wacDen : null;
    if (wac !== null) {
      globalData.insightWAC = wac; // expose to grade engine
      renderPulseCard(); // concentration insight can now include correlation
    }

    if (wac !== null) {
      const wacBox = document.createElement('div');
      wacBox.className = 'more-info-stat more-info-stat--tip';
      wacBox.dataset.tip =
        'Weighted Average Correlation: How correlated your portfolio is, ' +
        'weighted by position size. Pairs with larger combined weight count more. ' +
        'Below 0.3 is well-diversified, 0.3 to 0.6 is moderate, above 0.6 is concentrated.';

      function wacColor(v) {
        if (v < 0.3)  return '#2ECC71';
        if (v <= 0.6) return isLight() ? '#111827' : '#F5F7FA';
        return '#E05252';
      }

      const wacLabel = document.createElement('div');
      wacLabel.className = 'more-info-stat-label';
      wacLabel.textContent = 'Portfolio Correlation (WAC)';

      const wacValue = document.createElement('div');
      wacValue.className = 'more-info-stat-value';
      wacValue.textContent = (wac >= 0 ? '+' : '') + wac.toFixed(2);
      wacValue.style.color = wacColor(wac);

      const wacSub = document.createElement('div');
      wacSub.className = 'more-info-stat-sub';
      wacSub.textContent =
        wac >= 0.6  ? 'Concentrated: holdings move closely together' :
        wac >= 0.3  ? 'Moderate: some diversification benefit' :
        wac >= 0    ? 'Well diversified: low shared risk' :
                      'Strongly diversified: holdings offset each other';

      wacBox.append(wacLabel, wacValue, wacSub);

      // Pair extremes — scan off-diagonal for highest and lowest ρ
      let maxRho = -Infinity, minRho = Infinity;
      let maxPair = null, minPair = null;
      for (let i = 0; i < validIds.length; i++) {
        for (let j = i + 1; j < validIds.length; j++) {
          const rho = matrix[validIds[i]][validIds[j]];
          if (rho === null) continue;
          if (rho > maxRho) { maxRho = rho; maxPair = [validIds[i], validIds[j]]; }
          if (rho < minRho) { minRho = rho; minPair = [validIds[i], validIds[j]]; }
        }
      }

      // Headline pair for the collapsed card row — the summary is the insight
      if (maxPair) {
        setInsightSummary('correlationCard',
          `avg ${wac >= 0 ? '+' : ''}${wac.toFixed(2)} · highest pair ${maxRho >= 0 ? '+' : ''}${maxRho.toFixed(2)}`);
      }

      if (maxPair && minPair) {
        const extremesHeader = document.createElement('div');
        extremesHeader.className = 'pca-loadings-header';
        extremesHeader.style.marginTop = '14px';
        extremesHeader.textContent = 'Pair extremes';

        function extremeRow(idA, idB, rho, icon) {
          const row = document.createElement('div');
          row.className = 'corr-extreme-row';
          row.title = `${fullName(idA)} vs ${fullName(idB)}`;

          const iconSpan = document.createElement('span');
          iconSpan.className = 'corr-extreme-icon';
          iconSpan.textContent = icon;

          const namesSpan = document.createElement('span');
          namesSpan.className = 'corr-extreme-names';
          namesSpan.textContent = `${abbreviate(fullName(idA))} × ${abbreviate(fullName(idB))}`;

          const rhoSpan = document.createElement('span');
          rhoSpan.className = 'corr-extreme-rho';
          rhoSpan.textContent = (rho >= 0 ? '+' : '') + rho.toFixed(2);
          rhoSpan.style.color = corrColor(rho);

          // Order: icon · ρ value (prominent) · names (secondary)
          row.append(iconSpan, rhoSpan, namesSpan);
          return row;
        }

        wacBox.append(
          extremesHeader,
          extremeRow(maxPair[0], maxPair[1], maxRho, '↑'),
          extremeRow(minPair[0], minPair[1], minRho, '↓'),
        );
      }

      statsGrid.appendChild(wacBox);
    }

    // ── PCA — Dominant Risk Factor ─────────────────────────────────
    //    Power iteration to extract the first eigenvector of the
    //    correlation matrix, then report the % of variance explained
    //    and the top-loading holdings.

    // Build dense N×N correlation array (nulls → 0 for PCA purposes)
    const N = validIds.length;
    const C = [];
    for (let i = 0; i < N; i++) {
      C[i] = [];
      for (let j = 0; j < N; j++) {
        C[i][j] = matrix[validIds[i]][validIds[j]] ?? 0;
      }
    }

    // Power iteration: find the largest eigenvalue (λ1) and eigenvector (v1)
    let vec = Array(N).fill(1 / Math.sqrt(N)); // initial guess
    for (let iter = 0; iter < 200; iter++) {
      // Multiply: w = C × vec
      const w = Array(N).fill(0);
      for (let i = 0; i < N; i++)
        for (let j = 0; j < N; j++)
          w[i] += C[i][j] * vec[j];
      // Norm
      const norm = Math.sqrt(w.reduce((s, x) => s + x * x, 0));
      if (norm === 0) break;
      // Normalise
      const prev = vec.slice();
      for (let i = 0; i < N; i++) vec[i] = w[i] / norm;
      // Convergence check (change in direction)
      let diff = 0;
      for (let i = 0; i < N; i++) diff += (vec[i] - prev[i]) ** 2;
      if (diff < 1e-12) break;
    }

    // Eigenvalue λ1 = vec · (C × vec)
    const Cv = Array(N).fill(0);
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++)
        Cv[i] += C[i][j] * vec[j];
    const lambda1 = vec.reduce((s, v, i) => s + v * Cv[i], 0);
    // Total variance = trace(C) = N (since diagonal is all 1's)
    const varianceExplained = lambda1 / N;

    if (varianceExplained > 0 && isFinite(varianceExplained)) {
      const pcaBox = document.createElement('div');
      pcaBox.className = 'more-info-stat more-info-stat--tip';
      pcaBox.dataset.tip =
        'Dominant Risk Factor: What share of your portfolio\'s total variance is explained ' +
        'by a single common driver. A high percentage means most holdings move together ' +
        'as one bet. Below 40% is well-spread, 40% to 70% is moderate, above 70% is concentrated.';

      function pcaColor(v) {
        if (v < 0.4)  return '#2ECC71';
        if (v <= 0.7) return isLight() ? '#111827' : '#F5F7FA';
        return '#E05252';
      }

      const pcaLabel = document.createElement('div');
      pcaLabel.className = 'more-info-stat-label';
      pcaLabel.textContent = 'Dominant Risk Factor';

      const pcaValue = document.createElement('div');
      pcaValue.className = 'more-info-stat-value';
      pcaValue.textContent = Math.round(varianceExplained * 100) + '%';
      pcaValue.style.color = pcaColor(varianceExplained);

      const pcaSub = document.createElement('div');
      pcaSub.className = 'more-info-stat-sub';
      pcaSub.textContent =
        varianceExplained >= 0.7  ? 'High concentration: one factor dominates your risk' :
        varianceExplained >= 0.4  ? 'Moderate: a shared driver explains some risk' :
                                    'Well spread: no single factor dominates';

      pcaBox.append(pcaLabel, pcaValue, pcaSub);

      // Top-loading holdings — show which assets drive this factor.
      // Value shown: loading² × 100% = each asset's share of PC1 variance.
      // Since vec is a unit vector, Σ(vec[i]²) = 1, so loading² is directly
      // the fraction of the dominant factor's variance driven by that asset.
      const loadings = validIds.map((id, i) => ({
        id,
        name: abbreviate(fullName(id)),
        pct: vec[i] ** 2, // fraction of PC1 variance (sums to 1 across all assets)
      }));
      loadings.sort((a, b) => b.pct - a.pct);

      const topN = Math.min(4, loadings.length);

      const listHeader = document.createElement('div');
      listHeader.className = 'pca-loadings-header';
      listHeader.textContent = 'Top contributors to shared risk';
      pcaBox.appendChild(listHeader);

      const listEl = document.createElement('div');
      listEl.className = 'pca-loadings';

      for (let k = 0; k < topN; k++) {
        const item = loadings[k];
        const row = document.createElement('div');
        row.className = 'pca-loading-row';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'pca-loading-name';
        nameSpan.textContent = item.name;
        // title on the name span (row uses display:contents so its own title won't fire)
        nameSpan.title = `${fullName(item.id)} — drives ${Math.round(item.pct * 100)}% of the dominant risk factor`;

        const barOuter = document.createElement('span');
        barOuter.className = 'pca-loading-bar-outer';
        const barInner = document.createElement('span');
        barInner.className = 'pca-loading-bar-inner';
        // Bar scaled relative to the top asset
        barInner.style.width = Math.round((item.pct / loadings[0].pct) * 100) + '%';
        barOuter.appendChild(barInner);

        const valSpan = document.createElement('span');
        valSpan.className = 'pca-loading-val';
        valSpan.textContent = Math.round(item.pct * 100) + '%';

        row.append(nameSpan, barOuter, valSpan);
        listEl.appendChild(row);
      }

      pcaBox.appendChild(listEl);
      statsGrid.appendChild(pcaBox);
    }

    wrap.appendChild(statsGrid);
  }

  // 7. Shared floating tooltip
  let tooltip = document.getElementById('corrTooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'corrTooltip';
    tooltip.className = 'corr-tooltip';
    document.body.appendChild(tooltip);
  }

  // Helper: clamp tooltip so it never overflows the viewport
  function positionTooltip(e) {
    const pad = 14;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const tw = tooltip.offsetWidth  || 200;
    const th = tooltip.offsetHeight || 60;
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    // If it would overflow the right edge, flip to the left of the cursor
    if (x + tw > vw - 8) x = e.clientX - tw - pad;
    // If it would overflow the bottom, flip above the cursor
    if (y + th > vh - 8) y = e.clientY - th - pad;
    tooltip.style.left = Math.max(4, x) + 'px';
    tooltip.style.top  = Math.max(4, y) + 'px';
  }

  table.addEventListener('mouseover', e => {
    const td = e.target.closest('td');
    if (!td || !td.dataset.corr) { tooltip.style.display = 'none'; return; }
    const corr = parseFloat(td.dataset.corr);
    const interp = isNaN(corr) ? '' :
      corr >= 0.8  ? 'highly correlated'   :
      corr >= 0.5  ? 'moderately correlated':
      corr >= 0.2  ? 'weakly correlated'    :
      corr >= -0.2 ? 'uncorrelated'         :
      corr >= -0.5 ? 'weakly inverse'       :
      corr >= -0.8 ? 'moderately inverse'   :
                     'highly inverse';
    // Compact format: Name vs Name · ρ = 0.1234 · weakly correlated
    const label = td.dataset.rowName === td.dataset.colName
      ? `<strong>${td.dataset.rowName}</strong> (self)`
      : `<strong>${td.dataset.rowName}</strong> vs <strong>${td.dataset.colName}</strong>`;
    tooltip.innerHTML = `${label}<br>ρ = ${td.dataset.corr}` + (interp ? ` · ${interp}` : '');
    tooltip.style.display = 'block';
    positionTooltip(e);
  });

  table.addEventListener('mousemove', e => {
    if (tooltip.style.display === 'none') return;
    positionTooltip(e);
  });

  table.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
  });
}

async function wireCorrelationToggle() {
  const card = document.getElementById('correlationCard');
  if (!card || card.dataset.wired) return;
  card.dataset.wired = '1';

  // Add PRO badge when not unlocked
  if (!proUnlocked) {
    const title = document.getElementById('corrInfoIcon');
    if (title && !title.querySelector('.pro-badge')) {
      const badge = document.createElement('span');
      badge.className = 'pro-badge';
      badge.textContent = 'PRO';
      title.appendChild(badge);
    }
  }

  // ── Title hover tooltip ──
  const infoIcon = document.getElementById('corrInfoIcon');
  if (infoIcon) {
    let infoTip = document.getElementById('corrTooltip');
    if (!infoTip) {
      infoTip = document.createElement('div');
      infoTip.id = 'corrTooltip';
      infoTip.className = 'corr-tooltip';
      document.body.appendChild(infoTip);
    }

    const INFO_TEXT =
      'How closely each pair of holdings moves together, based on daily returns.<br><br>' +
      '<span style="color:#E05252">■</span> <strong>(0 → +1)</strong> · tend to rise and fall together<br>' +
      '<span style="color:#2ECC71">■</span> <strong>(0 → −1)</strong> · tend to move in opposite directions<br>' +
      '<strong>Near 0</strong> · largely independent of each other';

    infoIcon.addEventListener('mouseenter', e => {
      infoTip.innerHTML = INFO_TEXT;
      infoTip.className = 'corr-tooltip corr-tooltip--info';
      infoTip.style.display = 'block';
      const rect = infoIcon.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      let x = rect.left;
      let y = rect.bottom + 6;
      requestAnimationFrame(() => {
        const tw = infoTip.offsetWidth  || 300;
        const th = infoTip.offsetHeight || 100;
        if (x + tw > vw - 8) x = vw - tw - 8;
        if (y + th > vh - 8) y = rect.top - th - 6;
        infoTip.style.left = Math.max(4, x) + 'px';
        infoTip.style.top  = Math.max(4, y) + 'px';
      });
    });

    infoIcon.addEventListener('mouseleave', () => {
      infoTip.style.display = 'none';
      infoTip.className = 'corr-tooltip';
    });
  }

  // Auto-render content on Insights tab open
  const heatmap = document.getElementById('correlationHeatmap');
  if (!proUnlocked) {
    // Show blurred placeholder
    if (!heatmap.dataset.placeholderBuilt) {
      heatmap.dataset.placeholderBuilt = '1';

      const fakeNames = ['Stock A', 'Stock B', 'Stock C', 'Stock D', 'Stock E'];
      const n = fakeNames.length;
      const fakeMatrix = Array.from({ length: n }, (_, i) =>
        Array.from({ length: n }, (_, j) => {
          if (i === j) return 1.0;
          return parseFloat(Math.max(-1, Math.min(1, (Math.random() * 1.6 - 0.8))).toFixed(2));
        })
      );
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) fakeMatrix[j][i] = fakeMatrix[i][j];

      const corrColor = v => {
        const c = Math.max(-1, Math.min(1, v));
        const t = Math.pow(Math.abs(c), 0.6);
        const [nr,ng,nb] = THEME_COLORS.corrNeutral;
        return c >= 0
          ? `rgb(${Math.round(nr+t*(224-nr))},${Math.round(ng+t*(82-ng))},${Math.round(nb+t*(82-nb))})`
          : `rgb(${Math.round(nr+t*(46-nr))},${Math.round(ng+t*(204-ng))},${Math.round(nb+t*(113-nb))})`;
      };

      const table = document.createElement('table');
      table.className = 'correlation-table corr-blur-wrap';

      const thead = table.createTHead();
      const hrow = thead.insertRow();
      const corner = document.createElement('th'); corner.className = 'row-label'; hrow.appendChild(corner);
      fakeNames.forEach(name => {
        const th = document.createElement('th'); th.className = 'col-header-cell';
        const outer = document.createElement('div'); outer.className = 'col-label-outer';
        const span = document.createElement('span'); span.className = 'col-label-text'; span.textContent = name;
        outer.appendChild(span); th.appendChild(outer); hrow.appendChild(th);
      });

      const tbody = table.createTBody();
      fakeNames.forEach((rowName, i) => {
        const tr = tbody.insertRow();
        const th = document.createElement('th'); th.className = 'row-label'; th.textContent = rowName; tr.appendChild(th);
        fakeMatrix[i].forEach((v, j) => {
          const td = tr.insertCell();
          td.style.background = corrColor(v);
          td.style.color = Math.abs(v) > 0.15 ? (isLight() ? '#111827' : '#F5F7FA') : (isLight() ? '#4B5563' : '#C0C8D4');
          td.textContent = v.toFixed(2);
          if (i === j) td.classList.add('corr-diag');
        });
      });

      heatmap.innerHTML = '';
      heatmap.classList.add('pro-placeholder-box');
      heatmap.appendChild(table);
      showProOverlay(heatmap, 'Correlation Matrix');
    }
  } else {
    // Render real matrix
    if (!heatmap.dataset.rendered) {
      heatmap.dataset.rendered = '1';
      await renderCorrelationMatrix(
        globalData.positions,
        globalData.vwdIds,
        globalData.names
      );
    }
  }
}

// ── CSV Export ──────────────────────────────────────────────────────────────

// ── Pro header button ──────────────────────────────────────────────────────
function wireProButton() {
  const btn = document.getElementById('btnPro');
  if (!btn) return;

  // Replace the button node to clear all previous click handlers,
  // ensuring the correct modal opens after pro state changes.
  const fresh = btn.cloneNode(true);
  btn.parentNode.replaceChild(fresh, btn);

  if (proUnlocked) {
    fresh.classList.add('pro-active');
    fresh.title = 'Sharpe Pro — Active. Click to view subscription details.';
    fresh.style.cursor = 'pointer';
    fresh.addEventListener('click', () => showProStatusModal());
  } else {
    fresh.classList.remove('pro-active');
    fresh.title = 'Activate Sharpe Pro';
    fresh.addEventListener('click', () => showLicenseModal());
  }
}

/** Create a download-icon button. If locked=true, clicking opens the Pro upgrade flow instead of exporting. */
function makeExportBtn(title, onClick, locked) {
  const btn = document.createElement('button');
  btn.className = 'btn-export' + (locked ? ' btn-export--locked' : '');
  btn.title = locked ? 'Upgrade to Pro to export' : title;
  btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (locked) {
      chrome.tabs.create({ url: PRO_CONFIG.checkoutUrl });
    } else {
      onClick();
    }
  });
  return btn;
}

function wireExportButtons() {
  // Export buttons always rendered; non-Pro users see a locked variant that
  // triggers the upgrade flow instead of downloading.
  const locked = !proUnlocked;

  // 1. Performance chart — one button, exports whichever mode is showing
  const perfHeader = document.querySelector('#performanceChart')?.closest('.card')?.querySelector('.card-header');
  if (perfHeader && !perfHeader.querySelector('.btn-export')) {
    perfHeader.appendChild(makeExportBtn('Export chart data as CSV', exportPerformance, locked));
  }

  // 2. Allocation chart
  const allocHeader = document.querySelector('#allocationChart')?.closest('.card')?.querySelector('.card-header');
  if (allocHeader && !allocHeader.querySelector('.btn-export')) {
    allocHeader.appendChild(makeExportBtn('Export allocation as CSV', exportAllocation, locked));
  }

  // 3. Positions table (open + closed)
  const posHeader = document.querySelector('#positionsTable')?.closest('.card')?.querySelector('.card-header');
  if (posHeader && !posHeader.querySelector('.btn-export')) {
    posHeader.appendChild(makeExportBtn('Export positions as CSV', exportPositions, locked));
  }

  // 4. Correlation matrix
  const corrHeader = document.getElementById('correlationCard')?.querySelector('.card-header');
  if (corrHeader && !corrHeader.querySelector('.btn-export')) {
    const btn = makeExportBtn('Export correlation matrix as CSV', exportCorrelation, locked);
    // Keep the collapse chevron last in the row
    corrHeader.insertBefore(btn, corrHeader.querySelector('.insight-chevron'));
  }
}

function exportCapitalAppreciation() {
  const series = globalData.portfolioSeries;
  const eurSeries = globalData.eurSeries;
  if (!series || series.length === 0) return;
  const headers = ['Date', 'TWR %', 'Portfolio Value (EUR)'];
  const rows = series.map((d, i) => [
    d.date,
    (d.twr ?? d.twrDisplay ?? 0).toFixed(2),
    eurSeries?.[i]?.value?.toFixed(2) ?? ''
  ]);
  downloadCSV('capital_appreciation.csv', headers, rows);
}

function exportAllocation() {
  const positions = globalData.positions;
  if (!positions?.length) return;

  const posFiltered = positions.filter(p => p.value > 0);
  const total = posFiltered.reduce((s, p) => s + p.value, 0);

  // Helper: build sorted {labels, values} for a given mode
  function getAllocData(mode) {
    let map = {};
    if (mode === 'position') {
      const sorted = [...posFiltered].sort((a, b) => b.value - a.value);
      return { labels: sorted.map(p => p.name || 'ID ' + p.id), values: sorted.map(p => p.value) };
    } else if (mode === 'currency') {
      posFiltered.forEach(p => { map[p.currency] = (map[p.currency] || 0) + p.value; });
    } else if (mode === 'geography') {
      posFiltered.forEach(p => { const g = inferGeo(p); map[g] = (map[g] || 0) + p.value; });
    } else { // assetclass
      posFiltered.forEach(p => { const c = inferAssetClass(p); map[c] = (map[c] || 0) + p.value; });
      const cashValue = globalData._cashValue || 0;
      if (cashValue > 0) map['Cash'] = (map['Cash'] || 0) + cashValue;
    }
    const sorted = Object.entries(map).sort((a, b) => b[1] - a[1]);
    return { labels: sorted.map(([k]) => k), values: sorted.map(([, v]) => v) };
  }

  // Build one CSV with all four views separated by a blank row and a section header
  const sections = [
    { mode: 'position',   title: 'Holdings' },
    { mode: 'currency',   title: 'Currency' },
    { mode: 'geography',  title: 'Geography' },
    { mode: 'assetclass', title: 'Asset Class' },
  ];

  const escape = v => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  const lines = [];
  sections.forEach(({ mode, title }, si) => {
    if (si > 0) lines.push(''); // blank separator row
    lines.push(escape(title)); // section heading
    lines.push(['Category', 'Value (EUR)', 'Weight %'].map(escape).join(','));
    const { labels, values } = getAllocData(mode);
    labels.forEach((l, i) => {
      lines.push([escape(l), values[i].toFixed(2), (values[i] / total * 100).toFixed(1)].join(','));
    });
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'allocation.csv'; a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** One export button on the Performance card; it exports whichever mode is showing. */
function exportPerformance() {
  if (perfMode() === 'daily') exportDailyPerf();
  else exportCapitalAppreciation();
}

function exportDailyPerf() {
  const chart = charts.performance;
  if (!chart) return;
  const labels = chart.data.labels || [];
  const data = chart.data.datasets?.[0]?.data || [];
  const sp = chart.data.datasets?.[1]?.data || null;
  const headers = sp ? ['Date', 'Daily Change %', 'S&P 500 Daily %'] : ['Date', 'Daily Change %'];
  const rows = labels.map((d, i) => sp
    ? [d, (data[i] ?? 0).toFixed(4), sp[i] != null ? sp[i].toFixed(4) : '']
    : [d, (data[i] ?? 0).toFixed(4)]);
  downloadCSV('daily_performance.csv', headers, rows);
}

function exportPositions() {
  const positions = globalData.positions || [];
  const closed = globalData.closedPositions || [];
  const isOpenTab = document.getElementById('positionsTable')?.style.display !== 'none';

  if (isOpenTab) {
    const headers = ['Name', 'Currency', 'Shares', 'Price', 'Value (EUR)', 'P&L (EUR)', 'P&L %'];
    const rows = positions.map(p => {
      const unrealized = p.plUnrealized ?? p.plBase;
      const costBasis = p.value - unrealized;
      const plPct = costBasis > 0 ? (unrealized / costBasis * 100) : 0;
      return [p.name || 'ID ' + p.id, p.currency, p.size, p.price.toFixed(2), p.value.toFixed(2), p.plBase.toFixed(2), plPct.toFixed(1)];
    });
    downloadCSV('open_positions.csv', headers, rows);
  } else {
    const headers = ['Name', 'Currency', 'Shares Sold', 'Avg Buy (EUR)', 'Avg Sell (EUR)', 'Realized P&L (EUR)', 'P&L %'];
    const rows = closed.map(c => [c.name, c.currency, c.totalSold.toFixed(2), c.avgBuyPrice.toFixed(2), c.avgSellPrice.toFixed(2), c.realizedPL.toFixed(2), c.plPct.toFixed(1)]);
    downloadCSV('closed_positions.csv', headers, rows);
  }
}

function exportCorrelation() {
  const wrap = document.getElementById('correlationHeatmap');
  if (!wrap || !wrap.dataset.rendered) return;
  const table = wrap.querySelector('table');
  if (!table) return;
  const headerCells = table.querySelectorAll('thead th');
  const colNames = [...headerCells].slice(1).map(th => th.textContent.trim()); // skip corner cell
  const bodyRows = table.querySelectorAll('tbody tr');
  const headers = ['', ...colNames];
  const rows = [...bodyRows].map(tr => {
    const rowLabel = tr.querySelector('th')?.textContent.trim() || '';
    const cells = tr.querySelectorAll('td');
    return [rowLabel, ...[...cells].map(td => td.textContent.trim())];
  });
  downloadCSV('correlation_matrix.csv', headers, rows);
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Rate My Portfolio — scoring engine & UI wiring ───────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

const SLIDER_DESCS = {
  risk: {
    1: 'Capital preservation is your top priority',
    2: 'Very conservative — bonds, metals, money market',
    3: 'Conservative — mostly large-cap funds and ETFs',
    4: 'Moderately conservative — blue-chip equities with some bonds',
    5: 'Balanced — mix of equities and defensive assets',
    6: 'Moderate growth — mostly equities, some sector bets',
    7: 'Growth-oriented — individual stocks across sectors',
    8: 'Aggressive — small-caps, high-growth, concentrated positions',
    9: 'Very aggressive — leveraged products, high volatility',
    10: 'Maximum risk — derivatives, options, speculative plays',
  },
  involvement: {
    1: 'Buy once, check yearly',
    2: 'Review a couple of times a year',
    3: 'Check in quarterly, occasional rebalance',
    4: 'Monthly reviews, occasional trades',
    5: 'Regular monitoring, a few trades per month',
    6: 'Active — weekly reviews, frequent trades',
    7: 'Hands-on — multiple trades per week',
    8: 'Very active — daily monitoring and trading',
    9: 'Near day-trading — multiple trades daily',
    10: 'Full-time day trader',
  },
  goal: {
    1: 'Need regular income from my portfolio now',
    2: 'Primarily seeking steady dividend income',
    3: 'Income-focused with some growth',
    4: 'Balanced — income and moderate growth',
    5: 'Leaning toward growth with some income',
    6: 'Growth-focused, dividends are a bonus',
    7: 'Primarily capital appreciation',
    8: 'Aggressive growth over income',
    9: 'Maximum long-term capital gains',
    10: 'Pure wealth accumulation, no income needed',
  },
  horizon: {
    1: 'Need access to funds within 1 year',
    2: '1–2 year horizon',
    3: '2–3 years',
    4: '3–5 years',
    5: '5–7 years',
    6: '7–10 years',
    7: '10–15 years',
    8: '15–20 years',
    9: '20–30 years',
    10: '30+ years — multi-generational wealth',
  },
  complexity: {
    1: 'One or two broad index funds, nothing more',
    2: 'A handful of ETFs, fully passive',
    3: 'A few funds/ETFs, maybe one individual stock',
    4: 'Mix of ETFs and some individual stocks',
    5: 'Comfortable with 10–15 positions',
    6: 'Fine managing diverse holdings',
    7: 'Multiple asset classes and geographies',
    8: 'Comfortable with options or leveraged products',
    9: 'Complex portfolio with many instruments',
    10: 'Any instrument, any market, any complexity',
  },
};

function wireGradeCard() {
  const card = document.getElementById('portfolioGradeCard');
  if (!card || card.dataset.wired) return;
  card.dataset.wired = '1';

  const content = document.getElementById('gradeContent');
  const survey = document.getElementById('gradeSurvey');
  const results = document.getElementById('gradeResults');

  // ── Pro badge on card title (shown for both free and Pro) ──
  if (!proUnlocked) {
    const title = card.querySelector('.card-title');
    if (title && !title.querySelector('.pro-badge')) {
      const badge = document.createElement('span');
      badge.className = 'pro-badge';
      badge.textContent = 'PRO';
      title.appendChild(badge);
    }
    // Free users: survey is fully usable, but results are gated.
    // The survey wiring continues below — the gate happens in renderGradeResults.
  }

  // Slider interactivity — update value display and description
  const sliderMap = {
    sliderRisk:       { val: 'sliderValRisk',       desc: 'sliderDescRisk',       key: 'risk' },
    sliderInvolvement:{ val: 'sliderValInvolvement', desc: 'sliderDescInvolvement',key: 'involvement' },
    sliderGoal:       { val: 'sliderValGoal',        desc: 'sliderDescGoal',       key: 'goal' },
    sliderHorizon:    { val: 'sliderValHorizon',     desc: 'sliderDescHorizon',    key: 'horizon' },
    sliderComplexity: { val: 'sliderValComplexity',  desc: 'sliderDescComplexity', key: 'complexity' },
  };

  Object.entries(sliderMap).forEach(([sliderId, { val, desc, key }]) => {
    const slider = document.getElementById(sliderId);
    const valEl = document.getElementById(val);
    const descEl = document.getElementById(desc);
    if (!slider) return;
    const update = () => {
      const v = parseInt(slider.value);
      valEl.textContent = v;
      descEl.textContent = SLIDER_DESCS[key][v] || '';
    };
    slider.addEventListener('input', update);
    update(); // initial
  });

  // Collapsed-row summary — carries the grade so the card informs while closed
  const setGradeSummary = (gradeData, answeredAt) => {
    const when = answeredAt
      ? new Date(answeredAt).toLocaleDateString('default', { day: 'numeric', month: 'short' })
      : null;
    setInsightSummary('portfolioGradeCard',
      `Grade ${gradeData.overall}${when ? ` · rated ${when}` : ''}`);
  };

  // Restore saved survey answers
  chrome.storage.local.get(['gradeAnswers', 'gradeAnsweredAt'], ({ gradeAnswers, gradeAnsweredAt }) => {
    if (!gradeAnswers) return;
    Object.entries(sliderMap).forEach(([sliderId, { key }]) => {
      const slider = document.getElementById(sliderId);
      if (slider && gradeAnswers[key] !== undefined) {
        slider.value = gradeAnswers[key];
        slider.dispatchEvent(new Event('input'));
      }
    });
    // Auto-render results if we have saved answers and portfolio data
    if (globalData.positions?.length > 0) {
      const gradeData = computePortfolioGrade(gradeAnswers, globalData);
      renderGradeResults(gradeData, results);
      survey.style.display = 'none';
      results.style.display = 'block';
      setGradeSummary(gradeData, gradeAnsweredAt);
    }
  });

  // Submit
  document.getElementById('btnGradeSubmit').addEventListener('click', () => {
    const answers = {
      risk: parseInt(document.getElementById('sliderRisk').value),
      involvement: parseInt(document.getElementById('sliderInvolvement').value),
      goal: parseInt(document.getElementById('sliderGoal').value),
      horizon: parseInt(document.getElementById('sliderHorizon').value),
      complexity: parseInt(document.getElementById('sliderComplexity').value),
    };
    const answeredAt = Date.now();
    chrome.storage.local.set({ gradeAnswers: answers, gradeAnsweredAt: answeredAt });
    const gradeData = computePortfolioGrade(answers, globalData);
    renderGradeResults(gradeData, results);
    survey.style.display = 'none';
    results.style.display = 'block';
    setGradeSummary(gradeData, answeredAt);
  });
}

// ── Scoring Engine ──────────────────────────────────────────────────────────

/**
 * Compute portfolio grade from survey answers + portfolio data.
 * Returns { overall, subs: [{name, score, grade, detail}], narrative }.
 * Each sub-score is 0–100, mapped to a letter grade.
 */
function computePortfolioGrade(answers, gd) {
  const positions = gd.positions || [];
  const transactions = gd.transactions || [];
  const dividends = gd.dividends || [];
  const totalValue = positions.reduce((s, p) => s + p.value, 0);

  // ── Helper: sigmoid curve for smooth scoring ──
  // Maps a "distance" (0 = perfect, higher = worse) to a 0–100 score
  // k controls steepness, midpoint controls where score = 50
  const sigmoidScore = (distance, midpoint, k) => {
    return 100 / (1 + Math.exp(k * (distance - midpoint)));
  };

  // ── Helper: compute Herfindahl-Hirschman Index ──
  const hhi = (values) => {
    const total = values.reduce((s, v) => s + v, 0);
    if (total === 0) return 0;
    return values.reduce((s, v) => s + (v / total) ** 2, 0);
  };

  // ── Gather portfolio characteristics ──────────────────────────────────

  // Asset class distribution
  const assetClasses = {};
  positions.forEach(p => {
    const cls = inferAssetClass(p);
    assetClasses[cls] = (assetClasses[cls] || 0) + p.value;
  });
  const equityPct = ((assetClasses['Equity'] || 0) / totalValue) * 100;
  const bondsPct = ((assetClasses['Bonds'] || 0) / totalValue) * 100;
  const derivativesPct = ((assetClasses['Derivatives'] || 0) / totalValue) * 100;
  const moneyMarketPct = ((assetClasses['Money Market'] || 0) / totalValue) * 100;
  const commoditiesPct = ((assetClasses['Commodities'] || 0) / totalValue) * 100;

  // Implied risk level of portfolio (1–10 scale)
  // Heavier equity/derivatives = higher risk, bonds/MM = lower
  const impliedRisk = Math.min(10, Math.max(1,
    1 +
    (equityPct / 100) * 5 +
    (derivativesPct / 100) * 9 +
    (commoditiesPct / 100) * 3 -
    (bondsPct / 100) * 3 -
    (moneyMarketPct / 100) * 4
  ));

  // Geographic distribution
  const geos = {};
  positions.forEach(p => {
    const geo = inferGeo(p);
    geos[geo] = (geos[geo] || 0) + p.value;
  });
  const geoValues = Object.values(geos);

  // Currency distribution
  const currencies = {};
  positions.forEach(p => {
    currencies[p.currency] = (currencies[p.currency] || 0) + p.value;
  });
  // NOTE: currencyValues not used for scoring — instrument currency ≠ underlying exposure

  // Position concentration
  const positionValues = positions.map(p => p.value).sort((a, b) => b - a);
  const topPositionPct = totalValue > 0 ? (positionValues[0] / totalValue) * 100 : 0;
  const top3Pct = totalValue > 0 ? (positionValues.slice(0, 3).reduce((s, v) => s + v, 0) / totalValue) * 100 : 0;

  // Transaction frequency (trades per month over last 12 months)
  const oneYearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const recentTx = transactions.filter(t => t.date >= oneYearAgo);
  const monthsActive = Math.max(1, (() => {
    if (recentTx.length === 0) return 1;
    const first = recentTx[0].date;
    const last = recentTx[recentTx.length - 1].date;
    return Math.max(1, (new Date(last) - new Date(first)) / (30 * 864e5));
  })());
  const tradesPerMonth = recentTx.length / monthsActive;

  // Dividend yield approximation
  const oneYearDivs = dividends.filter(d => d.date >= oneYearAgo);
  const annualDivIncome = oneYearDivs.reduce((s, d) => s + (d.amountEUR || 0), 0);
  const divYield = totalValue > 0 ? (annualDivIncome / totalValue) * 100 : 0;

  // Portfolio Sharpe ratio — use the value already computed by the chart insight bar
  // (TWR-based, filters fill-forward zero-return days, matching the displayed value)
  const portfolioSharpe = gd.insightSharpe ?? null;

  // Number of distinct asset classes and instrument complexity
  const numAssetClasses = Object.keys(assetClasses).length;
  const hasDerivatives = derivativesPct > 0;
  const numPositions = positions.length;

  // ETF vs individual stock ratio
  const etfValue = positions.filter(p => p.productTypeId === 131 || p.productTypeId === 3).reduce((s, p) => s + p.value, 0);
  const etfPct = totalValue > 0 ? (etfValue / totalValue) * 100 : 0;


  // ══════════════════════════════════════════════════════════════════════════
  // ── Dimension 1: Risk Alignment (survey-dependent) ──────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  const riskGap = Math.abs(answers.risk - impliedRisk);
  const riskScore = sigmoidScore(riskGap, 3.5, 1.2);
  let riskShort = '';
  let riskLong = '';
  if (riskGap <= 1.5) {
    riskShort = `Portfolio risk matches your tolerance.`;
    riskLong  = `Portfolio risk closely matches your stated tolerance (implied risk: ${impliedRisk.toFixed(1)}/10, stated: ${answers.risk}/10).`;
  } else if (impliedRisk > answers.risk) {
    riskShort = `Portfolio is more aggressive than your stated tolerance.`;
    riskLong  = `Portfolio is riskier than your stated tolerance suggests (implied: ${impliedRisk.toFixed(1)}/10, stated: ${answers.risk}/10). `;
    if (derivativesPct > 5) riskLong += `${derivativesPct.toFixed(0)}% in derivatives is notable for a conservative investor. `;
    else if (equityPct > 80) riskLong += `${equityPct.toFixed(0)}% equity exposure is high for your comfort level — consider shifting some allocation toward bonds or defensive assets.`;
    else riskLong += `Consider shifting toward more defensive assets to bring the portfolio in line with your comfort level.`;
  } else {
    riskShort = `Portfolio is more conservative than your risk appetite.`;
    riskLong  = `Portfolio is more conservative than your risk appetite (implied: ${impliedRisk.toFixed(1)}/10, stated: ${answers.risk}/10). You could take on more equity exposure to better match your goals and maximise long-term returns.`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Dimension 2: Goal Alignment (survey-dependent) ──────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  let goalScore;
  let goalShort = '';
  let goalLong = '';
  if (answers.goal <= 4) {
    const idealYield = 2 + (4 - answers.goal) * 0.8;
    const yieldGap = Math.max(0, idealYield - divYield);
    goalScore = sigmoidScore(yieldGap, 2.5, 1.0);
    if (divYield >= idealYield * 0.7) {
      goalShort = `${divYield.toFixed(1)}% yield suits your income focus.`;
      goalLong  = `Your ${divYield.toFixed(1)}% dividend yield supports your income goal well (target: ~${idealYield.toFixed(1)}%).`;
    } else if (divYield < 0.5) {
      goalShort = `Very little income generated (${divYield.toFixed(1)}% yield).`;
      goalLong  = `With a ${divYield.toFixed(1)}% yield, your portfolio generates very little income for an income-focused strategy. Consider adding dividend-paying ETFs or stocks targeting a yield of ~${idealYield.toFixed(1)}%.`;
    } else {
      goalShort = `${divYield.toFixed(1)}% yield is modest for income focus.`;
      goalLong  = `Your ${divYield.toFixed(1)}% yield is modest for an income-focused strategy (target: ~${idealYield.toFixed(1)}%). Look for higher-yielding dividend stocks or income ETFs to close the gap.`;
    }
  } else if (answers.goal >= 7) {
    const growthTilt = equityPct + derivativesPct * 0.5 - bondsPct * 0.3 - moneyMarketPct * 0.5;
    goalScore = sigmoidScore(Math.max(0, 70 - growthTilt), 30, 0.12);
    if (growthTilt >= 70) {
      goalShort = `Strong equity tilt suits your growth goal.`;
      goalLong  = `Strong growth positioning with ${equityPct.toFixed(0)}% equities — well aligned with your long-term wealth goal.`;
    } else {
      goalShort = `Low equity for a growth strategy (${equityPct.toFixed(0)}%).`;
      goalLong  = `For a growth strategy, ${equityPct.toFixed(0)}% in equities is below what you'd typically need. Consider reducing defensive allocations and increasing exposure to equity ETFs or growth stocks.`;
    }
  } else {
    const balancePenalty = Math.abs(equityPct - 60) / 2 + Math.abs(bondsPct + moneyMarketPct - 20) / 2;
    goalScore = sigmoidScore(balancePenalty, 20, 0.15);
    goalShort = `${equityPct.toFixed(0)}% equities, ${(bondsPct + moneyMarketPct).toFixed(0)}% defensive.`;
    goalLong  = `Balanced approach with ${equityPct.toFixed(0)}% equities and ${(bondsPct + moneyMarketPct).toFixed(0)}% defensive — a reasonable mix for your balanced goal.`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Dimension 3: Time Horizon Fit (survey-dependent) ────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  let horizonScore;
  let horizonShort = '';
  let horizonLong = '';
  const defensivePct = bondsPct + moneyMarketPct + commoditiesPct;
  if (answers.horizon <= 3) {
    const idealDefensive = 40 + (3 - answers.horizon) * 15;
    const deficitFromIdeal = Math.max(0, idealDefensive - defensivePct);
    horizonScore = sigmoidScore(deficitFromIdeal, 25, 0.14);
    if (defensivePct >= idealDefensive * 0.6) {
      horizonShort = `Defensive allocation suits your short horizon.`;
      horizonLong  = `${defensivePct.toFixed(0)}% in defensive assets is appropriate for your ${answers.horizon <= 1 ? '1–2 year' : '2–3 year'} time horizon.`;
    } else {
      horizonShort = `High equity for a short time horizon (${equityPct.toFixed(0)}%).`;
      horizonLong  = `With a ${answers.horizon <= 1 ? '1–2 year' : '2–3 year'} horizon, ${equityPct.toFixed(0)}% in equities carries significant drawdown risk. A market correction could leave you with losses right when you need liquidity. Target at least ${idealDefensive}% in defensive assets (bonds, money market).`;
    }
  } else if (answers.horizon >= 7) {
    const opportunityCost = defensivePct - 20;
    horizonScore = sigmoidScore(Math.max(0, opportunityCost), 25, 0.14);
    if (defensivePct <= 25) {
      horizonShort = `Lean defensive allocation suits your long horizon.`;
      horizonLong  = `Only ${defensivePct.toFixed(0)}% in defensive assets — appropriate for a ${answers.horizon >= 9 ? '20+' : '10–15'} year horizon where equities have time to recover from downturns.`;
    } else {
      horizonShort = `${defensivePct.toFixed(0)}% defensive is conservative for your long horizon.`;
      horizonLong  = `${defensivePct.toFixed(0)}% in defensive assets is conservative for a ${answers.horizon >= 9 ? '20+' : '10–15'} year horizon. Equities have historically outperformed bonds significantly over long periods — reducing your defensive allocation could meaningfully improve long-term returns.`;
    }
  } else {
    const medPenalty = Math.max(0, equityPct - 80) + Math.max(0, defensivePct - 50);
    horizonScore = sigmoidScore(medPenalty, 20, 0.15);
    horizonShort = `Allocation suits your medium-term horizon.`;
    horizonLong  = `Your ${equityPct.toFixed(0)}% equity / ${defensivePct.toFixed(0)}% defensive split is reasonable for a medium-term horizon.`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Dimension 4: Structure Match (survey-dependent) ─────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  let structureScore;
  let structureShort = '';
  let structureLong = '';

  const expectedComplexity = (answers.complexity + answers.involvement) / 2;
  const actualComplexity = Math.min(10,
    (numPositions / 5) +
    (numAssetClasses / 2) +
    (hasDerivatives ? 2 : 0) +
    (1 - etfPct / 100) * 3
  );

  const complexityGap = Math.abs(expectedComplexity - actualComplexity);
  structureScore = sigmoidScore(complexityGap, 3, 1.0);

  if (complexityGap <= 2) {
    structureShort = `Portfolio structure matches your management style.`;
    structureLong  = `Portfolio structure matches your management style — complexity level is in line with your stated preferences.`;
  } else if (actualComplexity > expectedComplexity) {
    const mismatch = [];
    if (numPositions > 15 && answers.complexity <= 4) mismatch.push(`${numPositions} individual positions`);
    if (hasDerivatives && answers.complexity <= 5) mismatch.push('derivatives exposure');
    if (etfPct < 30 && answers.involvement <= 3) mismatch.push(`only ${etfPct.toFixed(0)}% in funds/ETFs`);
    structureShort = `More complex than your stated preference.`;
    structureLong  = `Portfolio is more complex than you'd prefer` + (mismatch.length ? ` — ${mismatch.join(', ')}` : '') + `. Consider consolidating into broader ETFs to reduce the management burden.`;
  } else {
    structureShort = `Simpler than your complexity preference.`;
    structureLong  = `Portfolio is simpler than your appetite for complexity. You could add more positions, asset classes, or geographies to match your stated preference.`;
  }

  if (answers.involvement <= 3 && tradesPerMonth > 4) {
    structureScore = Math.max(0, structureScore - 15);
    structureShort = `High trade frequency for a passive investor.`;
    structureLong += ` ${tradesPerMonth.toFixed(1)} trades/month is high for a passive approach — this may indicate reactive decision-making rather than a deliberate strategy.`;
  } else if (answers.involvement >= 7 && tradesPerMonth < 1) {
    structureScore = Math.max(0, structureScore - 10);
    structureShort = `Low trade frequency for an active strategy.`;
    structureLong += ` Trading frequency (${tradesPerMonth.toFixed(1)}/month) is low for an active strategy — you may not be capitalising on the opportunities you're watching for.`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Dimension 5: Diversification (portfolio-only) ───────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  const posHHI = hhi(positionValues);
  const geoHHI = hhi(geoValues);

  // Ideal HHI for N positions is 1/N (perfectly equal). Penalty based on deviation.
  // For positions: HHI of 0.15 = well diversified, 0.5+ = very concentrated
  //
  // NOTE: Currency HHI is intentionally excluded. On DEGIRO, many international ETFs
  // (e.g. MSCI World, S&P 500 trackers) are denominated in EUR but provide underlying
  // exposure to USD, GBP, JPY, etc. Penalising single-currency portfolios would
  // conflate instrument denomination with actual underlying currency exposure.
  const diversificationPenalty =
    posHHI * 45 +                               // position concentration (primary)
    geoHHI * 25 +                               // geographic concentration
    (numPositions < 5 ? (5 - numPositions) * 6 : 0);  // too few positions

  const diversificationScore = sigmoidScore(diversificationPenalty, 25, 0.12);

  // Build detail — always explain the score with specific data
  const geoCount = Object.keys(geos).length;
  const divDetails = [];

  // Position concentration — always comment
  if (topPositionPct > 30) {
    divDetails.push(`Your largest holding is ${topPositionPct.toFixed(0)}% of the portfolio — consider rebalancing.`);
  } else if (topPositionPct > 15) {
    divDetails.push(`Your largest holding is ${topPositionPct.toFixed(0)}% — moderate concentration.`);
  } else {
    divDetails.push(`No single position dominates (largest is ${topPositionPct.toFixed(0)}%).`);
  }

  // Top-3 concentration
  if (top3Pct > 60) {
    divDetails.push(`Top 3 positions make up ${top3Pct.toFixed(0)}% — high concentration risk.`);
  } else if (top3Pct > 40) {
    divDetails.push(`Top 3 positions are ${top3Pct.toFixed(0)}% of the portfolio.`);
  }

  // Geographic spread
  if (geoCount <= 2) {
    divDetails.push(`Only ${geoCount} geographic region${geoCount === 1 ? '' : 's'} represented — consider broader exposure.`);
  } else if (geoCount === 3) {
    divDetails.push(`${geoCount} geographic regions — decent but room for wider exposure.`);
  } else {
    divDetails.push(`Good geographic spread across ${geoCount} regions.`);
  }

  // Position count
  if (numPositions < 5) {
    divDetails.push(`Only ${numPositions} position${numPositions === 1 ? '' : 's'} — limited diversification.`);
  } else if (numPositions < 10) {
    divDetails.push(`${numPositions} positions — adequate but a broader base reduces individual risk.`);
  }

  // HHI commentary for mid-range scores
  if (posHHI > 0.15 && topPositionPct <= 30) {
    divDetails.push(`Position weights are uneven (HHI ${posHHI.toFixed(2)}) — more equal sizing would improve diversification.`);
  }

  const diversificationLong = divDetails.join(' ');
  // Short version: most salient fact only
  const diversificationShort = `Top holding: ${topPositionPct.toFixed(0)}% · ${numPositions} positions · ${geoCount} regions.`;

  // ══════════════════════════════════════════════════════════════════════════
  // ── Dimension 6: Risk-Adjusted Performance (portfolio-only) ─────────────
  // ══════════════════════════════════════════════════════════════════════════
  let perfScore;
  let perfShort = '';
  let perfLong = '';

  if (portfolioSharpe !== null) {
    perfScore = sigmoidScore(Math.max(0, 1.2 - portfolioSharpe), 0.8, 3.5);
    const sharpeStr = portfolioSharpe.toFixed(2);
    if (portfolioSharpe >= 1.5) {
      perfShort = `Excellent Sharpe ratio (${sharpeStr}).`;
      perfLong  = `Excellent risk-adjusted returns — Sharpe ratio of ${sharpeStr}. Your returns comfortably justify the risk you're taking.`;
    } else if (portfolioSharpe >= 1.0) {
      perfShort = `Good Sharpe ratio (${sharpeStr}).`;
      perfLong  = `Good risk-adjusted returns — Sharpe ratio of ${sharpeStr}. Solid performance relative to portfolio volatility.`;
    } else if (portfolioSharpe >= 0.5) {
      perfShort = `Moderate Sharpe ratio (${sharpeStr}).`;
      perfLong  = `Moderate risk-adjusted returns — Sharpe ratio of ${sharpeStr}. Consider whether the volatility is worth the returns, or if a simpler allocation could achieve similar results with less risk.`;
    } else if (portfolioSharpe >= 0) {
      perfShort = `Below-average Sharpe ratio (${sharpeStr}).`;
      perfLong  = `Below-average risk-adjusted returns — Sharpe ratio of ${sharpeStr}. You're earning above the risk-free rate, but the return doesn't fully compensate for the volatility. Reducing high-volatility, low-return positions could help.`;
    } else {
      perfShort = `Negative Sharpe ratio (${sharpeStr}).`;
      perfLong  = `Negative Sharpe ratio (${sharpeStr}) — returns below the risk-free rate. The portfolio is taking on risk without adequate compensation. Review your worst-performing and most volatile positions.`;
    }
  } else {
    perfScore = 50;
    perfShort = 'Not enough data for Sharpe calculation.';
    perfLong  = 'Not enough historical data to assess risk-adjusted performance. More trading days are needed for a reliable Sharpe ratio.';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Composite grade ─────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  const subs = [
    { name: 'Risk Alignment',        score: Math.round(riskScore),            detail: riskShort,            improvementDetail: riskLong },
    { name: 'Goal Alignment',        score: Math.round(goalScore),            detail: goalShort,            improvementDetail: goalLong },
    { name: 'Horizon Fit',           score: Math.round(horizonScore),         detail: horizonShort,         improvementDetail: horizonLong },
    { name: 'Structure Match',       score: Math.round(structureScore),       detail: structureShort,       improvementDetail: structureLong },
    { name: 'Diversification',       score: Math.round(diversificationScore), detail: diversificationShort, improvementDetail: diversificationLong },
    { name: 'Risk-Adj. Performance', score: Math.round(perfScore),            detail: perfShort,            improvementDetail: perfLong },
  ];

  // Map numeric score → letter grade
  subs.forEach(s => { s.grade = scoreToGrade(s.score); });

  // Weighted composite
  const weights = [0.20, 0.18, 0.15, 0.12, 0.20, 0.15];
  const overallScore = Math.round(subs.reduce((s, sub, i) => s + sub.score * weights[i], 0));
  const overall = scoreToGrade(overallScore);

  // ── Narrative ─────────────────────────────────────────────────────────
  const strengths = subs.filter(s => s.score >= 80).sort((a, b) => b.score - a.score);
  // Areas to improve: B- and below (score < 80), always shown unless empty
  const improvable = subs.filter(s => s.score < 80).sort((a, b) => a.score - b.score);

  let strengthsHtml = '';
  if (strengths.length > 0) {
    // Use the long/detailed version for the strengths narrative (with figures),
    // keeping the short version only in the grade sub-cards below.
    const lines = strengths.slice(0, 3).map(s => (s.improvementDetail || s.detail).trim()).filter(Boolean);
    strengthsHtml = `<strong>Strengths</strong><br>` + lines.map(l => `• ${l}`).join('<br>');
  }

  let improvementsHtml = '';
  if (improvable.length > 0) {
    const lines = improvable.slice(0, 4)
      .map(s => {
        const txt = (s.improvementDetail || s.detail).trim();
        return txt ? `${s.name} (${s.grade}): ${txt}` : null;
      })
      .filter(Boolean);
    if (lines.length > 0) {
      improvementsHtml = `<strong>Areas to improve</strong><br>` + lines.map(l => `• ${l}`).join('<br>');
    }
  }

  // ── Key metrics with survey-aware color ───────────────────────────────
  const mc = (label, raw) => {
    switch (label) {
      case 'Sharpe Ratio': {
        if (raw >= 1.2) return '#2ACA69';
        if (raw >= 0.8) return '#8BE06A';
        if (raw >= 0.5) return '#E8C832';
        if (raw >= 0)   return '#F97316';
        return '#E05252';
      }
      case 'Largest Holding': {
        if (raw <= 10) return '#2ACA69';
        if (raw <= 20) return '#8BE06A';
        if (raw <= 30) return '#E8C832';
        if (raw <= 50) return '#F97316';
        return '#E05252';
      }
      case 'Positions': {
        const c = answers.complexity;
        if (c <= 3) return raw <= 6 ? '#2ACA69' : raw <= 10 ? '#E8C832' : '#F97316';
        if (c <= 6) return raw >= 6 && raw <= 20 ? '#2ACA69' : raw >= 4 ? '#8BE06A' : '#E8C832';
        return raw >= 12 ? '#2ACA69' : raw >= 6 ? '#8BE06A' : '#E8C832';
      }
      case 'Dividend Yield': {
        const g = answers.goal;
        if (g <= 3) return raw >= 3 ? '#2ACA69' : raw >= 1.5 ? '#8BE06A' : raw >= 0.5 ? '#E8C832' : '#E05252';
        if (g >= 7) return '#8B9BB4'; // neutral for growth-focused
        return raw >= 1.5 ? '#2ACA69' : raw >= 0.5 ? '#8BE06A' : '#E8C832';
      }
      case 'Asset Classes':
        if (raw >= 4) return '#2ACA69';
        if (raw >= 3) return '#8BE06A';
        if (raw >= 2) return '#E8C832';
        return '#F97316';
      case 'Regions':
        if (raw >= 5) return '#2ACA69';
        if (raw >= 4) return '#8BE06A';
        if (raw >= 3) return '#E8C832';
        if (raw >= 2) return '#F97316';
        return '#E05252';
      case 'Trades / Month': {
        const inv = answers.involvement;
        if (inv <= 3) return raw <= 1 ? '#2ACA69' : raw <= 3 ? '#8BE06A' : raw <= 6 ? '#E8C832' : '#E05252';
        if (inv >= 7) return raw >= 15 ? '#2ACA69' : raw >= 8 ? '#8BE06A' : raw >= 3 ? '#E8C832' : '#F97316';
        return raw >= 2 && raw <= 10 ? '#2ACA69' : raw >= 1 ? '#8BE06A' : '#E8C832';
      }
      case 'Avg Correlation': {
        if (raw < 0.3)  return '#2ACA69';
        if (raw <= 0.6) return '#E8C832';
        return '#E05252';
      }
      default: return '';
    }
  };

  // Always exactly 8 metrics — 4 columns × 2 rows.
  // Row 1: Sharpe · Positions · Largest Holding · Avg Correlation (WAC)
  // Row 2: Dividend Yield · Asset Classes · Regions · Trades / Month
  const wacVal = gd.insightWAC ?? null;
  const keyMetrics = [];
  // Row 1
  keyMetrics.push(portfolioSharpe !== null
    ? { label: 'Sharpe Ratio',    value: portfolioSharpe.toFixed(2),                           color: mc('Sharpe Ratio',    portfolioSharpe) }
    : { label: 'Sharpe Ratio',    value: 'N/A',                                                 color: '#8B9BB4' });
  keyMetrics.push({ label: 'Positions',       value: String(numPositions),                      color: mc('Positions',       numPositions) });
  keyMetrics.push({ label: 'Largest Holding', value: topPositionPct.toFixed(0) + '%',           color: mc('Largest Holding', topPositionPct) });
  keyMetrics.push(wacVal !== null
    ? { label: 'Avg Correlation', value: (wacVal >= 0 ? '+' : '') + wacVal.toFixed(2),          color: mc('Avg Correlation', wacVal) }
    : { label: 'Top-3 Weight',    value: top3Pct.toFixed(0) + '%',                              color: mc('Largest Holding', top3Pct * 0.6) });
  // Row 2
  keyMetrics.push({ label: 'Dividend Yield',  value: divYield.toFixed(1) + '%',                 color: mc('Dividend Yield',  divYield) });
  keyMetrics.push({ label: 'Asset Classes',   value: String(Object.keys(assetClasses).length),  color: mc('Asset Classes',   Object.keys(assetClasses).length) });
  keyMetrics.push({ label: 'Regions',         value: String(geoCount),                          color: mc('Regions',         geoCount) });
  keyMetrics.push({ label: 'Trades / Month',  value: tradesPerMonth > 0 ? tradesPerMonth.toFixed(1) : '0', color: mc('Trades / Month', tradesPerMonth) });

  return { overall, overallScore, subs, strengthsHtml, improvementsHtml, keyMetrics };
}

function scoreToGrade(score) {
  if (score >= 97) return 'A+';
  if (score >= 93) return 'A';
  if (score >= 90) return 'A−';
  if (score >= 87) return 'B+';
  if (score >= 83) return 'B';
  if (score >= 80) return 'B−';
  if (score >= 77) return 'C+';
  if (score >= 73) return 'C';
  if (score >= 70) return 'C−';
  if (score >= 67) return 'D+';
  if (score >= 60) return 'D';
  if (score >= 50) return 'D−';
  return 'F';
}

function gradeColorClass(grade) {
  const map = {
    'A+': 'grade-a-plus', 'A': 'grade-a', 'A−': 'grade-a-minus',
    'B+': 'grade-b-plus', 'B': 'grade-b', 'B−': 'grade-b-minus',
    'C+': 'grade-c-plus', 'C': 'grade-c', 'C−': 'grade-c-minus',
    'D+': 'grade-d-plus', 'D': 'grade-d', 'D−': 'grade-d-minus',
    'F': 'grade-f',
  };
  return map[grade] || '';
}

function gradeBarColor(score) {
  if (score >= 93) return '#2ACA69';
  if (score >= 87) return '#5CD87A';
  if (score >= 83) return '#8BE06A';
  if (score >= 80) return '#B8E04A';
  if (score >= 77) return '#D4D63A';
  if (score >= 73) return '#E8C832';
  if (score >= 67) return '#FFB82E';
  if (score >= 60) return '#F9972A';
  if (score >= 50) return '#F97316';
  return '#E05252';
}

function renderGradeResults(gradeData, container) {
  container.innerHTML = '';
  container.dataset.rendered = '1';

  // ── Top row: Grade letter + narrative (left) | Key metrics (right) ──
  const topRow = document.createElement('div');
  topRow.className = 'grade-top-row';

  // Left column: grade letter + text column side by side
  const leftCol = document.createElement('div');
  leftCol.className = 'grade-left-col';

  const letterRow = document.createElement('div');
  letterRow.className = 'grade-letter-row';

  // Big grade letter
  const letterWrap = document.createElement('div');
  letterWrap.className = 'grade-letter-wrap';
  const letter = document.createElement('div');
  letter.className = 'grade-letter ' + gradeColorClass(gradeData.overall);
  letter.textContent = gradeData.overall;
  const letterLabel = document.createElement('div');
  letterLabel.className = 'grade-letter-label';
  letterLabel.textContent = 'Overall Grade';
  letterWrap.append(letter, letterLabel);

  // Text column: strengths + improvements at the same indent
  const textCol = document.createElement('div');
  textCol.className = 'grade-text-col';

  if (gradeData.strengthsHtml) {
    const strengthsWrap = document.createElement('div');
    strengthsWrap.className = 'grade-narrative-section';
    strengthsWrap.innerHTML = gradeData.strengthsHtml;
    textCol.appendChild(strengthsWrap);
  }

  if (gradeData.improvementsHtml) {
    const improvWrap = document.createElement('div');
    improvWrap.className = 'grade-narrative-section grade-improvements';
    improvWrap.innerHTML = gradeData.improvementsHtml;
    textCol.appendChild(improvWrap);
  }

  letterRow.append(letterWrap, textCol);
  leftCol.appendChild(letterRow);

  // Right column: key metrics in 3 columns
  const rightCol = document.createElement('div');
  rightCol.className = 'grade-metrics-col';

  gradeData.keyMetrics.forEach(m => {
    const box = document.createElement('div');
    box.className = 'grade-metric-box';
    const val = document.createElement('div');
    val.className = 'grade-metric-value';
    val.style.color = m.color || 'var(--text)';
    val.textContent = m.value;
    const lbl = document.createElement('div');
    lbl.className = 'grade-metric-label';
    lbl.textContent = m.label;

    box.append(val, lbl);
    rightCol.appendChild(box);
  });

  // ── Analysis section (narratives, metrics, sub-grades) ──
  const analysisWrap = document.createElement('div');
  analysisWrap.className = 'grade-analysis-wrap';

  topRow.append(leftCol, rightCol);
  analysisWrap.appendChild(topRow);

  // ── Sub-grades grid ──
  const subsGrid = document.createElement('div');
  subsGrid.className = 'grade-subs';

  gradeData.subs.forEach(sub => {
    const card = document.createElement('div');
    card.className = 'grade-sub';

    const nameEl = document.createElement('div');
    nameEl.className = 'grade-sub-name';
    nameEl.textContent = sub.name;

    const letterEl = document.createElement('div');
    letterEl.className = 'grade-sub-letter ' + gradeColorClass(sub.grade);
    letterEl.textContent = sub.grade;

    const bar = document.createElement('div');
    bar.className = 'grade-sub-bar';
    const barInner = document.createElement('div');
    barInner.className = 'grade-sub-bar-inner';
    barInner.style.width = (sub.grade === 'A+' ? 100 : sub.score) + '%';
    barInner.style.background = gradeBarColor(sub.score);
    bar.appendChild(barInner);

    const detail = document.createElement('div');
    detail.className = 'grade-sub-detail';
    detail.textContent = sub.detail;

    card.append(nameEl, letterEl, bar, detail);
    subsGrid.appendChild(card);
  });

  analysisWrap.appendChild(subsGrid);

  // ── Free users: show grade letter + teaser, blur the analysis ──
  if (!proUnlocked) {
    // Grade letter reveal (above the blurred section)
    const revealWrap = document.createElement('div');
    revealWrap.className = 'grade-reveal';

    const revealLetter = document.createElement('div');
    revealLetter.className = 'grade-letter ' + gradeColorClass(gradeData.overall);
    revealLetter.textContent = gradeData.overall;
    const revealLabel = document.createElement('div');
    revealLabel.className = 'grade-letter-label';
    revealLabel.textContent = 'Your Portfolio Grade';

    // Dynamic teaser — specific enough to be compelling, vague enough to require upgrade
    const sortedSubs = [...gradeData.subs].sort((a, b) => a.score - b.score);
    const weakest = sortedSubs[0];
    const strongest = sortedSubs[sortedSubs.length - 1];
    const weakCount = sortedSubs.filter(s => s.score < 50).length;
    const strongCount = sortedSubs.filter(s => s.score >= 70).length;

    let teaser = '';
    if (strongCount > 0 && weakCount > 0) {
      teaser = `Your portfolio scores well in ${strongCount} area${strongCount > 1 ? 's' : ''} but has ${weakCount} critical weakness${weakCount > 1 ? 'es' : ''} holding back your grade.`;
    } else if (weakCount > 0) {
      teaser = `We found ${weakCount} area${weakCount > 1 ? 's' : ''} where your portfolio falls short — unlock the full analysis to see what to fix.`;
    } else if (strongCount === sortedSubs.length) {
      teaser = `Your portfolio is strong across all dimensions — see the detailed breakdown to find out exactly where you excel.`;
    } else {
      teaser = `Your portfolio has room to improve in ${sortedSubs.length - strongCount} areas — unlock the full analysis for personalised recommendations.`;
    }

    // Add a hint about the weakest area without naming the specific metric
    if (weakest.score < 40 && strongest.score >= 60) {
      teaser += ` Your weakest dimension scored ${weakest.score}/100.`;
    }

    const teaserEl = document.createElement('div');
    teaserEl.className = 'grade-teaser';
    teaserEl.textContent = teaser;

    revealWrap.append(revealLetter, revealLabel, teaserEl);
    container.appendChild(revealWrap);

    // Blurred analysis with Pro overlay
    const gateWrap = document.createElement('div');
    gateWrap.className = 'grade-gate-wrap';
    gateWrap.style.position = 'relative';

    analysisWrap.classList.add('corr-blur-wrap');
    gateWrap.appendChild(analysisWrap);
    container.appendChild(gateWrap);
    showProOverlay(gateWrap, 'Full Analysis');

    // Retake button
    const retake = document.createElement('button');
    retake.className = 'grade-retake';
    retake.textContent = '↻ Retake survey';
    retake.addEventListener('click', () => {
      container.style.display = 'none';
      document.getElementById('gradeSurvey').style.display = 'block';
    });
    container.appendChild(retake);
    return;
  }

  container.appendChild(analysisWrap);

  // Retake button
  const retake = document.createElement('button');
  retake.className = 'grade-retake';
  retake.textContent = '↻ Retake survey';
  retake.addEventListener('click', () => {
    container.style.display = 'none';
    document.getElementById('gradeSurvey').style.display = 'block';
  });
  container.appendChild(retake);
}

// ══════════════════════════════════════════════════════════════════════════════
// ██  STRESS TEST SCENARIO ANALYSIS
// ══════════════════════════════════════════════════════════════════════════════

// ── Scenario definitions ─────────────────────────────────────────────────────
// Each scenario defines factor shocks keyed by "AssetClass:Geography".
// Lookup priority: exact match → AssetClass:* wildcard → benchmark fallback.
// Shocks are in percent (−30 = a 30% drop).
//
// Historical shocks sourced from index drawdowns during each event window.
// Hypothetical shocks modelled from analogous historical events, sector
// concentration studies, and geopolitical risk research.

const STRESS_SCENARIOS = [
  // ── Historical ────────────────────────────────────────────────────────────
  {
    id: 'covid_2020',
    name: 'COVID-19 Crash',
    type: 'historical',
    period: 'Feb 19 – Mar 23, 2020',
    startDate: '2020-02-19',
    endDate: '2020-03-23',
    description: 'Global pandemic triggers the fastest bear market in history. Broad-based liquidation across equities and commodities. Flight to government bonds.',
    shocks: {
      'Equity:USA': -34, 'Equity:Europe': -38, 'Equity:UK': -34,
      'Equity:Japan': -29, 'Equity:China': -15, 'Equity:Asia-Pacific': -28,
      'Equity:Emerging': -31, 'Equity:India': -38, 'Equity:Latin America': -46,
      'Equity:Global': -34, 'Equity:Canada': -34, 'Equity:Switzerland': -25,
      'Equity:Australia': -36, 'Equity:Other': -32,
      'Bonds:*': +1, 'Commodities:*': -25, 'Real Estate:*': -42,
      'Money Market:*': 0, 'Derivatives:*': -50,
    },
    benchmark: -34,
  },
  {
    id: 'rate_hike_2022',
    name: '2022 Rate Hike Cycle',
    type: 'historical',
    period: 'Jan 3 – Oct 12, 2022',
    startDate: '2022-01-03',
    endDate: '2022-10-12',
    description: 'Aggressive central bank tightening crushes both stocks and bonds simultaneously — the worst year for a 60/40 portfolio in modern history.',
    shocks: {
      'Equity:USA': -25, 'Equity:Europe': -22, 'Equity:UK': -8,
      'Equity:Japan': -11, 'Equity:China': -32, 'Equity:Asia-Pacific': -22,
      'Equity:Emerging': -28, 'Equity:India': -10, 'Equity:Latin America': -5,
      'Equity:Global': -26, 'Equity:Canada': -16, 'Equity:Switzerland': -20,
      'Equity:Australia': -12, 'Equity:Other': -20,
      'Bonds:*': -18, 'Commodities:*': +8, 'Real Estate:*': -32,
      'Money Market:*': +0.5, 'Derivatives:*': -30,
    },
    benchmark: -25,
  },
  {
    id: 'liberation_day_2025',
    name: 'Liberation Day Tariffs',
    type: 'historical',
    period: 'Apr 2 – Apr 9, 2025',
    startDate: '2025-04-02',
    endDate: '2025-04-09',
    description: 'Sweeping US tariff announcements trigger a sharp global sell-off. Trade-dependent sectors and Asian exporters hit hardest. Bonds rally on recession fears.',
    shocks: {
      'Equity:USA': -12, 'Equity:Europe': -14, 'Equity:UK': -10,
      'Equity:Japan': -9, 'Equity:China': -8, 'Equity:Asia-Pacific': -11,
      'Equity:Emerging': -13, 'Equity:India': -6, 'Equity:Latin America': -10,
      'Equity:Global': -12, 'Equity:Canada': -12, 'Equity:Switzerland': -8,
      'Equity:Australia': -10, 'Equity:Other': -11,
      'Bonds:*': +2, 'Commodities:*': -8, 'Real Estate:*': -10,
      'Money Market:*': 0, 'Derivatives:*': -18,
    },
    benchmark: -12,
  },

  // ── Hypothetical ──────────────────────────────────────────────────────────
  {
    id: 'ai_bubble',
    name: 'AI Bubble Burst',
    type: 'hypothetical',
    period: null,
    startDate: null,
    endDate: null,
    description: 'A dot-com style collapse in AI valuations. Tech mega-caps fall 50%+, dragging down indices with heavy tech weightings. Money rotates into bonds, gold, and value stocks.',
    shocks: {
      'Equity:USA': -35, 'Equity:Europe': -20, 'Equity:UK': -15,
      'Equity:Japan': -25, 'Equity:China': -18, 'Equity:Asia-Pacific': -22,
      'Equity:Emerging': -18, 'Equity:India': -15, 'Equity:Latin America': -14,
      'Equity:Global': -30, 'Equity:Canada': -22, 'Equity:Switzerland': -16,
      'Equity:Australia': -14, 'Equity:Other': -18,
      'Bonds:*': +5, 'Commodities:*': -10, 'Real Estate:*': -15,
      'Money Market:*': +0.5, 'Derivatives:*': -55,
    },
    // Sector multipliers on base geographic shock — AI crash punishes tech, spares defensives
    sectorOverrides: {
      'Technology': 1.6,        // tech is ground zero
      'Utilities': 0.25,        // defensive, dividend-paying — money rotates IN
      'Healthcare': 0.35,       // defensive, non-cyclical
      'Consumer Staples': 0.3,  // essential spending, safe haven rotation
      'Defence': 0.5,           // less correlated, government spending stable
      'Financials': 0.7,        // moderate — bank exposure to tech loans
      'Energy': 0.5,            // traditional energy largely unaffected
    },
    benchmark: -35,
  },
  {
    id: 'taiwan_invasion',
    name: 'Chinese Invasion of Taiwan',
    type: 'hypothetical',
    period: null,
    startDate: null,
    endDate: null,
    description: 'A military conflict disrupts the global semiconductor supply chain. Asian markets collapse, energy prices spike, and Western sanctions trigger broad economic uncertainty.',
    shocks: {
      'Equity:USA': -28, 'Equity:Europe': -22, 'Equity:UK': -18,
      'Equity:Japan': -35, 'Equity:China': -50, 'Equity:Asia-Pacific': -40,
      'Equity:Emerging': -32, 'Equity:India': -20, 'Equity:Latin America': -18,
      'Equity:Global': -30, 'Equity:Canada': -18, 'Equity:Switzerland': -14,
      'Equity:Australia': -25, 'Equity:Other': -25,
      'Bonds:*': +8, 'Commodities:*': +20, 'Real Estate:*': -18,
      'Money Market:*': +1, 'Derivatives:*': -45,
    },
    // Semiconductor supply chain devastation hits tech; defence benefits from war spending
    sectorOverrides: {
      'Technology': 1.5,        // semiconductor shortage cascades through supply chains
      'Defence': -0.5,          // negative = they GAIN (defence stocks rally on conflict)
      'Energy': 0.4,            // traditional energy benefits from commodity spike
      'Utilities': 0.6,         // domestic, regulated — relatively insulated
      'Healthcare': 0.6,        // non-cyclical, some upside from defensive rotation
      'Consumer Staples': 0.65, // essential spending but supply chain disruption
      'Financials': 1.1,        // sanctions exposure, trade finance disruption
    },
    benchmark: -28,
  },
  {
    id: 'eu_debt_crisis',
    name: 'European Sovereign Debt Crisis 2.0',
    type: 'hypothetical',
    period: null,
    startDate: null,
    endDate: null,
    description: 'A major EU member triggers a sovereign debt scare. European bonds and equities sell off together, the euro weakens, and contagion spreads to global banks. Modelled on the 2011–12 crisis at greater severity.',
    shocks: {
      'Equity:USA': -15, 'Equity:Europe': -38, 'Equity:UK': -14,
      'Equity:Japan': -10, 'Equity:China': -10, 'Equity:Asia-Pacific': -12,
      'Equity:Emerging': -18, 'Equity:India': -12, 'Equity:Latin America': -16,
      'Equity:Global': -22, 'Equity:Canada': -12, 'Equity:Switzerland': -10,
      'Equity:Australia': -10, 'Equity:Other': -15,
      'Bonds:*': -20, 'Commodities:*': -8, 'Real Estate:*': -30,
      'Money Market:*': -2, 'Derivatives:*': -35,
    },
    // Sovereign contagion hammers financials; defensives fare comparatively better
    sectorOverrides: {
      'Financials': 1.5,        // banks are the transmission mechanism of sovereign contagion
      'Utilities': 0.7,         // regulated, but government funding risk rises
      'Healthcare': 0.6,        // non-cyclical, less exposed to sovereign risk
      'Consumer Staples': 0.65, // essential, but euro weakness hits margins
      'Technology': 0.8,        // less affected than broad market, global revenue
      'Defence': 0.75,          // government spending at risk in austerity
      'Energy': 0.7,            // global commodity pricing offsets local weakness
    },
    benchmark: -22,
  },
];

// ── Estimation engine ────────────────────────────────────────────────────────

/**
 * Estimate a single position's shock under a scenario.
 * Path 1: If 5Y price history covers the scenario window, use actual returns.
 * Path 2: Otherwise, estimate from asset class × geography factor shocks.
 * Returns { shock (%), source ('actual'|'estimated') }
 */
function estimatePositionShock(position, scenario, priceHistories) {
  // Path 1: try actual historical data
  if (scenario.startDate && scenario.endDate && priceHistories) {
    const history = priceHistories[position.id];
    if (history && history.length > 10) {
      // Binary search for closest price on or before a date
      const findPrice = (targetDate) => {
        let lo = 0, hi = history.length - 1, best = null;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (history[mid].date <= targetDate) { best = history[mid].price; lo = mid + 1; }
          else hi = mid - 1;
        }
        return best;
      };
      const startPrice = findPrice(scenario.startDate);
      const endPrice = findPrice(scenario.endDate);
      if (startPrice && endPrice && startPrice > 0) {
        return { shock: ((endPrice - startPrice) / startPrice) * 100, source: 'actual' };
      }
    }
  }

  // Path 2: factor-based estimation
  const assetClass = inferAssetClass(position);
  const geo = inferGeo(position);

  // Try exact key, then wildcard, then benchmark
  const shocks = scenario.shocks;
  let shock = shocks[`${assetClass}:${geo}`]
    ?? shocks[`${assetClass}:*`]
    ?? shocks[`Equity:${geo}`]  // fallback: use equity shock for that region
    ?? scenario.benchmark;

  // Apply sector-level override for equities (e.g. utilities vs tech in AI crash)
  // Multiplier scales the base shock: 0.25 = 25% of impact (defensive), 1.5 = 150% (exposed)
  // Negative multiplier flips sign: -0.5 on a -22% shock → +11% gain (e.g. defence in conflict)
  if (assetClass === 'Equity' && scenario.sectorOverrides) {
    const sector = inferSector(position);
    if (sector && scenario.sectorOverrides[sector] !== undefined) {
      shock = shock * scenario.sectorOverrides[sector];
    }
  }

  return { shock: Math.round(shock * 10) / 10, source: 'estimated' };
}

/**
 * Compute the full portfolio impact for a single scenario.
 * Returns { portfolioShock, eurLoss, positionImpacts[], worstPositions[], bestPositions[] }
 */
function computeStressTest(positions, scenario, priceHistories) {
  const totalValue = positions.reduce((s, p) => s + p.value, 0);
  if (totalValue === 0) return null;

  let portfolioShock = 0;
  const positionImpacts = [];

  for (const p of positions) {
    const weight = p.value / totalValue;
    const { shock, source } = estimatePositionShock(p, scenario, priceHistories);
    const eurImpact = p.value * (shock / 100);

    portfolioShock += weight * shock;
    positionImpacts.push({
      id: p.id,
      name: p.name || 'ID ' + p.id,
      weight,
      shock: Math.round(shock * 10) / 10,
      eurImpact: Math.round(eurImpact),
      value: p.value,
      source,
      assetClass: inferAssetClass(p),
      geo: inferGeo(p),
    });
  }

  positionImpacts.sort((a, b) => a.shock - b.shock);

  return {
    scenario,
    portfolioShock: Math.round(portfolioShock * 10) / 10,
    eurLoss: Math.round(totalValue * (portfolioShock / 100)),
    totalValue,
    positionImpacts,
    worstPositions: positionImpacts.slice(0, 5),
    bestPositions: [...positionImpacts].sort((a, b) => b.shock - a.shock).slice(0, 3),
    actualCount: positionImpacts.filter(p => p.source === 'actual').length,
    totalCount: positionImpacts.length,
  };
}

// ── Mitigation generator ─────────────────────────────────────────────────────

function generateMitigations(impact, positions) {
  const suggestions = [];
  const totalValue = impact.totalValue;
  const scenario = impact.scenario;
  const posImpacts = impact.positionImpacts;

  // Precompute portfolio breakdown
  const geoExposure = {};
  const assetExposure = {};
  posImpacts.forEach(p => {
    geoExposure[p.geo] = (geoExposure[p.geo] || 0) + p.value;
    assetExposure[p.assetClass] = (assetExposure[p.assetClass] || 0) + p.value;
  });
  const geoEntries = Object.entries(geoExposure).sort((a, b) => b[1] - a[1]);
  const equityPct = ((assetExposure['Equity'] || 0) / totalValue) * 100;
  const bondsPct = ((assetExposure['Bonds'] || 0) / totalValue) * 100;
  const mmPct = ((assetExposure['Money Market'] || 0) / totalValue) * 100;
  const defensivePct = bondsPct + mmPct;
  const commodityPct = ((assetExposure['Commodities'] || 0) / totalValue) * 100;
  const rePct = ((assetExposure['Real Estate'] || 0) / totalValue) * 100;
  const totalLoss = Math.abs(impact.eurLoss);

  // 1. Concentration risk: top contributor > 25% of total loss
  if (impact.worstPositions.length > 0 && totalLoss > 0) {
    const worstLoss = Math.abs(impact.worstPositions[0].eurImpact);
    const worstPct = (worstLoss / totalLoss) * 100;
    if (worstPct > 25) {
      suggestions.push({
        sentiment: 'negative',
        text: `${impact.worstPositions[0].name} alone accounts for ${worstPct.toFixed(0)}% of the projected loss (${fmtEur(impact.worstPositions[0].eurImpact)}). Reducing this position or hedging with a less correlated asset would lower your exposure to this scenario.`,
      });
    }
  }

  // 2. Geographic concentration
  if (geoEntries.length > 0) {
    const topGeo = geoEntries[0];
    const topGeoPct = (topGeo[1] / totalValue) * 100;
    const topGeoShock = scenario.shocks[`Equity:${topGeo[0]}`] ?? scenario.benchmark;
    if (topGeoPct > 60 && topGeoShock < -15) {
      const lessHitGeos = geoEntries
        .filter(([geo]) => (scenario.shocks[`Equity:${geo}`] ?? scenario.benchmark) > topGeoShock + 10)
        .map(([geo]) => geo);
      const diversifyTo = lessHitGeos.length > 0
        ? ` Regions like ${lessHitGeos.slice(0, 2).join(' and ')} would be less affected.`
        : '';
      suggestions.push({
        sentiment: 'negative',
        text: `${topGeoPct.toFixed(0)}% of your portfolio is concentrated in ${topGeo[0]}, which drops ${topGeoShock}% in this scenario. Diversifying geographically would significantly reduce impact.${diversifyTo}`,
      });
    }
  }

  // ── Scenario-specific insights ───────────────────────────────────────────

  if (scenario.id === 'covid_2020') {
    // COVID: bonds rally, cash is king, V-shaped recovery potential
    const bondShock = scenario.shocks['Bonds:*'] ?? 0;
    if (defensivePct < 10) {
      suggestions.push({
        sentiment: 'negative',
        text: `Only ${defensivePct.toFixed(0)}% of your portfolio is in defensive assets. During COVID, government bonds gained ${bondShock > 0 ? '+' : ''}${bondShock}% while equities fell 34%. A 15–20% bond allocation would cushion pandemic-style shocks.`,
      });
    } else if (defensivePct >= 10) {
      suggestions.push({
        sentiment: 'positive',
        text: `Your ${defensivePct.toFixed(0)}% allocation to defensive assets helps here — bonds rallied ${bondShock > 0 ? '+' : ''}${bondShock}% during the COVID crash as a flight-to-safety trade.`,
      });
    }
    // Real estate warning
    if (rePct > 5) {
      suggestions.push({
        sentiment: 'negative',
        text: `Your ${rePct.toFixed(0)}% real estate exposure faces a –42% shock in this scenario. Lockdowns and commercial vacancy fears hit REITs especially hard during the pandemic.`,
      });
    }
    // Recovery note — broad equity exposure is actually good for the rebound
    if (equityPct > 70) {
      suggestions.push({
        sentiment: 'positive',
        text: `While equity-heavy portfolios suffer the initial drawdown, the COVID recovery was V-shaped — the S&P 500 recovered its losses within 5 months. High equity exposure means you would also benefit most from the rebound.`,
      });
    }
  }

  if (scenario.id === 'rate_hike_2022') {
    // Unique: bonds and equities fall together, commodities gain, duration matters
    if (bondsPct > 10) {
      suggestions.push({
        sentiment: 'negative',
        text: `The 2022 rate hike uniquely hit both stocks and bonds (bonds dropped ${scenario.shocks['Bonds:*']}%). Your ${bondsPct.toFixed(0)}% bond allocation would not protect you here. Short-duration bonds or floating-rate instruments are better hedges against rate hikes.`,
      });
    }
    if (commodityPct > 3) {
      suggestions.push({
        sentiment: 'positive',
        text: `Your ${commodityPct.toFixed(0)}% commodity exposure is a bright spot — commodities gained ${scenario.shocks['Commodities:*'] > 0 ? '+' : ''}${scenario.shocks['Commodities:*']}% during 2022's rate cycle as inflation-linked assets benefited.`,
      });
    } else {
      suggestions.push({
        sentiment: 'negative',
        text: `Commodity exposure is only ${commodityPct.toFixed(0)}%. Commodities gained +8% during the 2022 rate hike as inflation-linked assets outperformed. A small allocation to commodity ETFs could act as an inflation hedge.`,
      });
    }
    // UK/LatAm held up relatively well
    const ukPct = ((geoExposure['UK'] || 0) / totalValue) * 100;
    const latamPct = ((geoExposure['Latin America'] || 0) / totalValue) * 100;
    if (ukPct > 5 || latamPct > 3) {
      const resilient = [];
      if (ukPct > 5) resilient.push(`UK (–8%)`);
      if (latamPct > 3) resilient.push(`Latin America (–5%)`);
      suggestions.push({
        sentiment: 'positive',
        text: `Your exposure to ${resilient.join(' and ')} is beneficial — these value-tilted markets held up relatively well during the rate hike cycle compared to growth-heavy indices.`,
      });
    }
  }

  if (scenario.id === 'liberation_day_2025') {
    // Short, sharp shock. Trade-dependent sectors hit hardest. Bonds rally.
    const europePct = ((geoExposure['Europe'] || 0) / totalValue) * 100;
    if (europePct > 40) {
      suggestions.push({
        sentiment: 'negative',
        text: `${europePct.toFixed(0)}% of your portfolio is in European equities, which drop –14% in this scenario as trade-dependent exporters are hit by tariff uncertainty. Sectors with high US revenue exposure would be especially affected.`,
      });
    }
    const bondShock = scenario.shocks['Bonds:*'] ?? 0;
    if (defensivePct >= 10) {
      suggestions.push({
        sentiment: 'positive',
        text: `Your ${defensivePct.toFixed(0)}% in defensive assets provides a buffer — bonds rally ${bondShock > 0 ? '+' : ''}${bondShock}% on recession fears following tariff escalation.`,
      });
    } else {
      suggestions.push({
        sentiment: 'negative',
        text: `Only ${defensivePct.toFixed(0)}% in defensive assets. Bonds gained +2% during the Liberation Day sell-off as markets priced in recession. Some bond exposure would soften this type of short, sharp shock.`,
      });
    }
    // Swiss/India resilience
    const chPct = ((geoExposure['Switzerland'] || 0) / totalValue) * 100;
    const inPct = ((geoExposure['India'] || 0) / totalValue) * 100;
    if (chPct > 3 || inPct > 3) {
      const resilient = [];
      if (chPct > 3) resilient.push(`Switzerland (–8%)`);
      if (inPct > 3) resilient.push(`India (–6%)`);
      suggestions.push({
        sentiment: 'positive',
        text: `Your exposure to ${resilient.join(' and ')} helps — these domestically-oriented markets are less affected by US trade policy shocks.`,
      });
    }
  }

  if (scenario.id === 'ai_bubble') {
    // Tech-heavy portfolios are most exposed. Value rotation benefits non-US.
    const usGlobalPositions = posImpacts.filter(p =>
      p.assetClass === 'Equity' && (p.geo === 'USA' || p.geo === 'Global')
    );
    const techWeight = usGlobalPositions.reduce((s, p) => s + p.weight, 0) * 100;
    if (techWeight > 40) {
      suggestions.push({
        sentiment: 'negative',
        text: `${techWeight.toFixed(0)}% of your portfolio is in US/Global equities — ground zero for an AI valuation correction. US indices with heavy tech weighting (S&P 500 is ~35% tech) would drop significantly. Consider whether this exposure reflects conviction or index drift.`,
      });
    }
    const europePct = ((geoExposure['Europe'] || 0) / totalValue) * 100;
    const ukPct = ((geoExposure['UK'] || 0) / totalValue) * 100;
    if (europePct > 15 || ukPct > 10) {
      suggestions.push({
        sentiment: 'positive',
        text: `Your European${ukPct > 10 ? ' and UK' : ''} equity exposure would be relatively resilient — these markets have lower tech concentration and would benefit from a rotation into value stocks. Europe drops only –20% vs –35% for the US in this scenario.`,
      });
    }
    const bondShock = scenario.shocks['Bonds:*'] ?? 0;
    if (defensivePct >= 10) {
      suggestions.push({
        sentiment: 'positive',
        text: `Your ${defensivePct.toFixed(0)}% defensive allocation helps — bonds rally ${bondShock > 0 ? '+' : ''}${bondShock}% as capital flees overvalued tech into safe havens.`,
      });
    }
  }

  if (scenario.id === 'taiwan_invasion') {
    // Geopolitical: Asia devastated, commodities spike, semiconductor disruption
    // China-specific: –50% is the single worst shock in any scenario
    const chinaPct = ((geoExposure['China'] || 0) / totalValue) * 100;
    const chinaShock = scenario.shocks['Equity:China'] ?? -50;
    const chinaPositions = posImpacts.filter(p => p.geo === 'China');
    if (chinaPositions.length > 0) {
      const chinaNames = chinaPositions.map(p => p.name).slice(0, 3).join(', ');
      const chinaLoss = chinaPositions.reduce((s, p) => s + (p.value * chinaShock / 100), 0);
      suggestions.push({
        sentiment: 'negative',
        text: `Your Chinese holdings (${chinaNames}) face the most severe shock in this scenario at ${chinaShock}%. ${chinaPct.toFixed(1)}% of your portfolio is in China, projecting a loss of ${fmtEur(chinaLoss)} from these positions alone. China would be the direct conflict zone with potential capital controls and exchange closures.`,
      });
    }
    // Broader Asia (excluding China, already covered)
    const otherAsiaPositions = posImpacts.filter(p =>
      ['Japan', 'Asia-Pacific', 'Emerging'].includes(p.geo)
    );
    const otherAsiaWeight = otherAsiaPositions.reduce((s, p) => s + p.weight, 0) * 100;
    if (otherAsiaWeight > 10) {
      const regionBreakdown = [];
      const japanPct = ((geoExposure['Japan'] || 0) / totalValue) * 100;
      const apacPct = ((geoExposure['Asia-Pacific'] || 0) / totalValue) * 100;
      const emPct = ((geoExposure['Emerging'] || 0) / totalValue) * 100;
      if (japanPct > 3) regionBreakdown.push(`Japan ${japanPct.toFixed(0)}% (–35%)`);
      if (apacPct > 3) regionBreakdown.push(`Asia-Pacific ${apacPct.toFixed(0)}% (–40%)`);
      if (emPct > 3) regionBreakdown.push(`Emerging markets ${emPct.toFixed(0)}% (–32%)`);
      suggestions.push({
        sentiment: 'negative',
        text: `Beyond China, ${otherAsiaWeight.toFixed(0)}% of your portfolio is in other affected Asian regions: ${regionBreakdown.join(', ')}. Semiconductor supply chain disruptions would cascade across the region.`,
      });
    }
    const totalAsiaWeight = chinaPct + otherAsiaWeight;
    if (totalAsiaWeight < 5 && chinaPositions.length === 0) {
      suggestions.push({
        sentiment: 'positive',
        text: `Low Asian exposure (${totalAsiaWeight.toFixed(0)}%) means you avoid the worst of this scenario's direct impact. The heaviest losses fall on China (–50%), Asia-Pacific (–40%), and Japan (–35%).`,
      });
    }
    if (commodityPct > 3) {
      suggestions.push({
        sentiment: 'positive',
        text: `Your ${commodityPct.toFixed(0)}% commodity allocation would surge +20% in this scenario — energy prices spike on supply disruption and geopolitical risk premium, partially offsetting equity losses.`,
      });
    } else {
      suggestions.push({
        sentiment: 'negative',
        text: `Commodity exposure is only ${commodityPct.toFixed(0)}%. In a geopolitical conflict, energy and metals prices spike sharply (+20% modelled). A small commodity or gold allocation acts as a natural geopolitical hedge.`,
      });
    }
    const bondShock = scenario.shocks['Bonds:*'] ?? 0;
    if (bondsPct > 5) {
      suggestions.push({
        sentiment: 'positive',
        text: `Bonds rally ${bondShock > 0 ? '+' : ''}${bondShock}% in this scenario as investors flee to government debt. Your ${bondsPct.toFixed(0)}% bond allocation provides meaningful protection.`,
      });
    }
  }

  if (scenario.id === 'eu_debt_crisis') {
    // European sovereign contagion: bonds AND equities fall in Europe
    const europePct = ((geoExposure['Europe'] || 0) / totalValue) * 100;
    if (europePct > 50) {
      suggestions.push({
        sentiment: 'negative',
        text: `${europePct.toFixed(0)}% of your portfolio is in European assets, the epicentre of this crisis (–38%). Diversifying toward non-EU markets (US, Asia) would reduce your exposure to sovereign contagion.`,
      });
    }
    if (bondsPct > 10) {
      suggestions.push({
        sentiment: 'negative',
        text: `Unlike a typical crisis, European bonds would fall alongside equities (${scenario.shocks['Bonds:*']}%). Your ${bondsPct.toFixed(0)}% bond allocation would not provide its usual safe-haven protection — in a sovereign debt scare, government bonds are the problem, not the solution.`,
      });
    }
    if (rePct > 5) {
      suggestions.push({
        sentiment: 'negative',
        text: `Real estate (${rePct.toFixed(0)}% of portfolio) faces a –30% shock in this scenario. European REITs and property funds are directly exposed to sovereign credit risk through bank lending channels.`,
      });
    }
    const usPct = ((geoExposure['USA'] || 0) / totalValue) * 100;
    const chPct = ((geoExposure['Switzerland'] || 0) / totalValue) * 100;
    if (usPct > 15 || chPct > 5) {
      const shelters = [];
      if (usPct > 15) shelters.push(`US (–15%)`);
      if (chPct > 5) shelters.push(`Switzerland (–10%)`);
      suggestions.push({
        sentiment: 'positive',
        text: `Your exposure to ${shelters.join(' and ')} provides relative shelter — these markets are less affected by European sovereign contagion and historically attract safe-haven flows during EU crises.`,
      });
    }
    if (commodityPct < 3 && mmPct < 5) {
      suggestions.push({
        sentiment: 'negative',
        text: `With both bonds and equities falling in this scenario, cash and gold are the true safe havens. Consider a small allocation to money market funds or gold ETFs as a hedge against correlated sell-offs.`,
      });
    }
  }

  // ── Generic fallbacks (only if scenario-specific didn't trigger enough) ──

  if (suggestions.length < 2 && defensivePct < 10 && impact.portfolioShock < -20) {
    const bondShock = scenario.shocks['Bonds:*'] ?? 0;
    const bondEffect = bondShock > 0 ? `In this scenario, bonds would gain ${bondShock}%.` : 'Even modest bond allocation helps absorb equity drawdowns.';
    suggestions.push({
      sentiment: 'negative',
      text: `Your portfolio has only ${defensivePct.toFixed(0)}% in defensive assets (bonds + money market). Adding 15–20% in bonds could reduce this scenario's impact by approximately ${Math.abs(Math.round(0.15 * (bondShock - impact.portfolioShock)))}%. ${bondEffect}`,
    });
  }

  if (suggestions.length < 2 && equityPct > 90 && impact.portfolioShock < -25) {
    suggestions.push({
      sentiment: 'negative',
      text: `${equityPct.toFixed(0)}% of your portfolio is in equities. In severe downturns, adding uncorrelated asset classes (commodities, gold, bonds) can dampen losses significantly.`,
    });
  }

  // Silver lining — positions that would benefit
  const gainers = impact.bestPositions.filter(p => p.shock > 0);
  if (gainers.length > 0 && suggestions.length < 5) {
    const gainerNames = gainers.map(p => `${p.name} (${p.shock > 0 ? '+' : ''}${p.shock}%)`).join(', ');
    suggestions.push({
      sentiment: 'positive',
      text: `Silver lining: ${gainerNames} would likely gain in this scenario, partially offsetting losses.`,
    });
  }

  // Always return at least one suggestion
  if (suggestions.length === 0) {
    suggestions.push({
      sentiment: 'positive',
      text: `Your portfolio shows balanced exposure to this scenario. Maintaining diversification across asset classes and geographies is the most effective long-term mitigation strategy.`,
    });
  }

  return suggestions.slice(0, 5); // cap at 5
}

// ── Wire & Render ────────────────────────────────────────────────────────────

function wireStressTestCard() {
  const card = document.getElementById('stressTestCard');
  if (!card || card.dataset.wired) return;
  card.dataset.wired = '1';

  const content = document.getElementById('stressTestContent');
  const container = document.getElementById('stressTestResults');

  // ── Pro gate ──
  if (!proUnlocked) {
    const title = card.querySelector('.card-title');
    if (title && !title.querySelector('.pro-badge')) {
      const badge = document.createElement('span');
      badge.className = 'pro-badge';
      badge.textContent = 'PRO';
      title.appendChild(badge);
    }

    // Show blurred mock immediately
    if (!content.dataset.placeholderBuilt) {
      content.dataset.placeholderBuilt = '1';
      const mockWrap = document.createElement('div');
      mockWrap.className = 'stress-results corr-blur-wrap';
      mockWrap.style.pointerEvents = 'none';
      mockWrap.style.userSelect = 'none';
      const mockGrid = document.createElement('div');
      mockGrid.className = 'stress-grid';
      ['COVID-19 Crash', '2022 Rate Hike', 'Liberation Day'].forEach(name => {
        const c = document.createElement('div');
        c.className = 'stress-card';
        c.innerHTML = `<div class="stress-card-header"><div class="stress-card-title">${name} <span class="stress-badge stress-badge--historical">Historical</span></div><div class="stress-card-period">Hypothetical</div></div><div class="stress-card-impact"><span class="stress-impact-pct stress-impact--severe">−24.5%</span><span class="stress-impact-eur">−€12,340</span></div>`;
        mockGrid.appendChild(c);
      });
      mockWrap.appendChild(mockGrid);
      content.classList.add('pro-placeholder-box');
      container.appendChild(mockWrap);
      showProOverlay(content, 'Risk Analysis');
    }
    return;
  }

  // ── Real functionality: auto-render on Insights tab open ──
  if (!container.dataset.computed) {
    container.dataset.computed = '1';
    renderStressTests(container);
  }
}

// ── Value at Risk (VaR) ──────────────────────────────────────────────────────
// Historical simulation: equal-weighted daily portfolio returns, correct
// percentile index. 1D only — multi-day scaling is not used because √T
// assumes i.i.d. normal returns (wrong), and overlapping empirical windows
// from ~250-1250 data points are too correlated to give reliable tail estimates.

function computeVaR(positions, priceHistories) {
  if (!priceHistories) return null;

  const totalValue = positions.reduce((s, p) => s + p.value, 0);
  if (totalValue <= 0) return null;

  // Build price maps
  const posDateMap = {}; // posId -> { date -> price }
  positions.forEach(p => {
    const hist = priceHistories[p.id];
    if (!hist || hist.length < 2) return;
    const map = {};
    hist.forEach(d => { map[d.date] = d.price; });
    posDateMap[p.id] = map;
  });

  const posIds = Object.keys(posDateMap);
  if (posIds.length === 0) return null;

  // Sorted union of all trading dates
  const allDates = [...new Set(
    posIds.flatMap(id => Object.keys(posDateMap[id]))
  )].sort();

  // Equal-weighted daily portfolio returns.
  // Using today's portfolio weights on past data is wrong — a position that
  // grew to 30% of the portfolio was only 5% on a bad day 2 years ago.
  // Equal weighting across positions that traded on each day is unbiased.
  const dailyReturns = [];
  for (let i = 1; i < allDates.length; i++) {
    const today = allDates[i];
    const yest  = allDates[i - 1];
    let sum = 0, count = 0;
    posIds.forEach(id => {
      const pT = posDateMap[id][today];
      const pY = posDateMap[id][yest];
      if (pT != null && pY != null && pY > 0) {
        sum += (pT - pY) / pY;
        count++;
      }
    });
    // Require at least 30% of positions to have prices on both days
    if (count >= Math.max(1, posIds.length * 0.3)) {
      dailyReturns.push(sum / count);
    }
  }

  if (dailyReturns.length < 20) return null;

  const sorted = [...dailyReturns].sort((a, b) => a - b);
  const N = sorted.length;

  // Correct percentile index: Math.ceil((1-conf)*N)-1 finds the last observation
  // in the worst (1-conf) tail. The old Math.floor version picked one element
  // too high, systematically understating losses.
  const getPercentile = (conf) => sorted[Math.max(0, Math.ceil((1 - conf) * N) - 1)];

  return {
    varByConf: {
      0.90: getPercentile(0.90),
      0.95: getPercentile(0.95),
      0.99: getPercentile(0.99),
    },
    worstDay:   sorted[0],
    totalValue,
    _dataPoints: N,
  };
}

function renderVaRCard(container, positions, priceHistories) {
  const varData = computeVaR(positions, priceHistories);
  if (!varData) return;

  const card = document.createElement('div');
  card.className = 'var-card';

  // Title
  const titleRow = document.createElement('div');
  titleRow.className = 'var-title-row';
  const title = document.createElement('div');
  title.className = 'var-title';
  title.textContent = 'Daily Value at Risk (1D VaR)';
  const subtitle = document.createElement('div');
  subtitle.className = 'var-subtitle';
  subtitle.textContent = `Historical simulation · ${varData._dataPoints} trading days · equal-weighted`;
  titleRow.append(title, subtitle);
  card.appendChild(titleRow);

  // Confidence toggle only — horizon selector removed
  const controlsRow = document.createElement('div');
  controlsRow.className = 'var-controls';
  const confGroup = document.createElement('div');
  confGroup.className = 'var-toggle-group';
  const confLabel = document.createElement('span');
  confLabel.className = 'var-toggle-label';
  confLabel.textContent = 'Confidence';
  confGroup.appendChild(confLabel);
  const confSeg = document.createElement('div');
  confSeg.className = 'seg';
  const confidences = [{ key: 0.90, label: '90%' }, { key: 0.95, label: '95%' }, { key: 0.99, label: '99%' }];
  confidences.forEach((c, i) => {
    const btn = document.createElement('button');
    btn.className = 'seg-btn var-btn--conf' + (i === 1 ? ' active' : '');
    btn.dataset.conf = c.key;
    btn.textContent = c.label;
    confSeg.appendChild(btn);
  });
  confGroup.appendChild(confSeg);
  controlsRow.appendChild(confGroup);
  card.appendChild(controlsRow);

  // Result display
  const resultRow = document.createElement('div');
  resultRow.className = 'var-result';
  const resultPct = document.createElement('span');
  resultPct.className = 'var-result-pct';
  resultRow.appendChild(resultPct);
  const resultDesc = document.createElement('div');
  resultDesc.className = 'var-result-desc';
  // Worst day — always visible as a sanity anchor
  const worstDayNote = document.createElement('div');
  worstDayNote.className = 'var-result-desc';
  worstDayNote.style.cssText = 'margin-top:6px;opacity:0.6;';
  worstDayNote.textContent = `Worst single day in dataset: ${(varData.worstDay * 100).toFixed(2)}%  (${fmtEur(varData.worstDay * varData.totalValue)})`;
  card.append(resultRow, resultDesc, worstDayNote);

  let activeConf = 0.95;

  function updateDisplay() {
    const val = varData.varByConf[activeConf];
    if (val == null) return;
    resultPct.textContent = (val * 100).toFixed(2) + '%';
    const confPct = Math.round(activeConf * 100);
    resultDesc.textContent = `${confPct}% of trading days, your portfolio will not lose more than ${fmtEur(Math.abs(val * varData.totalValue))} in a single day`;
  }

  confGroup.querySelectorAll('.var-btn--conf').forEach(btn => {
    btn.addEventListener('click', () => {
      confGroup.querySelectorAll('.var-btn--conf').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeConf = parseFloat(btn.dataset.conf);
      updateDisplay();
    });
  });

  updateDisplay();
  container.appendChild(card);
}

function renderStressTests(container) {
  container.innerHTML = '';

  const positions = globalData.positions || [];
  if (positions.length === 0) {
    container.textContent = 'No positions to analyse.';
    return;
  }

  // Get cached price histories for actual-data lookups (5Y data from VWD)
  const priceHistories = globalData.priceHistories5Y || null;

  // ── Value at Risk card (top of stress test section) ──
  renderVaRCard(container, positions, priceHistories);

  // Collapsed-row summary: the two numbers worth knowing before opening
  const varForSummary = computeVaR(positions, priceHistories);
  let worstShock = null;
  STRESS_SCENARIOS.forEach(sc => {
    const im = computeStressTest(positions, sc, priceHistories);
    if (im && (worstShock == null || im.portfolioShock < worstShock)) worstShock = im.portfolioShock;
  });
  const summaryParts = [];
  if (varForSummary?.varByConf?.[0.95] != null) {
    summaryParts.push(`VaR₉₅ ${(varForSummary.varByConf[0.95] * 100).toFixed(2)}%`);
  }
  if (worstShock != null) summaryParts.push(`worst scenario ${worstShock.toFixed(1)}%`);
  if (summaryParts.length) setInsightSummary('stressTestCard', summaryParts.join(' · '));

  const wrap = document.createElement('div');
  wrap.className = 'stress-results';

  // Stress Test heading above scenario grids
  const stressHeading = document.createElement('div');
  stressHeading.className = 'stress-heading';
  stressHeading.textContent = 'Stress Test';
  wrap.appendChild(stressHeading);

  // Compute all scenarios
  const historical = STRESS_SCENARIOS.filter(s => s.type === 'historical');
  const hypothetical = STRESS_SCENARIOS.filter(s => s.type === 'hypothetical');

  const renderSection = (scenarios, label) => {
    const title = document.createElement('div');
    title.className = 'stress-section-title';
    title.textContent = label;
    wrap.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'stress-grid';

    scenarios.forEach(scenario => {
      const impact = computeStressTest(positions, scenario, priceHistories);
      if (!impact) return;
      const mitigations = generateMitigations(impact, positions);

      const card = document.createElement('div');
      card.className = 'stress-card';

      // Impact severity class
      const severityClass = impact.portfolioShock <= -30 ? 'stress-impact--extreme'
        : impact.portfolioShock <= -20 ? 'stress-impact--severe'
        : impact.portfolioShock <= -10 ? 'stress-impact--moderate'
        : impact.portfolioShock > 0 ? 'stress-impact--positive'
        : 'stress-impact--mild';

      // Bar width: normalize to worst possible (max 60%)
      const barWidth = Math.min(100, Math.abs(impact.portfolioShock) / 60 * 100);
      const barColor = impact.portfolioShock <= -30 ? '#E05252'
        : impact.portfolioShock <= -20 ? '#F45D45'
        : impact.portfolioShock <= -10 ? '#F97316'
        : impact.portfolioShock > 0 ? '#2ACA69'
        : '#E8C832';

      // Badge
      const badgeClass = scenario.type === 'historical' ? 'stress-badge--historical' : 'stress-badge--hypothetical';
      const badgeLabel = scenario.type === 'historical' ? 'Historical' : 'Hypothetical';

      // Card header + summary
      const header = document.createElement('div');
      header.className = 'stress-card-header';
      header.innerHTML = `<div class="stress-card-title">${scenario.name} <span class="stress-badge ${badgeClass}">${badgeLabel}</span></div>`
        + (scenario.period ? `<div class="stress-card-period">${scenario.period}</div>` : '');

      const impactRow = document.createElement('div');
      impactRow.className = 'stress-card-impact';
      const sign = impact.portfolioShock > 0 ? '+' : '';
      impactRow.innerHTML = `<span class="stress-impact-pct ${severityClass}">${sign}${impact.portfolioShock.toFixed(1)}%</span>`
        + `<span class="stress-impact-eur">${impact.eurLoss >= 0 ? '+' : ''}${fmtEur(impact.eurLoss)}</span>`;

      const bar = document.createElement('div');
      bar.className = 'stress-card-bar';
      bar.innerHTML = `<div class="stress-card-bar-inner" style="width:${barWidth}%;background:${barColor}"></div>`;

      // Detail section (hidden until expanded)
      const detail = document.createElement('div');
      detail.className = 'stress-detail';

      // Description
      const descEl = document.createElement('div');
      descEl.className = 'stress-detail-section';
      descEl.innerHTML = `<div style="font-size:11px;color:var(--muted);line-height:1.6;margin-bottom:4px">${scenario.description}</div>`;
      if (impact.actualCount > 0) {
        descEl.innerHTML += `<div style="font-size:10px;color:var(--muted);opacity:0.7;margin-top:4px">${impact.actualCount}/${impact.totalCount} positions used actual price data from this period.</div>`;
      }
      detail.appendChild(descEl);

      // ── Chart: historical = "what actually happened"; hypothetical = 3-scenario fan ──
      const isHistorical = scenario.type === 'historical';

      // Hypothetical-only: scenario name labels
      const SCENARIO_NAMES = {
        ai_bubble:       ['Orderly Correction',  'Prolonged Deflation', 'Dot-com Style Rout'],
        taiwan_invasion: ['Swift De-escalation', 'Prolonged Conflict',  'Full Escalation'],
        eu_debt_crisis:  ['ECB Backstop',        'Austerity Drag',      'Sovereign Default'],
      };
      const scNames = SCENARIO_NAMES[scenario.id] || ['Optimistic', 'Realistic', 'Pessimistic'];

      const chartSection = document.createElement('div');
      chartSection.className = 'stress-detail-section stress-chart-section';
      const chartLabel = document.createElement('div');
      chartLabel.className = 'stress-detail-label';
      chartLabel.textContent = isHistorical ? 'What Actually Happened' : '6-Month Projection';
      const chartWrap = document.createElement('div');
      chartWrap.className = 'stress-chart-wrap';
      const chartCanvas = document.createElement('canvas');
      chartWrap.appendChild(chartCanvas);
      chartSection.append(chartLabel, chartWrap);
      detail.appendChild(chartSection);

      // Render the chart when the card expands
      let chartRendered = false;
      const renderImpactChart = () => {
        if (chartRendered) return;
        chartRendered = true;

        const totalVal = impact.totalValue;
        const shockPct = impact.portfolioShock;
        const shockFrac = shockPct / 100;

        if (isHistorical) {
          // ── Single "what happened" line for historical scenarios ────────────
          // Parameters tuned per event to reflect the actual market shape.
          const HIST_SHAPES = {
            covid_2020:          { crashDays: 24, troughDepth: 1.00, recoveryDays: 106, recoveryFrac: 1.02, noise: 0.018, color: '#EF5350', label: 'Your portfolio impact', totalDays: 130 },
            rate_hike_2022:      { crashDays: 55, troughDepth: 1.00, recoveryDays: 75,  recoveryFrac: 0.38, noise: 0.011, color: '#F59E0B', label: 'Your portfolio impact', totalDays: 130 },
            liberation_day_2025: { crashDays: 6,  troughDepth: 1.00, recoveryDays: 124, recoveryFrac: 0.85, noise: 0.012, color: '#F59E0B', label: 'Your portfolio impact', totalDays: 130 },
          };
          const shape = HIST_SHAPES[scenario.id] || { crashDays: 20, troughDepth: 1.00, recoveryDays: 110, recoveryFrac: 0.50, noise: 0.015, color: '#F59E0B', label: 'Your portfolio impact', totalDays: 130 };

          let _seed = 77;
          const seededRandom = () => { _seed = (_seed * 16807 + 0) % 2147483647; return _seed / 2147483647; };

          const totalDays = shape.totalDays;
          const labels = [];
          const data = [];
          let troughVal = Infinity, troughIdx = 0;

          for (let d = 0; d <= totalDays; d++) {
            let pctChange;
            const troughPct = shockFrac * shape.troughDepth;
            if (d <= shape.crashDays) {
              // Crash phase: exponential plunge
              const t = d / shape.crashDays;
              pctChange = troughPct * (1 - Math.exp(-4 * t)) / (1 - Math.exp(-4));
            } else {
              // Recovery phase: partial bounce
              const t = (d - shape.crashDays) / (totalDays - shape.crashDays);
              const recoveryAmount = Math.abs(troughPct) * shape.recoveryFrac;
              pctChange = troughPct + recoveryAmount * (1 - Math.exp(-2 * t)) / (1 - Math.exp(-2));
            }
            pctChange += (seededRandom() - 0.5) * Math.abs(shockFrac) * shape.noise;

            if (d === 0) labels.push('Today');
            else if (d % 20 === 0) labels.push(`M${d / 20}`);
            else labels.push('');

            const val = Math.round(totalVal * (1 + pctChange));
            data.push(val);
            if (val < troughVal) { troughVal = val; troughIdx = d; }
          }

          const baselineVal = totalVal;
          const allMin = Math.min(...data);
          const allMax = Math.max(...data);

          const ctx = chartCanvas.getContext('2d');
          const gradient = ctx.createLinearGradient(0, 0, 0, 320);
          gradient.addColorStop(0, shape.color + '22');
          gradient.addColorStop(1, shape.color + '00');

          const annotationPlugin = {
            id: 'histAnnotations',
            afterDraw(chart) {
              const { ctx: c, chartArea: { left, right, top, bottom }, scales: { x, y } } = chart;

              // Dashed baseline
              const baseY = y.getPixelForValue(baselineVal);
              c.save();
              c.setLineDash([5, 4]);
              c.strokeStyle = THEME_COLORS.canvasBaseline;
              c.lineWidth = 1;
              c.beginPath(); c.moveTo(left, baseY); c.lineTo(right, baseY); c.stroke();
              c.restore();
              c.save();
              c.font = "9px 'DM Mono', monospace";
              c.fillStyle = THEME_COLORS.canvasBaselineLabel;
              c.textAlign = 'right';
              c.fillText(`Start: ${fmtEur(baselineVal)}`, right - 4, baseY - 5);
              c.restore();

              // Phase divider at crash trough
              const divX = x.getPixelForValue(shape.crashDays);
              c.save();
              c.setLineDash([3, 3]);
              c.strokeStyle = THEME_COLORS.canvasBaselineFaint;
              c.lineWidth = 1;
              c.beginPath(); c.moveTo(divX, top); c.lineTo(divX, bottom); c.stroke();
              c.restore();
              c.save();
              c.font = "bold 8px 'DM Mono', monospace";
              c.textAlign = 'center';
              c.fillStyle = THEME_COLORS.canvasCrashFill;
              c.fillText('CRASH', (left + divX) / 2, top + 12);
              c.fillStyle = THEME_COLORS.canvasRecoveryFill;
              c.fillText('RECOVERY', (divX + right) / 2, top + 12);
              c.restore();

              // End-state pill
              const endVal = data[data.length - 1];
              const endPct = ((endVal / baselineVal) - 1) * 100;
              const endY = y.getPixelForValue(endVal);
              c.save();
              const label = `${endPct.toFixed(1)}%`;
              c.font = "bold 9px 'DM Mono', monospace";
              const tw = c.measureText(label).width;
              const pillW = tw + 10, pillH = 17;
              const pillX = right - pillW - 3;
              const pillY = endY - pillH - 5;
              const rr = 3;
              c.fillStyle = shape.color + '28';
              c.beginPath();
              c.moveTo(pillX + rr, pillY); c.lineTo(pillX + pillW - rr, pillY);
              c.quadraticCurveTo(pillX + pillW, pillY, pillX + pillW, pillY + rr);
              c.lineTo(pillX + pillW, pillY + pillH - rr);
              c.quadraticCurveTo(pillX + pillW, pillY + pillH, pillX + pillW - rr, pillY + pillH);
              c.lineTo(pillX + rr, pillY + pillH);
              c.quadraticCurveTo(pillX, pillY + pillH, pillX, pillY + pillH - rr);
              c.lineTo(pillX, pillY + rr);
              c.quadraticCurveTo(pillX, pillY, pillX + rr, pillY);
              c.closePath(); c.fill();
              c.fillStyle = shape.color;
              c.textAlign = 'center'; c.textBaseline = 'middle';
              c.fillText(label, pillX + pillW / 2, pillY + pillH / 2);
              c.restore();

              // Trough marker
              const trX = x.getPixelForValue(troughIdx);
              const trY = y.getPixelForValue(troughVal);
              const trPct = ((troughVal / baselineVal) - 1) * 100;
              c.save();
              c.beginPath(); c.arc(trX, trY, 3.5, 0, Math.PI * 2);
              c.fillStyle = '#EF5350'; c.fill();
              c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.stroke();
              c.restore();
              const trLabel = `Max drawdown: ${trPct.toFixed(1)}%`;
              c.save();
              c.font = "bold 9px 'DM Mono', monospace";
              const trTw = c.measureText(trLabel).width;
              const trBoxW = trTw + 12, trBoxH = 20;
              const trBoxX = Math.min(trX - trBoxW / 2, right - trBoxW - 4);
              const trBoxY = trY + 12;
              const trR = 3;
              c.fillStyle = THEME_COLORS.canvasCrashFillHi;
              c.beginPath();
              c.moveTo(trBoxX + trR, trBoxY); c.lineTo(trBoxX + trBoxW - trR, trBoxY);
              c.quadraticCurveTo(trBoxX + trBoxW, trBoxY, trBoxX + trBoxW, trBoxY + trR);
              c.lineTo(trBoxX + trBoxW, trBoxY + trBoxH - trR);
              c.quadraticCurveTo(trBoxX + trBoxW, trBoxY + trBoxH, trBoxX + trBoxW - trR, trBoxY + trBoxH);
              c.lineTo(trBoxX + trR, trBoxY + trBoxH);
              c.quadraticCurveTo(trBoxX, trBoxY + trBoxH, trBoxX, trBoxY + trBoxH - trR);
              c.lineTo(trBoxX, trBoxY + trR);
              c.quadraticCurveTo(trBoxX, trBoxY, trBoxX + trR, trBoxY);
              c.closePath(); c.fill();
              c.beginPath();
              c.moveTo(trX - 4, trBoxY); c.lineTo(trX, trBoxY - 5); c.lineTo(trX + 4, trBoxY);
              c.closePath(); c.fill();
              c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle';
              c.fillText(trLabel, trBoxX + trBoxW / 2, trBoxY + trBoxH / 2);
              c.restore();
            },
          };

          new Chart(chartCanvas.getContext('2d'), {
            type: 'line',
            data: {
              labels,
              datasets: [{
                label: shape.label,
                data,
                borderColor: shape.color,
                backgroundColor: gradient,
                borderWidth: 2.5,
                fill: true,
                tension: 0.35,
                pointRadius: 0,
                pointHoverRadius: 4,
                pointHoverBackgroundColor: shape.color,
                pointHoverBorderColor: '#fff',
                pointHoverBorderWidth: 2,
              }],
            },
            plugins: [annotationPlugin],
            options: {
              responsive: true,
              maintainAspectRatio: false,
              animation: { duration: 900, easing: 'easeOutQuart' },
              layout: { padding: { top: 22, right: 72, bottom: 4, left: 6 } },
              plugins: {
                legend: { display: false },
                tooltip: {
                  backgroundColor: 'rgba(21,32,43,0.95)',
                  titleFont: { family: "'DM Mono', monospace", size: 10 },
                  bodyFont: { family: "'DM Mono', monospace", size: 11, weight: 'bold' },
                  padding: 10,
                  borderColor: THEME_COLORS.canvasBaselineFaint,
                  borderWidth: 1,
                  cornerRadius: 6,
                  callbacks: {
                    title: (items) => {
                      const idx = items[0].dataIndex;
                      if (idx === 0) return 'Start of event';
                      const month = Math.floor(idx / 20);
                      const day = idx % 20;
                      return month > 0 ? `Month ${month}, Day ${day + 1}` : `Day ${idx}`;
                    },
                    label: (item) => {
                      const val = item.raw;
                      const pct = ((val / baselineVal) - 1) * 100;
                      const sign = pct >= 0 ? '+' : '';
                      return ` Portfolio: ${fmtEur(val)}  (${sign}${pct.toFixed(1)}%)`;
                    },
                  },
                },
              },
              scales: {
                x: {
                  grid: { display: false },
                  ticks: { font: { family: "'DM Mono', monospace", size: 9 }, color: THEME_COLORS.canvasBaselineMed, maxRotation: 0, autoSkip: false, callback: function(val, idx) { return labels[idx] || ''; } },
                  border: { display: false },
                },
                y: {
                  grid: { color: THEME_COLORS.canvasBaselineFaint, drawBorder: false },
                  ticks: { font: { family: "'DM Mono', monospace", size: 9 }, color: THEME_COLORS.canvasBaselineMed, callback: function(val) { if (Math.abs(val) >= 1000000) return '€' + (val / 1000000).toFixed(1) + 'M'; return '€' + (val / 1000).toFixed(0) + 'k'; }, maxTicksLimit: 5 },
                  border: { display: false },
                  min: allMin * 0.97,
                  max: allMax * 1.02,
                },
              },
              interaction: { mode: 'index', intersect: false },
            },
          });
          return; // done for historical
        }

        // ── Hypothetical: 3-scenario fan (unchanged) ──────────────────────────
        const scenarioDefs = [
          {
            name: scNames[0], // Optimistic
            crashDepth: 0.55,
            overshoot: 1.00,
            phase1Days: 12,
            phase2Days: 25,
            recoveryFrac: 0.75,
            noise: 0.013,
            color: '#4CAF50',
            fillAlpha: 0.06,
          },
          {
            name: scNames[1], // Realistic
            crashDepth: 0.70,
            overshoot: 1.08,
            phase1Days: 20,
            phase2Days: 50,
            recoveryFrac: 0.30,
            noise: 0.019,
            color: '#F59E0B',
            fillAlpha: 0.10,
          },
          {
            name: scNames[2], // Pessimistic
            crashDepth: 0.90,
            overshoot: 1.28,
            phase1Days: 18,
            phase2Days: 65,
            recoveryFrac: 0.07,
            noise: 0.025,
            color: '#EF5350',
            fillAlpha: 0.15,
          },
        ];

        const tradingDays = 130;
        const labels = [];
        for (let d = 0; d <= tradingDays; d++) {
          if (d === 0) labels.push('Today');
          else if (d % 20 === 0) labels.push(`M${d / 20}`);
          else labels.push('');
        }

        // Seeded random for reproducible curves
        let _seed = 42;
        const seededRandom = () => { _seed = (_seed * 16807 + 0) % 2147483647; return _seed / 2147483647; };

        const allSeries = scenarioDefs.map((sc, idx) => {
          const data = [];
          let troughIdx = 0, troughVal = Infinity;
          _seed = idx * 1000 + 42;

          for (let d = 0; d <= tradingDays; d++) {
            let pctChange;
            if (d <= sc.phase1Days) {
              const t = d / sc.phase1Days;
              pctChange = shockFrac * sc.crashDepth * (1 - Math.exp(-3.5 * t)) / (1 - Math.exp(-3.5));
              pctChange += (seededRandom() - 0.52) * Math.abs(shockFrac) * sc.noise;
            } else if (d <= sc.phase2Days) {
              const p1End = shockFrac * sc.crashDepth;
              const trough = shockFrac * sc.overshoot;
              const t = (d - sc.phase1Days) / (sc.phase2Days - sc.phase1Days);
              pctChange = p1End + (trough - p1End) * t;
              pctChange += (seededRandom() - 0.48) * Math.abs(shockFrac) * sc.noise * 1.3;
            } else {
              const troughPct = shockFrac * sc.overshoot;
              const recovery = Math.abs(shockFrac) * sc.overshoot * sc.recoveryFrac;
              const t = (d - sc.phase2Days) / (tradingDays - sc.phase2Days);
              pctChange = troughPct + recovery * (1 - Math.exp(-2.5 * t)) / (1 - Math.exp(-2.5));
              pctChange += (seededRandom() - 0.45) * Math.abs(shockFrac) * sc.noise * 1.1;
            }

            const val = totalVal * (1 + pctChange);
            data.push(Math.round(val));
            if (val < troughVal) { troughVal = val; troughIdx = d; }
          }
          return { ...sc, data, troughIdx, troughVal };
        });

        const baselineVal = totalVal;
        const allVals = allSeries.flatMap(s => s.data);
        const globalMin = Math.min(...allVals);
        const globalMax = Math.max(...allVals);

        const ctx = chartCanvas.getContext('2d');

        // Datasets — pessimistic (red) drawn first so it renders behind
        const datasets = [...allSeries].reverse().map(sc => {
          const gradient = ctx.createLinearGradient(0, 0, 0, 300);
          gradient.addColorStop(0, sc.color + '00');
          gradient.addColorStop(1, sc.color + Math.round(sc.fillAlpha * 255).toString(16).padStart(2, '0'));
          return {
            label: sc.name,
            data: sc.data,
            borderColor: sc.color,
            backgroundColor: gradient,
            borderWidth: 2,
            fill: sc.name === scNames[2], // only fill pessimistic area
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHoverBackgroundColor: sc.color,
            pointHoverBorderColor: '#fff',
            pointHoverBorderWidth: 2,
          };
        });

        // Custom annotation plugin: baseline, phase labels, end-state pills, trough marker
        const annotationPlugin = {
          id: 'stressAnnotations',
          afterDraw(chart) {
            const { ctx: c, chartArea: { left, right, top, bottom }, scales: { x, y } } = chart;

            // 1. Dashed baseline
            const baseY = y.getPixelForValue(baselineVal);
            c.save();
            c.setLineDash([5, 4]);
            c.strokeStyle = THEME_COLORS.canvasBaseline;
            c.lineWidth = 1;
            c.beginPath(); c.moveTo(left, baseY); c.lineTo(right, baseY); c.stroke();
            c.restore();

            c.save();
            c.font = "9px 'DM Mono', monospace";
            c.fillStyle = THEME_COLORS.canvasBaselineLabel;
            c.textAlign = 'right';
            c.fillText(`Start: ${fmtEur(baselineVal)}`, right - 4, baseY - 5);
            c.restore();

            // 2. Phase dividers (anchored to realistic scenario)
            const refSc = allSeries[1];
            const p1X = x.getPixelForValue(refSc.phase1Days);
            const p2X = x.getPixelForValue(refSc.phase2Days);

            c.save();
            c.setLineDash([3, 3]);
            c.strokeStyle = THEME_COLORS.canvasBaselineFaint;
            c.lineWidth = 1;
            [p1X, p2X].forEach(px => {
              c.beginPath(); c.moveTo(px, top); c.lineTo(px, bottom); c.stroke();
            });
            c.restore();

            c.save();
            c.font = "bold 8px 'DM Mono', monospace";
            c.textAlign = 'center';
            c.fillStyle = THEME_COLORS.canvasCrashFill;
            c.fillText('SELL-OFF', (left + p1X) / 2, top + 12);
            c.fillStyle = 'rgba(248,150,30,0.4)';
            c.fillText('DECLINE', (p1X + p2X) / 2, top + 12);
            c.fillStyle = THEME_COLORS.canvasRecoveryFill;
            c.fillText('RECOVERY', (p2X + right) / 2, top + 12);
            c.restore();

            // 3. End-state pill badges (right edge)
            allSeries.forEach(sc => {
              const endVal = sc.data[sc.data.length - 1];
              const endPct = ((endVal / baselineVal) - 1) * 100;
              const endY = y.getPixelForValue(endVal);

              c.save();
              const label = `${endPct.toFixed(1)}%`;
              c.font = "bold 9px 'DM Mono', monospace";
              const tw = c.measureText(label).width;
              const pillW = tw + 10, pillH = 17;
              const pillX = right - pillW - 3;
              const pillY = endY - pillH - 5;
              const rr = 3;

              c.fillStyle = sc.color + '28';
              c.beginPath();
              c.moveTo(pillX + rr, pillY);
              c.lineTo(pillX + pillW - rr, pillY);
              c.quadraticCurveTo(pillX + pillW, pillY, pillX + pillW, pillY + rr);
              c.lineTo(pillX + pillW, pillY + pillH - rr);
              c.quadraticCurveTo(pillX + pillW, pillY + pillH, pillX + pillW - rr, pillY + pillH);
              c.lineTo(pillX + rr, pillY + pillH);
              c.quadraticCurveTo(pillX, pillY + pillH, pillX, pillY + pillH - rr);
              c.lineTo(pillX, pillY + rr);
              c.quadraticCurveTo(pillX, pillY, pillX + rr, pillY);
              c.closePath();
              c.fill();

              c.fillStyle = sc.color;
              c.textAlign = 'center';
              c.textBaseline = 'middle';
              c.fillText(label, pillX + pillW / 2, pillY + pillH / 2);
              c.restore();
            });

            // 4. Trough marker on pessimistic scenario
            const worstSc = allSeries[2];
            const trX = x.getPixelForValue(worstSc.troughIdx);
            const trY = y.getPixelForValue(worstSc.troughVal);
            const trPct = ((worstSc.troughVal / baselineVal) - 1) * 100;

            c.save();
            c.beginPath();
            c.arc(trX, trY, 3.5, 0, Math.PI * 2);
            c.fillStyle = '#EF5350';
            c.fill();
            c.strokeStyle = '#fff';
            c.lineWidth = 1.5;
            c.stroke();
            c.restore();

            const trLabel = `Max drawdown: ${trPct.toFixed(1)}%`;
            c.save();
            c.font = "bold 9px 'DM Mono', monospace";
            const trTw = c.measureText(trLabel).width;
            const trBoxW = trTw + 12, trBoxH = 20;
            const trBoxX = Math.min(trX - trBoxW / 2, right - trBoxW - 4);
            const trBoxY = trY + 12;
            const trR = 3;

            c.fillStyle = THEME_COLORS.canvasCrashFillHi;
            c.beginPath();
            c.moveTo(trBoxX + trR, trBoxY);
            c.lineTo(trBoxX + trBoxW - trR, trBoxY);
            c.quadraticCurveTo(trBoxX + trBoxW, trBoxY, trBoxX + trBoxW, trBoxY + trR);
            c.lineTo(trBoxX + trBoxW, trBoxY + trBoxH - trR);
            c.quadraticCurveTo(trBoxX + trBoxW, trBoxY + trBoxH, trBoxX + trBoxW - trR, trBoxY + trBoxH);
            c.lineTo(trBoxX + trR, trBoxY + trBoxH);
            c.quadraticCurveTo(trBoxX, trBoxY + trBoxH, trBoxX, trBoxY + trBoxH - trR);
            c.lineTo(trBoxX, trBoxY + trR);
            c.quadraticCurveTo(trBoxX, trBoxY, trBoxX + trR, trBoxY);
            c.closePath();
            c.fill();

            c.beginPath();
            c.moveTo(trX - 4, trBoxY);
            c.lineTo(trX, trBoxY - 5);
            c.lineTo(trX + 4, trBoxY);
            c.closePath();
            c.fill();

            c.fillStyle = '#fff';
            c.textAlign = 'center';
            c.textBaseline = 'middle';
            c.fillText(trLabel, trBoxX + trBoxW / 2, trBoxY + trBoxH / 2);
            c.restore();
          }
        };

        new Chart(ctx, {
          type: 'line',
          data: { labels, datasets },
          plugins: [annotationPlugin],
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 900, easing: 'easeOutQuart' },
            layout: { padding: { top: 22, right: 72, bottom: 4, left: 6 } },
            plugins: {
              legend: {
                display: true,
                position: 'bottom',
                labels: {
                  color: THEME_COLORS.canvasBaselineMed,
                  font: { family: "'DM Mono', monospace", size: 10 },
                  usePointStyle: true,
                  pointStyle: 'line',
                  padding: 14,
                  boxWidth: 20,
                  boxHeight: 2,
                },
              },
              tooltip: {
                backgroundColor: 'rgba(21,32,43,0.95)',
                titleFont: { family: "'DM Mono', monospace", size: 10 },
                bodyFont: { family: "'DM Mono', monospace", size: 11, weight: 'bold' },
                padding: 10,
                borderColor: THEME_COLORS.canvasBaselineFaint,
                borderWidth: 1,
                cornerRadius: 6,
                displayColors: true,
                boxWidth: 8,
                boxHeight: 2,
                usePointStyle: true,
                callbacks: {
                  title: (items) => {
                    const idx = items[0].dataIndex;
                    if (idx === 0) return 'Today';
                    const month = Math.floor(idx / 20);
                    const day = idx % 20;
                    return `Month ${month}, Day ${day + 1}`;
                  },
                  label: (item) => {
                    const val = item.raw;
                    const pct = ((val / baselineVal) - 1) * 100;
                    const sign = pct >= 0 ? '+' : '';
                    return ` ${item.dataset.label}: ${fmtEur(val)}  (${sign}${pct.toFixed(1)}%)`;
                  },
                },
              },
            },
            scales: {
              x: {
                grid: { display: false },
                ticks: {
                  font: { family: "'DM Mono', monospace", size: 9 },
                  color: THEME_COLORS.canvasBaselineMed,
                  maxRotation: 0,
                  autoSkip: false,
                  callback: function(val, idx) { return labels[idx] || ''; },
                },
                border: { display: false },
              },
              y: {
                grid: { color: THEME_COLORS.canvasBaselineFaint, drawBorder: false },
                ticks: {
                  font: { family: "'DM Mono', monospace", size: 9 },
                  color: THEME_COLORS.canvasBaselineMed,
                  callback: function(val) {
                    // Use k/M suffix, currency-neutral
                    if (Math.abs(val) >= 1000000) return '€' + (val / 1000000).toFixed(1) + 'M';
                    return '€' + (val / 1000).toFixed(0) + 'k';
                  },
                  maxTicksLimit: 5,
                },
                border: { display: false },
                min: globalMin * 0.96,
                max: globalMax * 1.02,
              },
            },
            interaction: { mode: 'index', intersect: false },
          },
        });
      };

      // Render chart the first time the card is expanded
      const expandObserver = new MutationObserver(() => {
        if (card.classList.contains('expanded')) {
          renderImpactChart();
          expandObserver.disconnect();
        }
      });
      expandObserver.observe(card, { attributes: true, attributeFilter: ['class'] });

      // ── Worst-hit positions ──────────────────────────────────────────────
      const posSection = document.createElement('div');
      posSection.className = 'stress-detail-section';
      posSection.innerHTML = `<div class="stress-detail-label">Most affected positions</div>`;
      const posList = document.createElement('div');
      posList.className = 'stress-positions';

      impact.worstPositions.forEach(p => {
        const maxShock = Math.max(1, Math.abs(impact.worstPositions[0].shock));
        const posBarW = Math.min(100, Math.abs(p.shock) / maxShock * 100);
        const posBarColor = p.shock < -20 ? '#E05252' : p.shock < -10 ? '#F97316' : p.shock < 0 ? '#E8C832' : '#2ACA69';

        const row = document.createElement('div');
        row.className = 'stress-pos-row';
        // sanitize() is applied to p.name and p.source — both are API-derived
        // strings (DEGIRO product names / 'actual'|'model') and must be escaped
        // before insertion into innerHTML to prevent XSS via a malformed API response.
        // posBarColor, posBarW, p.shock, p.eurImpact are all computed numbers — safe.
        row.innerHTML = `<span class="stress-pos-name">${sanitize(p.name)}</span>`
          + `<span class="stress-pos-pct" style="color:${posBarColor}">${p.shock > 0 ? '+' : ''}${p.shock.toFixed(1)}%</span>`
          + `<div class="stress-pos-bar-wrap"><div class="stress-pos-bar" style="width:${posBarW}%;background:${posBarColor}"></div></div>`
          + `<span class="stress-pos-eur">${p.eurImpact >= 0 ? '+' : ''}${fmtEur(p.eurImpact)}</span>`
          + `<span class="stress-pos-source stress-pos-source--${sanitize(p.source)}">${sanitize(p.source)}</span>`;
        posList.appendChild(row);
      });
      posSection.appendChild(posList);
      detail.appendChild(posSection);

      // Mitigations
      if (mitigations.length > 0) {
        const mitSection = document.createElement('div');
        mitSection.className = 'stress-detail-section';
        mitSection.innerHTML = `<div class="stress-detail-label">How to reduce exposure</div>`;
        const mitList = document.createElement('div');
        mitList.className = 'stress-mitigations';
        mitigations.forEach(m => {
          const mit = document.createElement('div');
          mit.className = 'stress-mitigation' + (m.sentiment === 'positive' ? ' stress-mitigation--positive' : m.sentiment === 'negative' ? ' stress-mitigation--negative' : '');
          mit.textContent = m.text;
          mitList.appendChild(mit);
        });
        mitSection.appendChild(mitList);
        detail.appendChild(mitSection);
      }

      // Collapse button
      const collapseBtn = document.createElement('button');
      collapseBtn.className = 'stress-card-collapse';
      collapseBtn.textContent = '↑ Collapse';

      card.append(header, impactRow, bar, detail, collapseBtn);

      // Click to expand/collapse
      card.addEventListener('click', (e) => {
        if (e.target === collapseBtn) return;
        if (card.classList.contains('expanded')) return;
        grid.querySelectorAll('.stress-card.expanded').forEach(c => c.classList.remove('expanded'));
        card.classList.add('expanded');
      });
      collapseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        card.classList.remove('expanded');
      });

      grid.appendChild(card);
    });

    wrap.appendChild(grid);
  };

  renderSection(historical, 'Historical Scenarios');
  renderSection(hypothetical, 'Hypothetical Scenarios');

  container.appendChild(wrap);
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Tax Reporting ────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

const TAX_COUNTRIES = {
  NL: {
    label: 'Netherlands',
    lang: 'nl',
    forms: ['IB-aangifte (Box 3)'],
    info: 'Dutch Box 3 taxes a deemed return on your net assets as of January 1 (peildatum). The actual dividends and gains are not directly taxed — only the portfolio value on the reference date matters for filing.',
    generate: generateNLTaxReport,
    pdfTitle: (year) => `Belastingaangifte — Overzicht ${year}`,
    pdfDisclaimer: 'Dit overzicht is gegenereerd op basis van DEGIRO-transactiegegevens en bevat mogelijk niet alle belastbare gebeurtenissen. Dit is geen belastingadvies. Controleer alle bedragen bij een gekwalificeerd belastingadviseur voordat u deze gebruikt voor officiële belastingaangiften. De ontwikkelaars aanvaarden geen aansprakelijkheid voor fouten, omissies of gevolgen van het gebruik van deze gegevens.',
    dateLocale: 'nl-NL',
  },
  FR: {
    label: 'France',
    lang: 'fr',
    forms: ['Formulaire 2042 (PFU summary)', 'Formulaire 2074 (per-transaction)'],
    info: 'France applies a 30% flat tax (PFU: 12.8% IR + 17.2% PS) on capital gains and dividends. Use 2042 for the summary (cases 3VG/3VH/2DC) or 2074 for per-transaction FIFO detail (cadre 510). Don\'t forget to declare your DEGIRO account via formulaire 3916.',
    generate: generateFRTaxReport,
    pdfTitle: (year) => `Déclaration fiscale — Exercice ${year}`,
    pdfDisclaimer: 'Ce document est généré à partir des données de transactions DEGIRO et peut ne pas refléter tous les événements imposables. Il ne constitue pas un conseil fiscal. Vérifiez tous les montants auprès d\'un conseiller fiscal qualifié avant de les utiliser pour vos déclarations officielles. Les développeurs déclinent toute responsabilité en cas d\'erreurs, d\'omissions ou de conséquences liées à l\'utilisation de ces données.',
    dateLocale: 'fr-FR',
  },
  DE: {
    label: 'Germany',
    lang: 'de',
    forms: ['Anlage KAP'],
    info: 'Germany applies Abgeltungsteuer (25% + 5.5% Soli = 26.375%) on capital gains and dividends. Important: stocks go on Anlage KAP, while ETFs and funds go on Anlage KAP-INV. Sparerpauschbetrag: €1.000/person.',
    generate: generateDETaxReport,
    pdfTitle: (year) => `Steuerübersicht — Steuerjahr ${year}`,
    pdfDisclaimer: 'Diese Übersicht wurde auf Grundlage von DEGIRO-Transaktionsdaten erstellt und enthält möglicherweise nicht alle steuerpflichtigen Vorgänge. Sie stellt keine Steuerberatung dar. Überprüfen Sie alle Beträge mit einem qualifizierten Steuerberater, bevor Sie diese für offizielle Steuererklärungen verwenden. Die Entwickler übernehmen keine Haftung für Fehler, Auslassungen oder Folgen der Nutzung dieser Daten.',
    dateLocale: 'de-DE',
  },
  BE: {
    label: 'Belgium',
    lang: 'nl', // default; overridden by language toggle
    hasLangToggle: true,
    forms: ['Déclaration IPP / Aangifte PB'],
    info: 'Belgium taxes dividends at 30% (roerende voorheffing). Capital gains on stocks are generally not taxed for private investors (income year 2025), but speculative gains (held < 6 months) may apply.',
    generate: generateBETaxReport,
    pdfTitle: (year, lang) => lang === 'fr'
      ? `Déclaration fiscale — Exercice ${year}`
      : `Belastingaangifte — Overzicht ${year}`,
    pdfDisclaimer: (lang) => (BE_LABELS[lang] || BE_LABELS.nl).disclaimer,
    dateLocale: 'nl-BE',
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function getTransactionsForYear(year) {
  const prefix = String(year);
  return (globalData.transactions || []).filter(tx => tx.date && tx.date.startsWith(prefix));
}

function getDividendsForYear(year) {
  const prefix = String(year);
  return (globalData.dividends || []).filter(d => d.date && d.date.startsWith(prefix));
}

/**
 * Replay all transactions through FIFO and return realised gains for sells
 * that occurred within the given tax year.
 */
function computeRealizedGainsForYear(year) {
  const allTx = globalData.transactions || [];
  const names = globalData.names || {};
  const meta = globalData.meta || {};
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const byProduct = {};
  allTx.forEach(tx => {
    const id = tx.productId;
    if (!byProduct[id]) byProduct[id] = [];
    byProduct[id].push(tx);
  });

  const results = [];

  Object.entries(byProduct).forEach(([id, txs]) => {
    const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date));
    const buyQueue = [];
    let yearBuyCost = 0;
    let yearSellProc = 0;
    let yearSoldQty = 0;
    let yearFees = 0;
    let yearFxPL = 0;
    const lots = []; // detailed per-lot matches for FR 2074

    const productCurrency = meta[id]?.currency || 'EUR';
    const productTypeId = meta[id]?.productTypeId;
    const isin = meta[id]?.isin || '';
    const isNonEUR = productCurrency !== 'EUR';

    sorted.forEach(tx => {
      const qty = Math.abs(tx.quantity);
      const eurPerShare = qty > 0 ? Math.abs(tx.totalInBaseCurrency) / qty : 0;
      const nativePrice = tx.price;
      const fees = txFeeEur(tx);
      const eurExFees = Math.abs(tx.totalInBaseCurrency) - fees;
      const impliedFX = (nativePrice > 0 && qty > 0 && eurExFees > 0)
        ? eurExFees / (nativePrice * qty) : 1;

      const inYear = tx.date >= yearStart && tx.date <= yearEnd;

      if (tx.buysell === 'B') {
        buyQueue.push({ qty, eurPerShare, nativePrice, fx: impliedFX, date: tx.date, fees });
        if (inYear) yearFees += fees;
      } else {
        const sellFX = impliedFX;
        const sellFees = fees;
        let remaining = qty;
        while (remaining > 0.0001 && buyQueue.length > 0) {
          const lot = buyQueue[0];
          const matched = Math.min(lot.qty, remaining);
          if (inYear) {
            yearBuyCost += matched * lot.eurPerShare;
            yearSoldQty += matched;
            if (isNonEUR && lot.nativePrice > 0) {
              yearFxPL += matched * lot.nativePrice * (sellFX - lot.fx);
            }
            // Allocate sell fees proportionally across matched lots
            const lotSellFees = qty > 0 ? sellFees * (matched / qty) : 0;
            // Allocate buy fees proportionally (from original buy)
            const lotBuyFees = lot.fees && lot.qty > 0 ? lot.fees * (matched / (matched + lot.qty)) : 0;
            lots.push({
              buyDate: lot.date,
              sellDate: tx.date,
              shares: matched,
              buyEurPerShare: lot.eurPerShare,
              sellEurPerShare: eurPerShare,
              holdingDays: Math.round((new Date(tx.date) - new Date(lot.date)) / 864e5),
              lotFees: Math.round((lotSellFees + lotBuyFees) * 100) / 100,
            });
          }
          lot.qty -= matched;
          remaining -= matched;
          if (lot.qty < 0.0001) buyQueue.shift();
        }
        if (inYear) {
          yearSellProc += Math.abs(tx.totalInBaseCurrency);
          yearFees += fees;
        }
      }
    });

    if (yearSoldQty > 0 || lots.length > 0) {
      results.push({
        id,
        name: names[id] || 'ID ' + id,
        isin,
        productTypeId,
        currency: productCurrency,
        sharesMatched: yearSoldQty,
        buyTotal: yearBuyCost,
        sellTotal: yearSellProc,
        realizedPL: yearSellProc - yearBuyCost,
        realizedFxPL: isNonEUR ? Math.round(yearFxPL * 100) / 100 : 0,
        fees: yearFees,
        lots,
      });
    }
  });

  return results.sort((a, b) => Math.abs(b.realizedPL) - Math.abs(a.realizedPL));
}

/**
 * Reconstruct holdings as of a given date and value them using VWD price history.
 * Returns { totalValue, holdings: [{ name, qty, price, value, source }] }
 */
function getPortfolioValueOnDate(targetDate) {
  const allTx = globalData.transactions || [];
  const names = globalData.names || {};
  const meta = globalData.meta || {};
  const priceHistories = globalData.priceHistories5Y || {};

  // Replay transactions to find holdings on targetDate
  const holdings = {};
  allTx.forEach(tx => {
    if (tx.date > targetDate) return;
    const id = tx.productId;
    if (!holdings[id]) holdings[id] = { qty: 0, costBasis: 0 };
    const qty = Math.abs(tx.quantity);
    if (tx.buysell === 'B') {
      holdings[id].qty += qty;
      holdings[id].costBasis += Math.abs(tx.totalInBaseCurrency);
    } else {
      holdings[id].qty -= qty;
    }
  });

  let totalValue = 0;
  const result = [];

  Object.entries(holdings).forEach(([id, h]) => {
    if (h.qty < 0.01) return;
    const name = names[id] || 'ID ' + id;
    const currency = meta[id]?.currency || 'EUR';

    // Try to find price from VWD history
    const history = priceHistories[id];
    let price = null;
    let source = 'cost basis';

    if (history && history.length > 0) {
      // Find nearest price on or before targetDate
      let best = null;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].date <= targetDate) { best = history[i]; break; }
      }
      if (!best && history[0].date <= targetDate) best = history[0];
      if (best) {
        // VWD prices are in native currency. For EUR positions, use directly.
        // For non-EUR, we need the FX rate — approximate from the cost basis.
        if (currency === 'EUR') {
          price = best.price * h.qty;
          source = 'market price';
        } else {
          // Use the average EUR cost per native unit as FX proxy
          const avgCostPerShare = h.costBasis / h.qty;
          const avgNativePrice = best.price;
          // We can't reliably get historical FX, so use cost-basis FX
          // costBasis / qty = EUR per share (including FX at purchase time)
          price = h.costBasis; // fall back to cost basis for non-EUR
          source = 'cost basis (non-EUR)';
        }
      }
    }

    if (price === null) {
      price = h.costBasis;
    }

    totalValue += price;
    const isin = meta[id]?.isin || '';
    result.push({ id, name, isin, qty: h.qty, value: price, source });
  });

  return { totalValue, holdings: result };
}

// ── Tax Classification & Constants ──────────────────────────────────────────

/**
 * Classify a product as 'stock', 'etf', 'bond', 'fund', or 'other'
 * for tax form routing (e.g., DE: stocks → KAP, ETFs/funds → KAP-INV).
 */
function classifyProduct(productId) {
  const meta = globalData.meta || {};
  const names = globalData.names || {};
  const m = meta[productId];
  const typeId = m?.productTypeId;
  if (typeId === 1) return 'stock';
  if (typeId === 131) return 'etf';
  if (typeId === 3) return 'fund';
  if (typeId === 2) return 'bond';
  // Fallback: name heuristics
  const name = (names[productId] || '').toUpperCase();
  if (/\bETF\b|\bUCITS\b|\bTRACKER\b|\bINDEX\b/.test(name)) return 'etf';
  if (/\bFONDS?\b|\bFUND\b/.test(name)) return 'fund';
  if (/\bBOND\b|\bOBLIG/i.test(name)) return 'bond';
  return 'stock'; // default assumption for individual securities
}

/**
 * Map classifyProduct() output to German labels for Anlage KAP / KAP-INV.
 */
function classifyProductDE(productId) {
  const cls = classifyProduct(productId);
  return (cls === 'etf' || cls === 'fund') ? 'fund' : cls;
}

const TAX_CONSTANTS = {
  NL: {
    2023: { threshold: 57000, deemedReturnInvestments: 6.17 },
    2024: { threshold: 57000, deemedReturnInvestments: 6.04 },
    2025: { threshold: 57684, deemedReturnInvestments: 5.88 },
  },
  FR: { pfuRate: 0.30, irRate: 0.128, psRate: 0.172 },
  DE: { sparerpauschbetrag: 1000, abgeltungsteuer: 0.26375 },
  BE: {
    2023: { voorheffing: 0.30, dividendExemption: 800 },
    2024: { voorheffing: 0.30, dividendExemption: 800 },
    2025: { voorheffing: 0.30, dividendExemption: 833 },
  },
};

const BE_LABELS = {
  nl: {
    dividendForeign: 'Dividenden (buitenlandse rekening)',
    exemptAmount: 'Vrijgesteld bedrag',
    taxableDividend: 'Belastbaar dividend',
    estWithholding: 'Geschatte voorheffing (30%)',
    capitalGains: 'Meerwaarden',
    notTaxable: 'Niet belastbaar (normaal beheer privévermogen)',
    code: 'Code',
    security: 'Effect',
    isin: 'ISIN',
    type: 'Type',
    dividend: 'Dividend (EUR)',
    realizedGain: 'Gerealiseerde winst/verlies (EUR)',
    holdingDays: 'Houdperiode (dagen)',
    speculative: 'Speculatief (<6m)',
    total: 'TOTAAL',
    stock: 'Aandeel',
    etf: 'ETF',
    bond: 'Obligatie',
    fund: 'Fonds',
    other: 'Overig',
    yes: 'Ja',
    no: 'Nee',
    noteNoWithholding: 'DEGIRO houdt geen Belgische roerende voorheffing in. U moet dividenden zelf aangeven via code 1444/2444.',
    noteETFExclusion: 'Dividenden van ICB\'s (inclusief ETF\'s) komen niet in aanmerking voor de vrijstelling.',
    noteSpeculative: 'Meerwaarden op aandelen zijn in principe niet belastbaar, tenzij zij als speculatief worden beschouwd (bezit < 6 maanden).',
    disclaimer: 'Dit overzicht is gegenereerd op basis van DEGIRO-transactiegegevens en bevat mogelijk niet alle belastbare gebeurtenissen. Dit is geen belastingadvies. Controleer alle bedragen bij een gekwalificeerd belastingadviseur voordat u deze gebruikt voor officiële belastingaangiften. De ontwikkelaars aanvaarden geen aansprakelijkheid voor fouten, omissies of gevolgen van het gebruik van deze gegevens.',
  },
  fr: {
    dividendForeign: 'Dividendes (compte étranger)',
    exemptAmount: 'Montant exempté',
    taxableDividend: 'Dividende imposable',
    estWithholding: 'Précompte estimé (30%)',
    capitalGains: 'Plus-values',
    notTaxable: 'Non imposable (gestion normale du patrimoine privé)',
    code: 'Code',
    security: 'Titre',
    isin: 'ISIN',
    type: 'Type',
    dividend: 'Dividende (EUR)',
    realizedGain: 'Plus/moins-value réalisée (EUR)',
    holdingDays: 'Durée de détention (jours)',
    speculative: 'Spéculatif (<6m)',
    total: 'TOTAL',
    stock: 'Action',
    etf: 'ETF',
    bond: 'Obligation',
    fund: 'Fonds',
    other: 'Autre',
    yes: 'Oui',
    no: 'Non',
    noteNoWithholding: 'DEGIRO ne retient pas de précompte mobilier belge. Vous devez déclarer vos dividendes vous-même via le code 1444/2444.',
    noteETFExclusion: 'Les dividendes d\'OPC (y compris les ETF) ne bénéficient pas de l\'exemption.',
    noteSpeculative: 'Les plus-values sur actions ne sont en principe pas imposables, sauf si elles sont considérées comme spéculatives (détention < 6 mois).',
    disclaimer: 'Ce document est généré à partir des données de transactions DEGIRO et peut ne pas refléter tous les événements imposables. Il ne constitue pas un conseil fiscal. Vérifiez tous les montants auprès d\'un conseiller fiscal qualifié avant de les utiliser pour vos déclarations officielles. Les développeurs déclinent toute responsabilité en cas d\'erreurs, d\'omissions ou de conséquences liées à l\'utilisation de ces données.',
  },
};

// ── Country Report Generators ───────────────────────────────────────────────

function generateNLTaxReport(year) {
  const peildatum = `${year}-01-01`;
  const portfolio = getPortfolioValueOnDate(peildatum);
  const dividends = getDividendsForYear(year);
  const gains = computeRealizedGainsForYear(year);
  const txYear = getTransactionsForYear(year);

  const totalDividends = sumDividends(dividends);
  const totalGains = gains.reduce((s, g) => s + g.realizedPL, 0);
  const totalFees = txYear.reduce((s, tx) =>
    s + txFeeEur(tx), 0);

  const nlConst = TAX_CONSTANTS.NL[year] || TAX_CONSTANTS.NL[2025];
  const threshold = nlConst.threshold;
  const deemedRate = nlConst.deemedReturnInvestments;
  const taxableWealth = Math.max(0, portfolio.totalValue - threshold);
  const deemedReturn = taxableWealth * (deemedRate / 100);

  const fmtNL = v => new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(v || 0);

  const summary = [
    { label: 'Waarde op peildatum (1 jan)', value: fmtNL(portfolio.totalValue), ref: 'Box 3' },
    { label: 'Belastbaar vermogen', value: fmtNL(taxableWealth), ref: taxableWealth > 0 ? '' : 'Onder vrijstelling' },
    { label: `Forfaitair rendement (${deemedRate}%)`, value: fmtNL(deemedReturn) },
  ];

  // Main table: per-position peildatum breakdown
  const headers = ['ISIN', 'Naam', 'Aantal', 'Waarde (EUR)', 'Bron'];
  const rows = [];

  portfolio.holdings
    .sort((a, b) => b.value - a.value)
    .forEach(h => {
      rows.push([
        h.isin || '-',
        h.name,
        h.qty.toFixed(2),
        h.value.toFixed(2),
        h.source === 'market price' ? 'Marktprijs' : 'Kostprijs',
      ]);
    });

  rows.push(['', '', '', '', '']);
  rows.push(['', 'TOTAAL', '', portfolio.totalValue.toFixed(2), '']);

  // Supplementary section: actual return (werkelijk rendement)
  const sections = [{
    title: `Bezittingen op peildatum 1 januari ${year}`,
    headers,
    rows,
  }];

  // Werkelijk rendement section
  const werkelijkHeaders = ['Categorie', 'Bedrag (EUR)'];
  const werkelijkRows = [
    ['Dividenden ontvangen', totalDividends.toFixed(2)],
    ['Gerealiseerde winst/verlies', totalGains.toFixed(2)],
    ['Transactiekosten', totalFees.toFixed(2)],
    ['', ''],
    ['Netto werkelijk rendement', (totalDividends + totalGains - totalFees).toFixed(2)],
  ];
  sections.push({
    title: 'Werkelijk rendement (informatief)',
    subtitle: 'U kunt werkelijk rendement opgeven als dit lager is dan het forfaitaire rendement.',
    headers: werkelijkHeaders,
    rows: werkelijkRows,
  });

  const notes = [
    `Heffingsvrij vermogen ${year}: €${threshold.toLocaleString('nl-NL')} per persoon / €${(threshold * 2).toLocaleString('nl-NL')} voor fiscale partners. Vermogen onder deze drempel is niet belastbaar.`,
    'Dit overzicht bevat alleen uw DEGIRO-beleggingsportefeuille. Vermeld ook spaargeld, onroerend goed, crypto en overige bezittingen in Box 3.',
    'Schuldendrempel: €3.800 per persoon — schulden boven deze drempel mogen worden afgetrokken.',
  ];

  return { summary, sections, notes, filename: `sharpe_tax_NL_box3_${year}.csv` };
}

function generateFRTaxReport(year, form) {
  const gains = computeRealizedGainsForYear(year);
  const dividends = getDividendsForYear(year);

  const totalGainsPositive = gains.reduce((s, g) => s + Math.max(0, g.realizedPL), 0);
  const totalGainsNegative = gains.reduce((s, g) => s + Math.min(0, g.realizedPL), 0);
  const netGains = totalGainsPositive + totalGainsNegative;
  const totalDividends = sumDividends(dividends);
  const totalFees = gains.reduce((s, g) => s + g.fees, 0);
  const pfuTaxable = Math.max(0, netGains) + totalDividends;
  const pfuEstimate = pfuTaxable * 0.30;

  if (form === '2074') {
    // Formulaire 2074 — Cadre 510: one row per cession lot (FIFO-matched)
    const headers = ['ISIN', 'Titre', 'Date d\'acquisition', 'Date de cession', 'Quantité',
      'Prix d\'acquisition (EUR)', 'Prix de cession (EUR)', 'Frais (EUR)', 'Plus/Moins-value (EUR)'];
    const rows = [];

    gains.forEach(g => {
      g.lots.forEach(lot => {
        const buyCost = lot.shares * lot.buyEurPerShare;
        const sellProc = lot.shares * lot.sellEurPerShare;
        const pv = sellProc - buyCost;
        rows.push([
          g.isin || '-',
          g.name,
          lot.buyDate,
          lot.sellDate,
          lot.shares.toFixed(4),
          buyCost.toFixed(2),
          sellProc.toFixed(2),
          (lot.lotFees || 0).toFixed(2),
          pv.toFixed(2),
        ]);
      });
    });

    rows.sort((a, b) => a[3].localeCompare(b[3])); // Sort by cession date
    rows.push(['', '', '', '', '', '', '', '', '']);
    rows.push(['', 'TOTAL', '', '', '',
      gains.reduce((s, g) => s + g.buyTotal, 0).toFixed(2),
      gains.reduce((s, g) => s + g.sellTotal, 0).toFixed(2),
      totalFees.toFixed(2),
      netGains.toFixed(2)]);

    const summary = [
      { label: 'Total plus-values', value: fmtEur(totalGainsPositive) },
      { label: 'Total moins-values', value: fmtEur(totalGainsNegative) },
      { label: 'Résultat net', value: fmtEur(netGains), ref: netGains >= 0 ? '→ case 3VG' : '→ case 3VH' },
      { label: 'Frais totaux', value: fmtEur(totalFees) },
    ];

    const notes = [
      'Chaque ligne correspond à un lot cédé, valorisé selon la méthode FIFO (premier entré, premier sorti).',
      'Pensez à déclarer votre compte DEGIRO via le formulaire 3916 (compte détenu à l\'étranger).',
      'Les dividendes de source étrangère doivent également être reportés sur le formulaire 2047.',
    ];

    return { summary, sections: [{ headers, rows }], notes, filename: `sharpe_tax_FR_2074_${year}.csv` };
  }

  // Formulaire 2042 — Résumé PFU
  const summary = [
    { label: 'Plus-values nettes', value: fmtEur(Math.max(0, netGains)), ref: '→ case 3VG' },
    { label: 'Moins-values nettes', value: fmtEur(Math.min(0, netGains)), ref: '→ case 3VH' },
    { label: 'Dividendes', value: fmtEur(totalDividends), ref: '→ case 2DC' },
    { label: 'PFU estimé (30%)', value: fmtEur(pfuEstimate) },
  ];

  const headers = ['ISIN', 'Titre', 'Plus/Moins-value (EUR)', 'Dividendes (EUR)', 'Frais (EUR)'];
  const rows = [];

  const divByProduct = {};
  dividends.forEach(d => {
    if (!divByProduct[d.product]) divByProduct[d.product] = 0;
    divByProduct[d.product] += d.amountEUR || 0;
  });

  const allProducts = new Set([...gains.map(g => g.name), ...Object.keys(divByProduct)]);
  allProducts.forEach(name => {
    const gain = gains.find(g => g.name === name);
    const div = divByProduct[name] || 0;
    const fees = gain ? gain.fees : 0;
    const pl = gain ? gain.realizedPL : 0;
    const isin = gain ? (gain.isin || '-') : '-';
    if (Math.abs(pl) > 0.01 || Math.abs(div) > 0.01) {
      rows.push([isin, name, pl.toFixed(2), div.toFixed(2), fees.toFixed(2)]);
    }
  });

  rows.sort((a, b) => Math.abs(parseFloat(b[2])) - Math.abs(parseFloat(a[2])));
  rows.push(['', '', '', '', '']);
  rows.push(['', 'TOTAL', netGains.toFixed(2), totalDividends.toFixed(2), totalFees.toFixed(2)]);

  const notes = [
    'Pensez à déclarer votre compte DEGIRO via le formulaire 3916 (compte détenu à l\'étranger).',
    'Les dividendes de source étrangère doivent également être reportés sur le formulaire 2047.',
    'En cas d\'option pour le barème progressif (case 2OP), des abattements pour durée de détention peuvent s\'appliquer sur les titres acquis avant 2018.',
    'Les moins-values sont reportables pendant 10 ans sur les plus-values de même nature.',
  ];

  return { summary, sections: [{ headers, rows }], notes, filename: `sharpe_tax_FR_2042_${year}.csv` };
}

function generateDETaxReport(year) {
  const gains = computeRealizedGainsForYear(year);
  const dividends = getDividendsForYear(year);
  const meta = globalData.meta || {};

  // Classify products into stocks vs funds/ETFs
  const divByProduct = {};
  const divProductIds = {};
  dividends.forEach(d => {
    if (!divByProduct[d.product]) { divByProduct[d.product] = 0; divProductIds[d.product] = null; }
    divByProduct[d.product] += d.amountEUR || 0;
  });
  // Try to find product IDs for dividend entries by name match
  Object.keys(globalData.names || {}).forEach(id => {
    const n = globalData.names[id];
    if (divProductIds[n] === null) divProductIds[n] = id;
  });

  // Build unified product list with classification
  const products = [];
  const seen = new Set();

  gains.forEach(g => {
    const cls = classifyProductDE(g.id);
    const div = divByProduct[g.name] || 0;
    products.push({
      isin: g.isin || '-',
      name: g.name,
      id: g.id,
      type: cls,
      pl: g.realizedPL,
      div,
      fees: g.fees,
    });
    seen.add(g.name);
  });

  Object.entries(divByProduct).forEach(([name, div]) => {
    if (seen.has(name)) return;
    const id = divProductIds[name];
    const cls = id ? classifyProductDE(id) : 'stock';
    const isin = id ? (meta[id]?.isin || '-') : '-';
    products.push({ isin, name, id, type: cls, pl: 0, div, fees: 0 });
  });

  // Separate into stocks (KAP) and funds/ETFs (KAP-INV)
  const stocks = products.filter(p => p.type !== 'fund');
  const funds = products.filter(p => p.type === 'fund');

  // Calculate totals per section
  const stockGainsPos = stocks.reduce((s, p) => s + Math.max(0, p.pl), 0);
  const stockGainsNeg = stocks.reduce((s, p) => s + Math.min(0, p.pl), 0);
  const stockDiv = stocks.reduce((s, p) => s + p.div, 0);
  const stockFees = stocks.reduce((s, p) => s + p.fees, 0);

  const fundGainsPos = funds.reduce((s, p) => s + Math.max(0, p.pl), 0);
  const fundGainsNeg = funds.reduce((s, p) => s + Math.min(0, p.pl), 0);
  const fundDiv = funds.reduce((s, p) => s + p.div, 0);
  const fundFees = funds.reduce((s, p) => s + p.fees, 0);

  const totalDiv = stockDiv + fundDiv;
  const totalFees = stockFees + fundFees;
  const sp = TAX_CONSTANTS.DE.sparerpauschbetrag;
  const totalCapitalIncome = stockGainsPos + stockGainsNeg + totalDiv;
  const taxableBase = Math.max(0, totalCapitalIncome - totalFees - sp);
  const abgeltungsteuer = taxableBase * TAX_CONSTANTS.DE.abgeltungsteuer;

  const summary = [
    { label: 'Kapitalerträge (ausl. Institut)', value: fmtEur(totalCapitalIncome), ref: 'Zeile 19' },
    { label: 'Gewinne Aktienveräußerung', value: fmtEur(stockGainsPos), ref: 'Zeile 20' },
    { label: 'Verluste Aktienveräußerung', value: fmtEur(stockGainsNeg), ref: 'Zeile 23' },
    { label: `Sparerpauschbetrag`, value: `€${sp.toLocaleString('de-DE')}`, ref: 'Zeile 16/17' },
    { label: 'Gesch. Abgeltungsteuer (26,375%)', value: fmtEur(abgeltungsteuer) },
  ];

  // Build section A: Stocks (Anlage KAP)
  const sHeaders = ['ISIN', 'Wertpapier', 'Veräußerungsgewinn/-verlust (EUR)', 'Dividenden (EUR)', 'Gebühren (EUR)'];
  const stockRows = [];
  stocks
    .filter(p => Math.abs(p.pl) > 0.01 || Math.abs(p.div) > 0.01)
    .sort((a, b) => Math.abs(b.pl) - Math.abs(a.pl))
    .forEach(p => {
      stockRows.push([p.isin, p.name, p.pl.toFixed(2), p.div.toFixed(2), p.fees.toFixed(2)]);
    });
  stockRows.push(['', '', '', '', '']);
  stockRows.push(['', 'GESAMT Aktien', (stockGainsPos + stockGainsNeg).toFixed(2), stockDiv.toFixed(2), stockFees.toFixed(2)]);

  // Build section B: Funds/ETFs (Anlage KAP-INV)
  const fundRows = [];
  funds
    .filter(p => Math.abs(p.pl) > 0.01 || Math.abs(p.div) > 0.01)
    .sort((a, b) => Math.abs(b.pl) - Math.abs(a.pl))
    .forEach(p => {
      fundRows.push([p.isin, p.name, p.pl.toFixed(2), p.div.toFixed(2), p.fees.toFixed(2)]);
    });
  fundRows.push(['', '', '', '', '']);
  fundRows.push(['', 'GESAMT Fonds/ETFs', (fundGainsPos + fundGainsNeg).toFixed(2), fundDiv.toFixed(2), fundFees.toFixed(2)]);

  const sections = [
    { title: 'Anlage KAP — Aktien / Einzelwerte', headers: sHeaders, rows: stockRows },
  ];
  if (funds.length > 0) {
    sections.push({
      title: 'Anlage KAP-INV — Fonds / ETFs',
      subtitle: 'Diese Erträge gehören auf die Anlage KAP-INV, nicht auf die Anlage KAP.',
      headers: sHeaders,
      rows: fundRows,
    });
  }

  const notes = [
    `Sparerpauschbetrag: €${sp.toLocaleString('de-DE')} (Einzelperson) / €${(sp * 2).toLocaleString('de-DE')} (Zusammenveranlagung) — Zeile 16/17.`,
    'Aktienverluste können nur mit Aktiengewinnen verrechnet werden. Allgemeine Verluste können mit allen Kapitalerträgen verrechnet werden.',
    'Ausländische Quellensteuer kann unter bestimmten Voraussetzungen angerechnet werden (Zeile 41).',
    'Günstigerprüfung (Zeile 4): Empfehlenswert wenn Ihr persönlicher Steuersatz unter 25% liegt.',
    'Kirchensteuer (8–9%) ist in der Schätzung nicht enthalten.',
  ];

  return { summary, sections, notes, filename: `sharpe_tax_DE_anlageKAP_${year}.csv` };
}

function generateBETaxReport(year, _form, beLang) {
  const lang = beLang || 'nl';
  const L = BE_LABELS[lang] || BE_LABELS.nl;
  const gains = computeRealizedGainsForYear(year);
  const dividends = getDividendsForYear(year);
  const meta = globalData.meta || {};

  const beConst = TAX_CONSTANTS.BE[year] || TAX_CONSTANTS.BE[2025];
  const exemption = beConst.dividendExemption;

  const totalDividends = sumDividends(dividends);
  const exemptAmount = Math.min(totalDividends, exemption);
  const taxableDividend = Math.max(0, totalDividends - exemption);
  const voorheffing = taxableDividend * beConst.voorheffing;

  const divByProduct = {};
  const divProductIds = {};
  dividends.forEach(d => {
    if (!divByProduct[d.product]) { divByProduct[d.product] = 0; divProductIds[d.product] = null; }
    divByProduct[d.product] += d.amountEUR || 0;
  });
  Object.keys(globalData.names || {}).forEach(id => {
    const n = globalData.names[id];
    if (divProductIds[n] === null) divProductIds[n] = id;
  });

  let speculativeGains = 0;
  let longTermGains = 0;

  const typeLabels = { stock: L.stock, etf: L.etf, bond: L.bond, fund: L.fund, other: L.other };

  const headers = [L.isin, L.security, L.type, L.dividend, L.realizedGain, L.holdingDays, L.speculative];
  const rows = [];

  const allProducts = new Set([...gains.map(g => g.name), ...Object.keys(divByProduct)]);
  allProducts.forEach(name => {
    const gain = gains.find(g => g.name === name);
    const div = divByProduct[name] || 0;
    const pl = gain ? gain.realizedPL : 0;
    const id = gain ? gain.id : divProductIds[name];
    const isin = gain ? (gain.isin || '-') : (id ? (meta[id]?.isin || '-') : '-');
    const cls = id ? classifyProduct(id) : 'stock';

    let avgHoldingDays = 0;
    let isSpeculative = false;
    if (gain && gain.lots.length > 0) {
      const totalShares = gain.lots.reduce((s, l) => s + l.shares, 0);
      avgHoldingDays = totalShares > 0
        ? Math.round(gain.lots.reduce((s, l) => s + l.holdingDays * l.shares, 0) / totalShares)
        : 0;
      isSpeculative = avgHoldingDays < 183;
      if (isSpeculative) speculativeGains += pl;
      else longTermGains += pl;
    }

    if (Math.abs(pl) > 0.01 || Math.abs(div) > 0.01) {
      rows.push([
        isin,
        name,
        typeLabels[cls] || typeLabels.other,
        div.toFixed(2),
        pl.toFixed(2),
        gain ? String(avgHoldingDays) : '-',
        gain ? (isSpeculative ? L.yes : L.no) : '-',
      ]);
    }
  });

  rows.sort((a, b) => Math.abs(parseFloat(b[4])) - Math.abs(parseFloat(a[4])));
  rows.push(['', '', '', '', '', '', '']);
  rows.push(['', L.total, '', totalDividends.toFixed(2), (speculativeGains + longTermGains).toFixed(2), '', '']);

  const summary = [
    { label: L.dividendForeign, value: fmtEur(totalDividends), ref: 'Code 1444' },
    { label: L.exemptAmount, value: fmtEur(exemptAmount), ref: 'Code 1437' },
    { label: L.taxableDividend, value: fmtEur(taxableDividend) },
    { label: L.estWithholding, value: fmtEur(voorheffing) },
    { label: L.capitalGains, value: L.notTaxable },
  ];

  const notes = [
    L.noteNoWithholding,
    `${L.exemptAmount}: €${exemption} (${year}).`,
    L.noteETFExclusion,
    L.noteSpeculative,
  ];

  return { summary, sections: [{ headers, rows }], notes, filename: `sharpe_tax_BE_ipp_${year}.csv` };
}

// ── Render Tax Tab ──────────────────────────────────────────────────────────

// ── Dividends tab ──────────────────────────────────────────────────────────

/**
 * Aggregate dividend history for the Dividends tab.
 * Pure function — no fetches, no DOM.
 */
function computeDividendStats(dividends, positions) {
  const now = new Date();
  const ttmCutoff = new Date(now.getTime() - 365 * 86400000).toISOString().slice(0, 10);

  // Zero-fill the last 12 calendar months (including the current one)
  const byMonth = {};
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    byMonth[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`] = 0;
  }

  let ttmTotal = 0, allTimeTotal = 0, ttmCount = 0;
  const byHolding = {};
  dividends.forEach(d => {
    const eur = d.amountEUR || 0;
    allTimeTotal += eur;
    if (d.date >= ttmCutoff) { ttmTotal += eur; ttmCount++; }
    const key = d.productId || d.product;
    if (!byHolding[key]) byHolding[key] = { name: d.product, count: 0, total: 0, ttm: 0, costBasis: null };
    const h = byHolding[key];
    h.count++;
    h.total += eur;
    if (d.date >= ttmCutoff) h.ttm += eur;
    const m = d.date.slice(0, 7);
    if (m in byMonth) byMonth[m] += eur;
  });

  // Attach per-holding cost basis from open positions (null when closed/absent)
  Object.entries(byHolding).forEach(([pid, h]) => {
    const pos = positions.find(p => String(p.id) === pid);
    if (pos) {
      const unrealized = pos.plUnrealized ?? pos.plBase;
      h.costBasis = pos.value - unrealized;
      if (pos.name) h.name = pos.name;
    }
  });

  const totalCostBasis = positions.reduce((s, p) => s + (p.value - (p.plUnrealized ?? p.plBase)), 0);
  const yieldOnCost = totalCostBasis > 0 ? (ttmTotal / totalCostBasis) * 100 : null;

  return { ttmTotal, allTimeTotal, count: dividends.length, ttmCount, yieldOnCost, byMonth, byHolding };
}

/**
 * Conservative next-payment projection from historical cadence only.
 * A product qualifies when its payment gaps form a recognisable cadence
 * (monthly/quarterly/semi-annual/annual) with ≥⅔ of gaps within ±20% of the
 * median. No external data — these are estimates, labeled as such in the UI.
 */
function computeExpectedDividends(dividends) {
  const byProduct = {};
  dividends.forEach(d => {
    const key = d.productId || d.product;
    (byProduct[key] = byProduct[key] || { name: d.product, payments: [] }).payments.push(d);
  });

  const CADENCE_WINDOWS = [[25, 35], [80, 100], [170, 195], [350, 380]];
  const todayStr = new Date().toISOString().slice(0, 10);
  const horizonStr = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);

  const out = [];
  Object.values(byProduct).forEach(({ name, payments }) => {
    const dates = payments.map(p => p.date).sort();
    let predictedTs = null;
    if (dates.length >= 3) {
      const gaps = [];
      for (let i = 1; i < dates.length; i++) gaps.push((new Date(dates[i]) - new Date(dates[i - 1])) / 86400000);
      const sortedGaps = [...gaps].sort((a, b) => a - b);
      const median = sortedGaps[Math.floor(sortedGaps.length / 2)];
      const cadenceOk = CADENCE_WINDOWS.some(([lo, hi]) => median >= lo && median <= hi);
      const regular = gaps.filter(g => Math.abs(g - median) <= median * 0.2).length >= gaps.length * (2 / 3);
      if (cadenceOk && regular) predictedTs = new Date(dates[dates.length - 1]).getTime() + median * 86400000;
    } else if (dates.length === 2) {
      // Two payments: only the annual same-cadence rule
      const gap = (new Date(dates[1]) - new Date(dates[0])) / 86400000;
      if (gap >= 350 && gap <= 380) predictedTs = new Date(dates[1]).getTime() + gap * 86400000;
    }
    if (!predictedTs) return;
    const predicted = new Date(predictedTs).toISOString().slice(0, 10);
    if (predicted < todayStr || predicted > horizonStr) return;
    // dividends arrive sorted desc by date, so the first 3 are the most recent
    const recentAmounts = payments.slice(0, 3).map(p => p.amountEUR).sort((a, b) => a - b);
    const amount = recentAmounts[Math.floor(recentAmounts.length / 2)];
    out.push({ name, date: predicted, amount });
  });

  return out.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3);
}

function exportDividends() {
  const rows = (globalData.dividends || []).map(d => [d.date, d.product, d.amount, d.currency, d.amountEUR]);
  downloadCSV('dividends.csv', ['Date', 'Product', 'Amount', 'Currency', 'Amount (EUR)'], rows);
}

function renderDividendsTab() {
  const emptyEl = document.getElementById('dividendsEmpty');
  const statsCard = document.getElementById('divStatsCard');
  const chartCard = document.getElementById('divChartCard');
  const holdingsCard = document.getElementById('divHoldingsCard');
  const statsGrid = document.getElementById('divStatsGrid');
  const holdingsContent = document.getElementById('divHoldingsContent');
  const nextEl = document.getElementById('divNextEstimate');
  if (!emptyEl || !statsCard || !chartCard || !holdingsCard || !statsGrid || !holdingsContent || !nextEl) return;

  const dividends = globalData.dividends || [];
  const positions = globalData.positions || [];

  // Idempotent re-render: clear everything this function owns
  statsGrid.textContent = '';
  holdingsContent.textContent = '';
  nextEl.textContent = '';
  nextEl.style.display = 'none';
  removeProOverlay(holdingsCard);
  holdingsCard.querySelector('.card-header .btn-export')?.remove();

  if (!dividends.length) {
    statsCard.style.display = 'none';
    chartCard.style.display = 'none';
    holdingsCard.style.display = 'none';
    emptyEl.style.display = 'block';
    emptyEl.textContent = '';
    const zero = document.createElement('div');
    zero.style.cssText = 'text-align:center;padding:60px 24px;color:var(--muted);font-family:var(--font-display)';
    const icon = document.createElement('div'); icon.style.cssText = 'font-size:48px;margin-bottom:16px'; icon.textContent = '💶';
    const title = document.createElement('div'); title.style.cssText = 'font-size:20px;font-weight:700;color:var(--text);margin-bottom:8px'; title.textContent = 'No dividends yet';
    const sub = document.createElement('div'); sub.style.cssText = 'font-size:13px;line-height:1.6'; sub.textContent = 'Dividend payments will appear here once they are received in your DEGIRO account.';
    zero.append(icon, title, sub);
    emptyEl.appendChild(zero);
    return;
  }
  emptyEl.style.display = 'none';
  statsCard.style.display = '';
  chartCard.style.display = '';
  holdingsCard.style.display = '';

  const stats = computeDividendStats(dividends, positions);

  // ── Stat tiles (reuse the .more-info-stat look) ──
  const makeTile = (label, value, sub, tooltip) => {
    const tile = document.createElement('div');
    tile.className = 'more-info-stat' + (tooltip ? ' more-info-stat--tip' : '');
    if (tooltip) tile.dataset.tip = tooltip;
    const lbl = document.createElement('div'); lbl.className = 'more-info-stat-label'; lbl.textContent = label;
    const val = document.createElement('div'); val.className = 'more-info-stat-value sensitive'; val.textContent = value;
    tile.append(lbl, val);
    if (sub) {
      const subEl = document.createElement('div'); subEl.className = 'more-info-stat-sub'; subEl.textContent = sub;
      tile.appendChild(subEl);
    }
    return tile;
  };
  statsGrid.append(
    makeTile('Received · last 12 months', fmtEur(stats.ttmTotal), `${stats.ttmCount} payments`),
    makeTile('Received · all-time', fmtEur(stats.allTimeTotal), `${stats.count} payments`),
    makeTile('Yield on cost', stats.yieldOnCost != null ? stats.yieldOnCost.toFixed(2) + '%' : '—', 'last 12M ÷ cost basis',
      'Trailing-12-month dividends divided by the current total cost basis of your open positions. ≈ estimate — cost basis covers open positions only, gross of withholding tax.'),
  );

  // ── Monthly bar chart ──
  renderDividendChart(stats.byMonth);

  // ── Expected next payments (heuristic) ──
  const expected = computeExpectedDividends(dividends);
  if (expected.length) {
    nextEl.style.display = '';
    const head = document.createElement('div');
    head.className = 'div-next-head';
    head.textContent = 'Expected next · estimates based on historical payment cadence — not announced by the issuer';
    nextEl.appendChild(head);
    expected.forEach(e => {
      const row = document.createElement('div'); row.className = 'div-next-row';
      const nm = document.createElement('span'); nm.className = 'div-next-name'; nm.textContent = e.name;
      const dt = document.createElement('span'); dt.className = 'div-next-date';
      dt.textContent = '≈ ' + new Date(e.date + 'T12:00:00').toLocaleDateString('default', { day: 'numeric', month: 'short' });
      const amt = document.createElement('span'); amt.className = 'div-next-amt sensitive'; amt.textContent = '≈ ' + fmtEur(e.amount);
      row.append(nm, dt, amt);
      nextEl.appendChild(row);
    });
  }

  // ── Per-holding breakdown (Pro) ──
  const buildHoldingsTable = (rows) => {
    const table = document.createElement('table');
    table.className = 'positions-table';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    ['Name', 'Payments', 'Total received', 'Last 12M', 'Yield on cost'].forEach(h => {
      const th = document.createElement('th'); th.textContent = h; hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    rows.forEach(h => {
      const tr = document.createElement('tr');
      const tdName = document.createElement('td'); tdName.className = 'td-name'; tdName.textContent = h.name;
      const tdCount = document.createElement('td'); tdCount.textContent = h.count;
      const tdTotal = document.createElement('td'); tdTotal.className = 'sensitive'; tdTotal.textContent = fmtEur(h.total);
      const tdTtm = document.createElement('td'); tdTtm.className = 'sensitive'; tdTtm.textContent = fmtEur(h.ttm);
      const tdYoc = document.createElement('td'); tdYoc.className = 'td-vol';
      tdYoc.textContent = (h.costBasis > 0 && h.ttm > 0) ? ((h.ttm / h.costBasis) * 100).toFixed(2) + '%' : '—';
      tr.append(tdName, tdCount, tdTotal, tdTtm, tdYoc);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  };

  const holdings = Object.values(stats.byHolding).sort((a, b) => b.total - a.total);
  const header = holdingsCard.querySelector('.card-header');
  if (proUnlocked) {
    holdingsContent.appendChild(buildHoldingsTable(holdings));
    if (header && !header.querySelector('.btn-export')) {
      header.appendChild(makeExportBtn('Export dividends as CSV', exportDividends, false));
    }
  } else {
    // Placeholder rows only — real figures are never rendered blurred
    const fakeRows = [
      { name: 'Vanguard FTSE All-World', count: 8, total: 214.4, ttm: 96.2, costBasis: 4600 },
      { name: 'Example Dividend Stock', count: 6, total: 122.1, ttm: 61.3, costBasis: 2900 },
      { name: 'Another Holding', count: 4, total: 58.7, ttm: 29.4, costBasis: 1500 },
      { name: 'Fourth Position', count: 2, total: 21.9, ttm: 21.9, costBasis: 1100 },
    ];
    const blurWrap = document.createElement('div');
    blurWrap.className = 'tax-blur-wrap';
    blurWrap.appendChild(buildHoldingsTable(fakeRows));
    holdingsContent.appendChild(blurWrap);
    showProOverlay(holdingsCard, 'Dividend Breakdown');
    if (header && !header.querySelector('.btn-export')) {
      header.appendChild(makeExportBtn('Export dividends as CSV', exportDividends, true));
    }
  }
}

async function renderTaxTab() {
  const container = document.getElementById('taxReportContent');
  if (!container) return;

  const buildFormUI = () => {
    const wrap = document.createElement('div');

    // ── Selector row ──
    const selectorRow = document.createElement('div');
    selectorRow.className = 'tax-selector-row';

    // Country
    const countryGroup = document.createElement('div');
    countryGroup.className = 'tax-selector-group';
    countryGroup.innerHTML = '<div class="tax-selector-label">Country</div>';
    const countrySelect = document.createElement('select');
    countrySelect.className = 'tax-select';
    Object.entries(TAX_COUNTRIES).forEach(([code, c]) => {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = c.label;
      countrySelect.appendChild(opt);
    });
    countryGroup.appendChild(countrySelect);
    selectorRow.appendChild(countryGroup);

    // Year
    const yearGroup = document.createElement('div');
    yearGroup.className = 'tax-selector-group';
    yearGroup.innerHTML = '<div class="tax-selector-label">Tax Year</div>';
    const yearSelect = document.createElement('select');
    yearSelect.className = 'tax-select';
    const txDates = (globalData.transactions || []).map(t => t.date).filter(Boolean).sort();
    const minYear = txDates.length > 0 ? parseInt(txDates[0].slice(0, 4)) : new Date().getFullYear() - 1;
    const maxYear = new Date().getFullYear() - 1;
    for (let y = maxYear; y >= minYear; y--) {
      const opt = document.createElement('option');
      opt.value = y;
      opt.textContent = String(y);
      yearSelect.appendChild(opt);
    }
    yearGroup.appendChild(yearSelect);
    selectorRow.appendChild(yearGroup);

    // Form (France only)
    const formGroup = document.createElement('div');
    formGroup.className = 'tax-selector-group';
    formGroup.style.display = 'none';
    formGroup.innerHTML = '<div class="tax-selector-label">Form</div>';
    const formSelect = document.createElement('select');
    formSelect.className = 'tax-select';
    TAX_COUNTRIES.FR.forms.forEach((f, i) => {
      const opt = document.createElement('option');
      opt.value = i === 0 ? '2042' : '2074';
      opt.textContent = f;
      formSelect.appendChild(opt);
    });
    formGroup.appendChild(formSelect);
    selectorRow.appendChild(formGroup);

    // Language toggle (Belgium only)
    const langGroup = document.createElement('div');
    langGroup.className = 'tax-selector-group';
    langGroup.style.display = 'none';
    langGroup.innerHTML = '<div class="tax-selector-label">Taal / Langue</div>';
    const langSelect = document.createElement('select');
    langSelect.className = 'tax-select';
    [['nl', 'Nederlands'], ['fr', 'Français']].forEach(([val, txt]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = txt;
      langSelect.appendChild(opt);
    });
    langGroup.appendChild(langSelect);
    selectorRow.appendChild(langGroup);

    wrap.appendChild(selectorRow);

    // ── Info box ──
    const infoBox = document.createElement('div');
    infoBox.className = 'tax-info-box';
    infoBox.textContent = TAX_COUNTRIES.NL.info;
    wrap.appendChild(infoBox);

    // ── Persistent disclaimer ──
    const persistentDisclaimer = document.createElement('div');
    persistentDisclaimer.className = 'tax-persistent-disclaimer';
    persistentDisclaimer.textContent = 'Sharpe provides tax tables for informational purposes only. These reports may contain errors or omissions. Always consult a qualified tax advisor before filing. Sharpe accepts no responsibility for inaccuracies.';
    wrap.appendChild(persistentDisclaimer);

    // ── Generate button ──
    const genBtn = document.createElement('button');
    genBtn.className = 'tax-generate-btn';
    genBtn.textContent = 'Generate Report';
    wrap.appendChild(genBtn);

    // ── Preview area (hidden initially) ──
    const previewWrap = document.createElement('div');
    previewWrap.style.display = 'none';
    wrap.appendChild(previewWrap);

    // ── Country change handler ──
    countrySelect.addEventListener('change', () => {
      const code = countrySelect.value;
      const country = TAX_COUNTRIES[code];
      infoBox.textContent = country.info;
      formGroup.style.display = code === 'FR' ? '' : 'none';
      langGroup.style.display = country.hasLangToggle ? '' : 'none';
      previewWrap.style.display = 'none';
    });

    // ── Generate handler ──
    genBtn.addEventListener('click', () => {
      const code = countrySelect.value;
      const year = parseInt(yearSelect.value);
      const form = code === 'FR' ? formSelect.value : null;
      const beLang = code === 'BE' ? langSelect.value : null;
      const country = TAX_COUNTRIES[code];

      genBtn.disabled = true;
      genBtn.textContent = 'Generating...';

      // Use setTimeout to let the UI update before heavy computation
      setTimeout(() => {
        try {
          const report = country.generate(year, form, beLang);
          const formLabel = code === 'FR' ? formSelect.options[formSelect.selectedIndex].text : country.forms[0];
          renderTaxReport(previewWrap, report, code, year, formLabel, beLang);
          previewWrap.style.display = '';
        } catch (e) {
          console.error('[Tax] Generation error:', e);
          previewWrap.innerHTML = '<div class="tax-empty-state">An error occurred generating the report. Please try again.</div>';
          previewWrap.style.display = '';
        }
        genBtn.disabled = false;
        genBtn.textContent = 'Generate Report';
      }, 50);
    });

    return wrap;
  };

  if (!proUnlocked) {
    // Non-Pro: show blurred form preview with Pro overlay
    const blurWrap = document.createElement('div');
    blurWrap.className = 'tax-blur-wrap';
    blurWrap.appendChild(buildFormUI());
    container.appendChild(blurWrap);
    showProOverlay(document.getElementById('taxReportCard'), 'Tax Reporting');
    return;
  }

  // Pro: show interactive form
  container.appendChild(buildFormUI());
}

// ── Render Generated Report ─────────────────────────────────────────────────

function renderTaxReport(container, report, countryCode, year, formLabel, beLang) {
  container.innerHTML = '';
  const { summary, sections, notes, filename } = report;

  // ── Summary cards (new format: array of { label, value, ref? }) ──
  const summaryWrap = document.createElement('div');
  summaryWrap.className = 'tax-summary-cards';
  summary.forEach(card => {
    const el = document.createElement('div');
    el.className = 'tax-summary-card';
    el.innerHTML = `
      <div class="tax-summary-label">${sanitize(card.label)}${card.ref ? ` <span class="tax-form-ref">${sanitize(card.ref)}</span>` : ''}</div>
      <div class="tax-summary-value sensitive">${sanitize(card.value)}</div>
    `;
    summaryWrap.appendChild(el);
  });
  container.appendChild(summaryWrap);

  // ── Sections (each with optional title, headers, rows) ──
  if (!sections || sections.length === 0) {
    container.innerHTML += '<div class="tax-empty-state">No taxable events found for this year.</div>';
    return;
  }

  const totalKeywords = ['TOTAL', 'GESAMT', 'TOTAAL', 'Netto'];

  sections.forEach((section, sIdx) => {
    // Section header
    if (section.title) {
      const sectionHeader = document.createElement('div');
      sectionHeader.className = 'tax-section-header';
      sectionHeader.textContent = section.title;
      container.appendChild(sectionHeader);
      if (section.subtitle) {
        const sub = document.createElement('div');
        sub.className = 'tax-section-subtitle';
        sub.textContent = section.subtitle;
        container.appendChild(sub);
      }
    }

    if (!section.rows || section.rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tax-empty-state';
      empty.textContent = 'No data for this section.';
      container.appendChild(empty);
      return;
    }

    const tableWrap = document.createElement('div');
    tableWrap.className = 'tax-preview-wrap';
    const table = document.createElement('table');
    table.className = 'positions-table';

    // Header
    if (section.headers) {
      const thead = document.createElement('thead');
      const headerRow = document.createElement('tr');
      section.headers.forEach((h, i) => {
        const th = document.createElement('th');
        th.textContent = h;
        // Right-align numeric columns (heuristic: columns with EUR, %, number keywords)
        if (i > 1 || /EUR|%|Waarde|Bedrag|Montant|Prix|Quantité|Aantal|Frais|Gebühr|Dividend|Gewinn|Verlust|value|Steuer|Plus|Moins|Houd/i.test(h)) {
          if (!/ISIN|Naam|Name|Titre|Valeur|Wertpapier|Effect|Type|Typ|Bron|Date|Categorie|Security|Speculat/i.test(h)) {
            th.style.textAlign = 'right';
          }
        }
        headerRow.appendChild(th);
      });
      thead.appendChild(headerRow);
      table.appendChild(thead);
    }

    // Body
    const tbody = document.createElement('tbody');
    section.rows.forEach(row => {
      const tr = document.createElement('tr');
      const firstCell = String(row[0] || '') + String(row[1] || '');
      const isTotal = totalKeywords.some(k => firstCell.startsWith(k));
      if (isTotal) tr.className = 'tax-total-row';

      row.forEach((cell, i) => {
        const td = document.createElement('td');
        td.textContent = cell;
        // Right-align numeric cells
        if (i > 1 && !isNaN(parseFloat(cell)) && String(cell).trim() !== '') {
          td.style.textAlign = 'right';
          td.classList.add('sensitive');
        }
        if (isTotal) td.style.fontWeight = '700';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    container.appendChild(tableWrap);
  });

  // ── Notes ──
  if (notes && notes.length > 0) {
    const notesWrap = document.createElement('div');
    notesWrap.className = 'tax-notes';
    notes.forEach(note => {
      const p = document.createElement('p');
      p.className = 'tax-note';
      p.textContent = note;
      notesWrap.appendChild(p);
    });
    container.appendChild(notesWrap);
  }

  // ── Download buttons ──
  const downloadRow = document.createElement('div');
  downloadRow.className = 'tax-download-row';

  // CSV: flatten all sections into one file with separators
  const maxCols = Math.max(...sections.map(s => (s.headers || []).length));
  const allHeaders = sections[0]?.headers || [];
  // Pad headers to max column count
  while (allHeaders.length < maxCols) allHeaders.push('');
  const allRows = [];
  sections.forEach((s, i) => {
    if (i > 0 && s.title) {
      allRows.push(Array(maxCols).fill(''));
      const titleRow = Array(maxCols).fill('');
      titleRow[0] = `--- ${s.title} ---`;
      allRows.push(titleRow);
      // Add section headers if different from first section
      if (s.headers) {
        const hRow = [...s.headers];
        while (hRow.length < maxCols) hRow.push('');
        allRows.push(hRow);
      }
    }
    (s.rows || []).forEach(r => {
      const row = [...r];
      while (row.length < maxCols) row.push('');
      allRows.push(row);
    });
  });

  const dlBtn = document.createElement('button');
  dlBtn.className = 'tax-download-btn';
  dlBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
    Download CSV
  `;
  dlBtn.addEventListener('click', () => downloadCSV(filename, allHeaders, allRows));
  downloadRow.appendChild(dlBtn);

  const pdfBtn = document.createElement('button');
  pdfBtn.className = 'tax-download-btn';
  pdfBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
    </svg>
    Export PDF
  `;
  pdfBtn.addEventListener('click', () => exportTaxPDF(report, countryCode, year, formLabel, beLang));
  downloadRow.appendChild(pdfBtn);

  container.appendChild(downloadRow);

  // ── Report disclaimer ──
  const country = TAX_COUNTRIES[countryCode];
  const disclaimer = document.createElement('div');
  disclaimer.className = 'tax-disclaimer';
  disclaimer.textContent = typeof country.pdfDisclaimer === 'function'
    ? country.pdfDisclaimer(beLang || country.lang)
    : country.pdfDisclaimer;
  container.appendChild(disclaimer);
}

// ── PDF Export ───────────────────────────────────────────────────────────────

function exportTaxPDF(report, countryCode, year, formLabel, beLang) {
  const { summary, sections, notes } = report;
  const country = TAX_COUNTRIES[countryCode];
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const lang = beLang || country.lang;
  const dateLocale = beLang === 'fr' ? 'fr-BE' : country.dateLocale;

  // Summary cards with form references
  const summaryHTML = summary.map(card => {
    const refBadge = card.ref
      ? `<span class="form-ref">${esc(card.ref)}</span>`
      : '';
    return `<div class="summary-card"><div class="summary-label">${esc(card.label)} ${refBadge}</div><div class="summary-value">${esc(card.value)}</div></div>`;
  }).join('');

  // Build sections HTML
  const totalKeywords = ['TOTAL', 'GESAMT', 'TOTAAL', 'Netto'];
  let sectionsHTML = '';

  (sections || []).forEach(section => {
    if (section.title) {
      sectionsHTML += `<div class="section-title">${esc(section.title)}</div>`;
      if (section.subtitle) {
        sectionsHTML += `<div class="section-subtitle">${esc(section.subtitle)}</div>`;
      }
    }

    if (section.headers && section.rows) {
      const thHTML = section.headers.map((h, i) => {
        const isNum = i > 1 && !/ISIN|Naam|Name|Titre|Valeur|Wertpapier|Effect|Type|Typ|Bron|Date|Categorie|Security|Speculat/i.test(h);
        return `<th${isNum ? ' class="num"' : ''}>${esc(h)}</th>`;
      }).join('');

      const tbodyHTML = section.rows.map(row => {
        const firstCell = String(row[0] || '') + String(row[1] || '');
        const isTotal = totalKeywords.some(k => firstCell.startsWith(k));
        const cls = isTotal ? ' class="total-row"' : '';
        const cells = row.map((cell, i) => {
          const numClass = (i > 1 && !isNaN(parseFloat(cell)) && String(cell).trim() !== '') ? ' class="num"' : '';
          return `<td${numClass}>${esc(cell)}</td>`;
        }).join('');
        return `<tr${cls}>${cells}</tr>`;
      }).join('\n');

      sectionsHTML += `<table><thead><tr>${thHTML}</tr></thead><tbody>${tbodyHTML}</tbody></table>`;
    }
  });

  // Notes HTML
  let notesHTML = '';
  if (notes && notes.length > 0) {
    notesHTML = '<div class="notes">' + notes.map(n => `<p class="note">${esc(n)}</p>`).join('') + '</div>';
  }

  const generatedDate = new Date().toLocaleDateString(dateLocale, { day: 'numeric', month: 'long', year: 'numeric' });
  const pdfTitle = typeof country.pdfTitle === 'function'
    ? country.pdfTitle(year, lang)
    : country.pdfTitle;
  const disclaimer = typeof country.pdfDisclaimer === 'function'
    ? country.pdfDisclaimer(lang)
    : country.pdfDisclaimer;

  const generatedLabels = { nl: 'Gegenereerd', fr: 'Généré le', de: 'Erstellt am' };
  const sourceLabels = { nl: 'Bron: DEGIRO transactiegegevens', fr: 'Source\u00a0: données DEGIRO', de: 'Quelle: DEGIRO-Transaktionsdaten' };
  const generatedLabel = generatedLabels[lang] || 'Generated';
  const sourceLabel = sourceLabels[lang] || 'Source: DEGIRO transaction data';

  const html = `<!DOCTYPE html>
<html lang="${esc(lang)}">
<head>
<meta charset="UTF-8">
<title>${esc(pdfTitle)} — ${esc(formLabel)}</title>
<style>
  @page { margin: 18mm 15mm; size: A4; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 11px;
    color: #1a1a2e;
    background: #fff;
    padding: 0;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    border-bottom: 2px solid #1a1a2e;
    padding-bottom: 14px;
    margin-bottom: 24px;
  }
  .report-title {
    font-size: 18px;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: #1a1a2e;
  }
  .report-sub {
    font-size: 12px;
    color: #555;
    margin-top: 3px;
  }
  .header-right {
    text-align: right;
    font-size: 10px;
    color: #888;
    line-height: 1.6;
  }

  .summary-row {
    display: flex;
    gap: 12px;
    margin-bottom: 22px;
    flex-wrap: wrap;
  }
  .summary-card {
    flex: 1;
    min-width: 140px;
    border: 1px solid #d0d0d0;
    border-left: 3px solid #333;
    border-radius: 0 6px 6px 0;
    padding: 10px 14px;
  }
  .summary-label {
    font-size: 8px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #777;
    margin-bottom: 3px;
  }
  .summary-value {
    font-size: 16px;
    font-weight: 700;
    color: #1a1a2e;
  }
  .form-ref {
    display: inline-block;
    font-size: 7px;
    font-weight: 700;
    color: #4f46e5;
    background: #eef2ff;
    border: 1px solid #c7d2fe;
    border-radius: 3px;
    padding: 1px 4px;
    margin-left: 3px;
    vertical-align: middle;
    text-transform: none;
    letter-spacing: 0;
  }

  .section-title {
    font-size: 12px;
    font-weight: 700;
    color: #1a1a2e;
    margin-top: 20px;
    margin-bottom: 4px;
    padding-top: 12px;
    border-top: 1px solid #d0d0d0;
  }
  .section-subtitle {
    font-size: 9px;
    color: #777;
    margin-bottom: 8px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 10px;
    margin-bottom: 16px;
  }
  th {
    background: #f0f0f4;
    font-weight: 700;
    text-align: left;
    padding: 8px 10px;
    border-bottom: 2px solid #1a1a2e;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #444;
  }
  th.num { text-align: right; }
  td {
    padding: 6px 10px;
    border-bottom: 1px solid #e8e8e8;
  }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .total-row td { font-weight: 700; border-top: 2px solid #1a1a2e; border-bottom: none; }
  tr:nth-child(even):not(.total-row) td { background: #fafafa; }

  .notes {
    border-top: 1px solid #d0d0d0;
    padding-top: 10px;
    margin-top: 8px;
    margin-bottom: 12px;
  }
  .note {
    font-size: 8px;
    color: #666;
    line-height: 1.5;
    margin: 0 0 4px;
    padding-left: 8px;
    border-left: 2px solid #d0d0d0;
  }

  .disclaimer {
    font-size: 8px;
    color: #999;
    line-height: 1.6;
    border-top: 1px solid #d0d0d0;
    padding-top: 12px;
    margin-top: 8px;
  }

  @media print {
    body { padding: 0; }
    .no-print { display: none; }
  }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="report-title">${esc(pdfTitle)}</div>
      <div class="report-sub">${esc(formLabel)}</div>
    </div>
    <div class="header-right">
      ${esc(generatedLabel)} ${esc(generatedDate)}<br>
      ${esc(sourceLabel)}
    </div>
  </div>

  <div class="summary-row">${summaryHTML}</div>

  ${sectionsHTML}

  ${notesHTML}

  <div class="disclaimer">${esc(disclaimer)}</div>

</body>
</html>`;

  const w = window.open('', '_blank');
  if (w) {
    w.document.write(html);
    w.document.close();
    w.onload = () => w.print();
  }
}
