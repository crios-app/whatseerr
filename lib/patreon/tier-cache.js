/**
 * In-memory cache of active Patreon members keyed by email + Patreon user id.
 *
 * Periodically refreshed so we don't hit Patreon on every WhatsApp message.
 * The first refresh runs synchronously at startup so the gate is correct
 * from the moment the bot accepts traffic.
 *
 * Failure model:
 *  - First refresh fails  -> cache stays empty AND `enabled = true` AND
 *    `lastRefreshOk = false`. The middleware fails closed (blocks all
 *    non-admins) until a successful refresh lands.
 *  - Later refresh fails  -> cache keeps the previous successful payload.
 *    The gate keeps working off stale data; we just log the error.
 *  - Patreon config absent -> `enabled = false`, gate passes everyone.
 */

import { fetchActivePatrons } from './patreon-client.js';
import { getErrorDetails } from '../errors/error-formatter.js';

const DEFAULT_REFRESH_MINUTES = 30;
const DEFAULT_ALLOWED_TIERS = ['Premium', 'Diamond'];

class PatreonTierCache {
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.logger = logger;
    this.enabled = !!(cfg?.patreon?.accessToken && cfg?.patreon?.campaignId);
    this.allowedTiers = (cfg?.patreon?.allowedTiers && cfg.patreon.allowedTiers.length > 0)
      ? cfg.patreon.allowedTiers
      : DEFAULT_ALLOWED_TIERS;
    this.refreshIntervalMs = (cfg?.patreon?.refreshIntervalMinutes || DEFAULT_REFRESH_MINUTES) * 60_000;

    this.byEmail = new Map();           // lowercased email -> { tierTitles: string[], fullName }
    this.byPatreonUserId = new Map();   // patreon user id -> same shape
    this.lastRefreshOk = false;
    this.lastRefreshAt = null;
    this.lastError = null;
    this._timer = null;
  }

  /**
   * Refresh the cache from Patreon. Returns true on success.
   */
  async refresh() {
    if (!this.enabled) return false;
    try {
      const patrons = await fetchActivePatrons(this.cfg, this.logger);
      const byEmail = new Map();
      const byPatreonUserId = new Map();
      for (const p of patrons) {
        const entry = { tierTitles: p.tierTitles, fullName: p.fullName };
        if (p.email) byEmail.set(p.email, entry);
        if (p.patreonUserId) byPatreonUserId.set(p.patreonUserId, entry);
      }
      this.byEmail = byEmail;
      this.byPatreonUserId = byPatreonUserId;
      this.lastRefreshOk = true;
      this.lastRefreshAt = new Date();
      this.lastError = null;
      this.logger?.info(`💎 Patreon tier cache refreshed: ${patrons.length} active patron${patrons.length !== 1 ? 's' : ''} (allowed tiers: ${this.allowedTiers.join(', ')})`);
      return true;
    } catch (err) {
      this.lastError = err;
      this.lastRefreshOk = false;
      this.logger?.error('Patreon tier cache refresh failed', getErrorDetails(err, 'patreonRefresh'));
      return false;
    }
  }

  startPeriodicRefresh() {
    if (!this.enabled) return;
    if (this._timer) return;
    this._timer = setInterval(() => {
      this.refresh().catch(err => {
        this.logger?.warn('Patreon refresh interval threw', getErrorDetails(err, 'patreonRefreshInterval'));
      });
    }, this.refreshIntervalMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Look up an entry by lowercased email. Returns the entry or null.
   */
  getByEmail(email) {
    if (!email || typeof email !== 'string') return null;
    return this.byEmail.get(email.trim().toLowerCase()) || null;
  }

  getByPatreonUserId(id) {
    if (!id) return null;
    return this.byPatreonUserId.get(String(id)) || null;
  }

  /**
   * Returns true if any of the entry's tier titles are in the allowed list
   * (case-insensitive).
   */
  isEntryAllowed(entry) {
    if (!entry || !Array.isArray(entry.tierTitles) || entry.tierTitles.length === 0) {
      return false;
    }
    const allowedLower = this.allowedTiers.map(t => t.toLowerCase());
    return entry.tierTitles.some(t => allowedLower.includes(String(t).toLowerCase()));
  }

  /**
   * One-shot lookup by email or Patreon user id.
   * @returns {{ allowed: boolean, tierTitles: string[]|null }}
   */
  check({ email, patreonUserId } = {}) {
    let entry = null;
    if (email) entry = this.getByEmail(email);
    if (!entry && patreonUserId) entry = this.getByPatreonUserId(patreonUserId);
    if (!entry) return { allowed: false, tierTitles: null };
    return { allowed: this.isEntryAllowed(entry), tierTitles: entry.tierTitles };
  }
}

let singleton = null;

/**
 * Initialise the singleton AND run the first refresh synchronously.
 * Returns the cache instance. Safe to call when patreon config is absent —
 * the cache will be marked `enabled = false` and `check()` always returns
 * `{ allowed: false, tierTitles: null }` (callers should consult `enabled`
 * to decide whether to enforce).
 */
export async function initPatreonTierCache(cfg, logger) {
  if (singleton) return singleton;
  singleton = new PatreonTierCache(cfg, logger);
  if (singleton.enabled) {
    await singleton.refresh();
    singleton.startPeriodicRefresh();
  } else {
    logger?.info('💎 Patreon tier gating is DISABLED (set patreon.accessToken and patreon.campaignId to enable)');
  }
  return singleton;
}

export function getPatreonTierCache() {
  return singleton;
}

// For tests — never use in production code.
export function _resetPatreonTierCacheForTests() {
  if (singleton) singleton.stop();
  singleton = null;
}
