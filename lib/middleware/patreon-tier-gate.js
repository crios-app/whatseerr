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
import { getErrorDetails } from '../errors/error-formatter.js';

const HELP_TRIGGER = 'help';

/**
 * Resolves the user's email to look up in Patreon, or null when none is known.
 */
function resolvePatreonEmail(cfg, phoneNumber) {
  const userMapping = cfg.mappings?.userIdMappings?.[phoneNumber];
  if (!userMapping) return null;

  if (typeof userMapping.patreonEmail === 'string' && userMapping.patreonEmail.trim()) {
    return userMapping.patreonEmail.trim().toLowerCase();
  }

  // Fallback: reverse-lookup an email in emailMappings whose value is this
  // user's Seerr userId. emailMappings is populated automatically when Seerr
  // webhooks reference a user.
  const userId = userMapping.userId;
  if (!userId) return null;

  const emailMappings = cfg.mappings?.emailMappings || {};
  for (const [email, mappedUserId] of Object.entries(emailMappings)) {
    if (mappedUserId === userId) {
      return email.trim().toLowerCase();
    }
  }
  return null;
}

async function resolvePhoneNumber(cfg, wahaClient, chatId) {
  if (!chatId) return null;
  if (isLidFormat(chatId)) {
    const phoneChatId = await getPhoneNumberByLid(wahaClient, cfg, chatId);
    return phoneChatId ? extractPhoneNumber(phoneChatId) : null;
  }
  return extractPhoneNumber(chatId);
}

function buildUpgradeMessage(cache, cfg) {
  const allowedTiers = cache?.allowedTiers || ['Premium', 'Diamond'];
  const upgradeUrl = (cfg.patreon?.upgradeUrl || '').trim();
  const tiersText = allowedTiers.length > 1
    ? `${allowedTiers.slice(0, -1).join(', ')} or ${allowedTiers[allowedTiers.length - 1]}`
    : allowedTiers[0];

  let msg = `🔒 This bot is reserved for ${tiersText} Patreon supporters.`;
  if (upgradeUrl) {
    msg += `\n\nUpgrade or join here:\n${upgradeUrl}`;
  }
  msg += '\n\nIf you already pledged, make sure the email on your Patreon account matches the one we have on file, and try again in a few minutes.';
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

    // `help` is always allowed so users can learn how to gain access.
    const trimmed = (messageText || '').trim().toLowerCase();
    if (trimmed === HELP_TRIGGER) {
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

    // Resolve phone -> patreonEmail.
    reloadMappings(cfg, logger);
    const phoneNumber = await resolvePhoneNumber(cfg, wahaClient, chatId);
    const email = phoneNumber ? resolvePatreonEmail(cfg, phoneNumber) : null;

    let allowed = false;
    let tierTitles = null;
    if (email) {
      const result = cache.check({ email });
      allowed = result.allowed;
      tierTitles = result.tierTitles;
    }

    if (allowed) {
      logger?.debug('Patreon tier gate: allowed', {
        chatId,
        phoneNumber,
        email,
        tierTitles
      });
      return next();
    }

    logger?.info(`🔒 Patreon tier gate: blocked ${phoneNumber || chatId}${email ? ` (email: ${email})` : ' (no patreonEmail on file)'}${tierTitles ? ` — current tiers: ${tierTitles.join(', ')}` : ''}`);
    try {
      await sendMessage(wahaClient, cfg, chatId, buildUpgradeMessage(cache, cfg));
    } catch (err) {
      logger?.warn('Failed to send Patreon upgrade prompt', getErrorDetails(err, 'sendPatreonUpgradePrompt'));
    }
    context.skip = true;
  };
}
