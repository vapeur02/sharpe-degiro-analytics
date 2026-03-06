chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_ALL') {
    fetchViaContentScript().then(sendResponse);
    return true;
  }
  if (message.type === 'GET_STORED') {
    chrome.storage.local.get(null).then(sendResponse);
    return true;
  }
  if (message.type === 'FETCH_PRICE_HISTORY') {
    fetchPriceHistoryCached(message.vwdIds, message.period).then(sendResponse);
    return true;
  }
  if (message.type === 'CLEAR_CACHE') {
    evictStaleCacheEntries(0).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// On service worker startup, evict any cache entries older than 7 days
// This prevents indefinite growth of stale price history data
chrome.runtime.onInstalled.addListener(() => evictStaleCacheEntries(7 * 24 * 3600e3));
self.addEventListener('activate', () => evictStaleCacheEntries(7 * 24 * 3600e3));

async function evictStaleCacheEntries(maxAgeMs) {
  try {
    const all = await chrome.storage.local.get(null);
    const keysToRemove = [];
    const now = Date.now();
    for (const [key, val] of Object.entries(all)) {
      if (key.startsWith('priceCache_') && val?.ts && (now - val.ts) > maxAgeMs) {
        keysToRemove.push(key);
      }
    }
    if (keysToRemove.length) {
      await chrome.storage.local.remove(keysToRemove);
      console.log('[BG] Evicted stale cache keys:', keysToRemove);
    }
  } catch(e) { console.error('[BG] Cache eviction failed:', e); }
}


async function fetchPriceHistoryCached(vwdIds, period) {
  // Include today's date in the cache key — this ensures the cache is automatically
  // invalidated each new calendar day, so data is never more than 1 day stale.
  // Within the same day, cache for up to 4h (long periods) or 1h (short periods).
  // Use local date (not UTC) to avoid cache invalidating at midnight UTC instead of local midnight.
  const today = (() => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); })();
  const cacheKey = 'priceCache_' + period + '_' + today;
  const maxAge = period === '1Y' || period === '5Y' ? 4 * 3600e3 : 3600e3; // 4h for long periods, 1h for short
  try {
    const cached = await chrome.storage.local.get([cacheKey]);
    const entry = cached[cacheKey];
    if (entry && Date.now() - entry.ts < maxAge) {
      console.log('[BG] Using cached price history for', period);
      return entry.data;
    }
  } catch(e) { console.error('[BG] Cache read failed:', e); }
  console.log('[BG] Fetching fresh price history for', period);
  const data = await fetchPriceHistory(vwdIds, period);
  try {
    await chrome.storage.local.set({ [cacheKey]: { ts: Date.now(), data } });
  } catch(e) { console.error('[BG] Cache write failed (storage quota?):', e); }
  return data;
}

async function fetchPriceHistory(vwdIds, period) {
  const periodMap = { '1W': 'P1M', '1M': 'P1M', '6M': 'P6M', '1Y': '1Y', '2Y': '2Y', '3Y': '3Y', '5Y': '5Y' };
  const vwdPeriod = periodMap[period] || period;
  const priceHistories = {};

  // Build task list: all positions + S&P 500
  const entries = Object.entries(vwdIds);
  const sp500Task = async () => {
    try {
      const res = await fetch(
        `https://charting.vwdservices.com/hchart/v1/deGiro/data.js?requestid=2&period=${vwdPeriod}&series=price:issueid:480012040&userToken=1&resolution=1d`
      );
      console.log('[BG] SP500 status:', res.status);
      if (res.ok) {
        const text = await res.text();
        const json = JSON.parse(text);
        priceHistories['__SP500__'] = parseVwdSeries(json);
        console.log('[BG] SP500 points:', priceHistories['__SP500__'].length);
      }
    } catch(e) { console.warn('[BG] SP500 fetch failed:', e.message); }
  };

  // Rate-limited fetch: process in batches of 4 with 150ms between batches
  const BATCH_SIZE = 4;
  const BATCH_DELAY_MS = 150;
  let completed = 0;
  const total = entries.length + 1; // +1 for S&P

  const fetchOne = async ([id, { vwdId, type }]) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(
        `https://charting.vwdservices.com/hchart/v1/deGiro/data.js?requestid=1&period=${vwdPeriod}&series=price:${type}:${vwdId}&userToken=1&resolution=1d`,
        { signal: controller.signal }
      );
      clearTimeout(timeout);
      if (res.ok) priceHistories[id] = parseVwdSeries(await res.json());
    } catch(e) { console.warn('[BG] Price fetch failed for', id, e.message); }
    completed++;
    chrome.runtime.sendMessage({ type: 'FETCH_PROGRESS', completed, total }).catch(() => {});
  };

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(fetchOne));
    if (i + BATCH_SIZE < entries.length) await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
  }

  // Fetch S&P 500 after positions
  await sp500Task();
  completed++;
  chrome.runtime.sendMessage({ type: 'FETCH_PROGRESS', completed, total }).catch(() => {});

  return priceHistories;
}

function parseVwdSeries(json) {
  try {
    const series = json.series || [];
    console.log('[BG] parseVwdSeries: series count:', series.length, 'types:', series.map(s=>s.type||'?'));
    const priceSeries = series.find(s => s.data);
    if (!priceSeries?.data) { console.log('[BG] no priceSeries found'); return []; }
    const startDate = new Date(json.start);
    return priceSeries.data.map(([offset, price]) => {
      const d = new Date(startDate);
      d.setDate(d.getDate() + offset);
      return { date: d.toISOString().slice(0,10), price };
    }).filter(d => d.price != null);
  } catch(e) { return []; }
}

async function fetchViaContentScript() {
  // Derive DEGIRO tab patterns from manifest host_permissions — single source of truth
  const allPatterns = chrome.runtime.getManifest().host_permissions
    .filter(p => p.includes('degiro'));

  const allTabs = (await Promise.all(
    allPatterns.map(url => chrome.tabs.query({ url }).catch(() => []))
  )).flat();
  if (allTabs.length === 0) return { error: 'Please open your broker in a tab and log in first.' };

  try {
    const result = await chrome.tabs.sendMessage(allTabs[0].id, { type: 'FETCH_ALL_FROM_PAGE' });
    if (!result?.ok) return { error: result?.error || 'Fetch failed' };

    const data = result.data;
    const toStore = { hasData: true, lastFetch: Date.now() };
    if (data.intAccount) toStore.intAccount = String(data.intAccount);
    if (data.sessionId) toStore.sessionId = data.sessionId;
    if (data.portfolio) toStore.portfolio = data.portfolio;
    if (data.dividends) toStore.dividends = data.dividends;
    if (data.transactions) toStore.transactions = data.transactions;
    if (data.account) toStore.account = data.account;
    if (data.client) toStore.client = data.client;
    if (data.productInfo) toStore.productInfo = data.productInfo;

    // Scraped real-time values from DEGIRO's rendered DOM
    if (data.scrapedDailyPnL !== undefined) toStore.scrapedDailyPnL = data.scrapedDailyPnL;
    if (data.scrapedTotalPnL !== undefined) toStore.scrapedTotalPnL = data.scrapedTotalPnL;
    if (data.scrapedPortfolioValue !== undefined) toStore.scrapedPortfolioValue = data.scrapedPortfolioValue;

    await chrome.storage.local.set(toStore);
    return { ok: true };
  } catch(e) {
    return { error: `Could not connect to DEGIRO tab: ${e.message}` };
  }
}
