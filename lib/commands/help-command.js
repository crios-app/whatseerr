/**
 * Help command - displays available commands
 */

import { BaseCommand } from './base-command.js';
import { sendMessage } from '../waha-client.js';
import { getUsernameFromChatId } from '../utils.js';
import { parseCommands } from '../command-parser.js';

export class HelpCommand extends BaseCommand {
  constructor() {
    super('help', 'Display help information');
  }

  match(messageText, context) {
    const trimmed = messageText?.toLowerCase().trim();
    if (trimmed === 'help') {
      return { matched: true, command: 'help' };
    }
    return null;
  }

  async execute(context) {
    const { cfg, chatId, wahaClient, logger } = context;
    
    // Get username from mappings if available
    const username = await getUsernameFromChatId(cfg, chatId, wahaClient);
    
    // Build help message
    const greeting = username ? `👋 Hello ${username}!\n\n` : '👋 Hello!\n\n';
    let helpText = greeting;
    
    helpText += '📌 Available Commands:\n\n';
    
    // Parse commands
    const searchCommands = parseCommands(cfg.commands?.command || '');
    const searchCommands4k = parseCommands(cfg.commands?.command4k || '');
    
    // Standard request section
    const primaryCommand = searchCommands[0] || 'r';
    helpText += `🎬 Standard Request:\n\n${primaryCommand} <title>\nExample: ${primaryCommand} Matrix\n`;
    
    // 4K request section (if configured and help4k is enabled)
    if (cfg.commands?.help4k && searchCommands4k.length > 0) {
      const fourKExample = searchCommands4k[0];
      helpText += `\n🖥️ 4K Request:\n\n${fourKExample} <title>\nExample: ${fourKExample} Matrix\n`;
    }
    
    // helpText += '\n📝 Just type the command followed by the movie or show title.';
    helpText += '\n\n📋 Other Commands:\n';
    helpText += '\n• "follow <title>" - Follow a movie/show for notifications';
    helpText += '\n• "unfollow [title]" - Stop following (omit title to pick from list)';
    helpText += '\n• "calendar" - Upcoming episodes / releases you follow';
    helpText += '\n• "subs" - View your active notifications';
    helpText += '\n• "agent" - Speak with an agent';
    helpText += '\n• "help" - Show this help message';
    
    await sendMessage(wahaClient, cfg, chatId, helpText);
    logger?.info('💬 Help requested');
  }
}

