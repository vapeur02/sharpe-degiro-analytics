// dashboard.js — Sharpe extension main dashboard
// Shared constants (COLORS, CASH_IDS, etc.) and utilities are in utils.js,
// loaded before this file via dashboard.html.

let charts = {};
let globalData = {};

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

  // Ko-fi donate button
  const btnDonate = document.getElementById('btnDonate');
  if (btnDonate) {
    btnDonate.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.windows.create({
        url: 'https://ko-fi.com/sharpe_dev/?hidefeed=true&widget=true&embed=true',
        type: 'popup',
        width: 400,
        height: 620,
        focused: true
      });
    });
  }
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

  // If opened from popup via a clickable stat card, switch to the requested chart mode
  chrome.storage.local.get('popupOpenMode', ({ popupOpenMode }) => {
    if (!popupOpenMode) return;
    chrome.storage.local.remove('popupOpenMode');
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

function showMain() {
  document.getElementById('loadingScreen').style.display = 'none';
  document.getElementById('mainContent').style.display = 'block';
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
  wireCorrelationToggle();

  // Wire up More Info toggle
  const btnMoreInfo = document.getElementById('btnMoreInfo');
  if (btnMoreInfo && !btnMoreInfo.dataset.wired) {
    btnMoreInfo.dataset.wired = '1';
    btnMoreInfo.addEventListener('click', () => {
      const content = document.getElementById('moreInfoContent');
      const isOpen = content.style.display !== 'none';
      content.style.display = isOpen ? 'none' : 'block';
      btnMoreInfo.textContent = isOpen ? '⊕ Show details' : '⊖ Hide details';
      btnMoreInfo.classList.toggle('open', !isOpen);
    });
  }

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
      const startDate = new Date(globalData.firstTxDate);
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
  
  const spyData = (allHistories['__SP500__'] || []).filter(d => d.date >= firstTxDate);
  console.log('[Perf] SPY sample:', spyData[0]);
  const priceHistories = {};
  Object.entries(allHistories).forEach(([id, data]) => {
    if (id !== '__SP500__') priceHistories[id] = data;
  });
  
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

  // Get portfolio value on a given date using historical holdings
  // Per-position last known price cache for fill-forward
  const lastKnownPrice = {};
  const getPortfolioValue = (date, holdingsSnapshot) => {
    let total = 0;
    const entries = Object.entries(holdingsSnapshot).filter(([, s]) => s > 0);
    if (!entries.length) return null;
    let anyPriced = false;
    for (const [id, shares] of entries) {
      const price = getPrice(id, date);
      if (price) {
        lastKnownPrice[id] = price; // update fill-forward cache
        total += price * shares;
        anyPriced = true;
      } else if (lastKnownPrice[id]) {
        // Fill forward: use last known price rather than dropping the date
        total += lastKnownPrice[id] * shares;
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
  if (fullPortfolioSeries.length === 0) return;

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
      const days = (new Date(lastDate) - new Date(firstDate)) / (1000 * 60 * 60 * 24);
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
          const days = (new Date(lastDate) - new Date(firstDate)) / (1000 * 60 * 60 * 24);
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

async function fetchHistoriesForPeriod(vwdIds, period) {
  return await chrome.runtime.sendMessage({ type: 'FETCH_PRICE_HISTORY', vwdIds, period });
}

function jumpPerfChartToDate(targetDate) {
  // Highlight the bar in the Recent Performance chart that matches targetDate
  const chart = charts.recentPerf;
  const dates = globalData.recentPerfDates;
  if (!chart || !dates) return;

  // Find closest date index
  let closestIdx = 0, minDiff = Infinity;
  dates.forEach((d, i) => {
    const diff = Math.abs(new Date(d) - new Date(targetDate));
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
  const cutoff = new Date(refDate - days * 864e5).toISOString().slice(0, 10);

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

  // Show up to 6 movers: best 3 and worst 3.
  // If one side is entirely empty (e.g. all positions are down in a bear period),
  // show up to 6 from the dominant direction instead of leaving slots empty.
  const sorted = [...all];                         // already sorted desc by pct
  const gainers = sorted.filter(p => p.pct >= 0);
  const losers  = sorted.filter(p => p.pct <  0).reverse(); // worst first (most negative first)

  let topGainers, topLosers;
  if (gainers.length === 0) {
    // All red: show 6 worst losers
    topGainers = [];
    topLosers  = losers.slice(0, 6);
  } else if (losers.length === 0) {
    // All green: show 6 best gainers
    topGainers = gainers.slice(0, 6);
    topLosers  = [];
  } else {
    // Mixed: target 3 each, borrow slots from the smaller side
    const targetG = Math.min(3, gainers.length);
    const targetL = Math.min(3, losers.length);
    const extraG  = Math.min(gainers.length - targetG, 3 - targetL);
    const extraL  = Math.min(losers.length  - targetL, 3 - targetG);
    topGainers = gainers.slice(0, targetG + Math.max(0, extraG));
    topLosers  = losers.slice(0,  targetL + Math.max(0, extraL));
  }
  const movers = [...topGainers, ...topLosers];

  if (!movers.length) {
    el.textContent = '';
    const span = document.createElement('span');
    span.className = 'muted'; span.style.cssText = 'padding:16px;display:block';
    span.textContent = 'No data available';
    el.appendChild(span);
    return;
  }

  el.textContent = '';
  movers.forEach(p => {
    const up = p.pct >= 0;
    const item = document.createElement('div'); item.className = 'mover-item';
    const nameEl = document.createElement('div'); nameEl.className = 'mover-name'; nameEl.textContent = p.name || 'ID ' + p.id;
    const prices = document.createElement('div'); prices.className = 'mover-prices'; prices.textContent = fmtPrice(p.priceStart) + ' → ' + fmtPrice(p.priceNow);
    const pctEl = document.createElement('div'); pctEl.className = 'mover-pct'; pctEl.style.color = up ? '#2ACA69' : '#FF4757';
    pctEl.textContent = (up ? '▲' : '▼') + ' ' + Math.abs(p.pct).toFixed(1) + '%';
    item.append(nameEl, prices, pctEl);
    el.appendChild(item);
  });
}


function renderRecentPerf(positions, histories, period) {
  const canvas = document.getElementById('recentPerfChart');
  if (!canvas) return;

  // Use only positions with value > 0 and valid histories
  const activePosns = positions.filter(p => p.value > 0 && histories[p.id]?.length >= 2);
  if (!activePosns.length) return;

  // Get dates that exist in ALL active position histories (trading days only)
  // Use the union of dates, fill forward for missing
  const dateSet = new Set();
  activePosns.forEach(p => histories[p.id].forEach(d => dateSet.add(d.date)));
  let dates = [...dateSet].sort();
  if (dates.length < 2) return;

  // For 1W view: trim to last 7 calendar days of dates + 1 prior day as baseline.
  // VWD now fetches P1M for 1W (to ensure Friday prior-week is available as baseline
  // for computing Monday's daily change bar). We then slice down to just what we need.
  // Also strip any weekend dates — some instruments have Saturday/Sunday data in VWD.
  const isWeekday = d => { const day = new Date(d + 'T12:00:00').getDay(); return day >= 1 && day <= 5; };
  if (period === '1W' && dates.length > 1) {
    const lastDate = new Date(dates[dates.length - 1]);
    const cutoff = new Date(lastDate);
    cutoff.setDate(cutoff.getDate() - 7); // 7 calendar days back
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    // Keep only weekday dates; display window = strictly after cutoff
    const displayDates = dates.filter(d => d > cutoffStr && isWeekday(d));
    const baselineDates = dates.filter(d => d <= cutoffStr && isWeekday(d));
    const baseline = baselineDates[baselineDates.length - 1];
    dates = baseline ? [baseline, ...displayDates] : displayDates;
  } else {
    // For all other periods, still strip weekends to avoid spurious data points
    dates = dates.filter(isWeekday);
  }

  // Build fill-forward price lookup per position (O(n) per position)
  const filledPrices = {}; // id -> sorted array of {date, price}
  activePosns.forEach(p => {
    const sorted = [...histories[p.id]].sort((a, b) => a.date.localeCompare(b.date));
    filledPrices[p.id] = sorted;
  });

  const lastSeen = {}; // fill-forward cache per position
  const getFilledPrice = (id, date) => {
    // Binary search for latest price <= date
    const arr = filledPrices[id];
    if (!arr?.length) return lastSeen[id] ?? null;
    let lo = 0, hi = arr.length - 1, res = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].date <= date) { res = arr[mid].price; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (res) lastSeen[id] = res;
    return res ?? lastSeen[id] ?? null;
  };

  // Find first date where all positions that CAN be priced at the baseline are priced.
  // Only require a position if fill-forward can produce a price at the baseline date —
  // i.e. it has at least one data point on or before dates[0].
  // Positions bought mid-period (first data after baseline) are excluded from the
  // requirement and handled via fill-forward once they appear. Without this, a mid-week
  // purchase would push firstValidDate past the baseline, losing a bar from the chart.
  const posnsWithData = activePosns.filter(p =>
    getFilledPrice(p.id, dates[0]) != null
  );
  const firstValidDate = dates.find(date =>
    posnsWithData.every(p => getFilledPrice(p.id, date) != null)
  );
  if (!firstValidDate) return;

  const dailyValues = dates.filter(d => d >= firstValidDate).map(date => {
    let total = 0;
    activePosns.forEach(p => {
      const price = getFilledPrice(p.id, date);
      if (price) total += price * p.size;
    });
    return { date, value: total };
  }).filter(d => d.value > 0);

  if (dailyValues.length < 2) return;

  // Daily % change bars — skip first day (no prior)
  const barDates = dailyValues.slice(1).map(d => d.date);
  const dailyChangePct = dailyValues.slice(1).map((d, i) => {
    const prev = dailyValues[i].value;
    return prev > 0 ? ((d.value - prev) / prev) * 100 : 0;
  });

  const fmtDate = d => {
    const [y,m,dd] = d.split('-');
    return new Date(y,m-1,dd).toLocaleDateString('default',{day:'numeric',month:'short'});
  };

  globalData.recentPerfDates = barDates;

  // Compound return for the visible window
  const compoundReturn = dailyValues.length >= 2
    ? ((dailyValues[dailyValues.length-1].value / dailyValues[0].value) - 1) * 100
    : 0;

  const recentBadgePlugin = {
    id: 'recentBadge',
    afterDraw(chart) {
      const ctx2 = chart.ctx;
      const { right, top } = chart.chartArea;
      const label = (compoundReturn >= 0 ? '+' : '') + compoundReturn.toFixed(2) + '%';
      const color = compoundReturn >= 0 ? '#2ACA69' : '#FF4757';
      ctx2.save();
      ctx2.font = 'bold 20px Syne, sans-serif';
      const textW = ctx2.measureText(label).width;
      const padX = 11, boxH = 28;
      const boxW = textW + padX * 2;
      // Position: top-right corner, sitting just above the chart area (in chart padding)
      const boxX = right - boxW;
      const boxY = top - boxH - 6; // above the bars so never overlaps
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

  if (charts.recentPerf) charts.recentPerf.destroy();
  charts.recentPerf = new Chart(canvas, {
    type: 'bar',
    plugins: [recentBadgePlugin],
    data: {
      labels: barDates.map(fmtDate),
      datasets: [{
        label: 'Daily Change',
        data: dailyChangePct,
        backgroundColor: dailyChangePct.map(v => v >= 0 ? '#2ACA6955' : '#FF475755'),
        borderColor: dailyChangePct.map(v => v >= 0 ? '#2ACA69' : '#FF4757'),
        borderWidth: 1,
        borderRadius: 2,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 40 } },   // reserve space above bars for the % return badge
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1E2C3A', borderColor: '#2A3A4A', borderWidth: 1,
          titleColor: '#F5F7FA', bodyColor: '#8B9BB4', padding: 10,
          callbacks: { label: ctx => ' '+(ctx.parsed.y>=0?'+':'')+ctx.parsed.y.toFixed(2)+'%' }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#8B9BB4', font: { size: 10 }, maxTicksLimit: 12 } },
        y: { grid: { color: '#1E2C3A88' }, ticks: { color: '#8B9BB4', font: { size: 10 }, callback: v => (v>=0?'+':'')+v.toFixed(1)+'%' } }
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
      return { date: d.toISOString().slice(0,10), price };
    }).filter(d => d.price != null);
  } catch(e) { console.warn('parseVwdSeries error:', e); return []; }
}

function buildHoldingsOverTime(transactions, dates) {
  // For each date, calculate how many shares of each product were held
  const result = {};
  const holdings = {};
  let txIdx = 0;
  const sortedTx = [...transactions].sort((a,b) => new Date(a.date)-new Date(b.date));
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

function renderPositionsTable(positions, sortCol, sortDir) {
  // Determine sort state — default: value descending
  sortCol = sortCol || globalData._posSort?.col || 'value';
  sortDir = sortDir || globalData._posSort?.dir || 'desc';
  globalData._posSort = { col: sortCol, dir: sortDir };

  const valueOf = (p, col) => {
    const unrealized = p.plUnrealized ?? p.plBase;
    const costBasis = p.value - unrealized;
    const plPct = costBasis > 0 ? (unrealized / costBasis * 100) : 0;
    switch (col) {
      case 'name':   return (p.name || 'ID ' + p.id).toLowerCase();
      case 'currency': return p.currency;
      case 'size':   return p.size;
      case 'price':  return p.price;
      case 'value':  return p.value;
      case 'pl':     return p.plBase;
      case 'plpct':  return plPct;
      default:       return p.value;
    }
  };

  const sorted = [...positions].sort((a, b) => {
    const av = valueOf(a, sortCol), bv = valueOf(b, sortCol);
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  // Update header arrows
  document.querySelectorAll('#positionsTable thead th').forEach(th => {
    const col = th.dataset.col;
    th.classList.toggle('sort-active', col === sortCol);
    // Strip old arrow, add new one
    th.textContent = th.textContent.replace(/ [▲▼]$/, '');
    if (col === sortCol) th.textContent += sortDir === 'asc' ? ' ▲' : ' ▼';
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

    tr.append(tdName, tdCurr, tdSize, tdPrice, tdValue, tdPL, tdPLPct);
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
function computeClosedPositions(transactions, names, meta) {
  const byProduct = {};
  transactions.forEach(tx => {
    const id = tx.productId;
    if (!byProduct[id]) byProduct[id] = [];
    byProduct[id].push(tx);
  });

  const closed = [];

  Object.entries(byProduct).forEach(([id, txs]) => {
    const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date));
    const buyQueue = [];
    let totalSoldQty = 0;
    let totalBuyCostEUR = 0;
    let totalSellProcEUR = 0;
    let netQty = 0;

    // ── Historical currency effect (realised FX P&L on sold lots) ──
    // For each matched lot: fxImpact = matchedQty × buyNativePrice × (sellFX − buyFX)
    // This isolates how much the EUR↔native exchange rate change contributed
    // to the realised P&L, separate from the product's own price movement.
    let realizedFxPL = 0;

    // Detect if this product is non-EUR: check meta first, else infer from first buy's FX rate
    const productCurrency = meta?.[id]?.currency || '';
    let isNonEUR = productCurrency !== '' && productCurrency !== 'EUR';

    sorted.forEach(tx => {
      const qty = Math.abs(tx.quantity);
      const eurPerShare = qty > 0 ? Math.abs(tx.totalInBaseCurrency) / qty : 0;
      const nativePrice = tx.price;
      // Implied FX rate: EUR per 1 unit of native currency.
      // Subtract fees for a cleaner FX rate (fees inflate totalInBaseCurrency).
      const fees = Math.abs(tx.totalFeesInBaseCurrency || 0) + Math.abs(tx.autoFxFeeInBaseCurrency || 0);
      const eurExFees = Math.abs(tx.totalInBaseCurrency) - fees;
      const impliedFX = (nativePrice > 0 && qty > 0 && eurExFees > 0)
        ? eurExFees / (nativePrice * qty)
        : 1;

      if (tx.buysell === 'B') {
        netQty += qty;
        buyQueue.push({ qty, eurPerShare, nativePrice, fx: impliedFX });
        // If we didn't know the currency, infer from FX rate deviation
        if (!productCurrency && Math.abs(impliedFX - 1) > 0.05) isNonEUR = true;
      } else {
        netQty -= qty;
        const sellFX = impliedFX;
        let remaining = qty;
        while (remaining > 0.0001 && buyQueue.length > 0) {
          const lot = buyQueue[0];
          const matched = Math.min(lot.qty, remaining);
          totalBuyCostEUR += matched * lot.eurPerShare;
          totalSoldQty += matched;

          // FX impact on this matched lot:
          // matchedQty × buyNativePrice × (sellFX − buyFX)
          if (isNonEUR && lot.nativePrice > 0) {
            realizedFxPL += matched * lot.nativePrice * (sellFX - lot.fx);
          }

          lot.qty -= matched;
          remaining -= matched;
          if (lot.qty < 0.0001) buyQueue.shift();
        }
        totalSellProcEUR += Math.abs(tx.totalInBaseCurrency);
      }
    });

    // Include both fully closed (netQty ≈ 0) AND partially closed (has sells but still holds some)
    if (totalSoldQty > 0) {
      const isPartial = netQty > 0.5;
      const realizedPL = totalSellProcEUR - totalBuyCostEUR;
      const plPct = totalBuyCostEUR > 0 ? (realizedPL / totalBuyCostEUR) * 100 : 0;
      closed.push({
        id,
        name: names?.[id] || 'ID ' + id,
        currency: productCurrency || 'EUR',
        totalSold: totalSoldQty,
        avgBuyPrice: totalSoldQty > 0 ? totalBuyCostEUR / totalSoldQty : 0,
        avgSellPrice: totalSoldQty > 0 ? totalSellProcEUR / totalSoldQty : 0,
        realizedPL,
        plPct,
        isPartial,
        realizedFxPL: isNonEUR ? Math.round(realizedFxPL * 100) / 100 : 0,
      });
    }
  });

  return closed.sort((a, b) => Math.abs(b.realizedPL) - Math.abs(a.realizedPL));
}

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

  // ── 3. Total realized gains ──────────────────────────────────────
  const totalRealized = positions.reduce((s, p) => s + (p.plBase - (p.plUnrealized ?? p.plBase)), 0);

  const makeStat = (label, value, sub, colorClass, tooltip) => {
    const stat = document.createElement('div');
    stat.className = 'more-info-stat' + (tooltip ? ' more-info-stat--tip' : '');
    if (tooltip) stat.dataset.tip = tooltip;
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

  // Dividends stat
  grid.appendChild(makeStat(
    'Dividends received (all-time)',
    (totalDividends >= 0 ? '+' : '') + fmtEur(totalDividends),
    dividends.length > 0 ? `${dividends.length} payments · gross before tax` : 'No dividend history found',
    totalDividends > 0 ? 'positive' : ''
  ));

  // Currency effect stat — combines unrealized (open positions) + realized (sold lots)
  const fxTooltip = 'Impact of exchange rate movements separate from product performance. Includes both open and closed positions.';
  const fxClass = totalFxPL >= 0 ? 'positive' : 'negative';
  const fxParts = [];
  if (fxPositions > 0) fxParts.push(`${(unrealizedFxPL >= 0 ? '+' : '') + fmtEur(unrealizedFxPL)} unrealized`);
  if (closedFxCount > 0) fxParts.push(`${(realizedFxPL >= 0 ? '+' : '') + fmtEur(realizedFxPL)} realized`);
  const fxSub = fxParts.length > 0
    ? fxParts.join(' · ')
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
    'Realized gains (closed positions)',
    (totalRealized >= 0 ? '+' : '') + fmtEur(totalRealized),
    'From fully or partially sold positions',
    totalRealized >= 0 ? 'positive' : 'negative'
  ));

  // ── 4. Total fees paid — sourced from raw transaction fields already fetched ──
  // totalFeesInBaseCurrency = trading commissions per trade
  // autoFxFeeInBaseCurrency = FX conversion fee per trade
  const rawTx = globalData.data?.transactions?.data || [];
  let totalFees = 0;
  let txFees = 0, fxFees = 0;
  for (const t of rawTx) {
    txFees += Math.abs(parseFloat(t.totalFeesInBaseCurrency) || 0);
    fxFees += Math.abs(parseFloat(t.autoFxFeeInBaseCurrency) || 0);
  }
  totalFees = txFees + fxFees;

  const feeBreakdownParts = [];
  if (txFees > 0) feeBreakdownParts.push(`${fmtEur(txFees)} trading commissions`);
  if (fxFees > 0) feeBreakdownParts.push(`${fmtEur(fxFees)} FX fees`);
  const feeSub = feeBreakdownParts.length > 0 ? feeBreakdownParts.join(' · ') : 'All-time · across all trades';

  grid.appendChild(makeStat(
    'Total fees paid (all-time)',
    totalFees > 0 ? '-' + fmtEur(totalFees) : fmtEur(0),
    feeSub,
    totalFees > 0 ? 'negative' : '',
    'Sum of all trading commissions (feeInBaseCurrency) and FX conversion fees (autoFxFeeInBaseCurrency) across all your trades since account opening.'
  ));

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

function wireCorrelationToggle() {
  const btn = document.getElementById('btnCorrelation');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';

  // ── Title hover tooltip (always available, even before matrix is opened) ──
  const infoIcon = document.getElementById('corrInfoIcon');
  if (infoIcon) {
    // Ensure the shared tooltip element exists
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
      // Position below-right of icon, clamped to viewport
      const rect = infoIcon.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      let x = rect.left;
      let y = rect.bottom + 6;
      // Force a layout pass so offsetWidth is accurate
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
      infoTip.className = 'corr-tooltip'; // reset class
    });
  }

  btn.addEventListener('click', async () => {
    const content = document.getElementById('correlationContent');
    const isOpen  = content.style.display !== 'none';
    if (isOpen) {
      content.style.display = 'none';
      btn.textContent = '⊕ Show matrix';
      btn.classList.remove('open');
    } else {
      content.style.display = 'block';
      btn.textContent = '⊖ Hide matrix';
      btn.classList.add('open');
      // Render lazily — only when first opened
      if (!document.getElementById('correlationHeatmap').dataset.rendered) {
        document.getElementById('correlationHeatmap').dataset.rendered = '1';
        await renderCorrelationMatrix(
          globalData.positions,
          globalData.vwdIds,
          globalData.names
        );
      }
    }
  });
}
