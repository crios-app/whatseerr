/**
 * Command registry and router
 */

import { HelpCommand } from './help-command.js';
import { SearchCommand } from './search-command.js';
import { ApprovalCommand } from './approval-command.js';
import { AgentCommand } from './agent-command.js';
import { SelectionCommand } from './selection-command.js';
import { SubscriptionsCommand } from './subscriptions-command.js';
import { FollowCommand } from './follow-command.js';
import { UnfollowCommand } from './unfollow-command.js';
import { CalendarCommand } from './calendar-command.js';

class CommandRegistry {
  constructor() {
    this.commands = [];
  }

  /**
   * Register a command
   */
  register(command) {
    this.commands.push(command);
  }

  /**
   * Register all default commands
   */
  registerDefaults() {
    // Register in priority order (most specific first)
    // Selection command should be checked before search to handle numeric selections
    this.register(new SelectionCommand());
    this.register(new ApprovalCommand());
    this.register(new HelpCommand());
    this.register(new AgentCommand());
    this.register(new SubscriptionsCommand());
    this.register(new CalendarCommand());
    // Follow / unfollow are more specific than search and must come first.
    // (Without this, "follow" would never match if its prefix overlapped a
    // configured search command.)
    this.register(new FollowCommand());
    this.register(new UnfollowCommand());
    this.register(new SearchCommand()); // Search should be last as it's most generic
  }

  /**
   * Find matching command for a message
   */
  findCommand(messageText, context) {
    for (const command of this.commands) {
      const matchResult = command.match(messageText, context);
      if (matchResult) {
        return { command, matchResult };
      }
    }
    return null;
  }

  /**
   * Execute a command
   */
  async executeCommand(command, matchResult, context) {
    // Merge match result into context
    context.matchResult = matchResult;
    
    // Validate command
    await command.validate(context);
    
    // Execute command
    await command.execute(context);
  }
}

// Export singleton instance
let commandRegistry = null;

export function createCommandRegistry() {
  if (!commandRegistry) {
    commandRegistry = new CommandRegistry();
    commandRegistry.registerDefaults();
  }
  return commandRegistry;
}

export function getCommandRegistry() {
  if (!commandRegistry) {
    return createCommandRegistry();
  }
  return commandRegistry;
}

