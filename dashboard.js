// dashboard.js — Sharpe extension main dashboard
// Shared constants (COLORS, CASH_IDS, etc.) and utilities are in utils.js,
// loaded before this file via dashboard.html.

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

let charts = {};
let globalData = {};
let proUnlocked = false; // set in renderAll after checking license

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('btnRefresh').addEventListener('click', async () => {
    document.getElementById('loadingText').textContent = 'Refreshing...';
    showLoading();
    await chrome.runtime.sendMessage({ type: 'FETCH_ALL' });
    const data = await chrome.runtime.sendMessage({ type: 'GET_STORED' });
    await renderAll(data);
  });

  // Privacy toggle — hide/show all .sensitive elements
  const btnPrivacy = document.getElementById('btnPrivacy');
  btnPrivacy.addEventListener('click', () => {
    const isHidden = document.body.classList.toggle('privacy-mode');
    btnPrivacy.title = isHidden ? 'Show sensitive figures' : 'Hide sensitive figures';
    btnPrivacy.classList.toggle('active', isHidden);
  });

  document.getElementById('periodSelect').addEventListener('change', async () => {
    if (globalData.positions) {
      await renderPerformanceChart(globalData);
      // Refresh movers with current toggle period
      const activeBtn = document.querySelector('#moversToggle .toggle-btn.active');
      const moversPeriod = activeBtn?.dataset.period || '1M';
      fetchHistoriesForPeriod(globalData.vwdIds, moversPeriod).then(histories => {
        if (histories && Object.keys(histories).length > 0) {
          renderMovers(globalData.positions, histories, moversPeriod);
          renderRecentPerf(globalData.positions, histories, moversPeriod);
        }
      });
    }
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
  if (!data.hasData) {
    document.getElementById('loadingText').textContent = 'Loading your portfolio...';
    // Try to trigger a fetch via background
    try {
      await chrome.runtime.sendMessage({ type: 'FETCH_ALL' });
    } catch(e) {}
    data = await new Promise(r => chrome.storage.local.get(null, r));
  }
  await renderAll(data);

  // Always auto-refresh in the background to ensure figures are up to date.
  // This runs after the initial render so the user sees cached data instantly
  // while fresh data is fetched and re-rendered silently.
  try {
    const result = await chrome.runtime.sendMessage({ type: 'FETCH_ALL' });
    if (result?.ok) {
      const freshData = await new Promise(r => chrome.storage.local.get(null, r));
      await renderAll(freshData);
    }
  } catch(e) { console.warn('[Sharpe] Auto-refresh failed:', e); }

  // If opened from popup via a clickable stat card, switch to the requested chart mode
  chrome.storage.local.get('popupOpenMode', ({ popupOpenMode }) => {
    if (!popupOpenMode) return;
    chrome.storage.local.remove('popupOpenMode');
    if (popupOpenMode === 'proModal') {
      // Delegate entirely to the dashboard's own PRO button, which already knows
      // whether to show the license modal (non-Pro) or the status modal (Pro).
      const btn = document.getElementById('btnPro');
      if (btn) btn.click();
      return;
    }
    if (popupOpenMode === 'proStatus') {
      // Legacy signal kept for safety — direct to proModal behaviour
      const btn = document.getElementById('btnPro');
      if (btn) btn.click();
      return;
    }
    const toggleBtns = document.querySelectorAll('#perfToggle .toggle-btn');
    toggleBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === popupOpenMode));
    if (globalData.portfolioSeries) {
      drawPerformanceChart(globalData.portfolioSeries, globalData.spyData, popupOpenMode, globalData.eurSeries);
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
  });
}

/** Render PRO-gated insight features when the Insights tab is first opened */
async function renderInsightsTab() {
  wireGradeCard();
  await wireCorrelationToggle();
  wireStressTestCard();
}

// ── Insight collapsible cards ──────────────────────────────────────────────

function wireInsightCollapsibles() {
  document.querySelectorAll('.insight-collapsible').forEach(card => {
    const btn = card.querySelector('.insight-collapse-btn');
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = '1';

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isCollapsed = card.classList.toggle('collapsed');
      btn.textContent = isCollapsed ? '⊕ Expand' : '⊖ Collapse';
    });
  });
}

function showMain() {
  document.getElementById('loadingScreen').style.display = 'none';
  document.getElementById('mainContent').style.display = 'flex';
  const tabBar = document.getElementById('tabBar');
  if (tabBar) tabBar.style.display = 'flex';
  wireTabBar();
  wireInsightCollapsibles();
  checkPortfolioTab();
}

// Show warning banner if the last fetch came from a non-portfolio DEGIRO page.
async function checkPortfolioTab() {
  const banner = document.getElementById('portfolioWarning');
  if (!banner) return;
  try {
    const stored = await chrome.storage.local.get('currentUrl');
    const url = stored.currentUrl || '';
    // Only warn if we have a URL and it's on DEGIRO but not the portfolio tab
    const onDegiro = url.includes('degiro');
    const onPortfolio = url.includes('#/portfolio');
    banner.style.display = (onDegiro && !onPortfolio) ? 'block' : 'none';
  } catch(e) {
    banner.style.display = 'none';
  }
}

async function renderAll(data) {
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

  // Sum todayPl from the already-extracted positions array.
  // extractPositions() (utils.js) already reads todayPlInBaseCurrency ?? todayPl
  // correctly, so we reuse that rather than re-parsing the raw portfolio.
  const todayPLFromAPI = (() => {
    let sum = 0, anyFound = false;
    for (const p of positions) {
      if (p.todayPl !== null && p.todayPl !== undefined && isFinite(p.todayPl)) {
        sum += p.todayPl;
        anyFound = true;
      }
    }
    console.log('[Sharpe] todayPLFromAPI sum=' + sum + ' anyFound=' + anyFound);
    return anyFound ? sum : null;
  })();

  // Fallback to DOM-scraped value when the API fields are absent
  const todayPL = todayPLFromAPI ?? (typeof data.scrapedDailyPnL === 'number' ? data.scrapedDailyPnL : null);

  // Real-time values scraped from DEGIRO's DOM (if available)
  const scrapedTotalPnL = typeof data.scrapedTotalPnL === 'number' ? data.scrapedTotalPnL : null;
  const scrapedPortfolioValue = typeof data.scrapedPortfolioValue === 'number' ? data.scrapedPortfolioValue : null;

  globalData = { positions, dividends, transactions, vwdIds, data, _cashValue: cashValue, _todayPL: todayPL, _scrapedTotalPnL: scrapedTotalPnL, _scrapedPortfolioValue: scrapedPortfolioValue, names };

  // ── Pro status check ──
  proUnlocked = await isPro();
  wireProButton();

  setStatus('connected');

  // Zero state: new account with no positions yet
  if (positions.length === 0) {
    renderHeaderStats([], []);
    showMain();
    const mainEl = document.getElementById('main');
    if (mainEl) {
      const zeroState = document.createElement('div');
      zeroState.style.cssText = 'text-align:center;padding:60px 24px;color:#8B9BB4;font-family:var(--font-display)';
      const icon = document.createElement('div'); icon.style.cssText = 'font-size:48px;margin-bottom:16px'; icon.textContent = '📊';
      const title = document.createElement('div'); title.style.cssText = 'font-size:20px;font-weight:700;color:#F5F7FA;margin-bottom:8px'; title.textContent = 'No positions found';
      const sub = document.createElement('div'); sub.style.cssText = 'font-size:13px;line-height:1.6'; sub.textContent = 'Once you have open positions in your account, they will appear here. Make sure you are logged in and have refreshed the data.';
      zeroState.append(icon, title, sub);
      // Replace main content with zero state
      const cards = mainEl.querySelectorAll('.card');
      cards.forEach(c => c.style.display = 'none');
      mainEl.appendChild(zeroState);
    }
    return;
  }

  renderHeaderStats(positions, dividends);
  renderAllocationChart(positions);
  renderPositionsTable(positions);
  renderClosedPositionsTable(computeClosedPositions(transactions, globalData.names, meta));
  wirePositionsTabs();
  renderMoreInfo(positions, dividends, transactions);

  // Always auto-show stock chart section — Pro users get real data,
  // free users see the blurred placeholder with upgrade overlay
  const biggestPosition = [...positions].sort((a, b) => b.value - a.value)[0];
  if (biggestPosition) showStockChart(biggestPosition, false, { scroll: false });

  // Export buttons — always shown; non-Pro clicks trigger upgrade flow
  wireExportButtons();

  // Grade, Correlation, Stress Test are now lazy-rendered
  // when the Insights tab is first opened (see renderInsightsTab)

  // Wire up movers toggle — controls both Big Movers and Recent Performance
  const moversToggle = document.getElementById('moversToggle');
  if (moversToggle) {
    moversToggle.addEventListener('click', async e => {
      const btn = e.target.closest('.toggle-btn');
      if (!btn) return;
      moversToggle.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const p = btn.dataset.period;
      const histories = await fetchHistoriesForPeriod(vwdIds, p);
      renderMovers(positions, histories, p);
      renderRecentPerf(positions, histories, p);
    });
  }
  // Fetch perf chart first (5Y), then fetch movers separately (1M)
  await renderPerformanceChart(globalData);
  // Re-render positions table now that priceHistories5Y is available (for volatility column)
  renderPositionsTable(positions);
  // After perf chart done, fetch movers data and compute daily P&L
  fetchHistoriesForPeriod(vwdIds, '1M').then(histories => {
    if (histories && Object.keys(histories).length > 0) {
      renderMovers(positions, histories, '1M');
      renderRecentPerf(positions, histories, '1M');
    }
  });

  showMain();
}

// ── Data extraction ────────────────────────────────────────────────


// ── Rendering ──────────────────────────────────────────────────────

function renderHeaderStats(positions, dividends) {
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
  const cashTooltip = cashValue > 0
    ? `Uninvested cash: ${fmtEur(cashValue)} (${cashPct.toFixed(1)}% of total)`
    : 'No uninvested cash';

  const headerStats = document.getElementById('headerStats');
  headerStats.textContent = '';

  // Stat 1: Portfolio Value (hover → cash)
  const statPV = document.createElement('div');
  statPV.className = 'stat stat--hoverable';
  statPV.id = 'statPortfolioValue';
  const pvLabelDef = document.createElement('div'); pvLabelDef.className = 'stat-label stat-label--default'; pvLabelDef.textContent = 'Portfolio Value';
  const pvLabelHov = document.createElement('div'); pvLabelHov.className = 'stat-label stat-label--hover'; pvLabelHov.textContent = 'Uninvested Cash';
  const pvValDef = document.createElement('div'); pvValDef.className = 'stat-value stat-value--default sensitive'; pvValDef.textContent = fmtEur(total);
  const pvValHov = document.createElement('div'); pvValHov.className = 'stat-value stat-value--hover'; pvValHov.textContent = cashValue > 0 ? fmtEur(cashValue) : '—';
  statPV.append(pvLabelDef, pvLabelHov, pvValDef, pvValHov);

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


  // Stat 4: Positions count
  const statPos = document.createElement('div');
  statPos.className = 'stat'; statPos.id = 'statPositions'; statPos.title = 'Click to cycle allocation view'; statPos.style.cursor = 'pointer';
  const posLabel = document.createElement('div'); posLabel.className = 'stat-label'; posLabel.textContent = 'Positions';
  const posVal = document.createElement('div'); posVal.className = 'stat-value'; posVal.id = 'statPositionsValue'; posVal.textContent = positions.length;
  statPos.append(posLabel, posVal);

  // Stat 5: Today's P&L — sourced from globalData._todayPL (extracted in renderAll
  // from totalPortfolio aggregate, or computed from previousClosePrice per position).
  const todayPL    = globalData._todayPL ?? null;
  const hasTodayData = todayPL != null;
  const yesterdayTotal = hasTodayData ? total - todayPL : total;
  const todayPLPct = yesterdayTotal > 0 && hasTodayData ? (todayPL / yesterdayTotal) * 100 : 0;

  const statDaily = document.createElement('div');
  statDaily.className = 'stat stat--hoverable';
  statDaily.id = 'statDailyPL';
  statDaily.title = 'Hover for daily % change';
  const dlLabelDef = document.createElement('div'); dlLabelDef.className = 'stat-label stat-label--default'; dlLabelDef.textContent = "Today's P&L";
  const dlLabelHov = document.createElement('div'); dlLabelHov.className = 'stat-label stat-label--hover'; dlLabelHov.textContent = 'Daily Change';
  const dlColorClass = !hasTodayData ? 'muted' : todayPL >= 0 ? 'positive' : 'negative';
  const dlSign       = hasTodayData && todayPL >= 0 ? '+' : '';
  const dlValDef = document.createElement('div');
  dlValDef.className = `stat-value stat-value--default sensitive ${dlColorClass}`;
  dlValDef.textContent = hasTodayData ? dlSign + fmtEur(todayPL) : '—';
  const dlValHov = document.createElement('div');
  dlValHov.className = `stat-value stat-value--hover ${dlColorClass}`;
  dlValHov.textContent = hasTodayData ? dlSign + todayPLPct.toFixed(2) + '%' : '—';
  statDaily.append(dlLabelDef, dlLabelHov, dlValDef, dlValHov);

  headerStats.append(statPV, statPL, statReturn, statDaily, statPos);

  // P&L clickable → switch to EUR chart
  document.getElementById('headerStats').querySelector('[data-chartmode="eur"]')?.addEventListener('click', () => {
    document.querySelectorAll('#perfToggle .toggle-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === 'eur');
    });
    drawPerformanceChart(globalData.portfolioSeries, globalData.spyData, 'eur', globalData.eurSeries);
  });

  // Return stat clickable → switch to % chart
  document.getElementById('statReturn')?.addEventListener('click', () => {
    document.querySelectorAll('#perfToggle .toggle-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === 'pct');
    });
    drawPerformanceChart(globalData.portfolioSeries, globalData.spyData, 'pct', globalData.eurSeries);
  });

  // Positions clickable → cycle allocation pie chart modes
  const allocModes = ['position','currency','geography','assetclass'];
  let allocIdx = 0;
  document.getElementById('statPositions')?.addEventListener('click', () => {
    allocIdx = (allocIdx + 1) % allocModes.length;
    const mode = allocModes[allocIdx];
    drawAllocationChart(globalData.positions, mode);
    // Sync the injected alloc-toggle buttons (they use data-mode, are inside the Allocation card)
    document.querySelectorAll('.alloc-toggle:not(#perfToggle):not(#moversToggle) .toggle-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
  });
}

// Body-level floating tooltip — escapes sticky/stacking-context clipping.
// One singleton reused by all callers.
function getFloatingTip() {
  let tip = document.getElementById('_floatingTip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = '_floatingTip';
    tip.style.cssText = [
      'position:fixed', 'z-index:9999', 'display:none',
      'background:#1E2C3A', 'border:1px solid #2A3A4A', 'border-radius:8px',
      'padding:10px 14px', 'width:280px', 'white-space:normal',
      'font-size:11px', 'font-family:DM Mono,monospace', 'color:#8B9BB4',
      'pointer-events:none', 'box-shadow:0 6px 24px #00000088',
      'line-height:1.6', 'font-weight:400'
    ].join(';');
    document.body.appendChild(tip);
  }
  return tip;
}

function updateHeaderReturn() {
  const periodReturn = globalData.periodReturn ?? 0;
  const periodLabel = globalData.periodLabel || '5Y';
  const labelMap = { '6M':'6M Return', '1Y':'1Y Return', '2Y':'2Y Return', '3Y':'3Y Return', '5Y':'5Y Return', 'ALL':'Return (all-time)' };
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

  // Wire floating tooltip on the parent stat card — do once per render cycle
  const statReturn = document.getElementById('statReturn');
  if (statReturn && !statReturn.dataset.tipWired) {
    statReturn.dataset.tipWired = '1';
    const tipText = statReturn.dataset.tip || '';
    const floatTip = getFloatingTip();
    statReturn.addEventListener('mouseenter', e => {
      if (!tipText) return;
      floatTip.textContent = tipText;
      const rect = statReturn.getBoundingClientRect();
      floatTip.style.display = 'block';
      // Position below the card, clamped to viewport
      let top = rect.bottom + 8;
      let left = rect.left;
      // Clamp right edge
      if (left + 280 > window.innerWidth - 8) left = window.innerWidth - 288;
      floatTip.style.top  = top  + 'px';
      floatTip.style.left = left + 'px';
    });
    statReturn.addEventListener('mouseleave', () => { floatTip.style.display = 'none'; });
  }
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
      console.log(`[Perf] Merged ${newer.length} newer points for ${id} (up to ${newer[newer.length-1].date})`);
    }
  });

  const spyData = (allHistories['__SP500__'] || []).filter(d => d.date >= firstTxDate);
  console.log('[Perf] SPY sample:', spyData[0]);
  const priceHistories = {};
  Object.entries(allHistories).forEach(([id, data]) => {
    if (id !== '__SP500__') priceHistories[id] = data;
  });
  // Store full 5Y histories so movers can slice them by period without re-fetching
  globalData.priceHistories5Y = priceHistories;
  
  console.log('[Perf] SPY points:', spyData.length, 'from', spyData[0]?.date);

  const periodDays = period === '6M' ? 182 : period === '1Y' ? 365 : period === '2Y' ? 730 : period === '3Y' ? 1095 : 1825;
  // Use local date offset (not UTC) to avoid timezone-induced off-by-one on period boundaries
  const periodStartMs = Date.now() - periodDays * 864e5;
  const periodStartDate = new Date(periodStartMs);
  const periodStart = new Date(periodStartMs - periodStartDate.getTimezoneOffset() * 60000).toISOString().slice(0,10);
  const chartStart = (period === '5Y' || period === 'ALL') ? firstTxDate : (periodStart > firstTxDate ? periodStart : firstTxDate);
  console.log(`[Perf] period=${period} periodStart=${periodStart} firstTxDate=${firstTxDate} chartStart=${chartStart}`);

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
      console.log(`[TWR] boundary ${fullPortfolioSeries[i-1].date}→${date}: eqBefore=${equityBefore.toFixed(0)} spStart=${spStart.toFixed(0)} ratio=${ratio.toFixed(4)} cumFactor=${cumFactor.toFixed(4)} newSpStart=${value.toFixed(0)}`);
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
  (() => {
    try {
      const RF_DAILY = Math.pow(1.03, 1 / 252) - 1;
      const allTimeReturns = [];
      for (let i = 1; i < fullWithTwr.length; i++) {
        const prev = 1 + fullWithTwr[i - 1].twr / 100;
        const curr = 1 + fullWithTwr[i].twr / 100;
        if (prev > 0) {
          const r = curr / prev - 1;
          if (r !== 0) allTimeReturns.push(r);
        }
      }
      if (allTimeReturns.length >= 20) {
        const n = allTimeReturns.length;
        const mean = allTimeReturns.reduce((s, r) => s + r, 0) / n;
        const variance = allTimeReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
        const std = Math.sqrt(variance);
        if (std > 0) {
          globalData.insightSharpe = ((mean - RF_DAILY) / std) * Math.sqrt(252);
        }
      }
    } catch(e) { /* leave unchanged */ }
  })();

  const filteredFull = fullWithTwr.filter(d => d.date >= chartStart);
  console.log(`[Perf] filteredFull: ${filteredFull.length} points, first=${filteredFull[0]?.date} last=${filteredFull[filteredFull.length-1]?.date}`);

  // Period gain = change within the visible window (for header/subtitle info only)
  const twrAtWindowStart = filteredFull[0]?.twr ?? 0;
  const twrAtWindowEnd   = filteredFull[filteredFull.length-1]?.twr ?? 0;
  const periodGain = ((1 + twrAtWindowEnd / 100) / (1 + twrAtWindowStart / 100) - 1) * 100;

  // filteredSeries has twr = absolute from inception; twrDisplay = same (no reset)
  const filteredSeries = filteredFull.map(d => ({ ...d, twrDisplay: d.twr }));

  const eurSeries = filteredSeries;
  console.log('[Perf] TWR points:', filteredSeries.length, 'final TWR:', twrAtWindowEnd.toFixed(1)+'%', 'period gain:', periodGain.toFixed(1)+'%');

  if (filteredSeries.length === 0 && spyData.length === 0) {
    document.getElementById('perfSubtitle').textContent = 'Historical price data unavailable';
    showMain();
    return;
  }

  // Store for toggle redraw
  globalData.portfolioSeries = filteredSeries;
  globalData.fullPortfolioSeries = fullPortfolioSeries; // full history for Sharpe calculation
  globalData.spyData = spyData;
  globalData.spyFullData = allHistories['__SP500__'] || []; // full series for absolute alignment
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
      drawPerformanceChart(globalData.portfolioSeries, globalData.spyData, btn.dataset.mode, globalData.eurSeries);
    });
  }

  // Wire up trades overlay toggle
  const tradesBtn = document.getElementById('tradesToggle');
  if (tradesBtn && !tradesBtn.dataset.wired) {
    tradesBtn.dataset.wired = '1';
    tradesBtn.addEventListener('click', () => {
      const isOn = tradesBtn.classList.toggle('active');
      globalData.showTrades = isOn;
      const activeMode = document.querySelector('#perfToggle .toggle-btn.active')?.dataset.mode || 'pct';
      drawPerformanceChart(globalData.portfolioSeries, globalData.spyData, activeMode, globalData.eurSeries);
    });
  }

  // Wire up insight toggle
  const insightBtn = document.getElementById('insightToggle');
  if (insightBtn && !insightBtn.dataset.wired) {
    insightBtn.dataset.wired = '1';
    // Default: on
    insightBtn.classList.add('active');
    globalData.showInsight = true;
    insightBtn.addEventListener('click', () => {
      const isOn = insightBtn.classList.toggle('active');
      globalData.showInsight = isOn;
      document.getElementById('chartInsight').style.display = isOn ? '' : 'none';
    });
  }

  globalData.eurSeries = eurSeries;
  globalData.periodReturn = periodGain;
  globalData.periodLabel = period;
  updateHeaderReturn();
  const activeMode = document.querySelector('#perfToggle .toggle-btn.active')?.dataset.mode || 'pct';
  drawPerformanceChart(filteredSeries, spyData, activeMode, eurSeries);
}


function drawPerformanceChart(twrSeries, spyData, mode, eurSeries) {
  if (!twrSeries.length) return;

  const isPct = mode === 'pct';
  const displaySeries = isPct ? twrSeries : (eurSeries || twrSeries);
  const windowBaseTwr = twrSeries[0]?.twr ?? 0;
  console.log(`[DRAW] twr[0]=${twrSeries[0]?.twr?.toFixed(2)} twr[-1]=${twrSeries[twrSeries.length-1]?.twr?.toFixed(2)} windowBaseTwr=${windowBaseTwr?.toFixed(2)} n=${twrSeries.length}`);

  const fmtDate = d => {
    const [y,m] = d.split('-');
    return new Date(y,m-1).toLocaleString('default',{month:'short',year:'numeric'});
  };

  // S&P baseline anchored to SAME date as portfolio TWR = 0%.
  // This is fullPortfolioSeries[0].date (first day with computable portfolio value),
  // NOT firstTxDate which could be an old transaction with no price data yet.
  const fullSpyData = globalData.spyFullData || spyData;
  const portfolioStart = globalData.portfolioStartDate || globalData.firstTxDate || '2021-01-01';
  const inceptionSpyEntry = fullSpyData.find(d => d.date >= portfolioStart);
  const spyBase = inceptionSpyEntry ? inceptionSpyEntry.price : (fullSpyData[0]?.price || 1);
  console.log('[SPY] portfolioStart:', portfolioStart, 'spyBase date:', inceptionSpyEntry?.date, 'spyBase price:', spyBase?.toFixed(2));

  // Subtitle: show period gain (change within the visible window) — not absolute
  const periodReturn = twrSeries[twrSeries.length-1]?.twr - (twrSeries[0]?.twr ?? 0);
  const allTimeTwr = twrSeries[twrSeries.length-1]?.twr ?? 0;
  const periodLabel = document.getElementById('periodSelect')?.options[document.getElementById('periodSelect')?.selectedIndex]?.text || '';
  const subtitleEl = document.getElementById('perfSubtitle');
  if (subtitleEl) {
    if (isPct) {
      subtitleEl.textContent = `${periodLabel} window`;
      subtitleEl.style.color = '';
    } else {
      subtitleEl.textContent = '';
    }
  }

  // ── Chart insight bar ───────────────────────────────────────────
  const insightEl = document.getElementById('chartInsight');
  if (insightEl && globalData.showInsight !== false) {
    insightEl.style.display = '';
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
    const spySource = (globalData.spyFullData && globalData.spyFullData.length ? globalData.spyFullData : null) || (Array.isArray(spyData) ? spyData : []);
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

    // Build insight cards safely using DOM API (no innerHTML = no XSS risk)
    const makeCard = (label, value, valueClass, tip) => {
      const card = document.createElement('div');
      card.className = 'ci-card' + (tip ? ' ci-card--tip' : '');
      if (tip) card.dataset.tip = tip;
      const lbl = document.createElement('div');
      lbl.className = 'ci-label';
      lbl.textContent = label;
      const val = document.createElement('div');
      val.className = 'ci-value' + (valueClass ? ' ' + valueClass : '');
      val.textContent = value;
      card.append(lbl, val);
      return card;
    };

    insightEl.textContent = '';
    insightEl.append(
      makeCard('Annualised Return', annualisedStr, annualisedStr !== '—' ? annualisedClass : ''),
      makeCard('Max Drawdown', ddStr, ddClass, 'Max drawdown: the largest peak-to-trough decline in portfolio value during this period.'),
      makeCard('Beta vs S&P 500', betaStr, betaClass, 'Beta measures your portfolio\'s sensitivity to S&P 500 movements. Beta > 1 means more volatile than the market; < 1 means more stable. Computed from monthly returns in the selected period.'),
      makeCard('Alpha vs S&P 500', alphaStr, alphaClass, 'Alpha is your annualised excess return above what beta-adjusted S&P 500 exposure would predict. Positive alpha means you outperformed on a risk-adjusted basis.'),
      makeCard('Sharpe Ratio', sharpeStr, sharpeClass, 'Sharpe ratio measures return per unit of risk. Above 1 is good, above 2 is great, above 3 is excellent. Below 0 means you earned less than the risk-free rate. Calculated from daily portfolio returns, annualised to 252 trading days.')
    );
    } catch(e) {
      console.warn('[Sharpe] Insight bar error:', e);
      insightEl.textContent = '';
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

  // S&P line: absolute % return since inception, anchored to same start date as portfolio
  const spyMap = {};
  fullSpyData.forEach(s => { spyMap[s.date] = s.price; });
  let lastSpyPrice = null;
  const spyLineData = twrSeries.map(pd => {
    if (spyMap[pd.date]) lastSpyPrice = spyMap[pd.date];
    return lastSpyPrice ? ((lastSpyPrice / spyBase) - 1) * 100 : null;
  });

  const spyFinalReturn = lastSpyPrice ? ((lastSpyPrice / spyBase) - 1) * 100 : null;
  console.log(`[CHART] All-time portfolio TWR: ${allTimeTwr.toFixed(1)}% | S&P since ${portfolioStart}: ${spyFinalReturn?.toFixed(1)}% | Period (${periodLabel}): ${periodReturn.toFixed(1)}%`);

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
          const lineColor = hasBuy && hasSell ? '#ffd60a' : hasBuy ? '#2ACA69' : '#FF4757';

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
              if (ei > 0) popupLines.push({ text: '─────────────', color: '#3a3a4a' });
              entry.lines.forEach(l => {
                popupLines.push({ text: l, color: l.startsWith('▲') ? '#2ACA69' : '#FF4757' });
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
            ctx2.fillStyle = '#0e0e1a';
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
          backgroundColor: barData.map(v => v >= 0 ? '#2ACA6933' : '#FF475733'),
          borderColor: barData.map(v => v >= 0 ? '#2ACA6999' : '#FF475799'),
          borderWidth: 0,
          borderRadius: 0,
          barPercentage: 1.0,
          categoryPercentage: 1.0,
        } : {
          type: 'line',
          label: 'My Portfolio',
          data: barData,
          borderColor: '#2ACA69',
          backgroundColor: '#2ACA6915',
          fill: true,
          tension: 0.2,
          pointRadius: 0,
          borderWidth: 2,
        },
        ...(spyLineData.some(v => v !== null) && isPct ? [{
          type: 'line',
          label: 'S&P 500',
          data: spyLineData,
          borderColor: '#00A8E1', backgroundColor: 'transparent', fill: false,
          tension: 0.2, pointRadius: 0, borderWidth: 2, borderDash: [4, 3]
        }] : [])
      ]
    },
    plugins: [tradePlugin].filter(Boolean),
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', align: 'end', labels: { color: '#8B9BB4', font: { size: 11 }, boxWidth: 12, padding: 16 } },
        tooltip: { backgroundColor: '#1E2C3A', borderColor: '#2A3A4A', borderWidth: 1, titleColor: '#F5F7FA', bodyColor: '#8B9BB4', padding: 10,
          callbacks: {
            title: ctx => {
              const idx = ctx[0].dataIndex;
              const rawDate = isPct ? twrSeries[idx]?.date : eurSeries[idx]?.date;
              if (rawDate) {
                const [y,m,dd] = rawDate.split('-');
                return new Date(y,m-1,dd).toLocaleDateString('default',{day:'numeric',month:'short',year:'numeric'});
              }
              return ctx[0].label;
            },
            label: ctx => isPct
              ? ' '+(ctx.parsed.y>=0?'+':'')+ctx.parsed.y.toFixed(1)+'% — '+ctx.dataset.label
              : ' '+fmtEur(ctx.parsed.y)+' — '+ctx.dataset.label
          } }
      },
      scales: {
        x: { grid: { color: '#1E2C3A' }, ticks: { color: '#8B9BB4', font: { size: 10 }, maxTicksLimit: 12 } },
        y: { 
          grid: { color: '#1E2C3A88' }, 
          ticks: { color: '#8B9BB4', font: { size: 10 },
            callback: isPct ? v => (v>=0?'+':'')+v.toFixed(0)+'%' : v => '€'+Math.round(v/1000)+'k' },
          // Always include 0 in view so the baseline is visible
          ...(isPct ? { 
            min: Math.min(0, Math.floor(Math.min(...barData.filter(v=>v!=null)) / 5) * 5 - 5),
          } : {})
        }
      }
    }
  });
  globalData.perfChart = charts.performance;
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

  const periodDays = { '1W': 7, '1M': 31, '6M': 183, '1Y': 366, '2Y': 731, '3Y': 1096, '5Y': 1826 };
  const days = periodDays[period];

  if (!days) return Promise.resolve(full); // unknown period — return everything

  // Find the last date across all histories (latest market close)
  let lastDate = '';
  Object.values(full).forEach(h => {
    if (h.length) {
      const d = h[h.length - 1].date;
      if (d > lastDate) lastDate = d;
    }
  });
  const cutoff = lastDate
    ? new Date(new Date(lastDate + 'T12:00:00').getTime() - days * 864e5).toISOString().slice(0, 10)
    : '';

  const sliced = {};
  Object.entries(full).forEach(([id, h]) => {
    const s = cutoff ? h.filter(d => d.date >= cutoff) : h;
    if (s.length) sliced[id] = s;
  });
  return Promise.resolve(sliced);
}

function jumpPerfChartToDate(targetDate) {
  // Highlight the bar in the Recent Performance chart that matches targetDate
  const chart = charts.recentPerf;
  const dates = globalData.recentPerfDates;
  if (!chart || !dates) return;

  // Find closest date index
  let closestIdx = 0, minDiff = Infinity;
  dates.forEach((d, i) => {
    const diff = Math.abs(new Date(d + 'T12:00:00') - new Date(targetDate + 'T12:00:00'));
    if (diff < minDiff) { minDiff = diff; closestIdx = i; }
  });

  // Highlight that bar: brighten its color, reset all others
  const dataset = chart.data.datasets[0];
  const baseBg   = dataset.data.map(v => v >= 0 ? '#2ACA6955' : '#FF475755');
  const baseBorder = dataset.data.map(v => v >= 0 ? '#2ACA69' : '#FF4757');
  const hlBg     = dataset.data.map(v => v >= 0 ? '#2ACA69cc' : '#FF4757cc');
  const hlBorder = dataset.data.map(v => v >= 0 ? '#00ffcc' : '#ff1a4d');

  dataset.backgroundColor = baseBg.map((c, i) => i === closestIdx ? hlBg[i] : c);
  dataset.borderColor     = baseBorder.map((c, i) => i === closestIdx ? hlBorder[i] : c);
  dataset.borderWidth     = baseBorder.map((_, i) => i === closestIdx ? 2 : 1);

  // Show tooltip on that bar
  chart.tooltip.setActiveElements([{ datasetIndex: 0, index: closestIdx }], { x: 0, y: 0 });
  chart.update();

  // Scroll the recent perf chart into view
  document.getElementById('recentPerfChart')?.closest('.card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}


function renderMovers(positions, histories, period) {
  const el = document.getElementById('moversContent');
  if (!el) return;

  // Use the last date present in the price data as the reference point —
  // this ensures the period window ends at the latest market close, not "today"
  // (which may be a weekend or pre-market and have no price data yet).
  const allDates = positions
    .filter(p => histories[p.id]?.length)
    .flatMap(p => histories[p.id].map(d => d.date));
  const lastDataDate = allDates.length ? [...allDates].sort().pop() : new Date().toISOString().slice(0,10);
  const refDate = new Date(lastDataDate + 'T12:00:00');

  const cutoffMap = { '1W': 7, '1M': 31, '3M': 92, '6M': 183, '1Y': 366 };
  const days = cutoffMap[period] || 31;
  const cutoff = new Date(refDate.getTime() - days * 864e5).toISOString().slice(0, 10);

  const all = positions
    .filter(p => p.value > 0 && histories[p.id]?.length >= 2)
    .map(p => {
      const h = histories[p.id].filter(d => d.date >= cutoff);
      if (h.length < 2) return null;
      const latest = h[h.length - 1].price;
      const oldest = h[0].price;
      const pct = ((latest - oldest) / oldest) * 100;
      return { ...p, pct: pct, priceNow: latest, priceStart: oldest };
    })
    .filter(p => p && isFinite(p.pct))
    .sort((a, b) => b.pct - a.pct);

  // Always show 3 left + 3 right. Left prioritises gainers, right prioritises losers.
  // When one side has fewer than 3, the overflow spills into the other column.
  const sorted = [...all];                         // already sorted desc by pct
  const gainers = sorted.filter(p => p.pct >= 0);
  const losers  = sorted.filter(p => p.pct <  0).reverse(); // worst first

  let leftCol, rightCol;
  if (gainers.length >= 3 && losers.length >= 3) {
    leftCol  = gainers.slice(0, 3);
    rightCol = losers.slice(0, 3);
  } else if (gainers.length < 3) {
    // Not enough gainers: fill left with all gainers + least-negative losers
    leftCol  = [...gainers, ...losers.slice(-(3 - gainers.length)).reverse()].slice(0, 3);
    rightCol = losers.slice(0, 3);
  } else {
    // Not enough losers: fill right with all losers + smallest gainers
    leftCol  = gainers.slice(0, 3);
    rightCol = [...losers, ...gainers.slice(-(3 - losers.length))].slice(0, 3);
  }
  const movers = [...leftCol, ...rightCol];

  if (!movers.length) {
    el.textContent = '';
    const span = document.createElement('span');
    span.className = 'muted'; span.style.cssText = 'padding:16px;display:block';
    span.textContent = 'No data available';
    el.appendChild(span);
    return;
  }

  el.textContent = '';

  // Two-column layout: left column, right column
  const cols = document.createElement('div'); cols.className = 'movers-columns';
  const colLeftEl  = document.createElement('div'); colLeftEl.className  = 'movers-col-half';
  const colRightEl = document.createElement('div'); colRightEl.className = 'movers-col-half';

  const renderItem = (p) => {
    const up = p.pct >= 0;
    const item = document.createElement('div'); item.className = 'mover-item';
    item.style.cursor = 'pointer';

    const icon = document.createElement('div');
    icon.className = 'mover-icon ' + (up ? 'up' : 'down');
    icon.innerHTML = up ? '&#x25B2;&#x25B2;' : '&#x25BC;&#x25BC;';

    const info = document.createElement('div'); info.className = 'mover-info';
    const nameEl = document.createElement('div'); nameEl.className = 'mover-name'; nameEl.textContent = p.name || 'ID ' + p.id;
    const ticker = document.createElement('div'); ticker.className = 'mover-ticker'; ticker.textContent = (p.symbol || p.ticker || '').toUpperCase();
    info.append(nameEl, ticker);

    const right = document.createElement('div'); right.className = 'mover-right';
    const pctEl = document.createElement('div'); pctEl.className = 'mover-pct'; pctEl.style.color = up ? '#2ACA69' : '#FF4757';
    pctEl.textContent = (up ? '+' : '') + p.pct.toFixed(2) + '%';
    right.append(pctEl);

    item.append(icon, info, right);

    // Click → scroll to position row + open stock chart
    item.addEventListener('click', () => {
      // Find the matching row in the positions table
      const row = document.querySelector(`#positionsBody tr[data-position-id="${p.id}"]`);
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Open the individual stock chart (works for PRO; shows upgrade overlay for free)
      showStockChart(p);
    });

    return item;
  };

  leftCol.forEach(p  => colLeftEl.appendChild(renderItem(p)));
  rightCol.forEach(p => colRightEl.appendChild(renderItem(p)));

  cols.append(colLeftEl, colRightEl);
  el.appendChild(cols);
}


function renderRecentPerf(positions, histories, period) {
  const canvas = document.getElementById('recentPerfChart');
  if (!canvas) return;
  if (charts.recentPerf) { charts.recentPerf.destroy(); charts.recentPerf = null; }

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

  // ── Replay transactions to get share count per position on each date ──────
  // This is the only correct way — using today's p.size retroactively causes
  // big fake jumps whenever you buy/sell, because the new size gets applied to
  // every past day.
  const txList = (globalData.transactions || [])
    .filter(tx => tx.productId && tx.buysell && tx.quantity)
    .map(tx => ({
      id:      String(tx.productId),
      date:    (tx.date || '').slice(0, 10),
      buysell: tx.buysell,
      qty:     Math.abs(tx.quantity),
    }))
    .filter(tx => tx.date)
    .sort((a, b) => a.date.localeCompare(b.date));

  // Running holdings: replay to build a snapshot after each transaction
  const txSnapshots = []; // [{ date, holdings: {id -> qty} }]
  const running = {};
  txList.forEach(tx => {
    if (!running[tx.id]) running[tx.id] = 0;
    running[tx.id] += tx.buysell === 'B' ? tx.qty : -tx.qty;
    if (running[tx.id] < 0.001) delete running[tx.id];
    txSnapshots.push({ date: tx.date, holdings: { ...running } });
  });

  // Fallback to today's sizes when no transaction history is available
  const todaySizes = {};
  activePosns.forEach(p => { todaySizes[String(p.id)] = p.size; });

  // Binary search: holdings as of a given date (last snapshot <= date)
  const getHoldings = txSnapshots.length
    ? (date) => {
        let lo = 0, hi = txSnapshots.length - 1, best = null;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (txSnapshots[mid].date <= date) { best = txSnapshots[mid].holdings; lo = mid + 1; }
          else hi = mid - 1;
        }
        return best || {};
      }
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

  // Portfolio value in EUR on a given date
  const lastKnown = {};
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

  globalData.recentPerfDates = barDates;

  const fmtDate = d => {
    const [y, m, dd] = d.split('-');
    return new Date(y, m - 1, dd).toLocaleDateString('default', { day: 'numeric', month: 'short' });
  };

  // Compound return for the badge
  const compoundReturn = dailyChangePct.reduce((acc, r) => acc * (1 + r / 100), 1);
  const compoundPct = (compoundReturn - 1) * 100;

  const recentBadgePlugin = {
    id: 'recentBadge',
    afterDraw(chart) {
      const ctx2 = chart.ctx;
      const { right, top } = chart.chartArea;
      const label = (compoundPct >= 0 ? '+' : '') + compoundPct.toFixed(2) + '%';
      const color = compoundPct >= 0 ? '#2ACA69' : '#FF4757';
      ctx2.save();
      ctx2.font = 'bold 20px Syne, sans-serif';
      const textW = ctx2.measureText(label).width;
      const padX = 11, boxH = 28;
      const boxW = textW + padX * 2;
      const boxX = right - boxW;
      const boxY = top - boxH - 6;
      ctx2.fillStyle = color + '18';
      ctx2.strokeStyle = color + '44';
      ctx2.lineWidth = 1;
      ctx2.setLineDash([]);
      ctx2.beginPath();
      ctx2.roundRect(boxX, boxY, boxW, boxH, 6);
      ctx2.fill();
      ctx2.stroke();
      ctx2.fillStyle = color;
      ctx2.textBaseline = 'middle';
      ctx2.fillText(label, boxX + padX, boxY + boxH / 2);
      ctx2.restore();
    }
  };

  charts.recentPerf = new Chart(canvas, {
    type: 'bar',
    plugins: [recentBadgePlugin],
    data: {
      labels: barDates.map(fmtDate),
      datasets: [{
        label: 'Daily Change',
        data: dailyChangePct,
        backgroundColor: dailyChangePct.map(v => v >= 0 ? '#2ACA6955' : '#FF475755'),
        borderColor:     dailyChangePct.map(v => v >= 0 ? '#2ACA69'   : '#FF4757'),
        borderWidth: 1,
        borderRadius: 2,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 40 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1E2C3A', borderColor: '#2A3A4A', borderWidth: 1,
          titleColor: '#F5F7FA', bodyColor: '#8B9BB4', padding: 10,
          callbacks: { label: ctx => ' ' + (ctx.parsed.y >= 0 ? '+' : '') + ctx.parsed.y.toFixed(2) + '%' }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#8B9BB4', font: { size: 10 }, maxTicksLimit: 12 } },
        y: { grid: { color: '#1E2C3A88' }, ticks: { color: '#8B9BB4', font: { size: 10 }, callback: v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%' } }
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

function buildHoldingsOverTime(transactions, dates) {
  // For each date, calculate how many shares of each product were held
  const result = {};
  const holdings = {};
  let txIdx = 0;
  const sortedTx = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  sortedTx.forEach(t => { if (t.date) t.date = t.date.slice(0,10); });

  dates.forEach(date => {
    // Apply all transactions up to this date
    while (txIdx < sortedTx.length && (sortedTx[txIdx].date||'').slice(0,10) <= date) {
      const tx = sortedTx[txIdx];
      const id = tx.productId;
      if (!holdings[id]) holdings[id] = 0;
      // quantity is already negative for sells in DEGIRO data
      holdings[id] += tx.buysell === 'B' ? Math.abs(tx.quantity) : -Math.abs(tx.quantity);
      if (holdings[id] < 0.001) delete holdings[id];
      txIdx++;
    }
    result[date] = { ...holdings };
  });
  return result;
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
      drawAllocationChart(positions, btn.dataset.mode);
    });
  }

  drawAllocationChart(positions, 'position');
}

function drawAllocationChart(positions, mode) {
  positions = positions.filter(p => p.value > 0);
  let labels, values;
  const total = positions.reduce((s,p)=>s+p.value, 0);

  if (mode === 'position') {
    const sorted = [...positions].sort((a,b)=>b.value-a.value);
    labels = sorted.map(p=>p.name||'ID '+p.id);
    values = sorted.map(p=>p.value);
  } else if (mode === 'currency') {
    const map = {};
    positions.forEach(p => { map[p.currency] = (map[p.currency]||0) + p.value; });
    const sorted = Object.entries(map).sort((a,b)=>b[1]-a[1]);
    labels = sorted.map(([k])=>k);
    values = sorted.map(([,v])=>v);
  } else if (mode === 'geography') {
    const map = {};
    positions.forEach(p => { const g = inferGeo(p); map[g] = (map[g]||0) + p.value; });
    const sorted = Object.entries(map).sort((a,b)=>b[1]-a[1]);
    labels = sorted.map(([k])=>k);
    values = sorted.map(([,v])=>v);
  } else { // assetclass
    const map = {};
    positions.forEach(p => { const c = inferAssetClass(p); map[c] = (map[c]||0) + p.value; });
    // Add cash from FLATEX_EUR and EUR rows
    const cashValue = globalData._cashValue || 0;
    if (cashValue > 0) map['Cash'] = (map['Cash']||0) + cashValue;
    const sorted = Object.entries(map).sort((a,b)=>b[1]-a[1]);
    labels = sorted.map(([k])=>k);
    values = sorted.map(([,v])=>v);
  }

  if (charts.allocation) charts.allocation.destroy();
  const sliceColors = values.map((_, i) => COLORS[i % COLORS.length]);
  charts.allocation = new Chart(document.getElementById('allocationChart'), {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: sliceColors, borderColor: '#15202B', borderWidth: 2 }] },
    options: { responsive:true, maintainAspectRatio:false, cutout:'65%',
      plugins: { legend:{display:false}, tooltip:{backgroundColor:'#1E2C3A',borderColor:'#2A3A4A',borderWidth:1,titleColor:'#F5F7FA',bodyColor:'#8B9BB4',padding:10,
        callbacks:{
          title: ctx => ctx[0]?.label || '',
          label: ctx => '  ' + fmtEur(ctx.parsed) + '  (' + (ctx.parsed/total*100).toFixed(1) + '%)'
        }}} }
  });

  const legend = document.getElementById('allocationLegend');
  legend.textContent = '';
  labels.forEach((l, i) => {
    const item = document.createElement('div'); item.className = 'legend-item';
    const dot = document.createElement('div'); dot.className = 'legend-dot'; dot.style.background = COLORS[i % COLORS.length];
    const name = document.createElement('div'); name.className = 'legend-name'; name.textContent = l;
    const pct = document.createElement('div'); pct.className = 'legend-pct'; pct.textContent = (values[i] / total * 100).toFixed(1) + '%';
    item.append(dot, name, pct);
    legend.appendChild(item);
  });
}



function renderCurrencyChart(positions) {
  const byCurrency = {};
  positions.forEach(p => { byCurrency[p.currency] = (byCurrency[p.currency]||0) + p.value; });
  const total = Object.values(byCurrency).reduce((a,b)=>a+b, 0);
  const sorted = Object.entries(byCurrency).sort((a,b)=>b[1]-a[1]);
  if (!sorted.length) return;
  if (charts.currency) charts.currency.destroy();
  charts.currency = new Chart(document.getElementById('currencyChart'), {
    type: 'doughnut',
    data: { labels: sorted.map(([c])=>c), datasets: [{ data: sorted.map(([,v])=>v), backgroundColor: sorted.map((_, i) => COLORS[i % COLORS.length]), borderColor: '#15202B', borderWidth: 2 }] },
    options: { responsive:true, maintainAspectRatio:false, cutout:'60%',
      plugins: { legend:{position:'right',labels:{color:'#8B9BB4',font:{size:11},boxWidth:10,padding:10}},
        tooltip:{backgroundColor:'#1E2C3A',borderColor:'#2A3A4A',borderWidth:1,
          callbacks:{label:ctx=>' '+(ctx.parsed/total*100).toFixed(1)+'% ('+fmtEur(ctx.parsed)+')'}}}}
  });
  const barsEl = document.getElementById('currencyBars');
  barsEl.textContent = '';
  sorted.forEach(([c, v], i) => {
    const pct = (v / total * 100).toFixed(1);
    const row = document.createElement('div'); row.className = 'currency-row';
    const lbl = document.createElement('div'); lbl.className = 'currency-label'; lbl.textContent = c;
    const wrap = document.createElement('div'); wrap.className = 'currency-bar-wrap';
    const bar = document.createElement('div'); bar.className = 'currency-bar'; bar.style.width = pct + '%'; bar.style.background = COLORS[i % COLORS.length];
    wrap.appendChild(bar);
    const pctEl = document.createElement('div'); pctEl.className = 'currency-pct'; pctEl.textContent = pct + '%';
    row.append(lbl, wrap, pctEl);
    barsEl.appendChild(row);
  });
}

function renderDividendChart(dividends) {
  const byMonth = {};
  dividends.forEach(d => { if(d.date) { const m=d.date.slice(0,7); byMonth[m]=(byMonth[m]||0)+d.amountEUR; } });
  const months = Object.keys(byMonth).sort().slice(-24);
  if (!months.length) return;
  if (charts.dividend) charts.dividend.destroy();
  charts.dividend = new Chart(document.getElementById('dividendChart'), {
    type: 'bar',
    data: { labels: months.map(fmtMonth), datasets: [{ data: months.map(m=>byMonth[m]), backgroundColor: '#2ACA6933', borderColor: '#2ACA69', borderWidth: 1, borderRadius: 3 }] },
    options: miniChartOptions(v => '€'+v.toFixed(2))
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

function renderPositionsTable(positions, sortCol, sortDir) {
  // Determine sort state — default: value descending
  sortCol = sortCol || globalData._posSort?.col || 'value';
  sortDir = sortDir || globalData._posSort?.dir || 'desc';
  globalData._posSort = { col: sortCol, dir: sortDir };

  // Pre-compute volatility for all positions
  const volCache = {};
  positions.forEach(p => { volCache[p.id] = computePositionVolatility(p.id); });

  // Total portfolio cost basis for attribution calculation
  const totalCostBasis = positions.reduce((s, p) => {
    const unrealized = p.plUnrealized ?? p.plBase;
    return s + (p.value - unrealized);
  }, 0);

  const valueOf = (p, col) => {
    const unrealized = p.plUnrealized ?? p.plBase;
    const costBasis = p.value - unrealized;
    const plPct = costBasis > 0 ? (unrealized / costBasis * 100) : 0;
    const attrib = totalCostBasis > 0 ? (unrealized / totalCostBasis * 100) : 0;
    switch (col) {
      case 'name':   return (p.name || 'ID ' + p.id).toLowerCase();
      case 'currency': return p.currency;
      case 'size':   return p.size;
      case 'price':  return p.price;
      case 'value':  return p.value;
      case 'pl':     return p.plBase;
      case 'plpct':  return plPct;
      case 'attrib': return attrib;
      case 'vol':    return volCache[p.id] ?? -1;
      default:       return p.value;
    }
  };

  const sorted = [...positions].sort((a, b) => {
    const av = valueOf(a, sortCol), bv = valueOf(b, sortCol);
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  // Update header arrows (use innerHTML to preserve <br> in multi-line headers)
  document.querySelectorAll('#positionsTable thead th').forEach(th => {
    const col = th.dataset.col;
    th.classList.toggle('sort-active', col === sortCol);
    // Strip old arrow, add new one
    th.innerHTML = th.innerHTML.replace(/ [▲▼]$/, '');
    if (col === sortCol) th.innerHTML += sortDir === 'asc' ? ' ▲' : ' ▼';
  });

  const tbody = document.getElementById('positionsBody');
  tbody.textContent = '';
  sorted.forEach((p, i) => {
    const pl = p.plBase;
    const unrealized = p.plUnrealized ?? p.plBase;
    const costBasis = p.value - unrealized;
    const plPct = costBasis > 0 ? (unrealized / costBasis * 100) : 0;
    const plClass    = pl    >= 0 ? 'positive' : 'negative';
    const plPctClass = plPct >= 0 ? 'positive' : 'negative';

    const tr = document.createElement('tr');
    tr.dataset.positionId = p.id;
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => showStockChart(p));

    // Name cell with colored dot
    const tdName = document.createElement('td'); tdName.className = 'td-name';
    const dot = document.createElement('span');
    dot.style.cssText = 'display:inline-block;width:8px;height:8px;border-radius:50%;background:' + COLORS[i % COLORS.length] + ';margin-right:8px';
    tdName.appendChild(dot);
    tdName.appendChild(document.createTextNode(p.name || 'ID ' + p.id));

    const tdCurr = document.createElement('td'); tdCurr.className = 'td-currency'; tdCurr.textContent = p.currency;
    const tdSize = document.createElement('td'); tdSize.textContent = p.size;
    const tdPrice = document.createElement('td'); tdPrice.textContent = fmtPrice(p.price);
    const tdValue = document.createElement('td'); tdValue.className = 'td-value sensitive'; tdValue.textContent = fmtEur(p.value);
    const tdPL    = document.createElement('td'); tdPL.className    = plClass    + ' sensitive'; tdPL.textContent    = (pl    >= 0 ? '+' : '') + fmtEur(pl);
    const tdPLPct = document.createElement('td'); tdPLPct.className = plPctClass + ' sensitive'; tdPLPct.textContent = (plPct >= 0 ? '+' : '') + plPct.toFixed(1) + '%';

    const attrib = totalCostBasis > 0 ? (unrealized / totalCostBasis * 100) : 0;
    const attribClass = attrib >= 0 ? 'positive' : 'negative';
    const tdAttrib = document.createElement('td');
    tdAttrib.className = attribClass + ' sensitive td-attrib';
    tdAttrib.textContent = (attrib >= 0 ? '+' : '') + attrib.toFixed(2) + '%';

    const vol = volCache[p.id];
    const tdVol = document.createElement('td');
    tdVol.className = 'td-vol';
    tdVol.textContent = vol != null ? vol.toFixed(1) + '%' : '—';

    tr.append(tdName, tdCurr, tdSize, tdPrice, tdValue, tdPL, tdPLPct, tdAttrib, tdVol);
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

  const sorted = [...closedPositions].sort((a, b) => {
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
    td.textContent = 'No fully closed positions found in transaction history.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  sorted.forEach((p, i) => {
    const plClass    = p.realizedPL >= 0 ? 'positive' : 'negative';
    const plPctClass = p.plPct >= 0 ? 'positive' : 'negative';
    const tr = document.createElement('tr');
    tr.dataset.positionId = p.id;
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => showStockChart(p, true));

    const tdName = document.createElement('td'); tdName.className = 'td-name';
    const dot = document.createElement('span');
    dot.style.cssText = 'display:inline-block;width:8px;height:8px;border-radius:50%;background:' + COLORS[i % COLORS.length] + ';margin-right:8px';
    tdName.appendChild(dot);
    tdName.appendChild(document.createTextNode(p.name));
    if (p.isPartial) {
      const badge = document.createElement('span');
      badge.textContent = 'partial';
      badge.style.cssText = 'margin-left:7px;font-size:9px;padding:1px 5px;border-radius:3px;background:#00A8E122;color:#00A8E1;border:1px solid #00A8E144;vertical-align:middle;font-family:var(--font-mono)';
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
    // Clear row highlights in both tables and destroy existing chart
    document.querySelectorAll('#positionsBody tr, #closedPositionsBody tr').forEach(tr => tr.classList.remove('row-selected'));
    if (charts.stockChart) { charts.stockChart.destroy(); charts.stockChart = null; }
    // Auto-load chart for first position in the newly selected tab
    if (isOpen) {
      const first = globalData.positions?.[0];
      if (first) showStockChart(first, false);
    } else {
      const first = globalData.closedPositions?.[0];
      if (first) showStockChart(first, true);
    }
  });
}

// ── Individual stock chart ──────────────────────────────────────────────────
async function showStockChart(position, isClosed, { scroll = true } = {}) {
  const container = document.getElementById('stockChartContainer');
  const titleEl   = document.getElementById('stockChartTitle');
  const metaEl    = document.getElementById('stockChartMeta');
  const closeBtn  = document.getElementById('stockChartClose');

  // Pro gate — show blurred placeholder chart with upgrade overlay
  if (!proUnlocked) {
    if (!container) return;
    container.style.display = 'block';

    // Only build the placeholder once
    if (!container.dataset.placeholderBuilt) {
      container.dataset.placeholderBuilt = '1';
      container.innerHTML = `
        <div class="stock-chart-header">
          <div class="stock-chart-title">Stock Price Chart</div>
          <div class="stock-chart-meta">Your holdings · all-time</div>
        </div>
        <div class="chart-wrap chart-wrap--stock stock-chart-blur-wrap">
          <canvas id="stockChartPlaceholder"></canvas>
        </div>
      `;

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
      const lineColor = isUp ? '#2ACA69' : '#FF4757';
      const fillColor = isUp ? 'rgba(42,202,105,0.08)' : 'rgba(255,71,87,0.08)';

      const phCanvas = document.getElementById('stockChartPlaceholder');
      if (phCanvas) {
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
      }

      // Overlay on top of the blurred chart
      showProOverlay(container, 'Stock Price Charts');
    }

    if (scroll) container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  const canvas    = document.getElementById('stockChart');
  if (!container || !canvas) return;

  // Highlight selected row in the correct table
  const bodyId = isClosed ? 'closedPositionsBody' : 'positionsBody';
  document.querySelectorAll('#positionsBody tr, #closedPositionsBody tr').forEach(tr => tr.classList.remove('row-selected'));
  document.querySelectorAll(`#${bodyId} tr`).forEach(tr => {
    tr.classList.toggle('row-selected', tr.dataset.positionId === position.id);
  });

  // Show container with loading state
  container.style.display = 'block';
  titleEl.textContent = position.name || 'Stock';
  metaEl.textContent = 'Loading price history…';
  if (scroll) container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Wire close button (only once)
  if (!closeBtn.dataset.wired) {
    closeBtn.dataset.wired = '1';
    closeBtn.addEventListener('click', () => {
      container.style.display = 'none';
      document.querySelectorAll('#positionsBody tr, #closedPositionsBody tr').forEach(tr => tr.classList.remove('row-selected'));
      if (charts.stockChart) { charts.stockChart.destroy(); charts.stockChart = null; }
    });
  }

  // Find first buy and last sell dates from transactions
  const txs = globalData.transactions || [];
  const buys  = txs.filter(tx => tx.productId === position.id && tx.buysell === 'B');
  const sells = txs.filter(tx => tx.productId === position.id && tx.buysell === 'S');
  const firstBuyDate = buys.length  > 0 ? buys[0].date                    : null;
  const lastSellDate = sells.length > 0 ? sells[sells.length - 1].date    : null;
  // For closed positions cap chart at last sell; open positions show through today
  const chartEndDate = isClosed && lastSellDate ? lastSellDate : null;

  // Fetch price history for this single stock
  const vwdEntry = globalData.vwdIds?.[position.id];
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
  const lineColor  = isUp ? '#2ACA69' : '#FF4757';
  const fillColor  = isUp ? 'rgba(42,202,105,0.08)' : 'rgba(255,71,87,0.08)';

  // Build meta line
  const currencySymbol = position.currency === 'USD' ? '$' : position.currency === 'GBP' ? '£' : position.currency === 'EUR' ? '€' : position.currency + ' ';
  const plSign = pricePL >= 0 ? '+' : '';
  if (isClosed && firstBuyDate && lastSellDate) {
    const realizedPL    = position.realizedPL ?? 0;
    const realizedSign  = realizedPL >= 0 ? '+' : '';
    const realizedColor = realizedPL >= 0 ? '#2ACA69' : '#FF4757';
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
      borderColor: '#2ACA69',
      backgroundColor: '#2ACA69',
      pointRadius: 5,
      pointStyle: 'triangle',
      showLine: false,
      label: 'Buy',
    });
  }
  if (sellPoints.some(v => v !== null)) {
    datasets.push({
      data: sellPoints,
      borderColor: '#FF4757',
      backgroundColor: '#FF4757',
      pointRadius: 5,
      pointStyle: 'triangle',
      rotation: 180,
      showLine: false,
      label: 'Sell',
    });
  }

  // Format dates the same way as the Capital Appreciation chart: "Sept 2025"
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
          backgroundColor: '#1E2C3A', borderColor: '#2A3A4A', borderWidth: 1,
          titleColor: '#F5F7FA', bodyColor: '#8B9BB4', padding: 10,
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
          grid: { color: '#1E2C3A' },
          ticks: {
            color: '#8B9BB4', font: { size: 10 }, maxTicksLimit: 10,
            callback: function(val) { return tickLabels[val] || null; }
          }
        },
        y: {
          grid: { color: '#1E2C3A88' },
          ticks: {
            color: '#8B9BB4', font: { size: 10 },
            callback: v => currencySymbol + v.toFixed(2)
          }
        }
      }
    }
  });
}

function miniChartOptions(yFmt) {
  return {
    responsive:true, maintainAspectRatio:false,
    interaction: { mode:'index', intersect:false },
    plugins: { legend:{display:false}, tooltip:{backgroundColor:'#1E2C3A',borderColor:'#2A3A4A',borderWidth:1,titleColor:'#F5F7FA',bodyColor:'#8B9BB4',padding:10,callbacks:{label:ctx=>' '+fmtEur(ctx.parsed.y)}} },
    scales: {
      x:{grid:{color:'#1E2C3A'},ticks:{color:'#8B9BB4',font:{size:10},maxTicksLimit:8}},
      y:{grid:{color:'#1E2C3A88'},ticks:{color:'#8B9BB4',font:{size:10},callback:yFmt||null}}
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
  const totalDividends = dividends.reduce((s, d) => s + (d.amountEUR || 0), 0);

  // ── 2. FX P&L — use p.plFx computed in extractPositions (matches DEGIRO's own P/L Devise) ──
  // Formula: plFx = unrealized − (priceGain × purchaseFX)
  // where purchaseFX = costBasisEUR / (size × breakEvenPrice)
  let unrealizedFxPL = 0;
  let fxPositions = 0;
  positions.forEach(p => {
    if (p.currency === 'EUR') return;
    unrealizedFxPL += p.plFx || 0;
    fxPositions++;
  });

  // Historical (realized) FX P&L from closed/partially closed positions
  const closedPosns = globalData.closedPositions || [];
  let realizedFxPL = 0;
  let closedFxCount = 0;
  closedPosns.forEach(cp => {
    if (cp.realizedFxPL && cp.realizedFxPL !== 0) {
      realizedFxPL += cp.realizedFxPL;
      closedFxCount++;
    }
  });
  const totalFxPL = unrealizedFxPL + realizedFxPL;

  // ── 3. Total realized gains — derived from computeClosedPositions for consistency ──
  const closedForGain = computeClosedPositions(transactions, globalData.names, globalData.data?.productInfo ? extractProductMeta(globalData.data.productInfo).meta : {});
  const totalRealized = closedForGain.reduce((s, cp) => s + cp.realizedPL, 0);

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
      fee: Math.abs(parseFloat(t.totalFeesInBaseCurrency) || 0) + Math.abs(parseFloat(t.autoFxFeeInBaseCurrency) || 0),
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

  // Realized gains cumulative — mirrors computeClosedPositions FIFO exactly
  // Walk each product's transactions independently, collect per-sell gain events, then sort by date
  const gainEvents = []; // [{date, gain}]
  const byProduct = {};
  transactions.forEach(tx => {
    if (!byProduct[tx.productId]) byProduct[tx.productId] = [];
    byProduct[tx.productId].push(tx);
  });
  Object.values(byProduct).forEach(txs => {
    const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date));
    const buyQueue = [];
    sorted.forEach(tx => {
      const qty = Math.abs(tx.quantity);
      const eurPerShare = qty > 0 ? Math.abs(tx.totalInBaseCurrency) / qty : 0;
      if (tx.buysell === 'B') {
        buyQueue.push({ qty, eurPerShare });
      } else if (tx.buysell === 'S') {
        let remaining = qty;
        let costBasis = 0;
        while (remaining > 0.0001 && buyQueue.length > 0) {
          const lot = buyQueue[0];
          const matched = Math.min(lot.qty, remaining);
          costBasis += matched * lot.eurPerShare;
          lot.qty -= matched;
          remaining -= matched;
          if (lot.qty < 0.0001) buyQueue.shift();
        }
        const sellProceeds = Math.abs(tx.totalInBaseCurrency);
        gainEvents.push({ date: tx.date, gain: sellProceeds - costBasis });
      }
    });
  });
  gainEvents.sort((a, b) => a.date.localeCompare(b.date));
  const gainSeries = [];
  let gainCum = 0;
  gainEvents.forEach(e => { gainCum += e.gain; gainSeries.push({ date: e.date, value: gainCum }); });

  // Store series for chart rendering
  const chartData = {
    dividends: divSeries,
    fees: feeSeries,
    realized: gainSeries,
  };

  // Dividends stat
  grid.appendChild(makeStat(
    'Dividends received',
    (totalDividends >= 0 ? '+' : '') + fmtEur(totalDividends),
    dividends.length > 0 ? `${dividends.length} payments · gross before tax` : 'No dividend history found',
    totalDividends > 0 ? 'positive' : '',
    null,
    divSeries.length > 1 ? 'dividends' : null
  ));

  // Currency effect stat — no time series available, not clickable
  const fxTooltip = 'Impact of exchange rate movements separate from product performance. Includes both open and closed positions.';
  const fxClass = totalFxPL >= 0 ? 'positive' : 'negative';
  const fxSub = (fxPositions > 0 || closedFxCount > 0)
    ? 'Open + closed positions · all-time'
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
    const lineColor = isPositive ? '#2ACA69' : '#FF4757';
    const fillColor = isPositive ? 'rgba(42,202,105,0.08)' : 'rgba(255,71,87,0.08)';

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
            backgroundColor: '#1E2C3A', borderColor: '#2A3A4A', borderWidth: 1,
            titleColor: '#F5F7FA', bodyColor: '#8B9BB4', padding: 10,
            callbacks: {
              title: ctx => { const d = labels[ctx[0]?.dataIndex]; return d ? fmtDate(d) : ''; },
              label: ctx => ` ${key === 'fees' ? '-' : ''}${fmtEur(Math.abs(ctx.parsed.y))}`,
            }
          }
        },
        scales: {
          x: {
            grid: { color: '#1E2C3A' },
            ticks: { color: '#8B9BB4', font: { size: 10 }, maxTicksLimit: 8, callback: function(val) { return tickLabels[val] || null; } }
          },
          y: {
            grid: { color: '#1E2C3A88' },
            ticks: {
              color: '#8B9BB4', font: { size: 10 },
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
function renderSharpe(portfolioSeries) {
  const stat = document.getElementById('moreInfoSharpeStat');
  if (!stat) return;

  const valEl  = stat.querySelector('.more-info-stat-value');
  const subEl  = stat.querySelector('.more-info-stat-sub');

  if (!portfolioSeries || portfolioSeries.length < 30) {
    if (valEl) valEl.textContent = 'N/A';
    if (subEl) subEl.textContent = 'Not enough data (need 30+ trading days)';
    return;
  }

  // Take trailing 252 trading days (or all available if fewer)
  const RF_DAILY  = Math.pow(1.03, 1 / 252) - 1; // 3.0% p.a. compounded daily

  const window1Y = portfolioSeries.slice(-252);
  const dailyReturns = [];
  for (let i = 1; i < window1Y.length; i++) {
    const prev = window1Y[i - 1].value;
    if (prev > 0) dailyReturns.push(window1Y[i].value / prev - 1);
  }

  if (dailyReturns.length < 20) {
    if (valEl) valEl.textContent = 'N/A';
    if (subEl) subEl.textContent = 'Not enough trading days';
    return;
  }

  const n    = dailyReturns.length;
  const mean = dailyReturns.reduce((s, r) => s + r, 0) / n;
  const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const std  = Math.sqrt(variance);

  if (std === 0) {
    if (valEl) valEl.textContent = 'N/A';
    return;
  }

  const sharpe = ((mean - RF_DAILY) / std) * Math.sqrt(252);
  const label  = sharpe >= 1 ? 'positive' : sharpe >= 0 ? '' : 'negative';
  const days   = portfolioSeries.length;
  const usedDays = Math.min(days, 252);

  if (valEl) {
    valEl.textContent = sharpe.toFixed(2);
    valEl.className = 'more-info-stat-value sensitive' + (label ? ' ' + label : '');
  }
  if (subEl) {
    subEl.textContent = `Based on ${usedDays} trading days · 3% risk-free rate`;
  }

  // Add tooltip explaining interpretation
  stat.className = 'more-info-stat more-info-stat--tip';
  stat.dataset.tip = 'Sharpe ratio measures return per unit of risk. Above 1 is good, above 2 is great, above 3 is excellent. Below 0 means you earned less than the risk-free rate. Calculated from daily portfolio returns, annualised to 252 trading days.';
}

function setStatus(s) {
  const d = document.getElementById('statusDot');
  d.className = 'status-dot' + (s==='connected'?' connected':s==='loading'?' loading':'');
}
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
  function pearson(a, b) {
    const pairs = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== null && b[i] !== null) pairs.push([a[i], b[i]]);
    }
    const n = pairs.length;
    if (n < 10) return null;
    const meanA = pairs.reduce((s, p) => s + p[0], 0) / n;
    const meanB = pairs.reduce((s, p) => s + p[1], 0) / n;
    let num = 0, da = 0, db = 0;
    for (const [x, y] of pairs) {
      const dx = x - meanA, dy = y - meanB;
      num += dx * dy;
      da  += dx * dx;
      db  += dy * dy;
    }
    const denom = Math.sqrt(da * db);
    return denom === 0 ? null : Math.min(1, Math.max(-1, num / denom));
  }

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
    if (c >= 0) {
      // neutral → vivid red (#E05252)
      return `rgb(${Math.round(30 + t * (224 - 30))},${Math.round(44 + t * (82 - 44))},${Math.round(58 + t * (82 - 58))})`;
    } else {
      // neutral → vivid green (#2ECC71)
      return `rgb(${Math.round(30 + t * (46 - 30))},${Math.round(44 + t * (204 - 44))},${Math.round(58 + t * (113 - 58))})`;
    }
  }

  function textColor(v) {
    if (v === null) return 'var(--muted)';
    return Math.abs(v) > 0.15 ? '#F5F7FA' : '#C0C8D4';
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
    if (wac !== null) globalData.insightWAC = wac; // expose to grade engine

    if (wac !== null) {
      const wacBox = document.createElement('div');
      wacBox.className = 'more-info-stat more-info-stat--tip';
      wacBox.dataset.tip =
        'Weighted Average Correlation: How correlated your portfolio is, ' +
        'weighted by position size. Pairs with larger combined weight count more. ' +
        'Below 0.3 is well-diversified, 0.3 to 0.6 is moderate, above 0.6 is concentrated.';

      function wacColor(v) {
        if (v < 0.3)  return '#2ECC71';
        if (v <= 0.6) return '#F5F7FA';
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
        if (v <= 0.7) return '#F5F7FA';
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
        return c >= 0
          ? `rgb(${Math.round(30+t*194)},${Math.round(44+t*38)},${Math.round(58+t*24)})`
          : `rgb(${Math.round(30+t*16)},${Math.round(44+t*160)},${Math.round(58+t*55)})`;
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
          td.style.color = Math.abs(v) > 0.15 ? '#F5F7FA' : '#C0C8D4';
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

  if (proUnlocked) {
    btn.classList.add('pro-active');
    btn.title = 'Sharpe Pro — Active. Click to view subscription details.';
    btn.style.cursor = 'pointer';
    if (!btn.dataset.wiredPro) {
      btn.dataset.wiredPro = '1';
      btn.addEventListener('click', () => showProStatusModal());
    }
  } else {
    btn.classList.remove('pro-active');
    btn.title = 'Activate Sharpe Pro';
    if (!btn.dataset.wiredPro) {
      btn.dataset.wiredPro = '1';
      btn.addEventListener('click', () => showLicenseModal());
    }
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

  // 1. Capital Appreciation chart
  const perfHeader = document.querySelector('#performanceChart')?.closest('.card')?.querySelector('.card-header');
  if (perfHeader && !perfHeader.querySelector('.btn-export')) {
    perfHeader.appendChild(makeExportBtn('Export chart data as CSV', exportCapitalAppreciation, locked));
  }

  // 2. Allocation chart
  const allocHeader = document.querySelector('#allocationChart')?.closest('.card')?.querySelector('.card-header');
  if (allocHeader && !allocHeader.querySelector('.btn-export')) {
    allocHeader.appendChild(makeExportBtn('Export allocation as CSV', exportAllocation, locked));
  }

  // 3. Recent Activity card
  const moversHeader = document.getElementById('moversCard')?.querySelector('.card-header');
  if (moversHeader && !moversHeader.querySelector('.btn-export')) {
    moversHeader.appendChild(makeExportBtn('Export recent performance as CSV', exportRecentPerf, locked));
  }

  // 4. Positions table (open + closed)
  const posHeader = document.querySelector('#positionsTable')?.closest('.card')?.querySelector('.card-header');
  if (posHeader && !posHeader.querySelector('.btn-export')) {
    posHeader.appendChild(makeExportBtn('Export positions as CSV', exportPositions, locked));
  }

  // 5. Correlation matrix
  const corrHeader = document.getElementById('correlationCard')?.querySelector('.card-header');
  if (corrHeader && !corrHeader.querySelector('.btn-export')) {
    corrHeader.appendChild(makeExportBtn('Export correlation matrix as CSV', exportCorrelation, locked));
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

function exportRecentPerf() {
  const dates = globalData.recentPerfDates;
  const chart = charts.recentPerf;
  if (!dates || !chart) return;
  const data = chart.data.datasets[0].data;
  const headers = ['Date', 'Daily Change %'];
  const rows = dates.map((d, i) => [d, (data[i] ?? 0).toFixed(4)]);
  downloadCSV('recent_performance.csv', headers, rows);
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

  // Restore saved survey answers
  chrome.storage.local.get('gradeAnswers', ({ gradeAnswers }) => {
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
    chrome.storage.local.set({ gradeAnswers: answers });
    const gradeData = computePortfolioGrade(answers, globalData);
    renderGradeResults(gradeData, results);
    survey.style.display = 'none';
    results.style.display = 'block';
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

// ── Grade metric navigation helper ─────────────────────────────────────────
// Scrolls to the relevant dashboard section and, where needed, opens a
// collapsed panel or activates a toggle before scrolling.
function navigateToSection(label) {
  const scrollTo = (el, offset = 80) => {
    if (!el) return;
    const y = el.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top: y, behavior: 'smooth' });
  };

  switch (label) {
    case 'Sharpe Ratio': {
      // Capital Appreciation chart — ensure insight bar is open
      const insightBtn = document.getElementById('insightToggle');
      const insightEl  = document.getElementById('chartInsight');
      if (insightBtn && insightEl && !insightBtn.classList.contains('active')) {
        insightBtn.classList.add('active');
        globalData.showInsight = true;
        insightEl.style.display = '';
      }
      scrollTo(document.getElementById('performanceChart')?.closest('.card'));
      break;
    }

    case 'Trades / Month': {
      // Capital Appreciation chart — turn on trades overlay if not already on
      const tradesBtn = document.getElementById('tradesToggle');
      if (tradesBtn && !tradesBtn.classList.contains('active')) {
        tradesBtn.classList.add('active');
        globalData.showTrades = true;
        const activeMode = document.querySelector('#perfToggle .toggle-btn.active')?.dataset.mode || 'pct';
        drawPerformanceChart(globalData.portfolioSeries, globalData.spyData, activeMode, globalData.eurSeries);
      }
      scrollTo(document.getElementById('performanceChart')?.closest('.card'));
      break;
    }

    case 'Positions':
    case 'Asset Classes':
    case 'Regions': {
      // Allocation pie chart (right card in grid-top)
      scrollTo(document.getElementById('allocationChart')?.closest('.card'));
      break;
    }

    case 'Largest Holding':
    case 'Top-3 Weight':
    case 'Avg Correlation': {
      // Correlation matrix — open it if collapsed (Pro only; non-Pro shows overlay)
      const corrBtn     = document.getElementById('btnCorrelation');
      const corrContent = document.getElementById('correlationContent');
      if (corrBtn && corrContent && corrContent.style.display === 'none') {
        corrBtn.click();
      }
      scrollTo(document.getElementById('correlationCard'));
      break;
    }

    case 'Dividend Yield': {
      // Switch to Insights tab and scroll to More Insights card
      const insightsBtn = document.querySelector('.tab-btn[data-tab="insights"]');
      if (insightsBtn) insightsBtn.click();
      scrollTo(document.getElementById('moreInfoCard'));
      break;
    }

    default:
      break;
  }
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
  const confidences = [{ key: 0.90, label: '90%' }, { key: 0.95, label: '95%' }, { key: 0.99, label: '99%' }];
  confidences.forEach((c, i) => {
    const btn = document.createElement('button');
    btn.className = 'var-btn var-btn--conf' + (i === 1 ? ' active' : '');
    btn.dataset.conf = c.key;
    btn.textContent = c.label;
    confGroup.appendChild(btn);
  });
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
              c.strokeStyle = 'rgba(255,255,255,0.18)';
              c.lineWidth = 1;
              c.beginPath(); c.moveTo(left, baseY); c.lineTo(right, baseY); c.stroke();
              c.restore();
              c.save();
              c.font = "9px 'DM Mono', monospace";
              c.fillStyle = 'rgba(255,255,255,0.30)';
              c.textAlign = 'right';
              c.fillText(`Start: ${fmtEur(baselineVal)}`, right - 4, baseY - 5);
              c.restore();

              // Phase divider at crash trough
              const divX = x.getPixelForValue(shape.crashDays);
              c.save();
              c.setLineDash([3, 3]);
              c.strokeStyle = 'rgba(255,255,255,0.07)';
              c.lineWidth = 1;
              c.beginPath(); c.moveTo(divX, top); c.lineTo(divX, bottom); c.stroke();
              c.restore();
              c.save();
              c.font = "bold 8px 'DM Mono', monospace";
              c.textAlign = 'center';
              c.fillStyle = 'rgba(239,83,80,0.5)';
              c.fillText('CRASH', (left + divX) / 2, top + 12);
              c.fillStyle = 'rgba(76,175,80,0.4)';
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
              c.fillStyle = 'rgba(239,83,80,0.92)';
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
                  borderColor: 'rgba(255,255,255,0.13)',
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
                  ticks: { font: { family: "'DM Mono', monospace", size: 9 }, color: 'rgba(255,255,255,0.35)', maxRotation: 0, autoSkip: false, callback: function(val, idx) { return labels[idx] || ''; } },
                  border: { display: false },
                },
                y: {
                  grid: { color: 'rgba(255,255,255,0.05)', drawBorder: false },
                  ticks: { font: { family: "'DM Mono', monospace", size: 9 }, color: 'rgba(255,255,255,0.35)', callback: function(val) { if (Math.abs(val) >= 1000000) return '€' + (val / 1000000).toFixed(1) + 'M'; return '€' + (val / 1000).toFixed(0) + 'k'; }, maxTicksLimit: 5 },
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
            c.strokeStyle = 'rgba(255,255,255,0.18)';
            c.lineWidth = 1;
            c.beginPath(); c.moveTo(left, baseY); c.lineTo(right, baseY); c.stroke();
            c.restore();

            c.save();
            c.font = "9px 'DM Mono', monospace";
            c.fillStyle = 'rgba(255,255,255,0.30)';
            c.textAlign = 'right';
            c.fillText(`Start: ${fmtEur(baselineVal)}`, right - 4, baseY - 5);
            c.restore();

            // 2. Phase dividers (anchored to realistic scenario)
            const refSc = allSeries[1];
            const p1X = x.getPixelForValue(refSc.phase1Days);
            const p2X = x.getPixelForValue(refSc.phase2Days);

            c.save();
            c.setLineDash([3, 3]);
            c.strokeStyle = 'rgba(255,255,255,0.07)';
            c.lineWidth = 1;
            [p1X, p2X].forEach(px => {
              c.beginPath(); c.moveTo(px, top); c.lineTo(px, bottom); c.stroke();
            });
            c.restore();

            c.save();
            c.font = "bold 8px 'DM Mono', monospace";
            c.textAlign = 'center';
            c.fillStyle = 'rgba(239,83,80,0.5)';
            c.fillText('SELL-OFF', (left + p1X) / 2, top + 12);
            c.fillStyle = 'rgba(248,150,30,0.4)';
            c.fillText('DECLINE', (p1X + p2X) / 2, top + 12);
            c.fillStyle = 'rgba(76,175,80,0.4)';
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

            c.fillStyle = 'rgba(239,83,80,0.92)';
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
                  color: 'rgba(255,255,255,0.55)',
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
                borderColor: 'rgba(255,255,255,0.13)',
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
                  color: 'rgba(255,255,255,0.35)',
                  maxRotation: 0,
                  autoSkip: false,
                  callback: function(val, idx) { return labels[idx] || ''; },
                },
                border: { display: false },
              },
              y: {
                grid: { color: 'rgba(255,255,255,0.05)', drawBorder: false },
                ticks: {
                  font: { family: "'DM Mono', monospace", size: 9 },
                  color: 'rgba(255,255,255,0.35)',
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
