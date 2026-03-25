(function () {
  'use strict';

  try {

  // Don't inject twice (SPA navigation may re-trigger)
  if (document.getElementById('sharpe-banner-host')) return;

  // Only inject on authenticated DEGIRO pages — not on the login screen.
  // The login page uses a different layout and the banner breaks it.
  // The portfolio path is /#/portfolio but we allow any authenticated route
  // (user may be on /orders, /account, etc.) — we just exclude /login.
  if (window.location.pathname.startsWith('/login') ||
      window.location.hash === '' && !window.location.pathname.startsWith('/trader')) {
    return;
  }

  // Check if user dismissed the banner this session
  const DISMISS_KEY = 'sharpe_banner_dismissed';
  if (sessionStorage.getItem(DISMISS_KEY)) return;

  const BANNER_H = 36;

  // ── Create host element + Shadow DOM ──────────────────────────────────
  const host = document.createElement('div');
  host.id = 'sharpe-banner-host';

  const shadow = host.attachShadow({ mode: 'closed' });

  // Resolve extension asset URLs
  const iconUrl = chrome.runtime.getURL('icons/icon32.png');
  const syneFontUrl = chrome.runtime.getURL('fonts/syne-latin-800-normal.woff2');
  const monoFontUrl = chrome.runtime.getURL('fonts/dm-mono-latin-400-normal.woff2');

  shadow.innerHTML = `
    <style>
      @font-face { font-family: 'Syne'; font-style: normal; font-weight: 800; src: url('${syneFontUrl}') format('woff2'); }
      @font-face { font-family: 'DM Mono'; font-style: normal; font-weight: 400; src: url('${monoFontUrl}') format('woff2'); }

      :host {
        display: block;
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: ${BANNER_H}px;
        z-index: 2147483647;
      }

      .banner {
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: ${BANNER_H}px;
        padding: 0 20px;
        background: #15202B;
        border-bottom: 1px solid #2A3A4A;
        font-family: 'DM Mono', monospace;
        font-size: 12px;
        color: #F5F7FA;
        user-select: none;
      }

      .banner-left {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .banner-logo {
        width: 20px;
        height: 20px;
      }

      .banner-name {
        font-family: 'Syne', sans-serif;
        font-weight: 800;
        font-size: 14px;
        letter-spacing: -0.02em;
        color: #F5F7FA;
      }

      .banner-right {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .banner-open {
        background: #00A8E1;
        color: #000;
        border: none;
        border-radius: 4px;
        padding: 5px 14px;
        font-family: 'Syne', sans-serif;
        font-weight: 700;
        font-size: 11px;
        letter-spacing: 0.02em;
        cursor: pointer;
        transition: filter 0.15s;
      }
      .banner-open:hover {
        filter: brightness(1.15);
      }

      .banner-close {
        background: none;
        border: none;
        color: #8B9BB4;
        font-size: 16px;
        cursor: pointer;
        padding: 0 2px;
        line-height: 1;
        transition: color 0.15s;
      }
      .banner-close:hover {
        color: #F5F7FA;
      }
    </style>

    <div class="banner">
      <div class="banner-left">
        <img class="banner-logo" src="${iconUrl}" alt="Sharpe">
      </div>
      <div class="banner-right">
        <button class="banner-open">Open Dashboard</button>
        <button class="banner-close" title="Dismiss">&times;</button>
      </div>
    </div>
  `;

  // ── Wire button actions ───────────────────────────────────────────────
 
  shadow.querySelector('.banner-open').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' }).catch(() => {});
  });
 
  function removeBanner() {
    sessionStorage.setItem(DISMISS_KEY, '1');
    host.remove();
    // Remove the offset stylesheet
    const offsetSheet = document.getElementById('sharpe-banner-offset');
    if (offsetSheet) offsetSheet.remove();
  }
 
  shadow.querySelector('.banner-close').addEventListener('click', removeBanner);
 

  // ── Inject into page ──────────────────────────────────────────────────
  // Append to <html> (not body) to avoid interfering with DEGIRO's SPA
  // framework which controls body's children.
  document.documentElement.appendChild(host);

  // Push DEGIRO's content down using an injected <style> with !important.
  // This is more resilient than setting inline styles which the SPA can overwrite.
  const style = document.createElement('style');
  style.id = 'sharpe-banner-offset';
  style.textContent = `body { margin-top: ${BANNER_H}px !important; }`;
  document.head.appendChild(style);

  } catch (e) {
    console.warn('[Sharpe] Banner injection failed:', e);
  }

})();
