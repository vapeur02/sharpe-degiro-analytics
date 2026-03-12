// utils.js — shared constants and utility functions for Sharpe extension
// Loaded before dashboard.js and popup.js in their respective HTML files.
// Do NOT use ES module syntax (import/export) — this file is loaded via <script src>.

// ── Constants ──────────────────────────────────────────────────────

const COLORS = [
  '#00A8E1', // DEGIRO blue
  '#2ACA69', // profit green
  '#FF4757', // red
  '#FFD166', // amber
  '#A78BFA', // violet
  '#F97316', // orange
  '#22D3EE', // cyan
  '#FB7185', // rose
  '#34D399', // emerald
  '#FBBF24', // yellow
  '#818CF8', // indigo
  '#F472B6', // pink
];

// All known DEGIRO cash/sweep account ID conventions across regional platforms.
// These are excluded from position analysis and treated as uninvested cash.
const CASH_IDS = new Set([
  'EUR','USD','GBP','CHF','SEK','DKK','NOK','PLN','CZK','HUF','RON',  // ISO currency cash rows
  'FLATEX_EUR','FLATEX_USD','FLATEX_GBP','FLATEX_CHF',                 // Flatex sweep (NL/DE/AT)
  'FLATEX_SEK','FLATEX_DKK','FLATEX_NOK','FLATEX_PLN',                 // Flatex sweep (Nordic/PL)
  'FLATEX_CZK','FLATEX_HUF','FLATEX_RON',                              // Flatex sweep (Eastern EU)
]);

// NOTE: Personal product ID overrides were removed — they only work for one user's portfolio
// and conflict with the universal ISIN-first detection below.
// The ISIN prefix → country map + name-based regex handles all portfolios correctly.
const GEO_MAP_HARDCODED = {};

// Same rationale: no personal ID overrides. productTypeId + name regex covers all cases.
const ASSET_CLASS_MAP_HARDCODED = {};

// DEGIRO productTypeId values
// 1=Stock, 2=Bond, 3=Fund, 13=Option, 14=Turbo/Sprinter, 15=Warrant, 131=ETF/Tracker
// NOTE: 131 (ETF/Tracker) and 3 (Fund) are intentionally NOT mapped here.
// ETFs and funds should fall through to content-based classification (Equity, Bonds,
// Commodities, Real Estate, etc.) so the Asset Class pie shows underlying exposure
// rather than a meaningless "ETF" bucket.
const PRODUCT_TYPE_CLASS = {
  1: 'Equity',
  2: 'Bonds',
  13: 'Derivatives',
  14: 'Derivatives',
  15: 'Derivatives',
};

// ISIN country code prefixes that map to a definitive geography
const ISIN_GEO_MAP = {
  'US': 'USA', 'CA': 'Canada', 'GB': 'UK',  'JP': 'Japan',
  'CN': 'China', 'HK': 'China', 'AU': 'Australia', 'CH': 'Switzerland',
  'DE': 'Europe', 'FR': 'Europe', 'NL': 'Europe', 'IT': 'Europe',
  'ES': 'Europe', 'PT': 'Europe', 'BE': 'Europe', 'AT': 'Europe',
  'FI': 'Europe', 'SE': 'Europe', 'DK': 'Europe', 'NO': 'Europe',
  'PL': 'Europe', 'CZ': 'Europe', 'HU': 'Europe', 'RO': 'Europe',
  'IN': 'India', 'BR': 'Latin America', 'MX': 'Latin America',
  'KR': 'Asia-Pacific', 'TW': 'Asia-Pacific', 'SG': 'Asia-Pacific',
};

// IE and LU are ETF domiciles — their ISIN prefix tells us *where the fund is registered*,
// not the underlying exposure. Fall back to name-based regex for these.
const ETF_DOMICILE_PREFIXES = new Set(['IE', 'LU', 'KY', 'JE', 'GG']);

// ── Date helpers ───────────────────────────────────────────────────

/**
 * Normalise any date string from API responses to YYYY-MM-DD.
 * Handles ISO strings ("2024-05-20T..."), ISO date-only ("2024-05-20"),
 * and European slash-delimited formats ("20/05/2024" or "05/20/2024").
 */
function normalizeDate(raw) {
  if (!raw) return '';
  const s = String(raw);
  // Already ISO: "2024-05-20" or "2024-05-20T..."
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // European DD/MM/YYYY
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [d, m, y] = s.split('/');
    return `${y}-${m}-${d}`;
  }
  // MM/DD/YYYY (US-style, just in case)
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const parts = s.split('/');
    return `${parts[2]}-${parts[0].padStart(2,'0')}-${parts[1].padStart(2,'0')}`;
  }
  return s.slice(0, 10); // best-effort fallback
}

// ── Categorisation engine ──────────────────────────────────────────

/**
 * Infer asset class for a position.
 * Priority: hardcoded map → productTypeId → multilingual name regex → 'Equity'.
 */
function inferAssetClass(position) {
  const id = String(position.id || '');
  if (ASSET_CLASS_MAP_HARDCODED[id]) return ASSET_CLASS_MAP_HARDCODED[id];

  // Use DEGIRO's own productTypeId where available
  if (position.productTypeId !== undefined) {
    const cls = PRODUCT_TYPE_CLASS[position.productTypeId];
    if (cls) return cls;
  }

  // Multilingual name regex fallback (EN + NL + DE + FR)
  const n = (position.name || '').toLowerCase();
  if (/\bbond|\bobligat|\banleihe|\bschuldverschreibung\b|\btips\b|\btreasur|\bgilts?\b|\bcredit\b|\byield\b|\brent(e|en)\b|\bfixed.income\b|\bstaatslening\b/.test(n)) return 'Bonds';
  if (/\bcommodit|\bgrondstof|\brohstoff\b|\bmatière\b|\bgold\b|\bor\b|\bgoud\b|\bsilver\b|\bsilber\b|\bargent\b|\boil\b|\böl\b|\bpétrole\b/.test(n)) return 'Commodities';
  if (/\breal estate|\breit\b|\bvastgoed\b|\bimmobilien\b|\bimmobi(lier|lière)\b|\bproperty\b/.test(n)) return 'Real Estate';
  if (/\bmoney market\b|\bgeldmarkt\b|\bmarché monétaire\b|\bgelmarkt\b|\bliquidity\b|\bliquidite\b/.test(n)) return 'Money Market';
  return 'Equity';
}

/**
 * Infer geography for a position.
 * Priority: hardcoded map → ISIN country code (with IE/LU ETF exception) → name regex → 'Other'.
 */
function inferGeo(position) {
  const id = String(position.id || '');
  if (GEO_MAP_HARDCODED[id]) return GEO_MAP_HARDCODED[id];

  // ISIN-based lookup — most reliable for stocks
  const isin = position.isin || '';
  if (isin.length >= 2) {
    const prefix = isin.slice(0, 2).toUpperCase();
    if (!ETF_DOMICILE_PREFIXES.has(prefix)) {
      const geo = ISIN_GEO_MAP[prefix];
      if (geo) return geo;
    }
    // For IE/LU ETFs, fall through to name regex to find underlying exposure
  }

  // Multilingual name regex fallback — ordered most-specific first so regional funds
  // (e.g. "MSCI Emerging Markets", "MSCI Europe") match their region before Global.
  // MSCI is a brand name used for many regional indices, NOT a geography indicator.
  const n = (position.name || '').toLowerCase();
  if (/\bindia\b|\bindien\b|\binde\b/.test(n)) return 'India';
  if (/\bchina\b|\bchinese\b|\bchinesisch\b|\bchinois\b|\bchinees\b/.test(n)) return 'China';
  if (/\bjapan\b|\bjapanese\b|\bjapon\b/.test(n)) return 'Japan';
  if (/\bbrazil\b|\bbresil\b|\bbrasilien\b|\blatin\b|\blatino\b/.test(n)) return 'Latin America';
  if (/\bemerging\b|\bopkomende\b|\bmarchés émergents\b|\bschwellenland\b/.test(n)) return 'Emerging';
  if (/\bgb\b|\bunited kingdom\b|\buk\b|\bbritish\b|\bftse\b/.test(n)) return 'UK';
  if (/\beurope|\beuro[sz]one|\beurostoxx\b|\bstoxx\b|\beuropäisch\b|\beuropéen\b|\beuropees\b|\bdax\b|\bcac\b|\baex\b/.test(n)) return 'Europe';
  if (/\bus\b|\busa\b|\bamerica|\bs&p\b|\bnasdaq\b|\bdow jones\b|\bunited states\b|\bamerikaans\b|\baméricain\b/.test(n)) return 'USA';
  if (/\bpacific\b|\bastien?\b|\basia\b|\basien\b|\basie\b/.test(n)) return 'Asia-Pacific';
  // 'Global' only when name explicitly signals world-wide scope — MSCI alone is not enough
  // (MSCI Europe, MSCI EM, etc. already matched above before reaching this line)
  if (/\bglobal\b|\bworld\b|\bwereld\b|\bmonde\b|\bwelt\b|\ball.country\b/.test(n)) return 'Global';
  if (/\bcommodit|\bgrondstof|\bmatière\b|\brohstoff\b|\bgold\b|\bor\b|\bgoud\b|\bsilver\b|\bsilber\b|\bargent\b|\boil\b|\böl\b|\bpétrole\b/.test(n)) return 'Commodities';

  // Last resort: infer from currency (most EUR instruments are European, USD = USA, etc.)
  const cur = (position.currency || '').toUpperCase();
  if (cur === 'EUR') return 'Europe';
  if (cur === 'USD') return 'USA';
  if (cur === 'GBP') return 'UK';
  if (cur === 'JPY') return 'Japan';
  if (cur === 'CHF') return 'Switzerland';
  if (cur === 'AUD') return 'Australia';
  if (cur === 'CAD') return 'Canada';
  return 'Other';
}

// ── Data extraction ────────────────────────────────────────────────

/**
 * Extract a unified metadata map from DEGIRO productInfo API response.
 * Returns { meta, vwdIds } where meta[id] contains name, currency, productTypeId, isin.
 */
function extractProductMeta(productInfo) {
  const meta = {}, vwdIds = {};
  if (!productInfo?.data) return { meta, vwdIds };
  Object.entries(productInfo.data).forEach(([id, prod]) => {
    let name = prod.name || prod.symbol || id;
    name = name
      .replace(/\s+UCITS\s+ETF\s+USD\s+(Acc|Dist)/i, ' ETF')
      .replace(/\s+UCITS\s+ETF\s+(Acc|Dist)/i, ' ETF')
      .replace(/\s+UCITS\s+ETF/i, ' ETF')
      .replace(/\s+ETF\s+\d+[A-Z]+$/i, ' ETF')
      .replace(/\s+(Inc\.?|NV|SE|PLC|Corp\.?|Ltd\.?)$/i, '');
    if (name.length > 35) name = name.slice(0, 34) + '…';
    meta[String(id)] = {
      name,
      currency: prod.currency || 'EUR',
      productTypeId: prod.productTypeId ?? undefined,
      isin: prod.isin || '',
    };
    if (prod.vwdId) vwdIds[String(id)] = { vwdId: prod.vwdId, type: prod.vwdIdentifierType };
  });
  return { meta, vwdIds };
}

/**
 * Extract an array of normalised position objects from the DEGIRO portfolio response.
 * Each position includes productTypeId and isin for accurate categorisation.
 */
function extractPositions(portfolio, meta, transactions) {
  // Pre-compute weighted-average purchase FX rate per product from transaction history.
  // purchaseFX = totalEurPaid / (shares × nativePrice) for each buy, then weighted avg.
  // This is the same calculation DEGIRO uses for their "Currency Effect" figure.
  const purchaseFxMap = {};          // productId → weighted-avg purchase FX (EUR/native)
  if (transactions) {
    const buysByProduct = {};
    for (const tx of transactions) {
      if (!tx.productId || tx.buysell !== 'B') continue;
      if (!buysByProduct[tx.productId]) buysByProduct[tx.productId] = [];
      buysByProduct[tx.productId].push(tx);
    }
    for (const [pid, buys] of Object.entries(buysByProduct)) {
      let nativeTotal = 0, eurTotal = 0;
      for (const tx of buys) {
        const nativeVal = Math.abs(tx.quantity) * tx.price;
        // Subtract fees for a cleaner FX rate
        const fees = Math.abs(tx.totalFeesInBaseCurrency || 0) + Math.abs(tx.autoFxFeeInBaseCurrency || 0);
        const eurVal = Math.abs(tx.totalInBaseCurrency) - fees;
        nativeTotal += nativeVal;
        eurTotal    += eurVal;
      }
      if (nativeTotal > 0 && eurTotal > 0) purchaseFxMap[pid] = eurTotal / nativeTotal;
    }
  }

  if (!portfolio?.portfolio?.value) return [];
  return portfolio.portfolio.value
    .filter(x => x.name === 'positionrow')
    .map(x => {
      const f = {};
      (x.value || []).forEach(v => { f[v.name] = v.value; });
      const id = String(f.id || x.id || '');
      if (CASH_IDS.has(id) || !/^\d+$/.test(id)) return null;
      if (f.positionType !== 'PRODUCT') return null;
      if (!f.value || f.value === 0) return null;

      const m = meta[id] || {};

      // FX-aware P&L: use DEGIRO's EUR-converted unrealized P&L field if available.
      const nativeSize  = f.size  || 0;
      const nativePrice = f.price || 0;
      const eurValue    = f.value || 0;
      const currentFX   = (nativeSize !== 0 && nativePrice > 0)
        ? eurValue / (nativeSize * nativePrice)
        : 1;
      const bep       = f.breakEvenPrice || 0;
      const currency  = m.currency || 'EUR';

      const realized = f.realizedProductPl || 0;

      // Unrealized P&L in EUR — try explicit API fields, fall back to
      // (price - breakEvenPrice) × size × fxRate.
      const eurUnrealizedRaw =
        f.totalPlInBaseCurrency ?? f.totalPl ?? f.unrealizedPl ?? undefined;
      const unrealized = eurUnrealizedRaw !== undefined
        ? eurUnrealizedRaw
        : (nativePrice - bep) * nativeSize * currentFX;

      const pl = unrealized + realized;
      const costBasis = eurValue - unrealized;
      const plPct = costBasis > 0 ? (unrealized / costBasis) * 100 : 0;

      // ── Currency Effect ─────────────────────────────────────────────
      // plFx = currentPrice × size × (currentFX − purchaseFX)
      //
      // Derivation:
      //   totalUnrealized_EUR  = eurValue − costBasisEUR
      //   plProduct_EUR        = (price − bep) × size × purchaseFX   [price gain at purchase rate]
      //   plFx                 = totalUnrealized − plProduct
      //                        = price × size × currentFX − bep × size × purchaseFX
      //                          − (price − bep) × size × purchaseFX
      //                        = price × size × (currentFX − purchaseFX)
      //
      // Note: bep cancels out completely — the formula only needs currentPrice,
      // size, currentFX (from eurValue/size/price), and purchaseFX (from transactions).
      //
      // Positive = currency tailwind (e.g. USD strengthened vs EUR since purchase)
      // Negative = currency headwind (e.g. USD weakened vs EUR since purchase)
      let plFx = 0;
      if (currency !== 'EUR' && nativeSize !== 0 && nativePrice > 0) {
        const purchaseFX = purchaseFxMap[id];
        if (purchaseFX && isFinite(purchaseFX) && purchaseFX > 0) {
          plFx = nativePrice * nativeSize * (currentFX - purchaseFX);
          if (!isFinite(plFx)) plFx = 0;
        }
      }

      // todayPl: DEGIRO's portfolio API fields (todayPl, todayPlBase, todayPlInBaseCurrency)
      // are unreliable — they often contain the total unrealized P&L rather than today's
      // change. We rely on the DOM-scraped daily P&L value instead (scrapedDailyPnL).
      // If a per-position today's P&L source becomes available in the future, it can be
      // added here with a sanity check (value should be < 5% of position value per day).
      const todayPl = null;

      return {
        id,
        name:          m.name  || null,
        currency,
        productTypeId: m.productTypeId,
        isin:          m.isin  || '',
        size:          nativeSize,
        price:         nativePrice,
        value:         eurValue,
        plBase:        pl,
        plUnrealized:  unrealized,
        plFx,
        plPct,
        breakEvenPrice: bep,
        todayPl,
      };
    })
    .filter(Boolean);
}

/**
 * Extract dividend history from DEGIRO account overview API response.
 * Entries come pre-filtered from content.js (positive divid* movements only).
 * Pass an optional names map {productId -> productName} to resolve product names.
 */
function extractDividends(d, names) {
  if (!d?.data) return [];
  const arr = Array.isArray(d.data) ? d.data : [];
  return arr.map(x => {
    const amt  = parseFloat(x.amount) || parseFloat(x.change) || 0;
    const date = normalizeDate(x.payDate || x.date || x.valueDate || '');
    const product = (names && x.product && names[x.product]) || x.product || '';
    return {
      product,
      amount:    amt,
      amountEUR: parseFloat(x.amountInBaseCurr) || amt,
      currency:  x.currency || 'EUR',
      date,
    };
  })
  .filter(x => x.date && x.amount > 0)
  .sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Extract and normalise transaction history.
 */
function extractTransactions(t) {
  if (!t?.data) return [];
  return t.data.map(x => ({
    date:               normalizeDate(x.date),
    productId:          String(x.productId || ''),
    price:              parseFloat(x.price) || 0,
    quantity:           parseFloat(x.quantity) || 0,
    totalInBaseCurrency:parseFloat(x.totalInBaseCurrency) || 0,
    totalFeesInBaseCurrency: parseFloat(x.totalFeesInBaseCurrency) || 0,
    autoFxFeeInBaseCurrency: parseFloat(x.autoFxFeeInBaseCurrency) || 0,
    buysell:            x.buysell || 'B',
  })).filter(x => x.date).sort((a, b) => a.date.localeCompare(b.date));
}

// ── Formatting ─────────────────────────────────────────────────────

function fmtEur(v) {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency', currency: 'EUR',
    minimumFractionDigits: 0, maximumFractionDigits: 0
  }).format(v || 0);
}

// Format a raw price number with 2 decimal places using locale-aware formatting.
// Uses fr-FR so decimal separator is a comma (e.g. 1 234,56) consistent with fmtEur.
function fmtPrice(v) {
  return new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(v || 0);
}

function fmtMonth(m) {
  const [y, mo] = m.split('-');
  return new Date(y, mo - 1).toLocaleString('default', { month: 'short', year: '2-digit' });
}
