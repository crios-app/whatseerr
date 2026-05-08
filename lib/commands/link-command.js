/**
 * `link` command — kicks off the Patreon OAuth flow so a patron can prove
 * which Patreon account belongs to their WhatsApp number.
 *
 * The user replies `link`, the bot generates a one-time state token,
 * remembers which chat issued it, and sends back a Patreon authorization
 * URL. When the user clicks "Allow", Patreon redirects them to our
 * `/patreon/callback` endpoint, which finishes the link.
 */

import { BaseCommand } from './base-command.js';
import { sendMessage } from '../waha-client.js';
import { isOauthConfigured, buildAuthUrl } from '../patreon/oauth.js';
import { getOAuthStateCache } from '../patreon/oauth-state.js';
import { getErrorDetails } from '../errors/error-formatter.js';

export class LinkCommand extends BaseCommand {
  constructor() {
    super('link', 'Link your WhatsApp number to your Patreon account');
  }

  match(messageText) {
    const trimmed = (messageText || '').trim().toLowerCase();
    if (trimmed === 'link') {
      return { matched: true, command: 'link' };
    }
    return null;
  }

  async execute(context) {
    const { cfg, chatId, wahaClient, logger } = context;

    if (!isOauthConfigured(cfg)) {
      logger?.warn('Link command invoked but Patreon OAuth is not configured');
      try {
        await sendMessage(wahaClient, cfg, chatId,
          '⚠️ Patreon linking is not configured on this bot. Please contact the admin.'
        );
      } catch {}
      return;
    }

    try {
      const stateCache = getOAuthStateCache();
      const state = stateCache.issue(chatId);
      const url = buildAuthUrl(cfg, state);

      const message = '🔗 To link your WhatsApp number to your Patreon account, click this one-time link and choose "Allow":\n\n'
        + url
        + '\n\nThis link expires in ~10 minutes. Once you authorize, I\'ll automatically link your account and you can start using the bot.';

      await sendMessage(wahaClient, cfg, chatId, message);
      logger?.info(`🔗 Issued Patreon link URL for chat ${chatId}`);
    } catch (err) {
      logger?.error('Failed to start Patreon link flow', {
        ...getErrorDetails(err, 'linkCommand'),
        chatId
      });
      try {
        await sendMessage(wahaClient, cfg, chatId,
          '❌ Could not start the Patreon link flow. Please try again later.'
        );
      } catch {}
    }
  }
}
