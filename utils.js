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

// ── Theme system ──────────────────────────────────────────────────
let _currentTheme = 'dark';

function getTheme() { return _currentTheme; }
function isLight() { return _currentTheme === 'light'; }

function applyTheme(theme) {
  _currentTheme = theme;
  if (theme === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  // Update toggle icon
  const icon = document.getElementById('themeIcon');
  if (icon) {
    icon.innerHTML = theme === 'light'
      ? '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'   // moon
      : '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
  }
  try { chrome.storage.sync.set({ sharpeTheme: theme, sharpeThemeExplicit: true }); } catch(e) {}
}

async function initTheme() {
  try {
    const stored = await new Promise(r => chrome.storage.sync.get(['sharpeTheme', 'sharpeThemeExplicit'], r));
    if (stored.sharpeTheme) {
      applyTheme(stored.sharpeTheme);
    } else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
      _currentTheme = 'light';
      document.documentElement.dataset.theme = 'light';
    }
  } catch(e) {}
  // Listen for system preference changes (only if user hasn't explicitly chosen)
  try {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', e => {
      chrome.storage.sync.get('sharpeThemeExplicit', result => {
        if (!result.sharpeThemeExplicit) applyTheme(e.matches ? 'light' : 'dark');
      });
    });
  } catch(e) {}
}

// Theme-aware color palette for Chart.js configs, canvas drawing, and inline styles.
// Colors that are semantic (benchmark, grade scale, COLORS palette) stay the same.
//
// P&L green/red are read from the stylesheet's --green/--red at draw time so a
// chart line and the table cell below it are literally the same colour. Falls
// back to the previous literals if the custom property is missing or non-hex
// (e.g. a surface that loads utils.js without the dashboard stylesheet).
function cssHex(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
  } catch (e) { return fallback; }
}

const THEME_COLORS = {
  get tooltipBg()     { return isLight() ? '#FFFFFF'  : '#1E2C3A'; },
  get tooltipBorder() { return isLight() ? '#D1D5DB'  : '#2A3A4A'; },
  get tooltipTitle()  { return isLight() ? '#111827'  : '#F5F7FA'; },
  get tooltipBody()   { return isLight() ? '#6B7280'  : '#8B9BB4'; },
  get tickColor()     { return isLight() ? '#6B7280'  : '#8B9BB4'; },
  get gridColor()     { return isLight() ? 'rgba(107,114,128,0.18)' : 'rgba(139,155,180,0.14)'; },
  get plGreen()       { return cssHex('--green', isLight() ? '#16A34A' : '#2ACA69'); },
  get plRed()         { return cssHex('--red',   isLight() ? '#DC2626' : '#FF4757'); },
  get pieBorderColor(){ return isLight() ? '#F7F5F0'  : '#15202B'; },
  get corrNeutral()   { return isLight() ? [240,242,245] : [30,44,58]; },
  get canvasBaseline()     { return isLight() ? 'rgba(0,0,0,0.12)'   : 'rgba(255,255,255,0.18)'; },
  get canvasBaselineLabel(){ return isLight() ? 'rgba(0,0,0,0.25)'   : 'rgba(255,255,255,0.30)'; },
  get canvasBaselineFaint(){ return isLight() ? 'rgba(0,0,0,0.06)'   : 'rgba(255,255,255,0.07)'; },
  get canvasBaselineMed()  { return isLight() ? 'rgba(0,0,0,0.18)'   : 'rgba(255,255,255,0.35)'; },
  get canvasCrashFill()    { return isLight() ? 'rgba(220,38,38,0.35)' : 'rgba(239,83,80,0.5)'; },
  get canvasCrashFillHi()  { return isLight() ? 'rgba(220,38,38,0.7)'  : 'rgba(239,83,80,0.92)'; },
  get canvasRecoveryFill() { return isLight() ? 'rgba(22,163,74,0.3)'  : 'rgba(76,175,80,0.4)'; },
  get annotationBg()       { return isLight() ? '#F8F9FB' : '#0e0e1a'; },
  get annotationLine()     { return isLight() ? '#9CA3AF' : '#3a3a4a'; },
  get zeroLineColor()      { return isLight() ? 'rgba(17,24,39,0.4)' : 'rgba(245,247,250,0.5)'; },
  plGreenAlpha(a) { const hex = Math.round(a * 255).toString(16).padStart(2, '0'); return this.plGreen + hex; },
  plRedAlpha(a)   { const hex = Math.round(a * 255).toString(16).padStart(2, '0'); return this.plRed + hex; },
  themeTooltip() {
    return {
      backgroundColor: this.tooltipBg, borderColor: this.tooltipBorder, borderWidth: 1,
      titleColor: this.tooltipTitle, bodyColor: this.tooltipBody, padding: 10,
    };
  },
};

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
 * Infer equity sector for a position from its name.
 * Returns a sector string or null if no sector can be determined.
 * Used by stress test to apply sector-specific shock overrides.
 */
function inferSector(position) {
  const n = (position.name || '').toLowerCase();
  // Utilities
  if (/\butilit(y|ies)\b|\bversorgung\b|\bnutsbedrijf\b|\bservice(s)? public(s)?\b|\benergy (infra|grid|distribut)\b|\belektrizität\b|\bstroom\b|\bélectricité\b/.test(n)) return 'Utilities';
  if (/\benel\b|\biberdrola\b|\bengie\b|\brwe\b|\bnaturgy\b|\bfortum\b|\bverbund\b|\borsted\b|\bveolia\b|\bendesa\b|\ba2a\b|\be\.on\b|\beon\b|\binnogy\b|\bvattenfall\b|\bssen\b|\bnational grid\b|\bunited utilit\b|\bsevern trent\b|\bpennon\b/.test(n)) return 'Utilities';
  // Healthcare / Pharma
  if (/\bhealth ?care\b|\bpharma\b|\bmedica\b|\bbiotech\b|\bgezondheidszorg\b|\bgesundheit\b|\bsanté\b|\btherapeutic\b|\boncolog\b/.test(n)) return 'Healthcare';
  if (/\bnovo nordisk\b|\broche\b|\bnovartis\b|\bsanofi\b|\bastrazeneca\b|\bgsk\b|\bglaxo\b|\bbayer\b|\bmerck\b|\bpfizer\b|\babbvie\b|\bamgen\b|\bjohnson.*johnson\b|\beli lilly\b|\bmedtronic\b/.test(n)) return 'Healthcare';
  // Consumer Staples
  if (/\bconsumer staple\b|\bdagelijks\b|\bbasiskonsumgüter\b|\bconsommation de base\b|\bstaple\b/.test(n)) return 'Consumer Staples';
  if (/\bnestlé?\b|\bunilever\b|\bprocter\b|\bdanone\b|\bhenkel\b|\bbeiersdorf\b|\bl'oréal\b|\bloreal\b|\breckitt\b|\bdiageo\b|\bab inbev\b|\bheineken\b|\bcarlsberg\b|\bcolgate\b|\bkimberly\b|\bchurch.*dwight\b/.test(n)) return 'Consumer Staples';
  // Technology
  if (/\btechnolog(y|ie)\b|\btech\b|\bsoftware\b|\bsemiconductor\b|\bhalbleiter\b|\bhalfgeleider\b|\bcloud\b|\bcyber\b|\bartificial intellig\b|\b[  ]ai\b|\bmachine learn\b/.test(n)) return 'Technology';
  if (/\basml\b|\bsap\b|\bnvidia\b|\bmicrosoft\b|\bapple\b|\bgoogle\b|\balphabet\b|\bmeta\b|\bamazon\b|\btsmc\b|\bbroadcom\b|\badobe\b|\boracle\b|\bsalesforce\b|\bcrowdstrike\b|\bpalantir\b|\barm\b/.test(n)) return 'Technology';
  // Financials
  if (/\bfinancial\b|\bbank\b|\binsurance\b|\bverzekering\b|\bversicherung\b|\bassurance\b|\bfinanz\b/.test(n)) return 'Financials';
  // Energy (oil & gas — distinct from commodities)
  if (/\benergy\b|\böl\b|\boil\b|\bgas\b|\bpetrol\b|\bpétrole\b|\benergie\b/.test(n)) return 'Energy';
  if (/\bshell\b|\btotalenergies\b|\bbp\b|\bequinor\b|\beni\b|\brepsol\b|\bgalp\b|\bomv\b/.test(n)) return 'Energy';
  // Defence / Aerospace
  if (/\bdefen[cs]e\b|\baerospace\b|\bmilitar\b|\brüstung\b|\bdéfense\b|\bdefensie\b/.test(n)) return 'Defence';
  if (/\brheinmetall\b|\bthales\b|\bleonardo\b|\bbae systems\b|\bsaab\b|\bdassault\b/.test(n)) return 'Defence';
  return null;
}

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
    const vwdKey = prod.vwdId || prod.vwdIdSecondary;
    if (vwdKey) vwdIds[String(id)] = { vwdId: vwdKey, type: prod.vwdIdentifierType || prod.vwdIdentifierTypeSecondary };
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
        const fees = txFeeEur(tx);
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
      let unrealized = eurUnrealizedRaw !== undefined
        ? eurUnrealizedRaw
        : (nativePrice - bep) * nativeSize * currentFX;
      if (!isFinite(unrealized)) unrealized = 0;

      const pl = unrealized + realized;
      const costBasis = eurValue - unrealized;
      let plPct = costBasis > 0 ? (unrealized / costBasis) * 100 : 0;
      if (!isFinite(plPct)) plPct = 0;

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
      productId: x.product != null ? String(x.product) : '',
      amount:    amt,
      amountEUR: parseFloat(x.amountInBaseCurr) || amt,
      currency:  x.currency || 'EUR',
      date,
    };
  })
  .filter(x => x.date && x.amount > 0)
  .sort((a, b) => b.date.localeCompare(a.date));
}

// ── Holdings replay ────────────────────────────────────────────────
//
// Using today's position sizes for past dates is wrong: the current size gets
// applied retroactively to every earlier day, producing fake jumps around any
// buy or sell. Replaying the transaction log is the only correct way.

/**
 * Replay transactions into a chronological list of holdings snapshots.
 * @returns {Array<{date: string, holdings: Object<string, number>}>}
 */
function buildHoldingSnapshots(transactions) {
  const txList = (transactions || [])
    .filter(tx => tx.productId && tx.buysell && tx.quantity)
    .map(tx => ({
      id:      String(tx.productId),
      date:    (tx.date || '').slice(0, 10),
      buysell: tx.buysell,
      qty:     Math.abs(tx.quantity),
    }))
    .filter(tx => tx.date)
    .sort((a, b) => a.date.localeCompare(b.date));

  const snapshots = [];
  const running = {};
  txList.forEach(tx => {
    running[tx.id] = (running[tx.id] || 0) + (tx.buysell === 'B' ? tx.qty : -tx.qty);
    if (running[tx.id] < 0.001) delete running[tx.id];
    snapshots.push({ date: tx.date, holdings: { ...running } });
  });
  return snapshots;
}

/**
 * Holdings as of a date — the last snapshot on or before it. Binary search.
 * Returns a fresh object the caller may mutate; {} when nothing applies yet.
 */
function holdingsAsOf(snapshots, date) {
  let lo = 0, hi = (snapshots?.length || 0) - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (snapshots[mid].date <= date) { best = snapshots[mid].holdings; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best ? { ...best } : {};
}

// ── Shared portfolio statistics ────────────────────────────────────
// Used by both the dashboard and the popup so the two surfaces can never
// disagree on a figure.

/** Total dividend income in EUR from an extracted dividend array. */
function sumDividends(dividends) {
  return (dividends || []).reduce((s, d) => s + (d.amountEUR || 0), 0);
}

/** Total commission + FX fee for one transaction, in EUR. Accepts raw or extracted rows. */
function txFeeEur(tx) {
  return Math.abs(parseFloat(tx.totalFeesInBaseCurrency) || 0)
       + Math.abs(parseFloat(tx.autoFxFeeInBaseCurrency) || 0);
}

/** Realised P&L across all closed/partially-closed positions. */
function sumRealized(closed) {
  return (closed || []).reduce((s, cp) => s + cp.realizedPL, 0);
}

/**
 * Currency (FX) effect: unrealised on open non-EUR positions (p.plFx, computed
 * in extractPositions) plus realised FX on sold lots (from the FIFO walk).
 * @returns {{unrealizedFxPL, realizedFxPL, totalFxPL, fxPositions, closedFxCount}}
 */
function computeFxEffect(positions, closed) {
  let unrealizedFxPL = 0, fxPositions = 0;
  (positions || []).forEach(p => {
    if (p.currency === 'EUR') return;
    unrealizedFxPL += p.plFx || 0;
    fxPositions++;
  });
  let realizedFxPL = 0, closedFxCount = 0;
  (closed || []).forEach(cp => {
    if (cp.realizedFxPL) { realizedFxPL += cp.realizedFxPL; closedFxCount++; }
  });
  return {
    unrealizedFxPL, realizedFxPL,
    totalFxPL: unrealizedFxPL + realizedFxPL,
    fxPositions, closedFxCount,
  };
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

// ── Closed positions (FIFO with realised FX tracking) ─────────────

/**
 * Compute closed (and partially closed) position P&L using FIFO matching.
 * Shared by both dashboard.js and popup.js.
 * @param {Array} transactions - extracted transaction array
 * @param {Object} names - {productId → displayName}
 * @param {Object} meta - {productId → {currency, ...}} from extractProductMeta
 */
function computeClosedPositions(transactions, names, meta) {
  const byProduct = {};
  transactions.forEach(tx => {
    const id = tx.productId;
    if (!byProduct[id]) byProduct[id] = [];
    byProduct[id].push(tx);
  });

  const closed = [];
  // Per-sell realised gain events, in the same FIFO walk — consumers that need
  // a cumulative realised-gains time series read these instead of re-walking
  // the whole history with a second (drift-prone) copy of this algorithm.
  const gainEvents = []; // [{date, gain}]

  Object.entries(byProduct).forEach(([id, txs]) => {
    const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date));
    const buyQueue = [];
    let totalSoldQty = 0;
    let totalBuyCostEUR = 0;
    let totalSellProcEUR = 0;
    let netQty = 0;

    // Historical currency effect (realised FX P&L on sold lots)
    // For each matched lot: fxImpact = matchedQty × buyNativePrice × (sellFX − buyFX)
    let realizedFxPL = 0;

    // Detect if this product is non-EUR
    const productCurrency = meta?.[id]?.currency || '';
    let isNonEUR = productCurrency !== '' && productCurrency !== 'EUR';

    sorted.forEach(tx => {
      const qty = Math.abs(tx.quantity);
      const eurPerShare = qty > 0 ? Math.abs(tx.totalInBaseCurrency) / qty : 0;
      const nativePrice = tx.price;
      const fees = txFeeEur(tx);
      const eurExFees = Math.abs(tx.totalInBaseCurrency) - fees;
      const impliedFX = (nativePrice > 0 && qty > 0 && eurExFees > 0)
        ? eurExFees / (nativePrice * qty)
        : 1;

      if (tx.buysell === 'B') {
        netQty += qty;
        buyQueue.push({ qty, eurPerShare, nativePrice, fx: impliedFX });
        if (!productCurrency && Math.abs(impliedFX - 1) > 0.05) isNonEUR = true;
      } else {
        netQty -= qty;
        const sellFX = impliedFX;
        let remaining = qty;
        let costBasisThisSell = 0;
        while (remaining > 0.0001 && buyQueue.length > 0) {
          const lot = buyQueue[0];
          const matched = Math.min(lot.qty, remaining);
          costBasisThisSell += matched * lot.eurPerShare;
          totalBuyCostEUR += matched * lot.eurPerShare;
          totalSoldQty += matched;
          if (isNonEUR && lot.nativePrice > 0) {
            realizedFxPL += matched * lot.nativePrice * (sellFX - lot.fx);
          }
          lot.qty -= matched;
          remaining -= matched;
          if (lot.qty < 0.0001) buyQueue.shift();
        }
        const sellProceeds = Math.abs(tx.totalInBaseCurrency);
        totalSellProcEUR += sellProceeds;
        gainEvents.push({ date: tx.date, gain: sellProceeds - costBasisThisSell });
      }
    });

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

  const result = closed.sort((a, b) => Math.abs(b.realizedPL) - Math.abs(a.realizedPL));
  // Carried on the returned array so existing callers are unaffected; read via
  // `closed.gainEvents` when a chronological realised-gains series is needed.
  result.gainEvents = gainEvents.sort((a, b) => a.date.localeCompare(b.date));
  return result;
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

/**
 * Convert an array of row objects to a CSV string and trigger download.
 * @param {string} filename - e.g. 'positions.csv'
 * @param {string[]} headers - column header labels
 * @param {Array<Array<string|number>>} rows - 2D array of cell values
 */
function downloadCSV(filename, headers, rows) {
  const escape = v => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  };
  const lines = [headers.map(escape).join(',')];
  rows.forEach(r => lines.push(r.map(escape).join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Pearson correlation coefficient between two aligned return arrays.
 * Null entries are skipped. Returns null if fewer than 10 overlapping points.
 */
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
    num += dx * dy; da += dx * dx; db += dy * dy;
  }
  const denom = Math.sqrt(da * db);
  return denom === 0 ? null : Math.min(1, Math.max(-1, num / denom));
}
