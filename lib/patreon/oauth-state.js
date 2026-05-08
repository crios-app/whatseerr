/**
 * Short-lived state token cache for the Patreon OAuth `link` flow.
 *
 * When a user sends `link`, we generate a random state token, remember
 * which WhatsApp chat it belongs to, and embed it in the Patreon auth URL.
 * On the callback we look up the state to know which chat to attribute the
 * link to. State tokens are single-use (deleted on consumption) and expire
 * after a short TTL so an unused link doesn't sit around forever.
 */

import crypto from 'crypto';
import NodeCache from 'node-cache';

const DEFAULT_TTL_SECONDS = 600; // 10 minutes — well beyond a normal click-through

class OAuthStateCache {
  constructor(ttlSeconds = DEFAULT_TTL_SECONDS) {
    this.cache = new NodeCache({ stdTTL: ttlSeconds, checkperiod: 60 });
  }

  /**
   * Record a fresh state token for the given chat. Returns the token string.
   */
  issue(chatId) {
    const token = crypto.randomBytes(24).toString('hex');
    this.cache.set(token, { chatId, issuedAt: Date.now() });
    return token;
  }

  /**
   * Look up *and consume* a state token. Returns the stored entry or null
   * if the token is unknown / expired.
   */
  consume(token) {
    if (!token || typeof token !== 'string') return null;
    const entry = this.cache.get(token);
    if (!entry) return null;
    this.cache.del(token);
    return entry;
  }

  size() {
    return this.cache.keys().length;
  }
}

let singleton = null;

export function getOAuthStateCache() {
  if (!singleton) {
    singleton = new OAuthStateCache();
  }
  return singleton;
}

// For tests
export function _resetOAuthStateCacheForTests() {
  singleton = null;
}
