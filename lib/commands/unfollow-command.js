/**
 * Unfollow command - lists the user's subscriptions (optionally filtered by
 * a title substring) and lets them remove one by replying with a number.
 */

import { BaseCommand } from './base-command.js';
import { sendMessage } from '../waha-client.js';
import { parseCommands } from '../command-parser.js';
import { getStateManager } from '../state/cache-state.js';
import { getSubscriptionManager } from '../subscriptions/subscription-manager.js';
import { numberToEmoji } from '../message-formatters.js';
import { formatQualityText } from '../request.js';
import { getErrorDetails } from '../errors/error-formatter.js';
import { RESULTS_PER_PAGE } from '../constants.js';

const UNFOLLOW_COMMANDS_DEFAULT = ['unfollow', 'uf'];

function getUnfollowCommands(cfg) {
  const configured = cfg?.commands?.unfollowCommand;
  return configured ? parseCommands(configured) : UNFOLLOW_COMMANDS_DEFAULT;
}

function extractUnfollowQuery(messageText, commands) {
  const trimmed = messageText.trim();
  const sorted = [...commands].sort((a, b) => b.length - a.length);
  for (const cmd of sorted) {
    const lc = cmd.toLowerCase();
    const lcTrim = trimmed.toLowerCase();
    if (lcTrim.startsWith(lc)) {
      const after = trimmed.slice(cmd.length);
      if (after.length === 0 || after[0] === ' ') {
        return { query: after.trim(), matchedCommand: cmd };
      }
    }
  }
  return null;
}

export class UnfollowCommand extends BaseCommand {
  constructor() {
    super('unfollow', 'Unfollow a movie or TV show');
  }

  match(messageText, context) {
    const commands = getUnfollowCommands(context.cfg);
    const result = extractUnfollowQuery(messageText, commands);
    if (!result) return null;
    return {
      matched: true,
      command: 'unfollow',
      query: result.query,
      matchedCommand: result.matchedCommand
    };
  }

  async execute(context) {
    const { cfg, chatId, wahaClient, logger, matchResult } = context;
    const { query } = matchResult;
    const stateManager = getStateManager();
    stateManager.validateFlowState(chatId);

    const subscriptionManager = getSubscriptionManager();
    let subs = subscriptionManager.getUserSubscriptions(chatId);

    if (subs.length === 0) {
      await sendMessage(wahaClient, cfg, chatId,
        '📋 You have no active notifications.\n\nUse "follow <title>" to start following a movie or show.'
      );
      return;
    }

    if (query) {
      const needle = query.toLowerCase();
      subs = subs.filter(s => (s.title || '').toLowerCase().includes(needle));
      if (subs.length === 0) {
        await sendMessage(wahaClient, cfg, chatId,
          `❌ No followed media matches "${query}".\n\nSend "subs" to see all your notifications.`
        );
        return;
      }
    }

    if (!stateManager.tryAcquireFlowLock(chatId)) {
      const current = stateManager.getUserResults(chatId);
      const currentQuery = current?.query || 'current request';
      await sendMessage(wahaClient, cfg, chatId,
        `⏳ Please finish your current "${currentQuery}" request before unfollowing.\n\nSend 0 to cancel.`
      );
      return;
    }

    try {
      // Cap the displayed list at RESULTS_PER_PAGE; surface a hint if there's
      // more so the user can narrow with a substring query.
      const truncated = subs.length > RESULTS_PER_PAGE;
      const visible = truncated ? subs.slice(0, RESULTS_PER_PAGE) : subs;

      const lines = visible.map((s, idx) => {
        const num = numberToEmoji(idx + 1);
        const icon = s.mediaType === 'movie' ? '🎬' : '📺';
        const year = s.year ? ` (${s.year})` : '';
        return `${num}${icon} ${s.title || `Media ${s.mediaId}`}${year}${formatQualityText(s.is4k)}`;
      });

      const headline = query
        ? `🔕 Pick one to unfollow (matching "${query}"):`
        : '🔕 Pick one to unfollow:';
      let body = `${headline}\n\n${lines.join('\n')}\n\n0️⃣ Cancel`;
      if (truncated) {
        body += `\n\nℹ️ Showing first ${RESULTS_PER_PAGE} of ${subs.length}. Use "unfollow <title>" to filter.`;
      }

      await sendMessage(wahaClient, cfg, chatId, body);
      stateManager.setPromptSentAt(chatId, Date.now());

      stateManager.setUserResults(chatId, {
        results: visible,
        offset: 0,
        query: query || '',
        mode: 'unfollow'
      });
    } catch (err) {
      logger?.error('Error showing unfollow list', {
        ...getErrorDetails(err, 'showUnfollowList'),
        chatId
      });
      stateManager.clearUserFlow(chatId);
      try {
        await sendMessage(wahaClient, cfg, chatId,
          '❌ An error occurred. Please try again later.'
        );
      } catch {}
    }
  }
}
