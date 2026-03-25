// pro.js — Sharpe Pro tier: license validation & feature gating
// Loaded before dashboard.js & popup.js via HTML script tags.

// ── Configuration ──────────────────────────────────────────────────────────
const PRO_CONFIG = {
  placeholderMode: true,
  storeSlug: 'sharpe',
  checkoutUrl: 'https://sharpe.lemonsqueezy.com/checkout/buy/ddba0155-f59f-4015-bfe7-43587a2d0143',

  // How long a successful validation result is trusted before a fresh network
  // check is required.  Kept short (24 h) so a cancelled subscription is
  // revoked within one day rather than the previous 7-day window.
  revalidateIntervalMs: 24 * 60 * 60 * 1000, // 24 hours

  // Hard ceiling: even with a valid cached result, if the last successful
  // validation is older than this, the user is locked out until connectivity
  // is restored.  Prevents indefinite offline access after cancellation.
  // Set to 3 days — generous for genuine connectivity issues, strict enough
  // for subscription enforcement.
  maxOfflineGracePeriodMs: 3 * 24 * 60 * 60 * 1000, // 3 days

  // Timeout for the LemonSqueezy API call (ms).  Avoids hanging the UI when
  // the user is on a slow connection.
  fetchTimeoutMs: 10_000,
};

// ── Pro State ──────────────────────────────────────────────────────────────

/**
 * Get the current Pro license state from chrome.storage.local.
 * Returns: { isPro, licenseKey, validatedAt, customerEmail, customerName, expiresAt }
 */
async function getProStatus() {
  return new Promise(resolve => {
    chrome.storage.local.get(
      ['pro_isPro', 'pro_licenseKey', 'pro_validatedAt', 'pro_customerEmail',
       'pro_customerName', 'pro_expiresAt'],
      (result) => {
        resolve({
          isPro:         result.pro_isPro === true,
          licenseKey:    result.pro_licenseKey  || '',
          validatedAt:   result.pro_validatedAt || 0,
          customerEmail: result.pro_customerEmail || '',
          customerName:  result.pro_customerName  || '',
          expiresAt:     result.pro_expiresAt     || null,
        });
      }
    );
  });
}

/**
 * Check whether the user has an active Pro license.
 *
 * Decision tree:
 *  1. No cached key → false immediately (no network call).
 *  2. Cached key is still within the revalidation window AND within the
 *     offline grace period → trust the cache (true).
 *  3. Cached key is stale (> 24 h) → revalidate against LemonSqueezy.
 *     • Network success + valid   → update cache, return true.
 *     • Network success + invalid → revoke locally, return false.
 *     • Network failure           → allow access ONLY if last successful
 *       validation is within the 3-day grace period; lock out otherwise.
 *       This means a cancelled subscription is enforced within 3 days even
 *       if the user is briefly offline at renewal time.
 */
async function isPro() {
  // ── Development / testing shortcut ──────────────────────────────────────
  // placeholderMode must be false in production builds.
  if (PRO_CONFIG.placeholderMode) {
    const { pro_placeholderDeactivated } = await new Promise(r =>
      chrome.storage.local.get('pro_placeholderDeactivated', r)
    );
    return pro_placeholderDeactivated !== true;
  }

  const status = await getProStatus();

  // No key stored — definitely not Pro
  if (!status.isPro || !status.licenseKey) return false;

  const now = Date.now();
  const age = now - status.validatedAt;

  // Within revalidation window — trust the cache
  if (age <= PRO_CONFIG.revalidateIntervalMs) return true;

  // Cache is stale — must revalidate
  const result = await validateLicense(status.licenseKey, { silent: true, isRevalidation: true });
  return result.ok;
}

// ── License Validation ─────────────────────────────────────────────────────

/**
 * Validate a license key against the LemonSqueezy Licenses API.
 *
 * @param {string} key
 * @param {{ silent?: boolean, isRevalidation?: boolean }} opts
 *   silent        – suppress console warnings (used for background revalidation)
 *   isRevalidation – when true, applies the offline grace period logic instead
 *                    of immediately locking out on network failure
 * @returns {Promise<{ok:boolean, reason?:string}>} Structured result — see shape below
 */
/**
 * Result shape returned by validateLicense:
 *   { ok: true }                    — key is valid and subscription active
 *   { ok: false, reason: 'invalid'} — key rejected by LemonSqueezy (4xx / valid:false)
 *   { ok: false, reason: 'network'} — could not reach LemonSqueezy
 *
 * Using a structured result (rather than a bare boolean) lets callers show
 * the correct error message without having to re-inspect storage state.
 */
async function validateLicense(key, { silent = false, isRevalidation = false } = {}) {
  if (!key || key.trim().length === 0) return { ok: false, reason: 'invalid' };
  key = key.trim();

  // ── Abort controller for timeout ────────────────────────────────────────
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRO_CONFIG.fetchTimeoutMs);

  try {
    const res = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ license_key: key }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      if (!silent) console.warn('[Sharpe Pro] License validation HTTP error:', res.status);
      // 4xx → key is definitively bad (not found, already used, etc.)
      // 5xx → LemonSqueezy server trouble, treat as transient network failure
      if (res.status >= 400 && res.status < 500) {
        await revokePro();
        return { ok: false, reason: 'invalid' };
      }
      return _handleNetworkFailure({ silent, isRevalidation });
    }

    const data = await res.json();

    // ── Subscription status check ────────────────────────────────────────
    // LemonSqueezy returns { valid: true/false, license_key: { status, ... }, meta: {...} }
    // "valid" alone is not enough for subscriptions — a key can be "valid" but
    // belong to a subscription that has been cancelled or past-due.
    // We also check license_key.status explicitly.
    const lsStatus = data.license_key?.status; // 'active' | 'inactive' | 'expired' | 'disabled'
    const subscriptionActive = data.valid === true && lsStatus === 'active';

    if (subscriptionActive) {
      const email     = data.meta?.customer_email || '';
      const name      = data.meta?.customer_name  || '';
      const expiresAt = data.license_key?.expires_at || null;
      await chrome.storage.local.set({
        pro_isPro:          true,
        pro_licenseKey:     key,
        pro_validatedAt:    Date.now(),
        pro_customerEmail:  email,
        pro_customerName:   name,
        pro_expiresAt:      expiresAt,
      });
      return { ok: true };
    } else {
      // Key exists but subscription is cancelled, expired, or disabled.
      if (!silent) {
        console.warn('[Sharpe Pro] License not active. Status:', lsStatus, '| valid:', data.valid);
      }
      await revokePro();
      return { ok: false, reason: 'invalid' };
    }

  } catch (e) {
    clearTimeout(timer);
    // Network error or fetch abort (timeout).
    if (!silent) console.warn('[Sharpe Pro] Validation network error:', e.message);
    return _handleNetworkFailure({ silent, isRevalidation });
  }
}

/**
 * Decide what to return when we cannot reach LemonSqueezy.
 *
 * Policy:
 *  • If this is a fresh activation attempt (isRevalidation = false), always
 *    return false — we must confirm the key is valid before granting access.
 *  • If this is a background revalidation of an existing session, allow
 *    continued access ONLY within the offline grace period.  Once the grace
 *    period expires the user is locked out until connectivity is restored and
 *    the key re-validates successfully.  This means a cancelled subscription
 *    cannot be kept alive indefinitely by staying offline.
 *
 * @private
 */
async function _handleNetworkFailure({ silent, isRevalidation }) {
  if (!isRevalidation) {
    // Fresh activation — we have no basis to grant Pro
    if (!silent) console.warn('[Sharpe Pro] Cannot activate: no network connection.');
    return { ok: false, reason: 'network' };
  }

  const status = await getProStatus();
  if (!status.isPro || !status.validatedAt) return { ok: false, reason: 'network' };

  const offlineAge = Date.now() - status.validatedAt;
  if (offlineAge <= PRO_CONFIG.maxOfflineGracePeriodMs) {
    if (!silent) {
      const hoursLeft = Math.ceil((PRO_CONFIG.maxOfflineGracePeriodMs - offlineAge) / 3_600_000);
      console.warn(`[Sharpe Pro] Offline — grace period active (${hoursLeft}h remaining).`);
    }
    return { ok: true }; // temporary pass while offline
  }

  // Grace period expired — lock out until we can verify with LemonSqueezy
  if (!silent) console.warn('[Sharpe Pro] Offline grace period expired. Locking out until re-validated.');
  await chrome.storage.local.set({ pro_isPro: false });
  return { ok: false, reason: 'network' };
}

/**
 * Activate a new license key.  Always requires a live network call —
 * we never grant Pro without a confirmed API response on first activation.
 * Returns { success: boolean, message: string }.
 */
async function activateLicense(key) {
  if (!key || key.trim().length === 0) {
    return { success: false, message: 'Please enter a license key.' };
  }

  if (PRO_CONFIG.placeholderMode) {
    await chrome.storage.local.remove('pro_placeholderDeactivated');
    return { success: true, message: 'PRO activated!' };
  }

  const trimmedKey = key.trim();

  // ── Activate the license with LemonSqueezy first ──────────────────────

  // LemonSqueezy keys start as "inactive" until activated via this endpoint.
  // instance_name identifies this particular installation.
  try {
    const activateRes = await fetch('https://api.lemonsqueezy.com/v1/licenses/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ license_key: trimmedKey, instance_name: 'Sharpe Extension' }),
    });
    // 400 with "already activated" is fine — proceed to validate.
    // Any other 4xx means the key is truly bad.
    if (!activateRes.ok) {
      const errBody = await activateRes.json().catch(() => ({}));
      const alreadyActivated = activateRes.status === 400
        && typeof errBody.error === 'string'
        && errBody.error.toLowerCase().includes('already');
      if (!alreadyActivated && activateRes.status >= 400 && activateRes.status < 500) {
        return {
          success: false,
          message: 'Invalid or inactive license key. Please check and try again.',
        };
      }
    }
  } catch (e) {
    console.warn('[Sharpe Pro] Activation request failed:', e.message);
    return {
      success: false,
      message: 'Could not reach the activation server. Please check your connection and try again.',
    };
  }

  // ── Now validate the (now-active) license ─────────────────────────────
  const result = await validateLicense(trimmedKey, { silent: false, isRevalidation: false });

  if (result.ok) {
    return { success: true, message: 'PRO activated! Enjoy your advanced features.' };
  }

  if (result.reason === 'network') {
    return {
      success: false,
      message: 'Could not reach the activation server. Please check your connection and try again.',
    };
  }

  // reason === 'invalid' — key was rejected or subscription is not active
  return {
    success: false,
    message: 'Invalid or inactive license key. Please check and try again.',
  };
}

/**
 * Deactivate Pro and clear stored license data.
 * Keeps the key in storage so re-activation is just a network call,
 * not requiring the user to find their key again — unless they explicitly
 * clear it via the status modal.
 */
async function revokePro() {
  // Clear Pro status flags but intentionally keep pro_licenseKey so the user
  // can re-validate automatically once their subscription is renewed.
  await chrome.storage.local.remove([
    'pro_isPro', 'pro_validatedAt',
    'pro_customerEmail', 'pro_customerName', 'pro_expiresAt',
  ]);
  if (PRO_CONFIG.placeholderMode) {
    await chrome.storage.local.set({ pro_placeholderDeactivated: true });
  }
}

/**
 * Fully remove all Pro data including the stored license key.
 * Used when the user explicitly clicks "Remove license" in the status modal.
 */
async function fullyRevokePro() {
  await chrome.storage.local.remove([
    'pro_isPro', 'pro_licenseKey', 'pro_validatedAt',
    'pro_customerEmail', 'pro_customerName', 'pro_expiresAt',
    'pro_placeholderDeactivated',
  ]);
}

// ── Feature Gating Helpers ─────────────────────────────────────────────────

/** Feature IDs gated behind Pro. */
const PRO_FEATURES = new Set([
  'correlation',   // Correlation matrix
  'export',        // CSV export buttons
  'stockChart',    // Individual stock price charts
]);

/**
 * Check if a specific feature is available for the current user.
 * @param {string} featureId
 * @returns {Promise<boolean>}
 */
async function isFeatureAvailable(featureId) {
  if (!PRO_FEATURES.has(featureId)) return true;
  return await isPro();
}

/**
 * Show a Pro upgrade overlay on a container element.
 */
function showProOverlay(container, featureName) {
  if (!container) return;
  if (container.querySelector('.pro-overlay')) return;

  const overlay = document.createElement('div');
  overlay.className = 'pro-overlay';
  overlay.innerHTML = `
    <div class="pro-overlay-content">
      <div class="pro-overlay-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      </div>
      <div class="pro-overlay-title">${featureName}</div>
      <div class="pro-overlay-text">This feature is available with Sharpe PRO</div>
      <button class="pro-overlay-btn" data-action="upgrade">Upgrade to PRO</button>
      <button class="pro-overlay-btn pro-overlay-btn--key" data-action="activate">I have a license key</button>
    </div>
  `;

  overlay.querySelector('[data-action="upgrade"]').addEventListener('click', () => {
    chrome.tabs.create({ url: PRO_CONFIG.checkoutUrl });
  });
  overlay.querySelector('[data-action="activate"]').addEventListener('click', () => {
    showLicenseModal();
  });

  container.style.position = 'relative';
  container.appendChild(overlay);
}

/**
 * Remove Pro overlay from a container (called after successful activation).
 */
function removeProOverlay(container) {
  if (!container) return;
  const overlay = container.querySelector('.pro-overlay');
  if (overlay) overlay.remove();
}

// ── Pro Status Modal ───────────────────────────────────────────────────────

async function showProStatusModal() {
  const existing = document.getElementById('proStatusModal');
  if (existing) existing.remove();

  const status = await getProStatus();

  // ── Renewal / billing row ──────────────────────────────────────────────
  let renewalLine = '';
  if (status.expiresAt) {
    const d = new Date(status.expiresAt);
    const formatted = d.toLocaleDateString('default', { day: 'numeric', month: 'long', year: 'numeric' });
    const daysLeft = Math.ceil((d - Date.now()) / 864e5);
    const urgencyStyle = daysLeft <= 7
      ? ' style="color:#FF4757"'
      : daysLeft <= 30 ? ' style="color:#F59E0B"' : '';
    renewalLine = `
      <div class="pro-status-row">
        <span class="pro-status-label">Next renewal</span>
        <span class="pro-status-val"${urgencyStyle}>${formatted}
          <span style="opacity:0.6;font-size:10px">(${daysLeft}d)</span>
        </span>
      </div>`;
  } else {
    renewalLine = `
      <div class="pro-status-row">
        <span class="pro-status-label">Billing</span>
        <span class="pro-status-val">Lifetime licence</span>
      </div>`;
  }

  // ── Grace period warning ───────────────────────────────────────────────
  // Show a banner if the user is in the offline grace period (pro_isPro may
  // have been temporarily set to false by _handleNetworkFailure while keeping
  // the key).  Re-read the raw flag from storage to detect this state.
  const rawFlags = await new Promise(r =>
    chrome.storage.local.get(['pro_isPro', 'pro_validatedAt'], r)
  );
  const offlineAge = Date.now() - (rawFlags.pro_validatedAt || 0);
  const inGrace = rawFlags.pro_isPro === false
    && status.licenseKey
    && offlineAge <= PRO_CONFIG.maxOfflineGracePeriodMs;
  const graceBanner = inGrace
    ? `<div class="pro-status-warning">
         ⚠ Could not verify your subscription. Access continues for up to
         ${Math.ceil((PRO_CONFIG.maxOfflineGracePeriodMs - offlineAge) / 3_600_000)}h while offline.
       </div>`
    : '';

  const lastChecked = status.validatedAt
    ? new Date(status.validatedAt).toLocaleDateString('default', { day: 'numeric', month: 'short', year: 'numeric' })
    : 'Never';

  const modal = document.createElement('div');
  modal.id = 'proStatusModal';
  modal.className = 'pro-modal-backdrop';
  modal.innerHTML = `
    <div class="pro-modal">
      <div class="pro-modal-header">
        <span class="pro-modal-title">Sharpe PRO — Active</span>
      </div>
      <div class="pro-modal-body">
        ${graceBanner}
        <div class="pro-status-grid">
          <div class="pro-status-row">
            <span class="pro-status-label">Status</span>
            <span class="pro-status-val pro-status-active">● Active</span>
          </div>
          ${status.customerName
            ? `<div class="pro-status-row"><span class="pro-status-label">Name</span><span class="pro-status-val">${status.customerName}</span></div>`
            : ''}
          ${status.customerEmail
            ? `<div class="pro-status-row"><span class="pro-status-label">Account</span><span class="pro-status-val" style="font-size:12px">${status.customerEmail}</span></div>`
            : ''}
          ${renewalLine}
          <div class="pro-status-row">
            <span class="pro-status-label">Last verified</span>
            <span class="pro-status-val" style="opacity:0.6;font-size:11px">${lastChecked}</span>
          </div>
        </div>
      </div>
      <div class="pro-modal-footer">
        <button class="pro-modal-btn pro-modal-btn--danger" id="proStatusRemove" title="Remove stored license key and deactivate PRO">Remove licence</button>
        <button class="pro-modal-btn pro-modal-btn--secondary" id="proStatusClose">Close</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector('#proStatusClose').addEventListener('click', e => {
    e.stopPropagation();
    modal.remove();
  });

  modal.querySelector('#proStatusRemove').addEventListener('click', async e => {
    e.stopPropagation();
    if (!confirm('Remove your Sharpe PRO licence from this device? You can re-enter your key at any time.')) return;
    await fullyRevokePro();
    modal.remove();
    location.reload();
  });

  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

// ── License Key Modal ──────────────────────────────────────────────────────

function showLicenseModal() {
  const existing = document.getElementById('proLicenseModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'proLicenseModal';
  modal.className = 'pro-modal-backdrop';
  modal.innerHTML = `
    <div class="pro-modal">
      <div class="pro-modal-header">
        <span class="pro-modal-title">Activate Sharpe PRO</span>
        <button class="pro-modal-close" title="Close">&times;</button>
      </div>
      <div class="pro-modal-body">
        <p class="pro-modal-text">Enter your license key below. You'll receive this key via email after purchasing Sharpe PRO.</p>
        <input type="text" class="pro-modal-input" id="proKeyInput" placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" spellcheck="false" autocomplete="off">
        <div class="pro-modal-msg" id="proKeyMsg"></div>
      </div>
      <div class="pro-modal-footer">
        <button class="pro-modal-btn pro-modal-btn--secondary" id="proBtnCancel">Cancel</button>
        <button class="pro-modal-btn pro-modal-btn--primary" id="proBtnActivate">Activate</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const input     = modal.querySelector('#proKeyInput');
  const msgEl     = modal.querySelector('#proKeyMsg');
  const btnActivate = modal.querySelector('#proBtnActivate');

  modal.querySelector('.pro-modal-close').addEventListener('click', () => modal.remove());
  modal.querySelector('#proBtnCancel').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  btnActivate.addEventListener('click', async () => {
    const key = input.value.trim();
    if (!key) {
      msgEl.textContent = 'Please enter a license key.';
      msgEl.className = 'pro-modal-msg error';
      return;
    }

    btnActivate.disabled = true;
    btnActivate.textContent = 'Validating...';
    msgEl.textContent = '';

    const result = await activateLicense(key);

    if (result.success) {
      msgEl.textContent = result.message;
      msgEl.className = 'pro-modal-msg success';
      btnActivate.textContent = 'Activated!';
      setTimeout(() => { modal.remove(); location.reload(); }, 1200);
    } else {
      msgEl.textContent = result.message;
      msgEl.className = 'pro-modal-msg error';
      btnActivate.disabled = false;
      btnActivate.textContent = 'Activate';
    }
  });

  input.addEventListener('keydown', e => { if (e.key === 'Enter') btnActivate.click(); });
  input.focus();
}
