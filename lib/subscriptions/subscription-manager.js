/**
 * Subscription Manager for Media Notification Subscriptions
 *
 * Handles persistent storage of user subscriptions to media availability notifications.
 * Subscriptions are stored in a separate JSON file for persistence across restarts.
 *
 * Format structure:
 * Key format: "mediaId:type:quality" (e.g., "307962:tv:standard")
 * {
 *   "key": {
 *     "title": "Show Title",
 *     "year": "2024",
 *     "typeStr": "TV Show",
 *     "tvdbId": 12345,
 *     "subscribers": [
 *       {
 *         "lid": "151169980723349@lid",
 *         "phoneNumber": "96566674323",
 *         "userId": 1,
 *         "username": "User",
 *         "persistent": true
 *       }
 *     ]
 *   }
 * }
 *
 * `persistent: true` marks subscribers added via the `follow` command — these
 * are NOT auto-removed by the Seerr availability webhook so users keep getting
 * notified about future seasons / sequels.
 */

import fs from 'fs';
import path from 'path';
import { getConfigPath, reloadMappings } from '../utils.js';
import { getErrorDetails } from '../errors/error-formatter.js';
import { extractPhoneNumber, getLidFromPhoneNumber } from '../utils.js';
import { formatQualityText, formatMediaType } from '../request.js';

/**
 * Gets the subscriptions file path (same location as config.json)
 * @returns {string} Path to subscriptions.json
 */
function getSubscriptionsPath() {
  const configPath = getConfigPath();
  const configDir = path.dirname(configPath);
  return path.join(configDir, 'subscriptions.json');
}

/**
 * Creates a subscription key from media details
 * @param {number} mediaId - Media ID (TMDB ID)
 * @param {string|number} mediaType - Media type ('movie'|'tv' or 1|2)
 * @param {boolean} is4k - Whether this is a 4K subscription
 * @returns {string} Subscription key
 */
function createSubscriptionKey(mediaId, mediaType, is4k) {
  // Normalize mediaType to string
  const type = typeof mediaType === 'number' 
    ? (mediaType === 1 ? 'movie' : 'tv')
    : mediaType;
  return `${mediaId}:${type}:${is4k ? '4k' : 'standard'}`;
}

/**
 * Gets chat IDs from a subscription entry
 * @param {Object} entry - Subscription entry
 * @returns {string[]} Array of chat IDs (LIDs)
 */
function getChatIdsFromEntry(entry) {
  return entry.subscribers?.map(sub => sub.lid).filter(Boolean) || [];
}

class SubscriptionManager {
  constructor(logger = null, cfg = null) {
    this.logger = logger;
    this.cfg = cfg;
    this.subscriptionsPath = getSubscriptionsPath();
    this.subscriptions = {}; // In-memory cache: { key: entry }
    this.loadSubscriptions();
  }

  /**
   * Loads subscriptions from file into memory
   */
  loadSubscriptions() {
    try {
      if (fs.existsSync(this.subscriptionsPath)) {
        const content = fs.readFileSync(this.subscriptionsPath, 'utf8');
        const data = JSON.parse(content);
        this.subscriptions = data.subscriptions || {};
        
        this.logger?.debug('Loaded subscriptions from file', {
          path: this.subscriptionsPath,
          count: Object.keys(this.subscriptions).length
        });
      } else {
        this.subscriptions = {};
        this.logger?.debug('Subscriptions file not found, starting with empty subscriptions', {
          path: this.subscriptionsPath
        });
      }
    } catch (err) {
      this.logger?.warn('Failed to load subscriptions file', {
        ...getErrorDetails(err, 'loadSubscriptions'),
        path: this.subscriptionsPath
      });
      this.subscriptions = {};
    }
  }

  /**
   * Saves subscriptions to file
   * @returns {boolean} True if successful, false otherwise
   */
  saveSubscriptions() {
    try {
      // Ensure directory exists before writing
      const dir = path.dirname(this.subscriptionsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      const data = {
        subscriptions: this.subscriptions,
        lastUpdated: new Date().toISOString()
      };
      fs.writeFileSync(this.subscriptionsPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
      this.logger?.debug('Saved subscriptions to file', {
        path: this.subscriptionsPath,
        count: Object.keys(this.subscriptions).length
      });
      return true;
    } catch (err) {
      this.logger?.warn('Failed to save subscriptions file', {
        ...getErrorDetails(err, 'saveSubscriptions'),
        path: this.subscriptionsPath
      });
      return false;
    }
  }

  /**
   * Adds a subscription for a user to receive notifications for specific media
   * @param {number} mediaId - Media ID (TMDB ID)
   * @param {string|number} mediaType - Media type ('movie'|'tv' or 1|2)
   * @param {boolean} is4k - Whether this is a 4K subscription
   * @param {string} chatId - User's chat ID (LID format)
   * @param {string} title - Optional media title
   * @param {string|null} year - Optional media year
   * @param {string|null} typeStr - Optional media type string ('Movie' or 'TV Show')
   * @param {Object} [extras] - Optional extras: { tvdbId, persistent }
   * @returns {boolean} True if subscription was added, false if already exists
   */
  addSubscription(mediaId, mediaType, is4k, chatId, title = '', year = null, typeStr = null, extras = {}) {
    if (!mediaId || !chatId) {
      this.logger?.warn('Invalid parameters for addSubscription', { mediaId, chatId });
      return false;
    }

    const { tvdbId = null, persistent = false } = extras;
    const key = createSubscriptionKey(mediaId, mediaType, is4k);

    // Initialize entry if it doesn't exist
    if (!this.subscriptions[key]) {
      this.subscriptions[key] = {
        title: title || '',
        year: year || null,
        typeStr: typeStr || null,
        tvdbId: tvdbId || null,
        subscribers: []
      };
    }

    const entry = this.subscriptions[key];

    // Check if already subscribed
    const existingSubscriber = entry.subscribers.find(sub => sub.lid === chatId);
    if (existingSubscriber) {
      this.logger?.debug('User already subscribed', { key, chatId });
      // Update metadata if provided and different
      let updated = false;
      if (title && title !== entry.title) {
        entry.title = title;
        updated = true;
      }
      if (year && year !== entry.year) {
        entry.year = year;
        updated = true;
      }
      if (typeStr && typeStr !== entry.typeStr) {
        entry.typeStr = typeStr;
        updated = true;
      }
      if (tvdbId && tvdbId !== entry.tvdbId) {
        entry.tvdbId = tvdbId;
        updated = true;
      }
      // Promote to persistent on re-subscribe via follow command (never demote)
      if (persistent && existingSubscriber.persistent !== true) {
        existingSubscriber.persistent = true;
        updated = true;
      }
      if (updated) {
        this.saveSubscriptions();
      }
      return false;
    }

    // Create subscriber object
    const subscriber = { lid: chatId };
    if (persistent) {
      subscriber.persistent = true;
    }

    // Try to enrich with user info from config
    if (this.cfg?.lidMappings) {
      // Reverse lookup: find phoneChatId that maps to this lid
      for (const [phoneChatId, mappedLid] of Object.entries(this.cfg.mappings?.lidMappings || {})) {
        if (mappedLid === chatId) {
          const phoneNumber = extractPhoneNumber(phoneChatId);
          if (phoneNumber) {
            subscriber.phoneNumber = phoneNumber;

            // Reload mappings from file to get latest changes (dynamic mapping updates)
            if (this.cfg && this.logger) {
              reloadMappings(this.cfg, this.logger);
            }

            // Get userId and username from userIdMappings
            const userIdMappings = this.cfg.mappings?.userIdMappings || {};
            const userMapping = userIdMappings[phoneNumber];
            if (userMapping) {
              subscriber.userId = userMapping.userId;
              subscriber.username = userMapping.username || '';
            }
          }
          break;
        }
      }
    }

    entry.subscribers.push(subscriber);

    // Update metadata if provided and different
    if (title && title !== entry.title) {
      entry.title = title;
    }
    if (year && year !== entry.year) {
      entry.year = year;
    }
    if (typeStr && typeStr !== entry.typeStr) {
      entry.typeStr = typeStr;
    }
    if (tvdbId && tvdbId !== entry.tvdbId) {
      entry.tvdbId = tvdbId;
    }
    
    this.saveSubscriptions();
    
    this.logger?.info(`🔔 Subscription added (${entry.subscribers.length} subscriber${entry.subscribers.length !== 1 ? 's' : ''})`);
    return true;
  }

  /**
   * Removes a subscription for a user
   * @param {number} mediaId - Media ID (TMDB ID)
   * @param {string|number} mediaType - Media type ('movie'|'tv' or 1|2)
   * @param {boolean} is4k - Whether this is a 4K subscription
   * @param {string} chatId - User's chat ID (LID format)
   * @param {Object} [options] - Options: { forceRemovePersistent }
   * @returns {boolean} True if subscription was removed, false if it didn't exist
   *                    or was skipped because it's persistent
   */
  removeSubscription(mediaId, mediaType, is4k, chatId, options = {}) {
    if (!mediaId || !chatId) {
      this.logger?.warn('Invalid parameters for removeSubscription', { mediaId, chatId });
      return false;
    }

    const { forceRemovePersistent = false } = options;
    const key = createSubscriptionKey(mediaId, mediaType, is4k);

    if (!this.subscriptions[key]) {
      return false;
    }

    const entry = this.subscriptions[key];

    // Remove from subscribers array
    const index = entry.subscribers.findIndex(sub => sub.lid === chatId);
    if (index === -1) {
      return false;
    }

    // Persistent subscriptions (added via `follow`) survive automatic
    // cleanup so users keep getting notified about future seasons / sequels.
    // The explicit `unfollow` command passes forceRemovePersistent=true.
    if (entry.subscribers[index].persistent && !forceRemovePersistent) {
      this.logger?.debug('Skipping removal of persistent subscription', { key, chatId });
      return false;
    }

    entry.subscribers.splice(index, 1);
    
    // Clean up empty keys
    if (entry.subscribers.length === 0) {
      delete this.subscriptions[key];
    }

    this.saveSubscriptions();
    
    // Include title in log if available
    const title = entry.title || null;
    const qualityText = formatQualityText(is4k);
    const mediaTypeText = formatMediaType(mediaType);
    if (title) {
      this.logger?.info(`🔔 Subscription removed: "${title}"${qualityText}`);
    } else {
      this.logger?.info(`🔔 Subscription removed: ${mediaTypeText} (ID: ${mediaId})${qualityText}`);
    }
    return true;
  }

  /**
   * Gets all subscribers for a specific media item
   * @param {number} mediaId - Media ID (TMDB ID)
   * @param {string|number} mediaType - Media type ('movie'|'tv' or 1|2)
   * @param {boolean} is4k - Whether this is a 4K subscription
   * @returns {string[]} Array of chat IDs (LIDs) subscribed to this media
   */
  getSubscribers(mediaId, mediaType, is4k) {
    if (!mediaId) {
      return [];
    }

    const key = createSubscriptionKey(mediaId, mediaType, is4k);
    const entry = this.subscriptions[key];
    
    if (!entry) {
      return [];
    }
    
    return getChatIdsFromEntry(entry);
  }

  /**
   * Checks if a user is subscribed to a specific media item
   * @param {number} mediaId - Media ID (TMDB ID)
   * @param {string|number} mediaType - Media type ('movie'|'tv' or 1|2)
   * @param {boolean} is4k - Whether this is a 4K subscription
   * @param {string} chatId - User's chat ID
   * @returns {boolean} True if user is subscribed
   */
  isSubscribed(mediaId, mediaType, is4k, chatId) {
    const subscribers = this.getSubscribers(mediaId, mediaType, is4k);
    return subscribers.includes(chatId);
  }

  /**
   * Gets all subscriptions for a specific user
   * @param {string} chatId - User's chat ID (LID format)
   * @returns {Array} Array of subscription objects { mediaId, mediaType, is4k, title, year, typeStr, tvdbId, persistent }
   */
  getUserSubscriptions(chatId) {
    if (!chatId) {
      return [];
    }

    const userSubscriptions = [];

    for (const [key, entry] of Object.entries(this.subscriptions)) {
      const subscriber = entry.subscribers?.find(sub => sub.lid === chatId);

      if (subscriber) {
        // Parse key: "mediaId:mediaType:quality"
        const parts = key.split(':');
        if (parts.length !== 3) {
          this.logger?.warn('Invalid subscription key format', { key });
          continue;
        }

        const [mediaId, mediaType, quality] = parts;
        const parsedMediaId = parseInt(mediaId, 10);
        if (isNaN(parsedMediaId)) {
          this.logger?.warn('Invalid mediaId in subscription key', { key, mediaId });
          continue;
        }

        const subscription = {
          mediaId: parsedMediaId,
          mediaType: mediaType === 'movie' ? 'movie' : 'tv',
          is4k: quality === '4k',
          persistent: subscriber.persistent === true
        };

        // Add metadata if available
        if (entry.title) {
          subscription.title = entry.title;
        }
        if (entry.year) {
          subscription.year = entry.year;
        }
        if (entry.typeStr) {
          subscription.typeStr = entry.typeStr;
        }
        if (entry.tvdbId) {
          subscription.tvdbId = entry.tvdbId;
        }

        userSubscriptions.push(subscription);
      }
    }

    return userSubscriptions;
  }

  /**
   * Looks up subscribers by external (TVDB) id, useful for Plex/Sonarr webhooks
   * which carry TVDB ids for TV episodes rather than TMDB ids.
   * @param {number|string} tvdbId - TVDB ID
   * @param {string|number} mediaType - 'movie'|'tv' or 1|2
   * @param {boolean} [is4k] - When omitted, returns subscribers for both qualities
   * @returns {Array<{ chatId: string, mediaId: number, is4k: boolean }>}
   */
  getSubscribersByTvdbId(tvdbId, mediaType, is4k = null) {
    const tvdbIdNum = parseInt(tvdbId, 10);
    if (!tvdbIdNum || isNaN(tvdbIdNum)) {
      return [];
    }

    const normalizedType = typeof mediaType === 'number'
      ? (mediaType === 1 ? 'movie' : 'tv')
      : mediaType;

    const matches = [];
    for (const [key, entry] of Object.entries(this.subscriptions)) {
      if (!entry.tvdbId || parseInt(entry.tvdbId, 10) !== tvdbIdNum) continue;

      const parts = key.split(':');
      if (parts.length !== 3) continue;
      const [mediaIdStr, type, quality] = parts;
      if (type !== normalizedType) continue;
      const isEntry4k = quality === '4k';
      if (is4k !== null && is4k !== isEntry4k) continue;

      const mediaIdNum = parseInt(mediaIdStr, 10);
      if (isNaN(mediaIdNum)) continue;

      for (const sub of (entry.subscribers || [])) {
        if (sub.lid) {
          matches.push({ chatId: sub.lid, mediaId: mediaIdNum, is4k: isEntry4k });
        }
      }
    }
    return matches;
  }

  /**
   * Returns the entry metadata for a media key, or null
   */
  getEntry(mediaId, mediaType, is4k) {
    const key = createSubscriptionKey(mediaId, mediaType, is4k);
    return this.subscriptions[key] || null;
  }

  /**
   * Removes all subscriptions for a specific user
   * @param {string} chatId - User's chat ID (LID format)
   * @returns {number} Number of subscriptions removed
   */
  removeAllUserSubscriptions(chatId) {
    let removed = 0;
    
    for (const [key, entry] of Object.entries(this.subscriptions)) {
      const index = entry.subscribers?.findIndex(sub => sub.lid === chatId);
      if (index !== undefined && index !== -1) {
        entry.subscribers.splice(index, 1);
        removed++;
        
        // Clean up empty keys
        if (entry.subscribers.length === 0) {
          delete this.subscriptions[key];
        }
      }
    }
    
    if (removed > 0) {
      this.saveSubscriptions();
      this.logger?.info(`🔔 Removed ${removed} subscription${removed !== 1 ? 's' : ''} for user`);
    }
    
    return removed;
  }

  /**
   * Gets statistics about subscriptions
   * @returns {Object} Statistics object
   */
  getStats() {
    const totalKeys = Object.keys(this.subscriptions).length;
    const totalSubscriptions = Object.values(this.subscriptions).reduce((sum, entry) => {
      return sum + (entry.subscribers?.length || 0);
    }, 0);
    
    return {
      totalMediaItems: totalKeys,
      totalSubscriptions,
      filePath: this.subscriptionsPath
    };
  }
  
  /**
   * Updates metadata for a subscription
   * @param {number} mediaId - Media ID (TMDB ID)
   * @param {string|number} mediaType - Media type ('movie'|'tv' or 1|2)
   * @param {boolean} is4k - Whether this is a 4K subscription
   * @param {string|null} title - Media title (optional)
   * @param {string|null} year - Media year (optional)
   * @param {string|null} typeStr - Media type string (optional)
   * @returns {boolean} True if metadata was updated
   */
  updateMetadata(mediaId, mediaType, is4k, title = null, year = null, typeStr = null) {
    if (!mediaId) {
      return false;
    }
    
    const key = createSubscriptionKey(mediaId, mediaType, is4k);
    const entry = this.subscriptions[key];
    
    if (!entry) {
      return false;
    }
    
    let updated = false;
    if (title && this.subscriptions[key].title !== title) {
      this.subscriptions[key].title = title;
      updated = true;
    }
    if (year && this.subscriptions[key].year !== year) {
      this.subscriptions[key].year = year;
      updated = true;
    }
    if (typeStr && this.subscriptions[key].typeStr !== typeStr) {
      this.subscriptions[key].typeStr = typeStr;
      updated = true;
    }
    
    if (updated) {
      this.saveSubscriptions();
      this.logger?.debug('Updated subscription metadata', { key, title, year, typeStr });
    }
    return updated;
  }

  /**
   * Clears all subscriptions (for testing/cleanup)
   */
  clearAll() {
    this.subscriptions = {};
    this.saveSubscriptions();
    this.logger?.info('🔔 Cleared all subscriptions');
  }
}

// Export singleton instance
let subscriptionManager = null;

/**
 * Creates the subscription manager instance
 * @param {Object} logger - Logger instance
 * @param {Object} cfg - Configuration object (for user mappings)
 * @returns {SubscriptionManager} Subscription manager instance
 */
export function createSubscriptionManager(logger = null, cfg = null) {
  if (!subscriptionManager) {
    subscriptionManager = new SubscriptionManager(logger, cfg);
  }
  return subscriptionManager;
}

/**
 * Gets the subscription manager instance
 * @returns {SubscriptionManager} Subscription manager instance
 */
export function getSubscriptionManager() {
  if (!subscriptionManager) {
    throw new Error('SubscriptionManager not initialized. Call createSubscriptionManager() first.');
  }
  return subscriptionManager;
}

