/**
 * Calendar command - shows upcoming episodes / releases for the user's
 * followed (subscribed) media. Pulls fresh details from Jellyseerr so
 * `nextEpisodeToAir` is current.
 */

import { BaseCommand } from './base-command.js';
import { sendMessage } from '../waha-client.js';
import { parseCommands } from '../command-parser.js';
import { getSubscriptionManager } from '../subscriptions/subscription-manager.js';
import { getMediaDetails, formatQualityText } from '../request.js';
import { getQueueManager } from '../queue/message-queue.js';
import { getErrorDetails } from '../errors/error-formatter.js';
import { MEDIA_TYPE_MOVIE, MEDIA_TYPE_TV } from '../constants.js';

const CALENDAR_COMMANDS_DEFAULT = ['calendar', 'cal'];

function getCalendarCommands(cfg) {
  const configured = cfg?.commands?.calendarCommand;
  return configured ? parseCommands(configured) : CALENDAR_COMMANDS_DEFAULT;
}

function commandMatches(messageText, commands) {
  const trimmed = messageText?.toLowerCase().trim();
  if (!trimmed) return false;
  return commands.some(cmd => trimmed === cmd.toLowerCase());
}

/**
 * Parses an ISO-style date (YYYY-MM-DD) into a Date at UTC midnight, or null.
 */
function parseDate(input) {
  if (!input || typeof input !== 'string') return null;
  // Accept YYYY-MM-DD; tolerate longer ISO strings.
  const m = input.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatHumanDate(date) {
  // Avoid locale surprises in tests/containers — format as e.g. "Tue, 28 May 2026".
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[date.getUTCDay()]}, ${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function daysUntil(date) {
  const today = new Date();
  const utcToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const diff = Math.round((date.getTime() - utcToday) / (1000 * 60 * 60 * 24));
  return diff;
}

function formatRelative(days) {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 0) return `${-days}d ago`;
  return `in ${days}d`;
}

export class CalendarCommand extends BaseCommand {
  constructor() {
    super('calendar', 'Show upcoming episodes / releases for media you follow');
  }

  match(messageText, context) {
    const commands = getCalendarCommands(context.cfg);
    if (commandMatches(messageText, commands)) {
      return { matched: true, command: 'calendar' };
    }
    return null;
  }

  async execute(context) {
    const { cfg, chatId, wahaClient, jellyseerrClient, logger } = context;
    const subscriptionManager = getSubscriptionManager();
    const subs = subscriptionManager.getUserSubscriptions(chatId);

    if (subs.length === 0) {
      await sendMessage(wahaClient, cfg, chatId,
        '📅 Your calendar is empty.\n\nUse "follow <title>" to start tracking a movie or show.'
      );
      return;
    }

    logger?.info(`📅 Building calendar for ${subs.length} subscription${subs.length !== 1 ? 's' : ''}`);

    if (subs.length > 5) {
      // Best-effort heads-up so the user knows we're working on it; we
      // don't care whether the heads-up itself succeeds.
      try {
        await sendMessage(wahaClient, cfg, chatId,
          `📅 Building calendar for ${subs.length} followed item${subs.length !== 1 ? 's' : ''}...`
        );
      } catch {}
    }

    const queueManager = getQueueManager();
    const today = new Date();
    const utcToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

    const upcoming = [];
    const errors = [];

    // Fetch details serially through the API queue so we don't hammer Jellyseerr.
    for (const sub of subs) {
      try {
        const typeNum = sub.mediaType === 'movie' ? MEDIA_TYPE_MOVIE : MEDIA_TYPE_TV;
        const details = await queueManager.addApiTask(async () => {
          return await getMediaDetails(jellyseerrClient, cfg, sub.mediaId, typeNum, logger);
        });

        if (sub.mediaType === 'movie') {
          const date = parseDate(details?.releaseDate);
          if (date && date.getTime() >= utcToday) {
            upcoming.push({
              date,
              kind: 'movie',
              title: sub.title || details?.title || `Movie ${sub.mediaId}`,
              year: sub.year || (details?.releaseDate ? details.releaseDate.slice(0, 4) : ''),
              is4k: sub.is4k,
              detail: 'Theatrical / digital release'
            });
          }
        } else {
          const next = details?.nextEpisodeToAir;
          const nextDate = parseDate(next?.airDate || next?.air_date);
          if (next && nextDate && nextDate.getTime() >= utcToday) {
            const seasonNum = next.seasonNumber ?? next.season_number;
            const episodeNum = next.episodeNumber ?? next.episode_number;
            const epLabel = (seasonNum != null && episodeNum != null)
              ? `S${String(seasonNum).padStart(2, '0')}E${String(episodeNum).padStart(2, '0')}`
              : 'Next episode';
            const epTitle = next.name ? ` "${next.name}"` : '';
            upcoming.push({
              date: nextDate,
              kind: 'tv',
              title: sub.title || details?.name || `TV ${sub.mediaId}`,
              year: sub.year || '',
              is4k: sub.is4k,
              detail: `${epLabel}${epTitle}`
            });
          }
        }
      } catch (err) {
        errors.push({ mediaId: sub.mediaId, title: sub.title });
        logger?.warn('Failed to fetch calendar details for subscription', {
          ...getErrorDetails(err, 'getMediaDetailsForCalendar'),
          mediaId: sub.mediaId,
          mediaType: sub.mediaType
        });
      }
    }

    if (upcoming.length === 0) {
      const errPart = errors.length > 0
        ? `\n\n⚠️ Could not fetch details for ${errors.length} item${errors.length !== 1 ? 's' : ''}.`
        : '';
      await sendMessage(wahaClient, cfg, chatId,
        `📅 No upcoming episodes or releases for your ${subs.length} followed item${subs.length !== 1 ? 's' : ''}.${errPart}`
      );
      return;
    }

    upcoming.sort((a, b) => a.date.getTime() - b.date.getTime());

    const lines = ['📅 Upcoming for your follows:\n'];
    let lastDate = null;
    for (const item of upcoming) {
      const ts = item.date.getTime();
      if (ts !== lastDate) {
        lines.push(`\n📆 ${formatHumanDate(item.date)} (${formatRelative(daysUntil(item.date))})`);
        lastDate = ts;
      }
      const icon = item.kind === 'movie' ? '🎬' : '📺';
      const yearPart = item.year ? ` (${item.year})` : '';
      lines.push(`  ${icon} ${item.title}${yearPart}${formatQualityText(item.is4k)} — ${item.detail}`);
    }

    if (errors.length > 0) {
      lines.push(`\n⚠️ Could not fetch details for ${errors.length} item${errors.length !== 1 ? 's' : ''}.`);
    }

    await sendMessage(wahaClient, cfg, chatId, lines.join('\n'));
    logger?.info(`📅 Calendar sent: ${upcoming.length} upcoming item${upcoming.length !== 1 ? 's' : ''}`);
  }
}
