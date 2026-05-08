/**
 * Follow command - search for media and subscribe to notifications without
 * creating a Seerr request. Useful when the user wants to be notified about
 * future seasons / availability without queuing a download right now.
 */

import { BaseCommand } from './base-command.js';
import { sendMessage } from '../waha-client.js';
import { searchTitle } from '../request.js';
import { formatSearchResults } from '../message-formatters.js';
import { parseCommands } from '../command-parser.js';
import { RESULTS_PER_PAGE } from '../constants.js';
import { getStateManager } from '../state/cache-state.js';
import { getQueueManager } from '../queue/message-queue.js';
import { getErrorDetails } from '../errors/error-formatter.js';

const FOLLOW_COMMANDS_DEFAULT = ['follow', 'f'];

function getFollowCommands(cfg) {
  const configured = cfg?.commands?.followCommand;
  return configured ? parseCommands(configured) : FOLLOW_COMMANDS_DEFAULT;
}

function extractFollowQuery(messageText, commands) {
  const trimmed = messageText.trim();
  // Sort longest-first so 'follow' wins over 'f' when both are configured.
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

export class FollowCommand extends BaseCommand {
  constructor() {
    super('follow', 'Follow a movie or TV show to receive notifications');
  }

  match(messageText, context) {
    const commands = getFollowCommands(context.cfg);
    const result = extractFollowQuery(messageText, commands);
    if (!result) return null;
    return {
      matched: true,
      command: 'follow',
      query: result.query,
      matchedCommand: result.matchedCommand
    };
  }

  async execute(context) {
    const { cfg, chatId, wahaClient, jellyseerrClient, logger, matchResult } = context;
    const { query, matchedCommand } = matchResult;
    const stateManager = getStateManager();

    stateManager.validateFlowState(chatId);

    if (!query || query.trim().length === 0) {
      logger?.info(`💬 User: "${matchedCommand}" (no title provided)`);
      try {
        await sendMessage(wahaClient, cfg, chatId,
          `💬 ${matchedCommand} <name>\nExample: ${matchedCommand} Severance`
        );
      } catch (err) {
        logger?.error('Error sending empty follow help message', {
          ...getErrorDetails(err, 'sendEmptyFollowHelp'),
          chatId
        });
      }
      return;
    }

    if (!stateManager.tryAcquireFlowLock(chatId)) {
      const currentResults = stateManager.getUserResults(chatId);
      const currentQuery = currentResults?.query || 'current request';
      try {
        await sendMessage(wahaClient, cfg, chatId,
          `⏳ Please finish your current "${currentQuery}" request before starting a new follow.\n\nSend 0 to cancel.`
        );
      } catch (err) {
        logger?.error('Error sending active flow message', {
          ...getErrorDetails(err, 'sendActiveFlowMessage'),
          chatId
        });
      }
      return;
    }

    try {
      logger?.info(`🔍 Follow search: "${query}"`);
      await sendMessage(wahaClient, cfg, chatId, '🔍 Searching...');

      const queueManager = getQueueManager();
      const candidates = await queueManager.addApiTask(async () => {
        return await searchTitle(jellyseerrClient, cfg, query, null, null, logger);
      });

      if (!candidates || candidates.length === 0) {
        logger?.info(`❌ No follow results for: "${query}"`);
        await sendMessage(wahaClient, cfg, chatId, '❌ No results found. Try different keywords');
        stateManager.clearUserFlow(chatId);
        return;
      }

      const formatted = formatSearchResults(candidates, query, RESULTS_PER_PAGE, 0);
      // Replace the trailing prompt to clarify intent
      const followMessage = formatted.message.replace(
        /\n📥 Reply with a number to request\.$/,
        '\n🔔 Reply with a number to follow.'
      );

      await sendMessage(wahaClient, cfg, chatId, followMessage);
      stateManager.setPromptSentAt(chatId, Date.now());

      stateManager.setUserResults(chatId, {
        results: candidates,
        is4k: false,
        offset: 0,
        query,
        mode: 'follow'
      });
    } catch (err) {
      logger?.error(`Error during follow search "${query}"`, {
        ...getErrorDetails(err, 'followSearch'),
        query
      });
      await sendMessage(wahaClient, cfg, chatId,
        `❌ Search error: ${err?.message || 'Failed to search'}`
      );
      stateManager.clearUserFlow(chatId);
    }
  }
}
