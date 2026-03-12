// popup.js — Sharpe extension popup
// Shared utilities (COLORS, fmtEur, fmtPrice, extractPositions, etc.) are in utils.js.

let charts = {};
let popupState = {
  portfolioSeries: [],   // full TWR series [{date,value,twr}]
  activePeriod: '1Y',
};

document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();

  document.getElementById('btnRefresh').addEventListener('click', async () => {
    const btn = document.getElementById('btnRefresh');
    btn.classList.add('spinning');
    setStatus('loading');
    showScreen('loading');
    await chrome.runtime.sendMessage({ type: 'FETCH_ALL' });
    const data = await chrome.runtime.sendMessage({ type: 'GET_STORED' });
    renderDashboard(data);
    btn.classList.remove('spinning');
  });

  document.getElementById('btnFullPage').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  });

  // P&L card → open dashboard on EUR mode
  document.getElementById('cardTotalPL')?.addEventListener('click', () => {
    chrome.storage.local.set({ popupOpenMode: 'eur' }, () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    });
  });

  // TWR card → open dashboard on TWR (pct) mode
  document.getElementById('cardTWR')?.addEventListener('click', () => {
    chrome.storage.local.set({ popupOpenMode: 'pct' }, () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    });
  });

  // Ko-fi donate button
  const btnDonate = document.getElementById('btnDonate');
  if (btnDonate) {
    btnDonate.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.windows.create({
        url: 'https://ko-fi.com/sharpe_dev/?hidefeed=true&widget=true&embed=true',
        type: 'popup', width: 400, height: 620, focused: true
      });
    });
  }

  // Period toggle for TWR chart
  document.getElementById('periodToggle')?.addEventListener('click', e => {
    const btn = e.target.closest('.period-btn');
    if (!btn) return;
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    popupState.activePeriod = btn.dataset.period;
    drawTwrChart(popupState.activePeriod);
  });

  // Positions open/closed toggle
  document.getElementById('posTabToggle')?.addEventListener('click', e => {
    const btn = e.target.closest('.toggle-btn');
    if (!btn) return;
    document.querySelectorAll('#posTabToggle .toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const isOpen = btn.dataset.postab === 'open';
    document.getElementById('positionsListOpen').style.display  = isOpen ? '' : 'none';
    document.getElementById('positionsListClosed').style.display = isOpen ? 'none' : '';
  });

  await loadData();
});

function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
  });
}

async function loadData() {
  showScreen('loading');
  setStatus('loading');
  const data = await chrome.runtime.sendMessage({ type: 'GET_STORED' });
  if (!data.hasData) {
    setLoadingText('Loading your portfolio...');
    const result = await chrome.runtime.sendMessage({ type: 'FETCH_ALL' });
    if (result && result.error) { showError(result.error); return; }
    const fresh = await chrome.runtime.sendMessage({ type: 'GET_STORED' });
    renderDashboard(fresh);
  } else {
    renderDashboard(data);
  }
  checkPortfolioTab();
}

// Show a warning banner if DEGIRO is open but not on the portfolio page.
async function checkPortfolioTab() {
  const banner = document.getElementById('portfolioWarning');
  if (!banner) return;
  try {
    const stored = await chrome.storage.local.get('currentUrl');
    const url = stored.currentUrl || '';
    const onDegiro = url.includes('degiro');
    const onPortfolio = url.includes('#/portfolio');
    banner.style.display = (onDegiro && !onPortfolio) ? 'block' : 'none';
  } catch(e) {
    banner.style.display = 'none';
  }
}

function renderDashboard(data) {
  const { meta } = extractProductMeta(data.productInfo);
  const transactions = extractTransactions(data.transactions);
  const positions    = extractPositions(data.portfolio, meta, transactions);
  const dividends    = extractDividends(data.dividends);

  showScreen('dashboard');
  setStatus('connected');

  renderSummary(positions, dividends, data);
  renderOpenPositions(positions);
  renderClosedPositions(transactions, meta);
  renderInsights(positions, dividends, transactions);

  if (positions.length > 0) {
    renderAllocationChart(positions, 'holdings');
    renderTwrSeries(positions, data.transactions);
  }

  // Wire allocation toggle
  const toggle = document.getElementById('allocToggle');
  if (toggle) {
    toggle.addEventListener('click', e => {
      const btn = e.target.closest('.toggle-btn');
      if (!btn) return;
      toggle.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderAllocationChart(positions, btn.dataset.alloc);
    });
  }

  if (data.lastFetch) {
    const t = new Date(data.lastFetch).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    document.querySelector('.last-updated')?.remove();
    const lastUpdated = document.createElement('div');
    lastUpdated.className = 'last-updated';
    lastUpdated.textContent = 'Updated ' + t + ' · ' + (data.intAccount || '');
    document.getElementById('dashboard').appendChild(lastUpdated);
  }
}

// ── Summary ─────────────────────────────────────────────────────────

function renderSummary(positions, dividends, data) {
  const apiTotal  = positions.reduce((s, p) => s + p.value, 0);
  const apiTotalPL = positions.reduce((s, p) => s + p.plBase, 0);
  // Use real-time scraped values from DEGIRO's DOM when available
  const totalPL   = typeof data?.scrapedTotalPnL === 'number' ? data.scrapedTotalPnL : apiTotalPL;
  // Portfolio value: prefer DEGIRO's own total (includes cash), fall back to API sum + P&L adjustment
  const total     = typeof data?.scrapedPortfolioValue === 'number' ? data.scrapedPortfolioValue : (apiTotal + (totalPL - apiTotalPL));
  const costBasis = total - totalPL;
  const plPct     = costBasis > 0 ? (totalPL / costBasis) * 100 : 0;

  document.getElementById('totalValue').textContent = fmtEur(total);

  const plEl = document.getElementById('totalPL');
  plEl.textContent = (totalPL >= 0 ? '+' : '') + fmtEur(totalPL);
  plEl.className = 'summary-value ' + (totalPL >= 0 ? 'positive' : 'negative');

  const pctEl = document.getElementById('totalPLPct');
  pctEl.textContent = (plPct >= 0 ? '+' : '') + plPct.toFixed(1) + '%';
  pctEl.className = 'summary-value ' + (plPct >= 0 ? 'positive' : 'negative');
}

// ── TWR Chart ────────────────────────────────────────────────────────

async function renderTwrSeries(positions, rawTransactions) {
  const cached = await new Promise(r =>
    chrome.storage.local.get(['priceCache_5Y', 'priceCache_1Y', 'productInfo'], r)
  );
  let histories = cached.priceCache_5Y?.data || cached.priceCache_1Y?.data || null;

  if (!histories) {
    const vwdIds = {};
    Object.entries(cached.productInfo?.data || {}).forEach(([id, p]) => {
      if (p.vwdId) vwdIds[id] = { vwdId: p.vwdId, type: p.vwdIdentifierType || 'issueid' };
    });
    try {
      histories = await chrome.runtime.sendMessage({ type: 'FETCH_PRICE_HISTORY', vwdIds, period: '5Y' });
    } catch(e) { return; }
  }

  const transactions = extractTransactions(rawTransactions);
  const firstTxDate  = transactions[0]?.date || '2021-01-01';

  // Binary search price lookup with fill-forward
  const lastKnown = {};
  const getPrice = (id, date) => {
    const h = histories[id];
    if (!h?.length) return null;
    let lo = 0, hi = h.length - 1, res = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (h[mid].date <= date) { res = h[mid].price; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (res) lastKnown[id] = res;
    return res || lastKnown[id] || null;
  };

  // All unique dates since first tx
  const dateSet = new Set();
  Object.values(histories).forEach(h => {
    if (Array.isArray(h)) h.forEach(d => { if (d.date >= firstTxDate) dateSet.add(d.date); });
  });
  const allDates = [...dateSet].sort();
  if (allDates.length < 2) return;

  // Build portfolio value series
  let currentHoldings = {};
  let txIdx = 0;
  const rawSeries = [];

  allDates.forEach(date => {
    let hasTx = false;
    while (txIdx < transactions.length && transactions[txIdx].date <= date) {
      const tx = transactions[txIdx];
      const id = tx.productId;
      if (!currentHoldings[id]) currentHoldings[id] = 0;
      currentHoldings[id] += tx.buysell === 'B' ? Math.abs(tx.quantity) : -Math.abs(tx.quantity);
      if (currentHoldings[id] < 0.001) delete currentHoldings[id];
      hasTx = true;
      txIdx++;
    }
    let total = 0, anyPriced = false;
    Object.entries(currentHoldings).filter(([, s]) => s > 0).forEach(([id, shares]) => {
      const price = getPrice(id, date);
      if (price) { total += price * shares; anyPriced = true; }
    });
    if (anyPriced && total > 0) rawSeries.push({ date, value: total, hasTx });
  });

  if (rawSeries.length < 2) return;

  // Compute TWR (same algo as dashboard)
  let cumFactor = 1;
  let spStart   = rawSeries[0].value;
  const twrSeries = rawSeries.map((pt, i) => {
    if (pt.hasTx && i > 0) {
      const equityBefore = rawSeries[i - 1].value;
      if (spStart > 0 && equityBefore > 0) cumFactor *= equityBefore / spStart;
      spStart = pt.value;
    }
    const twr = spStart > 0 ? (cumFactor * (pt.value / spStart) - 1) * 100 : 0;
    return { date: pt.date, value: pt.value, twr };
  });

  // Update All-time TWR summary card
  const allTimeTwr = twrSeries[twrSeries.length - 1]?.twr ?? 0;
  const pctEl = document.getElementById('totalPLPct');
  if (pctEl) {
    pctEl.textContent = (allTimeTwr >= 0 ? '+' : '') + allTimeTwr.toFixed(1) + '%';
    pctEl.className = 'summary-value ' + (allTimeTwr >= 0 ? 'positive' : 'negative');
  }

  popupState.portfolioSeries = twrSeries;

  // Compute and display Sharpe ratio in insights
  renderSharpeInsight(twrSeries);

  drawTwrChart(popupState.activePeriod);
}

function drawTwrChart(period) {
  const canvas = document.getElementById('perfChartPopup');
  if (!canvas) return;
  const twrSeries = popupState.portfolioSeries;
  if (!twrSeries.length) return;

  // Slice to the period window using date strings (same approach as dashboard)
  const now = new Date();
  let cutoff;
  if (period === '6M') {
    cutoff = new Date(now); cutoff.setMonth(cutoff.getMonth() - 6);
  } else if (period === '1Y') {
    cutoff = new Date(now); cutoff.setFullYear(cutoff.getFullYear() - 1);
  } else { // 3Y
    cutoff = new Date(now); cutoff.setFullYear(cutoff.getFullYear() - 3);
  }
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  // Use the absolute TWR values directly — same as dashboard, no re-basing
  let sliced = twrSeries.filter(d => d.date >= cutoffStr);
  if (sliced.length < 2) sliced = twrSeries.slice(-60);

  // Period gain — multiplicative chain (not additive subtraction)
  const twrStart = sliced[0].twr ?? 0;
  const twrEnd   = sliced[sliced.length - 1].twr ?? 0;
  const periodGain = ((1 + twrEnd / 100) / (1 + twrStart / 100) - 1) * 100;

  // Update badge with period gain
  const badge = document.getElementById('twrBadge');
  if (badge) {
    badge.textContent = (periodGain >= 0 ? '+' : '') + periodGain.toFixed(1) + '%';
    badge.className = 'twr-badge ' + (periodGain >= 0 ? 'positive' : 'negative');
  }

  const fmtDate = d => {
    const [y, m] = d.split('-');
    return new Date(+y, +m - 1).toLocaleString('default', { month: 'short', year: 'numeric' });
  };

  // Bar chart — same style as dashboard % mode
  // Each bar = absolute cumulative TWR at that date
  const barData = sliced.map(d => d.twr ?? 0);

  if (charts.perf) charts.perf.destroy();
  charts.perf = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: sliced.map(d => fmtDate(d.date)),
      datasets: [{
        data: barData,
        backgroundColor: barData.map(v => v >= 0 ? '#2ACA6933' : '#FF475733'),
        borderColor:     barData.map(v => v >= 0 ? '#2ACA6999' : '#FF475799'),
        borderWidth: 0,
        borderRadius: 0,
        barPercentage: 1.0,
        categoryPercentage: 1.0,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1E2C3A', borderColor: '#2A3A4A', borderWidth: 1,
          titleColor: '#F5F7FA', bodyColor: '#8B9BB4', padding: 10,
          callbacks: {
            title: ctx => {
              const raw = sliced[ctx[0].dataIndex]?.date;
              if (!raw) return ctx[0].label;
              const [y, m, dd] = raw.split('-');
              return new Date(+y, +m - 1, +dd).toLocaleDateString('default', { day: 'numeric', month: 'short', year: 'numeric' });
            },
            label: ctx => ' ' + (ctx.parsed.y >= 0 ? '+' : '') + ctx.parsed.y.toFixed(1) + '% TWR'
          }
        }
      },
      scales: {
        x: { grid: { color: '#1E2C3A' }, ticks: { color: '#8B9BB4', font: { size: 9 }, maxTicksLimit: 8 } },
        y: {
          grid: { color: '#1E2C3A88' },
          ticks: { color: '#8B9BB4', font: { size: 9 }, callback: v => (v >= 0 ? '+' : '') + v.toFixed(0) + '%' },
          beginAtZero: false
        }
      }
    }
  });
}

// ── Open Positions ───────────────────────────────────────────────────

function renderOpenPositions(positions) {
  const c = document.getElementById('positionsListOpen');
  c.textContent = '';

  if (!positions.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No open positions.';
    c.appendChild(empty);
    return;
  }

  [...positions].sort((a, b) => b.value - a.value).forEach((p, i) => {
    const color   = COLORS[i % COLORS.length];
    const plClass = p.plBase >= 0 ? 'pl-positive' : 'pl-negative';
    const arrow   = p.plBase >= 0 ? '▲' : '▼';

    const item = document.createElement('div');
    item.className = 'position-item';

    const dot = document.createElement('div');
    dot.className = 'position-dot';
    dot.style.background = color;

    const left = document.createElement('div');
    left.className = 'position-left';

    const nameEl = document.createElement('div');
    nameEl.className = 'position-name';
    nameEl.textContent = p.name || ('ID ' + p.id);

    const metaEl = document.createElement('div');
    metaEl.className = 'position-meta';
    const qty = document.createElement('span');
    qty.className = 'position-qty';
    qty.textContent = p.size + ' × ' + fmtPrice(p.price);
    metaEl.appendChild(qty);

    left.appendChild(nameEl);
    left.appendChild(metaEl);

    const right = document.createElement('div');
    right.className = 'position-right';

    const val = document.createElement('div');
    val.className = 'position-value';
    val.textContent = fmtEur(p.value);

    const pl = document.createElement('div');
    pl.className = plClass;
    pl.textContent = arrow + ' ' + Math.abs(p.plPct).toFixed(1) + '%';

    right.appendChild(val);
    right.appendChild(pl);

    item.appendChild(dot);
    item.appendChild(left);
    item.appendChild(right);
    c.appendChild(item);
  });
}

// ── Closed Positions (FIFO) ──────────────────────────────────────────

function renderClosedPositions(transactions, meta) {
  const names = {};
  Object.entries(meta).forEach(([id, m]) => { names[id] = m.name; });
  const closed = computeClosedPositions(transactions, names);

  const c = document.getElementById('positionsListClosed');
  c.textContent = '';

  if (!closed.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No closed or partially closed positions found.';
    c.appendChild(empty);
    return;
  }

  closed.forEach(p => {
    const plClass = p.realizedPL >= 0 ? 'pl-positive' : 'pl-negative';
    const arrow   = p.realizedPL >= 0 ? '▲' : '▼';

    const item = document.createElement('div');
    item.className = 'position-item';

    const dot = document.createElement('div');
    dot.className = 'position-dot';
    dot.style.background = p.realizedPL >= 0 ? '#2ACA69' : '#FF4757';

    const left = document.createElement('div');
    left.className = 'position-left';

    const nameEl = document.createElement('div');
    nameEl.className = 'position-name';
    nameEl.textContent = p.name;

    const metaEl = document.createElement('div');
    metaEl.className = 'position-meta';
    if (p.isPartial) {
      const badge = document.createElement('span');
      badge.textContent = 'PARTIAL';
      badge.style.cssText = 'font-size:9px;font-weight:700;letter-spacing:0.05em;color:#00A8E1;margin-right:5px';
      metaEl.appendChild(badge);
    }
    const qty = document.createElement('span');
    qty.className = 'position-qty';
    qty.textContent = Math.round(p.totalSold) + ' shares · ' + fmtPrice(p.avgBuyPrice) + ' → ' + fmtPrice(p.avgSellPrice);
    metaEl.appendChild(qty);

    left.appendChild(nameEl);
    left.appendChild(metaEl);

    const right = document.createElement('div');
    right.className = 'position-right';

    const val = document.createElement('div');
    val.className = 'position-value';
    val.textContent = (p.realizedPL >= 0 ? '+' : '') + fmtEur(p.realizedPL);

    const pl = document.createElement('div');
    pl.className = plClass;
    pl.textContent = arrow + ' ' + Math.abs(p.plPct).toFixed(1) + '%';

    right.appendChild(val);
    right.appendChild(pl);

    item.appendChild(dot);
    item.appendChild(left);
    item.appendChild(right);
    c.appendChild(item);
  });
}

// FIFO — same algorithm as dashboard.js
function computeClosedPositions(transactions, names) {
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
    let totalSoldQty = 0, totalBuyCostEUR = 0, totalSellProcEUR = 0, netQty = 0;

    sorted.forEach(tx => {
      const qty = Math.abs(tx.quantity);
      const eurPerShare = qty > 0 ? Math.abs(tx.totalInBaseCurrency) / qty : 0;
      if (tx.buysell === 'B') {
        netQty += qty;
        buyQueue.push({ qty, eurPerShare });
      } else {
        netQty -= qty;
        let remaining = qty;
        while (remaining > 0.0001 && buyQueue.length > 0) {
          const lot = buyQueue[0];
          const matched = Math.min(lot.qty, remaining);
          totalBuyCostEUR += matched * lot.eurPerShare;
          totalSoldQty    += matched;
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
        id, name: names?.[id] || 'ID ' + id,
        totalSold: totalSoldQty,
        avgBuyPrice:  totalSoldQty > 0 ? totalBuyCostEUR  / totalSoldQty : 0,
        avgSellPrice: totalSoldQty > 0 ? totalSellProcEUR / totalSoldQty : 0,
        realizedPL, plPct, isPartial
      });
    }
  });

  return closed.sort((a, b) => Math.abs(b.realizedPL) - Math.abs(a.realizedPL));
}

// ── More Insights ────────────────────────────────────────────────────

function renderInsights(positions, dividends, transactions) {
  const grid = document.getElementById('insightsGrid');
  if (!grid) return;
  grid.textContent = '';

  // 1. Dividends
  const totalDividends = dividends.reduce((s, d) => s + (d.amountEUR || 0), 0);

  // 2. FX P&L
  let totalFxPL = 0, fxPositions = 0;
  positions.forEach(p => {
    if (p.currency === 'EUR') return;
    totalFxPL += p.plFx || 0;
    fxPositions++;
  });

  // 3. Realized gains
  const totalRealized = positions.reduce((s, p) => s + (p.plBase - (p.plUnrealized ?? p.plBase)), 0);

  const makeCard = (label, value, sub, colorClass, tooltip) => {
    const card = document.createElement('div');
    card.className = 'insight-card' + (tooltip ? ' insight-card--tip' : '');
    if (tooltip) card.dataset.tip = tooltip;
    const lbl = document.createElement('div'); lbl.className = 'insight-label'; lbl.textContent = label;
    const val = document.createElement('div');
    val.className = 'insight-value sensitive' + (colorClass ? ' ' + colorClass : '');
    val.textContent = value;
    const subEl = document.createElement('div'); subEl.className = 'insight-sub'; subEl.textContent = sub;
    card.append(lbl, val, subEl);
    return card;
  };

  grid.appendChild(makeCard(
    'Dividends received',
    (totalDividends >= 0 ? '+' : '') + fmtEur(totalDividends),
    dividends.length > 0 ? dividends.length + ' payments · gross before tax' : 'No dividend history found',
    totalDividends > 0 ? 'positive' : ''
  ));

  grid.appendChild(makeCard(
    'Currency effect',
    (totalFxPL >= 0 ? '+' : '') + fmtEur(totalFxPL),
    fxPositions > 0
      ? 'Across ' + fxPositions + ' non-EUR position' + (fxPositions > 1 ? 's' : '') + ' · unrealized'
      : 'No non-EUR positions',
    totalFxPL >= 0 ? 'positive' : 'negative',
    'Impact of exchange rate movements separate from product performance.'
  ));

  grid.appendChild(makeCard(
    'Realized gains',
    (totalRealized >= 0 ? '+' : '') + fmtEur(totalRealized),
    'From partially or fully sold positions',
    totalRealized >= 0 ? 'positive' : 'negative'
  ));

  // Sharpe ratio placeholder — filled later once TWR series is ready
  const sharpeCard = makeCard('Sharpe ratio (all-time)', '—', 'Annualised vs 3% risk-free rate', '',
    'Sharpe ratio measures return per unit of risk. Above 1 is good, above 2 is great, above 3 is excellent. Below 0 means you earned less than the 3% risk-free rate. Calculated from daily TWR returns (cash-flow adjusted), annualised over all available history.');
  sharpeCard.id = 'insightSharpeCard';
  grid.appendChild(sharpeCard);
}

function renderSharpeInsight(twrSeries) {
  const card = document.getElementById('insightSharpeCard');
  if (!card) return;
  const valEl = card.querySelector('.insight-value');
  const subEl = card.querySelector('.insight-sub');

  if (!twrSeries || twrSeries.length < 30) {
    if (valEl) valEl.textContent = 'N/A';
    if (subEl) subEl.textContent = 'Not enough data (need 30+ days)';
    return;
  }

  const RF_DAILY = Math.pow(1.03, 1 / 252) - 1;

  // Use TWR-derived daily returns — strips out cash flow distortion from deposits/withdrawals.
  // Filter zero-return days caused by fill-forward stale prices (same logic as dashboard).
  const dailyReturns = [];
  for (let i = 1; i < twrSeries.length; i++) {
    const prev = 1 + twrSeries[i - 1].twr / 100;
    const curr = 1 + twrSeries[i].twr / 100;
    if (prev > 0) {
      const r = curr / prev - 1;
      if (r !== 0) dailyReturns.push(r);
    }
  }

  if (dailyReturns.length < 20) {
    if (valEl) valEl.textContent = 'N/A';
    if (subEl) subEl.textContent = 'Not enough data';
    return;
  }

  const n    = dailyReturns.length;
  const mean = dailyReturns.reduce((s, r) => s + r, 0) / n;
  const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const std  = Math.sqrt(variance);
  if (std === 0) { if (valEl) valEl.textContent = 'N/A'; return; }

  const sharpe = ((mean - RF_DAILY) / std) * Math.sqrt(252);
  const colorClass = sharpe >= 1 ? 'positive' : sharpe < 0 ? 'negative' : '';

  if (valEl) {
    valEl.textContent = sharpe.toFixed(2);
    valEl.className = 'insight-value sensitive' + (colorClass ? ' ' + colorClass : '');
  }
  if (subEl) subEl.textContent = n + ' trading days · 3% risk-free rate';
}

// ── Allocation Chart ─────────────────────────────────────────────────

function renderAllocationChart(positions, mode) {
  const canvas = document.getElementById('allocationChart');
  if (!canvas) return;

  const groups = {};
  positions.forEach(p => {
    let key;
    if      (mode === 'holdings') key = p.name || p.id;
    else if (mode === 'currency') key = p.currency;
    else if (mode === 'geo')      key = inferGeo(p);
    else if (mode === 'asset')    key = inferAssetClass(p);
    groups[key] = (groups[key] || 0) + p.value;
  });

  const sorted = Object.entries(groups).sort((a, b) => b[1] - a[1]);
  const total  = sorted.reduce((s, [, v]) => s + v, 0);

  let legendEl = document.getElementById('allocLegendScroll');
  if (!legendEl) {
    legendEl = document.createElement('div');
    legendEl.id = 'allocLegendScroll';
    legendEl.className = 'alloc-legend-scroll';
    canvas.parentElement.insertAdjacentElement('afterend', legendEl);
  }
  legendEl.textContent = '';
  sorted.forEach(([label, value], i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 0;font-size:11px;color:#8B9BB4';
    const dot = document.createElement('span');
    dot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${COLORS[i % COLORS.length]}`;
    const name = document.createElement('span');
    name.style.cssText = 'flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    name.textContent = label;
    const pct = document.createElement('span');
    pct.style.cssText = 'flex-shrink:0;font-size:10px;color:#8B9BB4';
    pct.textContent = ((value / total) * 100).toFixed(1) + '%';
    row.append(dot, name, pct);
    legendEl.appendChild(row);
  });

  if (charts.allocation) charts.allocation.destroy();
  charts.allocation = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: sorted.map(([k]) => k),
      datasets: [{ data: sorted.map(([, v]) => v), backgroundColor: COLORS, borderColor: '#0A111A', borderWidth: 2 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '62%',
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: '#1E2C3A', borderColor: '#2A3A4A', borderWidth: 1,
          callbacks: { label: ctx => ' ' + ctx.label + ': ' + ((ctx.parsed / total) * 100).toFixed(1) + '% · ' + fmtEur(ctx.parsed) } }
      }
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────

function showScreen(name) {
  document.getElementById('loadingScreen').style.display = name === 'loading'  ? 'flex'  : 'none';
  document.getElementById('noSession').style.display    = name === 'noSession' ? 'flex'  : 'none';
  document.getElementById('dashboard').style.display   = name === 'dashboard' ? 'block' : 'none';
}
function setStatus(s) {
  const d = document.getElementById('statusDot');
  d.className = 'status-dot' + (s === 'connected' ? ' connected' : s === 'loading' ? ' loading' : '');
}
function setLoadingText(t) { const el = document.querySelector('.loading-text'); if (el) el.textContent = t; }
function showError(msg) { document.querySelector('.no-session p').textContent = msg; showScreen('noSession'); setStatus(''); }
