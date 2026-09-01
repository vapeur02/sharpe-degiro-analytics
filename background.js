chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only accept messages from our own extension (content scripts + extension pages)
  if (sender.id !== chrome.runtime.id) return;

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
  if (message.type === 'OPEN_DASHBOARD') {
    const dashUrl = chrome.runtime.getURL('dashboard.html');
    // Focus existing dashboard tab if already open, otherwise create one
    chrome.tabs.query({ url: dashUrl }).then(tabs => {
      if (tabs.length > 0) {
        chrome.tabs.update(tabs[0].id, { active: true });
        chrome.windows.update(tabs[0].windowId, { focused: true });
      } else {
        chrome.tabs.create({ url: dashUrl });
      }
    });
    return false; // no async response needed
  }
});

// On service worker startup, evict any cache entries older than 7 days
// This prevents indefinite growth of stale price history data
chrome.runtime.onInstalled.addListener(() => evictStaleCacheEntries(7 * 24 * 3600e3));
self.addEventListener('activate', () => evictStaleCacheEntries(7 * 24 * 3600e3));

// Financial portfolio data keys that contain sensitive user information.
// These are cleared automatically when the data is older than PORTFOLIO_MAX_AGE_MS,
// ensuring that stale account data does not persist indefinitely on the device.
const PORTFOLIO_DATA_KEYS = [
  'portfolio', 'dividends', 'transactions', 'account',
  'intAccount', 'productInfo', 'currentUrl',
  'scrapedDailyPnL', 'scrapedDailyPnLPerPosition', 'scrapedTotalPnL', 'scrapedPortfolioValue',
  'favouriteLists', 'favouriteProductIds', 'favouriteProductInfo',
  'todayPLSnapshots', 'todayPLSnapshotsDate',
];
const PORTFOLIO_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

async function evictStaleCacheEntries(maxAgeMs) {
  try {
    const all = await chrome.storage.local.get(null);
    const keysToRemove = [];
    const now = Date.now();

    // ── Price history cache eviction ────────────────────────────────────
    for (const [key, val] of Object.entries(all)) {
      if (!key.startsWith('priceCache_')) continue;
      // Remove legacy cache entries (v1/v2/v3) unconditionally
      if (!key.startsWith('priceCache_v4_')) { keysToRemove.push(key); continue; }
      if (val?.ts && (now - val.ts) > maxAgeMs) {
        keysToRemove.push(key);
      }
    }

    // ── Sensitive financial data eviction ───────────────────────────────
    // If lastFetch exists and the portfolio data is older than 24 hours,
    // clear it so sensitive account data doesn't persist indefinitely.
    // The data is re-fetched fresh on the next Refresh, so nothing is lost.
    const lastFetch = all.lastFetch || 0;
    if (lastFetch && (now - lastFetch) > PORTFOLIO_MAX_AGE_MS) {
      for (const key of PORTFOLIO_DATA_KEYS) {
        if (key in all) keysToRemove.push(key);
      }
      // Also clear hasData so the UI prompts a fresh fetch rather than
      // rendering a dashboard from stale/missing data.
      if ('hasData' in all) keysToRemove.push('hasData');
      if ('lastFetch' in all) keysToRemove.push('lastFetch');
      console.log('[BG] Evicting stale portfolio data (age:', Math.round((now - lastFetch) / 3600e3), 'h)');
    }

    if (keysToRemove.length) {
      await chrome.storage.local.remove(keysToRemove);
      console.log('[BG] Evicted stale keys:', keysToRemove);
    }
  } catch(e) { console.error('[BG] Cache eviction failed:', e); }
}


async function fetchPriceHistoryCached(vwdIds, period) {
  // Include today's date in the cache key — this ensures the cache is automatically
  // invalidated each new calendar day, so data is never more than 1 day stale.
  // Within the same day, cache for up to 4h (long periods) or 1h (short periods).
  // Use local date (not UTC) to avoid cache invalidating at midnight UTC instead of local midnight.
  const today = (() => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); })();
  // Include a fingerprint of the requested product IDs so different sets (portfolio vs watchlist) get separate caches
  const idKeys = Object.keys(vwdIds || {}).sort();
  // Use a simple hash of all IDs to avoid cache collisions between different product sets
  const idsFp = idKeys.length + '_' + idKeys.reduce((h, id) => ((h << 5) - h + id.split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0)) | 0, 0).toString(36);
  const cacheKey = 'priceCache_v4_' + period + '_' + today + '_' + idsFp;
  const maxAge = period === '1Y' || period === '5Y' ? 4 * 3600e3 : 3600e3; // 4h for long periods, 1h for short
  let existingEntry = null;
  try {
    const cached = await chrome.storage.local.get([cacheKey]);
    existingEntry = cached[cacheKey] || null;
    if (existingEntry && Date.now() - existingEntry.ts < maxAge) {
      // Check completeness: if any requested IDs are missing from cache, force refresh.
      // Benchmarks are appended to every response by fetchPriceHistory (they are never
      // part of the request), so they must be checked explicitly — otherwise one
      // transient benchmark fetch failure gets latched into the cache for hours and
      // every chart silently loses its S&P 500 comparison.
      const cachedIds = new Set(Object.keys(existingEntry.data || {}));
      const missingIds = idKeys.filter(id => !cachedIds.has(id));
      const missingBench = ['__SP500__', '__EUROSTOXX__', '__NASDAQ__']
        .filter(k => !(existingEntry.data?.[k]?.length));
      const missing = [...missingIds, ...missingBench];
      if (missing.length === 0) {
        console.log('[BG] Using cached price history for', period);
        return existingEntry.data;
      }
      console.log('[BG] Cache hit but missing', missing.length, 'IDs — refetching:', missing.slice(0, 5));
    }
  } catch(e) { console.error('[BG] Cache read failed:', e); }
  console.log('[BG] Fetching fresh price history for', period);
  const freshData = await fetchPriceHistory(vwdIds, period);

  // Merge with existing cache: if some fetches failed (rate limit / timeout),
  // keep previously successful data for those IDs instead of losing them.
  let merged = freshData;
  const prevData = existingEntry?.data;
  if (prevData && typeof prevData === 'object') {
    merged = { ...prevData, ...freshData };
    const kept = Object.keys(prevData).filter(k => !freshData[k] && prevData[k]);
    if (kept.length) console.log('[BG] Kept', kept.length, 'cached entries for IDs that failed to refresh:', kept);
  }

  try {
    await chrome.storage.local.set({ [cacheKey]: { ts: Date.now(), data: merged } });
  } catch(e) { console.error('[BG] Cache write failed (storage quota?):', e); }
  return merged;
}

async function fetchPriceHistory(vwdIds, period) {
  const periodMap = { '1W': '1M', '1M': '1M', '6M': '6M', '1Y': '1Y', '2Y': '2Y', '3Y': '3Y', '5Y': '5Y' };
  const vwdPeriod = periodMap[period] || period;
  const priceHistories = {};

  // Build task list: all positions + benchmarks
  const BENCHMARKS = [
    { key: '__SP500__',      vwdId: '480012040', label: 'S&P 500' },
    { key: '__EUROSTOXX__',  vwdId: '360015511', label: 'Euro Stoxx 50' },
    { key: '__NASDAQ__',     vwdId: '480012041', label: 'Nasdaq 100' },
  ];
  const entries = Object.entries(vwdIds);
  const benchmarkTasks = BENCHMARKS.map(bm => async () => {
    try {
      const res = await fetch(
        `https://charting.vwdservices.com/hchart/v1/deGiro/data.js?requestid=2&period=${vwdPeriod}&series=price:issueid:${bm.vwdId}&userToken=1&resolution=1d`
      );
      console.log(`[BG] ${bm.label} status:`, res.status);
      if (res.ok) {
        const text = await res.text();
        const json = JSON.parse(text);
        priceHistories[bm.key] = parseVwdSeries(json);
        console.log(`[BG] ${bm.label} points:`, priceHistories[bm.key].length);
      }
    } catch(e) { console.warn(`[BG] ${bm.label} fetch failed:`, e.message); }
  });

  // Rate-limited fetch: process in batches of 4 with 150ms between batches
  const BATCH_SIZE = 4;
  const BATCH_DELAY_MS = 150;
  let completed = 0;
  const total = entries.length + BENCHMARKS.length;

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

  // Retry pass: any positions that failed on the first attempt get a second chance
  // (rate limits / transient timeouts are the most common cause of missing data)
  const failedEntries = entries.filter(([id]) => !priceHistories[id]);
  if (failedEntries.length > 0) {
    console.log('[BG] Retrying', failedEntries.length, 'failed positions:', failedEntries.map(([id]) => id));
    await new Promise(r => setTimeout(r, 500)); // longer pause before retry
    for (let i = 0; i < failedEntries.length; i += BATCH_SIZE) {
      const batch = failedEntries.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(fetchOne));
      if (i + BATCH_SIZE < failedEntries.length) await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
    const stillFailed = failedEntries.filter(([id]) => !priceHistories[id]);
    if (stillFailed.length) console.warn('[BG] Still failed after retry:', stillFailed.map(([id]) => id));
  }

  // Fetch benchmarks after positions
  await Promise.all(benchmarkTasks.map(async task => {
    await task();
    completed++;
    chrome.runtime.sendMessage({ type: 'FETCH_PROGRESS', completed, total }).catch(() => {});
  }));

  return priceHistories;
}

function parseVwdSeries(json) {
  try {
    const series = json.series || [];
    console.log('[BG] parseVwdSeries: series count:', series.length, 'types:', series.map(s=>s.type||'?'));
    const priceSeries = series.find(s => s.data);
    if (!priceSeries?.data) { console.log('[BG] no priceSeries found'); return []; }
    // VWD sends `start` as a CET/CEST date string or timestamp.
    // Parse it and use UTC noon to avoid any timezone-induced day shifts.
    // Adding offset days in UTC guarantees the calendar date stays correct
    // regardless of the user's local timezone.
    const raw = json.start;
    let startMs;
    if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
      // Date string like "2021-03-29" — parse as UTC noon
      const [y, m, d] = raw.split(/[-T]/);
      startMs = Date.UTC(+y, +m - 1, +d, 12, 0, 0);
    } else {
      // Timestamp (ms or s) — snap to UTC noon of that day
      const ts = typeof raw === 'number' ? (raw < 1e12 ? raw * 1000 : raw) : new Date(raw).getTime();
      const tmp = new Date(ts);
      startMs = Date.UTC(tmp.getUTCFullYear(), tmp.getUTCMonth(), tmp.getUTCDate(), 12, 0, 0);
    }
    return priceSeries.data.map(([offset, price]) => {
      const d = new Date(startMs + offset * 864e5);
      const yyyy = d.getUTCFullYear();
      const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd   = String(d.getUTCDate()).padStart(2, '0');
      return { date: `${yyyy}-${mm}-${dd}`, price };
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
    if (data.currentUrl) toStore.currentUrl = data.currentUrl;
    // NOTE: sessionId is intentionally NOT persisted — it's a sensitive auth token
    // that expires and is only needed transiently by the content script for API calls.
    if (data.portfolio) toStore.portfolio = data.portfolio;
    if (data.dividends) toStore.dividends = data.dividends;
    if (data.transactions) toStore.transactions = data.transactions;
    if (data.account) toStore.account = data.account;
    // Store only intAccount from client — the full client object contains PII
    // (name, email, phone, address) that doesn't need to persist in extension storage.
    if (data.intAccount) toStore.intAccount = data.intAccount;
    if (data.productInfo) toStore.productInfo = data.productInfo;

    // Scraped real-time values from DEGIRO's rendered DOM
    if (data.scrapedDailyPnL !== undefined) toStore.scrapedDailyPnL = data.scrapedDailyPnL;
    if (data.scrapedDailyPnLPerPosition !== undefined) toStore.scrapedDailyPnLPerPosition = data.scrapedDailyPnLPerPosition;
    if (data.scrapedTotalPnLPerPosition !== undefined) toStore.scrapedTotalPnLPerPosition = data.scrapedTotalPnLPerPosition;
    if (data.scrapedTotalPnL !== undefined) toStore.scrapedTotalPnL = data.scrapedTotalPnL;
    if (data.scrapedPortfolioValue !== undefined) toStore.scrapedPortfolioValue = data.scrapedPortfolioValue;

    // Favourites / watchlist
    if (data.favouriteLists) toStore.favouriteLists = data.favouriteLists;
    if (data.favouriteProductIds) toStore.favouriteProductIds = data.favouriteProductIds;
    if (data.favouriteProductInfo) toStore.favouriteProductInfo = data.favouriteProductInfo;

    await chrome.storage.local.set(toStore);
    return { ok: true };
  } catch(e) {
    return { error: `Could not connect to DEGIRO tab: ${e.message}` };
  }
}
