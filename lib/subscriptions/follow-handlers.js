/**
 * Follow / unfollow selection handlers.
 *
 * Called from `selection-command.js` when the user picks a number after
 * issuing the `follow` or `unfollow` command. Kept out of the request flow
 * because they don't talk to Jellyseerr's request API at all.
 */

import { sendMessage } from '../waha-client.js';
import { getMediaDetails, formatMedia, formatMediaType, formatQualityText } from '../request.js';
import { getSubscriptionManager } from './subscription-manager.js';
import { getErrorDetails } from '../errors/error-formatter.js';
import { MEDIA_TYPE_MOVIE, MEDIA_TYPE_TV } from '../constants.js';

/**
 * User picked a media item from `follow <title>` results — subscribe them
 * to availability notifications without creating a Seerr request.
 */
export async function handleFollowSelection(cfg, jellyseerrClient, wahaClient, chatId, media, logger) {
  const { title, year, typeStr } = formatMedia(media);
  const isTvShow = typeStr === 'TV Show' || media.mediaType === 2 || media.mediaType === 'tv';
  const mediaTypeNum = isTvShow ? MEDIA_TYPE_TV : MEDIA_TYPE_MOVIE;

  // Pull tvdbId for TV when possible — needed so Plex/Sonarr webhooks
  // (which carry TVDB ids) can match this subscription.
  let tvdbId = null;
  if (isTvShow) {
    try {
      const details = await getMediaDetails(jellyseerrClient, cfg, media.id, mediaTypeNum, logger);
      tvdbId = details?.externalIds?.tvdbId
        || details?.mediaInfo?.tvdbId
        || null;
    } catch (err) {
      logger?.warn('Could not fetch tvdbId for follow', {
        ...getErrorDetails(err, 'getMediaDetailsForFollow'),
        mediaId: media.id
      });
    }
  }

  try {
    const subscriptionManager = getSubscriptionManager();
    const added = subscriptionManager.addSubscription(
      media.id,
      mediaTypeNum,
      false, // standard quality follow (4K follow not yet exposed)
      chatId,
      title,
      year,
      typeStr,
      { tvdbId, persistent: true }
    );

    const icon = isTvShow ? '📺' : '🎬';
    if (added) {
      const verb = isTvShow ? 'new episodes are added' : 'it becomes available';
      await sendMessage(wahaClient, cfg, chatId,
        `🔔 Following ${icon} ${title} (${year})\n\nYou'll be notified when ${verb}.\n\nUse "subs" to view, "unfollow ${title}" to stop.`
      );
      logger?.info(`🔔 Follow added: "${title}"${formatQualityText(false)}`);
    } else {
      // Already subscribed — addSubscription returns false in that case.
      // The flag may have been promoted to persistent, which is fine.
      await sendMessage(wahaClient, cfg, chatId,
        `🔔 You're already following ${icon} ${title} (${year}).\n\nUse "subs" to view, "unfollow ${title}" to stop.`
      );
    }
    return { success: true };
  } catch (err) {
    logger?.error('Failed to add follow subscription', {
      ...getErrorDetails(err, 'addFollowSubscription'),
      chatId,
      mediaId: media.id
    });
    try {
      await sendMessage(wahaClient, cfg, chatId,
        '❌ An error occurred while following. Please try again later.'
      );
    } catch {}
    return { success: false };
  }
}

/**
 * User picked a media item from the unfollow list — remove the subscription.
 * `subscription` is the entry returned by `getUserSubscriptions()`.
 */
export async function handleUnfollowSelection(cfg, wahaClient, chatId, subscription, logger) {
  const subscriptionManager = getSubscriptionManager();
  const { mediaId, mediaType, is4k, title, year } = subscription;
  const typeNum = mediaType === 'movie' ? MEDIA_TYPE_MOVIE : MEDIA_TYPE_TV;
  const removed = subscriptionManager.removeSubscription(
    mediaId,
    typeNum,
    is4k,
    chatId,
    { forceRemovePersistent: true }
  );

  const icon = mediaType === 'movie' ? '🎬' : '📺';
  const titleStr = title || `${formatMediaType(typeNum)} ${mediaId}`;
  const yearStr = year ? ` (${year})` : '';

  try {
    if (removed) {
      await sendMessage(wahaClient, cfg, chatId,
        `🔕 Unfollowed ${icon} ${titleStr}${yearStr}${formatQualityText(is4k)}\n\nYou will no longer be notified about this title.`
      );
      logger?.info(`🔕 Unfollow: "${titleStr}"${formatQualityText(is4k)}`);
    } else {
      await sendMessage(wahaClient, cfg, chatId,
        `ℹ️ You weren't following ${icon} ${titleStr}${yearStr} anymore.`
      );
    }
  } catch (err) {
    logger?.error('Failed to send unfollow confirmation', {
      ...getErrorDetails(err, 'sendUnfollowConfirmation'),
      chatId
    });
  }
  return { success: true };
}
