/**
 * Patreon tier gate middleware.
 *
 * Blocks WhatsApp users whose phone number isn't linked to an active
 * Premium / Diamond Patreon supporter. Admins (`admin: true` in
 * `userIdMappings`) bypass the gate. The `help` command also bypasses
 * so users can discover what tier is required.
 *
 * Resolution order for the user's Patreon email:
 *   1. `userIdMappings[<phone>].patreonEmail` (explicit, preferred)
 *   2. Reverse lookup in `emailMappings` (Seerr-derived email for the
 *      user's Jellyseerr account) — handy when the patron uses the same
 *      email on Patreon and Jellyseerr and you don't want to maintain
 *      `patreonEmail` separately.
 *
 * Failure semantics:
 *   - Patreon config absent  -> gate disabled, everyone passes.
 *   - First Patreon refresh failed -> fail closed (block all non-admin).
 *   - Refresh failed *later* -> we keep using the last good cache snapshot.
 */

import { sendMessage } from '../waha-client.js';
import {
  extractPhoneNumber,
  isLidFormat,
  reloadMappings,
  isAdminChatId
} from '../utils.js';
import { getPhoneNumberByLid } from '../waha-client.js';
import { getPatreonTierCache } from '../patreon/tier-cache.js';
import { isOauthConfigured } from '../patreon/oauth.js';
import { getErrorDetails } from '../errors/error-formatter.js';

// Commands that always pass through the gate without a tier check.
// `help` so users can discover what's required, `link` so they can
// initiate the OAuth flow that *establishes* the link in the first place.
const ALWAYS_ALLOWED_COMMANDS = new Set(['help', 'link']);

/**
 * Resolves the user's Patreon identifiers, or null when nothing is known.
 * Preference: explicit patreonUserId (set by the OAuth `link` flow) >
 * explicit patreonEmail > Seerr-derived email from emailMappings.
 */
function resolvePatreonIdentifiers(cfg, phoneNumber) {
  const userMapping = cfg.mappings?.userIdMappings?.[phoneNumber];
  if (!userMapping) return { patreonUserId: null, email: null };

  const patreonUserId = (typeof userMapping.patreonUserId === 'string' && userMapping.patreonUserId.trim())
    ? userMapping.patreonUserId.trim()
    : null;

  let email = null;
  if (typeof userMapping.patreonEmail === 'string' && userMapping.patreonEmail.trim()) {
    email = userMapping.patreonEmail.trim().toLowerCase();
  }

  if (!email) {
    // Fallback: reverse-lookup an email in emailMappings whose value is this
    // user's Seerr userId. emailMappings is populated automatically when
    // Seerr webhooks reference a user.
    const userId = userMapping.userId;
    if (userId) {
      const emailMappings = cfg.mappings?.emailMappings || {};
      for (const [m, mappedUserId] of Object.entries(emailMappings)) {
        if (mappedUserId === userId) {
          email = m.trim().toLowerCase();
          break;
        }
      }
    }
  }

  return { patreonUserId, email };
}

async function resolvePhoneNumber(cfg, wahaClient, chatId) {
  if (!chatId) return null;
  if (isLidFormat(chatId)) {
    const phoneChatId = await getPhoneNumberByLid(wahaClient, cfg, chatId);
    return phoneChatId ? extractPhoneNumber(phoneChatId) : null;
  }
  return extractPhoneNumber(chatId);
}

function buildUpgradeMessage(cache, cfg, { hasLink, oauthAvailable }) {
  const allowedTiers = cache?.allowedTiers || ['Premium', 'Diamond'];
  const upgradeUrl = (cfg.patreon?.upgradeUrl || '').trim();
  const tiersText = allowedTiers.length > 1
    ? `${allowedTiers.slice(0, -1).join(', ')} or ${allowedTiers[allowedTiers.length - 1]}`
    : allowedTiers[0];

  let msg = `🔒 This bot is reserved for ${tiersText} Patreon supporters.`;
  if (upgradeUrl) {
    msg += `\n\nUpgrade or join here:\n${upgradeUrl}`;
  }

  if (oauthAvailable && !hasLink) {
    // No Patreon identity on file at all — the user hasn't run `link` yet,
    // and the admin hasn't manually set patreonEmail/patreonUserId.
    msg += '\n\nIf you already pledged, send `link` and I\'ll send you a one-time URL to connect your Patreon account.';
  } else {
    // We have a link/email but the patron isn't on the right tier.
    msg += '\n\nIf you just upgraded, please wait a few minutes and try again. If we have the wrong Patreon account on file, send `link` to re-link.';
  }
  return msg;
}

function buildOutageMessage() {
  return '⚠️ Patreon tier check is temporarily unavailable. Please try again in a few minutes.';
}

export function createPatreonTierGateMiddleware(wahaClient, logger) {
  return async (context, next) => {
    const cache = getPatreonTierCache();

    // Gate disabled (no config) — pass through.
    if (!cache || !cache.enabled) {
      return next();
    }

    const { cfg, chatId, messageText } = context;

    // `help` and `link` always pass — users need them to discover the
    // requirement and to establish a Patreon link respectively.
    const trimmed = (messageText || '').trim().toLowerCase();
    if (ALWAYS_ALLOWED_COMMANDS.has(trimmed)) {
      return next();
    }

    // Admins always bypass.
    try {
      if (await isAdminChatId(cfg, chatId, wahaClient, logger)) {
        return next();
      }
    } catch (err) {
      logger?.warn('Admin check failed in Patreon gate, treating as non-admin', {
        ...getErrorDetails(err, 'patreonGateAdminCheck'),
        chatId
      });
    }

    // First-refresh failure: fail closed.
    if (!cache.lastRefreshOk) {
      logger?.warn('Patreon tier gate: cache has never refreshed successfully, blocking');
      try {
        await sendMessage(wahaClient, cfg, chatId, buildOutageMessage());
      } catch (err) {
        logger?.warn('Failed to send Patreon outage message', getErrorDetails(err, 'sendPatreonOutage'));
      }
      context.skip = true;
      return;
    }

    // Resolve phone -> patreonUserId / patreonEmail.
    reloadMappings(cfg, logger);
    const phoneNumber = await resolvePhoneNumber(cfg, wahaClient, chatId);
    const ids = phoneNumber
      ? resolvePatreonIdentifiers(cfg, phoneNumber)
      : { patreonUserId: null, email: null };

    let allowed = false;
    let tierTitles = null;
    if (ids.patreonUserId || ids.email) {
      // patreonUserId is the more reliable key; email is the fallback so
      // a manual `patreonEmail` entry still works.
      const result = cache.check({ patreonUserId: ids.patreonUserId, email: ids.email });
      allowed = result.allowed;
      tierTitles = result.tierTitles;
    }

    if (allowed) {
      logger?.debug('Patreon tier gate: allowed', {
        chatId,
        phoneNumber,
        patreonUserId: ids.patreonUserId,
        email: ids.email,
        tierTitles
      });
      return next();
    }

    const hasLink = !!(ids.patreonUserId || ids.email);
    const reason = hasLink
      ? `tiers: ${tierTitles ? tierTitles.join(', ') : 'none'}`
      : 'no Patreon link on file';
    logger?.info(`🔒 Patreon tier gate: blocked ${phoneNumber || chatId} (${reason})`);

    try {
      await sendMessage(wahaClient, cfg, chatId,
        buildUpgradeMessage(cache, cfg, {
          hasLink,
          oauthAvailable: isOauthConfigured(cfg)
        })
      );
    } catch (err) {
      logger?.warn('Failed to send Patreon upgrade prompt', getErrorDetails(err, 'sendPatreonUpgradePrompt'));
    }
    context.skip = true;
  };
}
