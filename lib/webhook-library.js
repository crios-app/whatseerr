/**
 * Library webhook handler — accepts Plex, Sonarr and Radarr webhook payloads
 * and DM-notifies users who are subscribed (via `follow` or via the regular
 * request flow) to the affected media.
 *
 * Endpoint: POST <webhook.library.path> (default `/library`)
 *
 * Content types supported:
 *  - application/json                 (Sonarr, Radarr, Plex JSON variants)
 *  - application/x-www-form-urlencoded (Plex with `payload=<json>`)
 *  - multipart/form-data              (Plex default; payload field carries JSON)
 *
 * Optional shared-secret authentication via `?token=...` matched against
 * `cfg.webhook.library.token` (or env `WHATSEERR_LIBRARY_TOKEN`). When no
 * secret is configured the endpoint is open — set one when exposing it
 * to the public internet.
 */

import { sendMessage } from './waha-client.js';
import { getSubscriptionManager } from './subscriptions/subscription-manager.js';
import { getErrorDetails } from './errors/error-formatter.js';
import { isPhoneNumberConfigured } from './utils.js';
import { MEDIA_TYPE_MOVIE, MEDIA_TYPE_TV } from './constants.js';

/**
 * Extract the configured secret token (if any). When set, callers must
 * include it as a `token` query string parameter or `X-Library-Token`
 * header to be accepted.
 */
function getLibraryToken(cfg) {
  return (cfg?.webhook?.library?.token
    || process.env.WHATSEERR_LIBRARY_TOKEN
    || '').trim() || null;
}

/**
 * Constant-time string compare to avoid leaking the token via timing.
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/**
 * Best-effort JSON parser that also handles Plex's payload field.
 * @returns {Object|null}
 */
export function parseLibraryBody(rawBody, contentType) {
  if (rawBody == null) return null;
  const ct = (contentType || '').toLowerCase();

  if (typeof rawBody === 'object' && !Buffer.isBuffer(rawBody)) {
    // Fastify already parsed JSON — most common case for Sonarr/Radarr.
    if (rawBody.payload && typeof rawBody.payload === 'string') {
      try { return JSON.parse(rawBody.payload); } catch { /* fall through */ }
    }
    return rawBody;
  }

  const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);

  if (ct.startsWith('application/json')) {
    try { return JSON.parse(text); } catch { return null; }
  }

  if (ct.startsWith('application/x-www-form-urlencoded')) {
    try {
      const params = new URLSearchParams(text);
      const payload = params.get('payload');
      if (payload) return JSON.parse(payload);
    } catch {}
    return null;
  }

  if (ct.startsWith('multipart/form-data')) {
    // Naive multipart parse — pull out the `name="payload"` part, which is
    // what Plex sends. We avoid pulling in a multipart dep just for this.
    const boundaryMatch = (contentType || '').match(/boundary=("?)([^";]+)\1/i);
    if (!boundaryMatch) return null;
    const boundary = boundaryMatch[2];
    const parts = text.split(`--${boundary}`);
    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const headers = part.slice(0, headerEnd);
      if (!/name="payload"/i.test(headers)) continue;
      const body = part.slice(headerEnd + 4).replace(/\r\n$/, '');
      try { return JSON.parse(body); } catch { return null; }
    }
    return null;
  }

  // Last-resort: assume JSON.
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Detect which upstream sent this payload.
 * @returns {'sonarr'|'radarr'|'plex'|'unknown'}
 */
function detectSource(payload) {
  if (!payload || typeof payload !== 'object') return 'unknown';
  // Sonarr/Radarr put `eventType` at the top level along with their domain root.
  if (payload.eventType && payload.series) return 'sonarr';
  if (payload.eventType && payload.movie) return 'radarr';
  // Plex uses `event` + `Metadata`.
  if (payload.event && payload.Metadata) return 'plex';
  return 'unknown';
}

/**
 * Pull a TVDB id out of a Plex Metadata.Guid array, e.g. "tvdb://123" or
 * { id: "tvdb://123" }.
 */
function findTvdbIdInGuids(guids) {
  if (!Array.isArray(guids)) return null;
  for (const g of guids) {
    const id = typeof g === 'string' ? g : (g?.id || g?.Id || '');
    const m = String(id).match(/tvdb:\/\/(\d+)/i);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function findTmdbIdInGuids(guids) {
  if (!Array.isArray(guids)) return null;
  for (const g of guids) {
    const id = typeof g === 'string' ? g : (g?.id || g?.Id || '');
    const m = String(id).match(/tmdb:\/\/(\d+)/i);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * Normalize a webhook into a list of items we'd notify subscribers about.
 * Each item: { kind: 'episode'|'movie'|'test', tmdbId?, tvdbId?, title, season?, episode?, episodeTitle? }
 */
function extractItems(payload, source) {
  if (source === 'sonarr') {
    const eventType = String(payload.eventType || '').toLowerCase();
    if (eventType === 'test') {
      return [{ kind: 'test', source: 'sonarr', title: 'Sonarr connectivity test' }];
    }
    // We notify for "Download" (file imported / available) — both first import
    // and upgrade emit this. Skip Grab to avoid notifying before file is ready.
    if (eventType !== 'download') return [];
    const series = payload.series || {};
    const tvdbId = series.tvdbId || null;
    const tmdbId = series.tmdbId || null;
    const episodes = Array.isArray(payload.episodes) ? payload.episodes : [];
    return episodes.map(ep => ({
      kind: 'episode',
      source: 'sonarr',
      tvdbId,
      tmdbId,
      title: series.title || 'Unknown Show',
      season: ep.seasonNumber,
      episode: ep.episodeNumber,
      episodeTitle: ep.title || ''
    }));
  }

  if (source === 'radarr') {
    const eventType = String(payload.eventType || '').toLowerCase();
    if (eventType === 'test') {
      return [{ kind: 'test', source: 'radarr', title: 'Radarr connectivity test' }];
    }
    if (eventType !== 'download') return [];
    const movie = payload.movie || {};
    return [{
      kind: 'movie',
      source: 'radarr',
      tmdbId: movie.tmdbId || null,
      tvdbId: movie.tvdbId || null,
      title: movie.title || 'Unknown Movie',
      year: movie.year || null
    }];
  }

  if (source === 'plex') {
    const event = String(payload.event || '').toLowerCase();
    // We only act on new-content events. Plex ships several flavours.
    if (!['library.new', 'media.added', 'library.on.deck'].includes(event)) {
      // Plex test ping uses other event types — surface as a test for visibility.
      if (event.includes('test')) {
        return [{ kind: 'test', source: 'plex', title: 'Plex connectivity test' }];
      }
      return [];
    }
    const meta = payload.Metadata || {};
    const type = String(meta.type || '').toLowerCase();
    const guids = meta.Guid || meta.guid || [];

    if (type === 'episode') {
      return [{
        kind: 'episode',
        source: 'plex',
        tvdbId: findTvdbIdInGuids(guids) || findTvdbIdInGuids(meta.grandparentGuid ? [{ id: meta.grandparentGuid }] : []),
        tmdbId: findTmdbIdInGuids(guids),
        title: meta.grandparentTitle || meta.title || 'Unknown Show',
        season: meta.parentIndex,
        episode: meta.index,
        episodeTitle: meta.title || ''
      }];
    }
    if (type === 'movie') {
      return [{
        kind: 'movie',
        source: 'plex',
        tmdbId: findTmdbIdInGuids(guids),
        tvdbId: findTvdbIdInGuids(guids),
        title: meta.title || 'Unknown Movie',
        year: meta.year || null
      }];
    }
    return [];
  }

  return [];
}

/**
 * Find the subscribers for an extracted item.
 * Returns a deduped array of LID chatIds.
 */
function findSubscribers(item) {
  const subscriptionManager = getSubscriptionManager();
  const out = new Map(); // chatId -> {is4k}

  if (item.kind === 'episode') {
    if (item.tmdbId) {
      for (const isFourK of [false, true]) {
        for (const cid of subscriptionManager.getSubscribers(item.tmdbId, 'tv', isFourK)) {
          out.set(cid, { is4k: isFourK });
        }
      }
    }
    if (item.tvdbId) {
      for (const m of subscriptionManager.getSubscribersByTvdbId(item.tvdbId, 'tv')) {
        out.set(m.chatId, { is4k: m.is4k });
      }
    }
  } else if (item.kind === 'movie') {
    if (item.tmdbId) {
      for (const isFourK of [false, true]) {
        for (const cid of subscriptionManager.getSubscribers(item.tmdbId, 'movie', isFourK)) {
          out.set(cid, { is4k: isFourK });
        }
      }
    }
    if (item.tvdbId) {
      // rare for movies, but possible
      for (const m of subscriptionManager.getSubscribersByTvdbId(item.tvdbId, 'movie')) {
        out.set(m.chatId, { is4k: m.is4k });
      }
    }
  }

  return [...out.entries()].map(([chatId, meta]) => ({ chatId, ...meta }));
}

// Library webhooks (Plex/Sonarr/Radarr) tell us a file landed but don't
// reliably tell us its quality. We deliberately don't tag the message with
// "(4K)" or similar — the subscriber's `is4k` flag reflects what they
// requested, not what actually arrived, and conflating the two would lie
// to users who follow at one quality and have a file land at another.
function formatItemMessage(item) {
  if (item.kind === 'episode') {
    const sLabel = (item.season != null && item.episode != null)
      ? `S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}`
      : 'New episode';
    const epTitle = item.episodeTitle ? ` "${item.episodeTitle}"` : '';
    return `📺 New episode available\n\n*${item.title}*\n${sLabel}${epTitle}`;
  }
  if (item.kind === 'movie') {
    const yearPart = item.year ? ` (${item.year})` : '';
    return `🎬 Now available\n\n*${item.title}*${yearPart}`;
  }
  return null;
}

/**
 * Process a parsed library webhook payload — entry point used by the
 * Fastify route. Returns a small status summary for logging / acks.
 */
export async function handleLibraryWebhook(cfg, wahaClient, payload, logger) {
  const source = detectSource(payload);
  if (source === 'unknown') {
    logger?.warn('Library webhook: unknown payload shape', {
      keys: Object.keys(payload || {}).slice(0, 10)
    });
    return { status: 'ignored', reason: 'unknown_source' };
  }

  const items = extractItems(payload, source);
  if (items.length === 0) {
    return { status: 'ignored', source, reason: 'no_actionable_items' };
  }

  // Test pings: just log and return.
  if (items.every(i => i.kind === 'test')) {
    logger?.info(`📥 Library webhook test ping from ${source}`);
    return { status: 'ok', source, kind: 'test' };
  }

  let totalNotified = 0;
  for (const item of items) {
    if (item.kind === 'test') continue;
    const subscribers = findSubscribers(item);
    if (subscribers.length === 0) {
      logger?.debug('Library webhook: no subscribers for item', {
        source,
        kind: item.kind,
        tmdbId: item.tmdbId,
        tvdbId: item.tvdbId,
        title: item.title
      });
      continue;
    }

    logger?.info(`📬 Library webhook: notifying ${subscribers.length} subscriber${subscribers.length !== 1 ? 's' : ''} of "${item.title}" (${source}/${item.kind})`);

    for (const sub of subscribers) {
      // Don't message users who are no longer in userIdMappings — protects
      // against leaking notifications to removed users.
      try {
        const isConfigured = await isPhoneNumberConfigured(cfg, sub.chatId, wahaClient);
        if (!isConfigured) {
          logger?.info('⏭️ Skipping library notification to non-configured subscriber');
          continue;
        }
      } catch (err) {
        logger?.warn('isPhoneNumberConfigured failed for library notification', {
          ...getErrorDetails(err, 'isPhoneNumberConfiguredLibrary'),
          chatId: sub.chatId
        });
        continue;
      }

      const message = formatItemMessage(item);
      if (!message) continue;

      try {
        await sendMessage(wahaClient, cfg, sub.chatId, message);
        totalNotified++;
      } catch (err) {
        logger?.warn('Library notification send failed', {
          ...getErrorDetails(err, 'sendLibraryNotification'),
          chatId: sub.chatId,
          source,
          title: item.title
        });
      }
    }
  }

  return { status: 'ok', source, items: items.length, notified: totalNotified };
}

/**
 * Validate the optional shared-secret token. Returns null if OK, or an
 * error string when the request should be rejected.
 */
export function validateLibraryToken(cfg, request) {
  const expected = getLibraryToken(cfg);
  if (!expected) return null;
  const provided = (request.query?.token || request.headers?.['x-library-token'] || '').toString();
  return safeEqual(expected, provided) ? null : 'invalid_token';
}

// Exports for tests
export const _internal = {
  parseLibraryBody,
  detectSource,
  extractItems,
  findTvdbIdInGuids,
  findTmdbIdInGuids,
  formatItemMessage
};
