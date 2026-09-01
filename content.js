(function() {
  'use strict';

  // ---------------------------------------------------------------------------
  // Shared number parser (European format, unicode minus)
  // ---------------------------------------------------------------------------
  function parseDegiroNumber(raw) {
    if (!raw) return null;
    // Normalise unicode minus sign (U+2212) to regular hyphen
    let s = raw.replace(/\u2212/g, '-').replace(/[^\d,.\-]/g, '');
    const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
    if (lc > ld) s = s.replace(/\./g, '').replace(',', '.');
    else         s = s.replace(/,/g, '');
    const v = parseFloat(s);
    return isNaN(v) ? null : v;
  }

  // ---------------------------------------------------------------------------
  // Proactive DOM watcher — caches dailyPnL as soon as DEGIRO renders it.
  // This runs immediately when the content script is injected, so by the time
  // the user clicks Refresh the value is almost always already cached.
  // ---------------------------------------------------------------------------
  let cachedDailyPnL = null;          // null = not yet seen (aggregate number)
  let cachedDailyPnLPerPosition = null; // null = not yet seen ({ productId: eurValue })
  let cachedTotalPnLPerPosition = null; // null = not yet seen ({ productId: eurValue })

  function readDailyPnLFromDOM() {
    // Filter: skip table headers (data-id must be a numeric product ID)
    // Do NOT filter by offsetParent — DEGIRO's table rows are inside a scrollable
    // container which sets offsetParent to null even for fully visible rows.
    const spans = document.querySelectorAll('[data-field="todayPl"]');
    if (!spans.length) return null;
    let sum = 0, found = 0;
    const perPosition = {};
    for (const el of spans) {
      const id = el.getAttribute('data-id');
      if (!id || !/^\d+$/.test(id)) continue;          // skip TH / non-position rows
      const raw = (el.getAttribute('title') || el.textContent || '').trim();
      const v = parseDegiroNumber(raw);
      if (v !== null) { sum += v; found++; perPosition[id] = Math.round(v * 100) / 100; }
    }
    if (!found) return null;
    console.log('[Sharpe] DOM dailyPnL: summed', found, 'positions =', sum);
    return { total: Math.round(sum * 100) / 100, perPosition };
  }

  function readTotalPnLFromDOM() {
    const spans = document.querySelectorAll('[data-field="totalPl"]');
    if (!spans.length) return null;
    const perPosition = {};
    let found = 0;
    for (const el of spans) {
      const id = el.getAttribute('data-id');
      if (!id || !/^\d+$/.test(id)) continue;
      const raw = (el.getAttribute('title') || el.textContent || '').trim();
      const v = parseDegiroNumber(raw);
      if (v !== null) { found++; perPosition[id] = Math.round(v * 100) / 100; }
    }
    if (!found) return null;
    console.log('[Sharpe] DOM totalPnL: read', found, 'positions');
    return perPosition;
  }

  function tryUpdateCache() {
    const result = readDailyPnLFromDOM();
    if (result !== null) {
      cachedDailyPnL = result.total;
      cachedDailyPnLPerPosition = result.perPosition;
      console.log('[Sharpe] dailyPnL cached by observer:', result.total, 'positions:', Object.keys(result.perPosition).length);
    }
    const totalResult = readTotalPnLFromDOM();
    if (totalResult !== null) {
      cachedTotalPnLPerPosition = totalResult;
      console.log('[Sharpe] totalPnL cached by observer: positions:', Object.keys(totalResult).length);
    }
  }

  // Debounced version — prevents firing dozens of times per second during
  // live price ticks on DEGIRO's SPA.
  let _debounceTimer = null;
  function tryUpdateCacheDebounced() {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(tryUpdateCache, 500);
  }

  // Kick off observer as soon as the body exists
  function startObserver() {
    // Read immediately (may already be rendered if user navigated within DEGIRO)
    tryUpdateCache();

    // Observe the full document — DEGIRO is a SPA and replaces DOM nodes on navigation,
    // so observing a specific table element risks detachment. The debounce (500ms) keeps
    // CPU cost low. attributeFilter limits triggers to title changes (price updates only).
    const mo = new MutationObserver(tryUpdateCacheDebounced);
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['title'],
      characterData: true
    });
    console.log('[Sharpe] MutationObserver started');
  }

  if (document.body) {
    startObserver();
  } else {
    document.addEventListener('DOMContentLoaded', startObserver);
  }

  // ---------------------------------------------------------------------------
  // Message listener — triggered by the extension popup/dashboard
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'FETCH_ALL_FROM_PAGE') {
      fetchAllFromPage()
        .then(data => sendResponse({ ok: true, data }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;
    }
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  async function get(url) {
    const res = await fetch(url, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }

  // ---------------------------------------------------------------------------
  // Main fetch — collects portfolio data + scraped dailyPnL
  // ---------------------------------------------------------------------------
  async function fetchAllFromPage() {
    const BASE = window.location.origin;
    const results = {};

    // Report current page so dashboard can warn if user isn't on portfolio tab
    results.currentUrl = window.location.href;

    const config = await get(`${BASE}/login/secure/config`);
    const sessionId = config?.data?.sessionId;
    if (!sessionId) throw new Error('Could not get sessionId from config');
    // sessionId is intentionally NOT added to results — it is a sensitive auth
    // token used only locally to build API URLs below. It must never travel
    // through the extension message bus or be stored anywhere.

    const client = await get(`${BASE}/pa/secure/client?sessionId=${sessionId}`);
    const intAccount = client?.data?.intAccount;
    if (!intAccount) throw new Error('Could not get intAccount');
    results.intAccount = intAccount;
    // client is intentionally NOT added to results — the full object contains PII
    // (name, email, phone, address). Only intAccount (a plain integer) is forwarded.

    const p = `?intAccount=${intAccount}&sessionId=${sessionId}`;

    try {
      results.portfolio = await get(
        `${BASE}/trading/secure/v5/update/${intAccount};jsessionid=${sessionId}${p}&portfolio=0&totalPortfolio=0`
      );
    } catch(e) { console.warn('[Sharpe] Portfolio:', e.message); }

    if (results.portfolio?.portfolio?.value) {
      const rows = results.portfolio.portfolio.value.filter(x => x.name === 'positionrow');
      const productIds = rows.map(r => r.id).filter(id => id && /^\d+$/.test(String(id)));

      if (productIds.length > 0) {
        try {
          const BATCH = 50;
          const batches = [];
          for (let i = 0; i < productIds.length; i += BATCH) {
            batches.push(productIds.slice(i, i + BATCH));
          }
          const responses = await Promise.all(batches.map(batch =>
            fetch(
              `${BASE}/product_search/secure/v5/products/info${p}&languageCode=en`,
              {
                method: 'POST',
                credentials: 'include',
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify(batch.map(String))
              }
            ).then(r => r.ok ? r.json() : null).catch(() => null)
          ));
          const merged = { data: {} };
          responses.forEach(r => { if (r?.data) Object.assign(merged.data, r.data); });
          results.productInfo = merged;
        } catch(e) { console.warn('[Sharpe] Product info:', e.message); }
      }
    }

    // Fetch dividends from account overview (portfolio-reports/v6)
    try {
      const today = new Date();
      const toDate = `${String(today.getDate()).padStart(2,'0')}/${String(today.getMonth()+1).padStart(2,'0')}/${today.getFullYear()}`;
      const aoData = await get(`${BASE}/portfolio-reports/secure/v6/accountoverview?fromDate=01/01/2010&toDate=${toDate}&intAccount=${intAccount}&sessionId=${sessionId}`);
      const movements = aoData?.data?.cashMovements || [];
      // Keep only positive dividend payments — description contains "divid" in any language
      // (EN: "Dividend", FR: "Dividende", NL: "Dividend", DE: "Dividende")
      // Exclude withholding-tax lines which have negative change
      const divEntries = movements.filter(m =>
        (m.description || '').toLowerCase().includes('divid') && parseFloat(m.change) > 0
      );
      console.log('[Sharpe] Dividend entries found:', divEntries.length);
      results.dividends = {
        data: divEntries.map(m => ({
          product:         String(m.productId || ''),
          amount:          parseFloat(m.change) || 0,
          amountInBaseCurr:parseFloat(m.change) || 0,
          currency:        m.currency || 'EUR',
          payDate:         m.date || m.valueDate || '',
        }))
      };
    } catch(e) { console.warn('[Sharpe] Dividends fetch failed:', e.message); }

    try {
      const today = new Date();
      const toDate = `${String(today.getDate()).padStart(2,'0')}/${String(today.getMonth()+1).padStart(2,'0')}/${today.getFullYear()}`;
      results.transactions = await get(`${BASE}/portfolio-reports/secure/v4/transactions${p}&fromDate=01/01/2010&toDate=${toDate}&groupTransactionsByOrder=false`);
    } catch(e) {}

    // Fetch DEGIRO favourites (watchlist)
    try {
      let favLists = null;
      // Try multiple known endpoint patterns
      favLists = await get(`${BASE}/favorites/secure/v1${p}`);
      console.log('[Sharpe] Favourites response:', JSON.stringify(favLists).slice(0, 500));

      const allFavIds = [];
      const seenIds = new Set();
      // Also exclude products already in the portfolio so watchlist only shows non-owned
      const portfolioIds = new Set(
        (results.portfolio?.portfolio?.value || [])
          .filter(x => x.name === 'positionrow')
          .map(r => String(r.id))
      );

      // Handle different response shapes
      const lists = Array.isArray(favLists) ? favLists : (favLists?.data || favLists?.value || []);
      for (const list of lists) {
        const pids = list.productIds || list.products || list.data || [];
        for (const pid of pids) {
          const s = String(typeof pid === 'object' ? (pid.id || pid.productId) : pid);
          if (s && s !== 'undefined' && !seenIds.has(s) && !portfolioIds.has(s)) {
            seenIds.add(s);
            allFavIds.push(s);
          }
        }
      }
      results.favouriteLists = favLists;
      results.favouriteProductIds = allFavIds;

      if (allFavIds.length > 0) {
        const BATCH = 50;
        const batches = [];
        for (let i = 0; i < allFavIds.length; i += BATCH) {
          batches.push(allFavIds.slice(i, i + BATCH));
        }
        const responses = await Promise.all(batches.map(batch =>
          fetch(
            `${BASE}/product_search/secure/v5/products/info${p}&languageCode=en`,
            {
              method: 'POST',
              credentials: 'include',
              headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
              body: JSON.stringify(batch.map(String))
            }
          ).then(r => r.ok ? r.json() : null).catch(() => null)
        ));
        const merged = { data: {} };
        responses.forEach(r => { if (r?.data) Object.assign(merged.data, r.data); });
        results.favouriteProductInfo = merged;
      }
      console.log('[Sharpe] Favourites found:', allFavIds.length, 'products');
    } catch(e) { console.warn('[Sharpe] Favourites fetch failed:', e.message); }

    // Step 7: Scrape real-time P&L values from DEGIRO's rendered DOM.
    // The REST API only returns yesterday's closing prices, so the only way
    // to get intraday figures is to read what DEGIRO's own UI has rendered.
    try {
      // --- Daily P&L (per-position + aggregate from todayPl spans) ---
      let scrapedDaily = cachedDailyPnL;
      let scrapedPerPos = cachedDailyPnLPerPosition;
      console.log('[Sharpe] cachedDailyPnL at fetch time:', scrapedDaily);
      if (scrapedDaily === null) {
        const pollResult = await new Promise(resolve => {
          const start = Date.now();
          const check = () => {
            const result = readDailyPnLFromDOM();
            if (result !== null) {
              cachedDailyPnL = result.total;
              cachedDailyPnLPerPosition = result.perPosition;
              resolve(result);
              return;
            }
            if (Date.now() - start < 3000) setTimeout(check, 300);
            else resolve(null);
          };
          check();
        });
        if (pollResult) {
          scrapedDaily = pollResult.total;
          scrapedPerPos = pollResult.perPosition;
        }
        console.log('[Sharpe] dailyPnL fallback poll:', scrapedDaily);
      }
      if (scrapedDaily !== null) results.scrapedDailyPnL = scrapedDaily;
      if (scrapedPerPos && Object.keys(scrapedPerPos).length > 0) results.scrapedDailyPnLPerPosition = scrapedPerPos;

      // --- Per-position Total P&L (from DOM, like daily P&L) ---
      let scrapedTotalPerPos = cachedTotalPnLPerPosition;
      if (!scrapedTotalPerPos) scrapedTotalPerPos = readTotalPnLFromDOM();
      if (scrapedTotalPerPos && Object.keys(scrapedTotalPerPos).length > 0) {
        results.scrapedTotalPnLPerPosition = scrapedTotalPerPos;
        console.log('[Sharpe] scrapedTotalPnLPerPosition: positions:', Object.keys(scrapedTotalPerPos).length);
      }

      // --- Total P&L (from the totalPortfolio summary row) ---
      const totalPlEl = document.querySelector('[data-id="totalPortfolio"][data-field="totalPl"]');
      if (totalPlEl) {
        const raw = (totalPlEl.getAttribute('title') || totalPlEl.textContent || '').trim();
        const v = parseDegiroNumber(raw);
        if (v !== null) {
          results.scrapedTotalPnL = v;
          console.log('[Sharpe] scrapedTotalPnL:', v);
        }
      }

      // --- Portfolio total value (investments + cash, matches DEGIRO's headline number) ---
      const totalValEl = document.querySelector('[data-id="totalPortfolio"][data-field="total"]');
      if (totalValEl) {
        const raw = (totalValEl.getAttribute('title') || totalValEl.textContent || '').trim();
        const v = parseDegiroNumber(raw);
        if (v !== null) {
          results.scrapedPortfolioValue = v;
          console.log('[Sharpe] scrapedPortfolioValue:', v);
        }
      }

      console.log('[Sharpe] final scraped — daily:', scrapedDaily, ' total:', results.scrapedTotalPnL ?? 'N/A', ' value:', results.scrapedPortfolioValue ?? 'N/A');
    } catch(e) { console.warn('[Sharpe] DOM Scrape Error:', e.message); }

    return results;
  }
})();
