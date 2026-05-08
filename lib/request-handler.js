/**
 * Request handling logic for movies and TV shows
 * Handles duplicate prevention, status checking, and request creation
 */

import { getMediaDetails, createRequest, formatMedia, formatMediaType, extractMediaStatus, formatStatusMessage, formatQualityText } from './request.js';
import { isRequested, isAvailable, canBeRequested, getRequestStatusMessage } from './media-status.js';
import { checkSeasonRequestStatus } from './media-status.js';
import { filterOutSpecials, getSeasonNumber } from './season-utils.js';
import { sendMessage } from './waha-client.js';
import {
  getMovieMessage,
  getSeasonMessage,
  getAllSeasonsStatusMessage,
  getGenericErrorMessage
} from './message-mapper.js';
import { getErrorDetails } from './errors/error-formatter.js';
import { getSubscriptionManager } from './subscriptions/subscription-manager.js';
import { getUserIdFromChatId } from './utils.js';

/**
 * Helper function to check if a user requested specific seasons
 * @param {Object} mediaDetails - Media details from API
 * @param {number} userId - User ID to check
 * @param {number[]} seasonNumbers - Array of season numbers to check
 * @param {boolean} is4k - Whether to check 4K requests
 * @returns {Object} { hasRequestedAny: boolean, requestedSeasons: number[], seasonRequestDates: Map<number, string> }
 */
function checkUserRequestedSeasons(mediaDetails, userId, seasonNumbers, is4k) {
  const result = {
    hasRequestedAny: false,
    requestedSeasons: [],
    seasonRequestDates: new Map()
  };
  
  if (!mediaDetails?.mediaInfo?.requests || !Array.isArray(mediaDetails.mediaInfo.requests)) {
    return result;
  }
  
  for (const request of mediaDetails.mediaInfo.requests) {
    const requestUserId = request.requestedBy?.id;
    const requestIs4k = request.is4k === true;
    
    // Check if this request matches the user and quality
    if (requestUserId === userId && requestIs4k === is4k) {
      // Check if this request includes any of the seasons we're checking
      // API returns seasons as array of objects with seasonNumber property, or array of numbers
      const requestSeasons = request.seasons || [];
      for (const seasonNum of seasonNumbers) {
        // Handle both formats: array of objects {seasonNumber: X} or array of numbers
        const hasSeason = requestSeasons.some(s => {
          if (typeof s === 'number') {
            return s === seasonNum;
          } else if (s && typeof s === 'object') {
            return (s.seasonNumber || s.season_number) === seasonNum;
          }
          return false;
        });
        
        if (hasSeason && !result.requestedSeasons.includes(seasonNum)) {
          result.requestedSeasons.push(seasonNum);
          result.hasRequestedAny = true;
          if (request.createdAt) {
            result.seasonRequestDates.set(seasonNum, request.createdAt);
          }
        }
      }
    }
  }
  
  return result;
}

/**
 * Helper function to check if a user requested a TV show (any seasons)
 * @param {Object} mediaDetails - Media details from API
 * @param {number} userId - User ID to check
 * @param {boolean} is4k - Whether to check 4K requests
 * @returns {boolean} True if user has any requests for this show
 */
function checkUserRequestedTvShow(mediaDetails, userId, is4k) {
  if (!mediaDetails?.mediaInfo?.requests || !Array.isArray(mediaDetails.mediaInfo.requests)) {
    return false;
  }
  
  return mediaDetails.mediaInfo.requests.some(req => {
    const requestUserId = req.requestedBy?.id;
    const requestIs4k = req.is4k === true;
    return requestUserId === userId && requestIs4k === is4k;
  });
}

/**
 * Creates a function to check if user was already a requester for a movie
 * @returns {Function} Function that checks if user was already requester
 */
function createMovieRequesterChecker() {
  return (mediaDetails, userId, is4k) => {
    if (!mediaDetails?.mediaInfo?.requests || !Array.isArray(mediaDetails.mediaInfo.requests)) {
      return false;
    }
    return mediaDetails.mediaInfo.requests.some(req => {
      const requestUserId = req.requestedBy?.id;
      const requestIs4k = req.is4k === true;
      return requestUserId === userId && requestIs4k === is4k;
    });
  };
}

/**
 * Creates a function to check if user was already a requester for TV show seasons
 * @param {string|number[]} seasons - Seasons to check (can be 'all' or array of numbers)
 * @param {Object} mediaDetailsForExtraction - Media details for season extraction (when seasons is 'all')
 * @returns {Function} Function that checks if user was already requester
 */
function createTvSeasonsRequesterChecker(seasons, mediaDetailsForExtraction) {
  return (mediaDetails, userId, is4k) => {
    let seasonsForCheck = seasons;
    if (seasons === 'all' && mediaDetailsForExtraction) {
      const allSeasons = mediaDetailsForExtraction.seasons || mediaDetailsForExtraction.Seasons || [];
      seasonsForCheck = allSeasons
        .map(s => s.seasonNumber || s.season_number)
        .filter(num => num !== null && num !== 0 && num !== undefined);
    }
    const userRequestInfo = checkUserRequestedSeasons(mediaDetails, userId, seasonsForCheck, is4k);
    return userRequestInfo.hasRequestedAny;
  };
}

/**
 * Checks if a request response indicates success
 * @param {Object} res - Response object with status property
 * @returns {boolean} True if status is 201 or 200
 */
function isRequestSuccessful(res) {
  return res.status === 201 || res.status === 200;
}

/**
 * Sends status message only if request was not successful (suppresses success messages)
 * @param {Object} wahaClient - WAHA API client
 * @param {Object} cfg - Configuration
 * @param {string} chatId - Chat ID
 * @param {Object} res - Request response
 * @param {string} typeStr - Media type string
 * @param {boolean} isTvShow - Whether this is a TV show
 * @param {boolean} is4k - Whether this is a 4K request
 * @param {Object} media - Media object
 * @param {string|number[]|null} requestedSeasons - Requested seasons (for TV shows)
 */
async function sendStatusMessageIfNotSuccessful(wahaClient, cfg, chatId, res, typeStr, isTvShow, is4k, media, requestedSeasons = null) {
  if (!isRequestSuccessful(res)) {
    const statusMessage = getRequestStatusMessage(res, typeStr, isTvShow, is4k, media, requestedSeasons);
    await sendMessage(wahaClient, cfg, chatId, statusMessage);
  }
}

/**
 * Subscribes user to media notifications if request was successful and user wasn't already a requester
 * @param {Object} cfg - Configuration
 * @param {Object} wahaClient - WAHA API client
 * @param {string} chatId - Chat ID
 * @param {Object} res - Request response
 * @param {Object} mediaDetails - Media details from API
 * @param {number} mediaId - Media ID
 * @param {number} mediaType - Media type (1 = movie, 2 = TV)
 * @param {string} mediaTitle - Media title
 * @param {boolean} is4k - Whether this is a 4K request
 * @param {Object} logger - Logger instance
 * @param {Function} checkWasAlreadyRequester - Function to check if user was already requester
 * @returns {Promise<void>}
 */
async function subscribeToNotificationsIfNewRequest(cfg, wahaClient, chatId, res, mediaDetails, mediaId, mediaType, mediaTitle, is4k, logger, checkWasAlreadyRequester) {
  if (!isRequestSuccessful(res)) {
    return;
  }

  await subscribeToNotificationsIfNotRequester(cfg, wahaClient, chatId, mediaDetails, mediaId, mediaType, mediaTitle, is4k, logger, checkWasAlreadyRequester);
}

/**
 * Subscribes user to media notifications if user wasn't already a requester
 * @param {Object} cfg - Configuration
 * @param {Object} wahaClient - WAHA API client
 * @param {string} chatId - Chat ID
 * @param {Object} mediaDetails - Media details from API
 * @param {number} mediaId - Media ID
 * @param {number} mediaType - Media type (1 = movie, 2 = TV)
 * @param {string} mediaTitle - Media title
 * @param {boolean} is4k - Whether this is a 4K request
 * @param {Object} logger - Logger instance
 * @param {Function} checkWasAlreadyRequester - Function to check if user was already requester
 * @param {string} logContext - Context for logging (e.g., "new request", "already requested by someone else")
 * @returns {Promise<void>}
 */
async function subscribeToNotificationsIfNotRequester(cfg, wahaClient, chatId, mediaDetails, mediaId, mediaType, mediaTitle, is4k, logger, checkWasAlreadyRequester, logContext = 'new request') {
  const userId = await getUserIdFromChatId(cfg, chatId, wahaClient);
  const wasAlreadyRequester = checkWasAlreadyRequester(mediaDetails, userId, is4k);

  if (!wasAlreadyRequester) {
    try {
      const subscriptionManager = getSubscriptionManager();
      // Extract formatted metadata from mediaDetails for storage
      const formatted = formatMedia(mediaDetails);
      const typeStr = formatMediaType(mediaType);
      // Capture tvdbId when present so Plex/Sonarr webhooks (which carry TVDB ids
      // for TV episodes) can match this subscription.
      const tvdbId = mediaDetails?.externalIds?.tvdbId
        || mediaDetails?.mediaInfo?.tvdbId
        || null;
      subscriptionManager.addSubscription(
        mediaId, mediaType, is4k, chatId,
        formatted.title, formatted.year, typeStr,
        { tvdbId }
      );
      const mediaTypeName = mediaType === 1 ? 'movie' : 'TV show';
      logger?.info(`🔔 Subscribed user to ${mediaTypeName} notifications${formatQualityText(is4k)}`);
    } catch (err) {
      logger?.warn('Failed to subscribe user to notifications', {
        ...getErrorDetails(err, `subscribe${mediaType === 1 ? 'Movie' : 'Tv'}Notifications`),
        mediaId,
        chatId
      });
    }
  } else {
    logger?.info('⏭️ Skipping subscription - user is the original requester');
  }
}

/**
 * Handles TV show season selection and request creation
 * @param {Object} cfg - Configuration
 * @param {Object} jellyseerrClient - Jellyseerr API client
 * @param {Object} wahaClient - WAHA API client
 * @param {string} chatId - Chat ID
 * @param {string} messageText - User's season selection message
 * @param {Object} tvShow - Selected TV show object
 * @param {Object} logger - Logger instance
 * @param {boolean} is4k - Whether this is a 4K request
 * @returns {Promise<void>}
 */
export async function handleTvSeasonSelection(cfg, jellyseerrClient, wahaClient, chatId, messageText, tvShow, logger, is4k = false) {
  const { title: chosenTitle } = formatMedia(tvShow);
  
  // is4k flag propagates through all status checks and request creation
  logger?.info(`📺 User selected: "${chosenTitle}"${formatQualityText(is4k)}`);
  
  // Parse season selection - use actual seasons array length
  const availableSeasons = tvShow.seasons || [];
  const maxSeasons = availableSeasons.length > 0 ? availableSeasons.length : (tvShow.numberOfSeasons || 10);
  const { parseSeasonSelection } = await import('./season-utils.js');
  const seasonSelection = parseSeasonSelection(messageText, maxSeasons);
  
  if (seasonSelection.cancelled) {
    logger?.info(`🚫 User cancelled selection for "${chosenTitle}"`);
    try {
      await sendMessage(wahaClient, cfg, chatId, 
        `❌ Season selection cancelled for "${chosenTitle}"${formatQualityText(is4k)}\n\nYou can start a new search anytime.`
      );
    } catch (err) {
      logger?.error('Error sending cancellation message', {
        ...getErrorDetails(err, 'sendSeasonCancellationMessage'),
        chatId
      });
    }
    return { cancelled: true };
  }
  
  if (seasonSelection.error) {
    await sendMessage(wahaClient, cfg, chatId, seasonSelection.error);
    return { error: seasonSelection.error };
  }
  
  // Handle season selection - can be array of numbers or string "all" per API spec
  // API reference: seasons: oneOf: [array of numbers, string enum: ["all"]]
  // parseSeasonSelection already returns 'all' as string when isAll is true
  let seasons = seasonSelection.seasons;
  
  if (seasonSelection.isAll) {
    // Already 'all' string from parseSeasonSelection, but ensure it's set explicitly
    seasons = 'all';
  } else if (Array.isArray(seasons)) {
    // Filter out season 0 (Specials) - never allow requesting specials
    seasons = seasons.filter(s => s !== 0);
    
    if (seasons.length === 0) {
      await sendMessage(wahaClient, cfg, chatId, `❌ No valid seasons selected. Season 0 (Specials) cannot be requested`);
      return { error: 'No valid seasons' };
    }
  } else {
    await sendMessage(wahaClient, cfg, chatId, `❌ Invalid season selection`);
    return { error: 'Invalid season selection' };
  }
  
  // Get fresh media details to check current season status
  let mediaDetails = tvShow.mediaDetails;
  if (!mediaDetails) {
    logger?.debug('Fetching fresh media details for season status check', { 
      tvShowId: tvShow.id, 
      title: tvShow.title 
    });
    try {
      mediaDetails = await getMediaDetails(jellyseerrClient, cfg, tvShow.id, 2, logger);
      // Attach mediaDetails to tvShow so createRequest can extract tvdbId if available
      tvShow.mediaDetails = mediaDetails;
    } catch (err) {
      logger?.warn('Failed to fetch media details for status check, proceeding with request', {
        ...getErrorDetails(err, 'getMediaDetailsForStatusCheck'),
        mediaId: tvShow.id
      });
    }
  }
  
  // Check if selected seasons are already requested (duplicate prevention)
  if (mediaDetails) {
    const alreadyRequestedSeasons = [];
    const alreadyAvailableSeasons = [];
    const canRequestSeasons = [];
    
    // Handle "all" vs specific seasons
    let seasonsToCheck = [];
    if (seasons === 'all') {
      // For "all", check all available seasons (excluding season 0)
      const allSeasons = mediaDetails.seasons || mediaDetails.Seasons || [];
      seasonsToCheck = allSeasons
        .map(s => s.seasonNumber || s.season_number)
        .filter(num => num !== null && num !== 0 && num !== undefined);
    } else if (Array.isArray(seasons)) {
      seasonsToCheck = seasons;
    }
    
    for (const seasonNum of seasonsToCheck) {
      const seasonStatus = checkSeasonRequestStatus(mediaDetails, seasonNum, is4k);
      if (seasonStatus.isRequested) {
        if (seasonStatus.isAvailable) {
          alreadyAvailableSeasons.push(seasonNum);
        } else {
          alreadyRequestedSeasons.push(seasonNum);
        }
      } else {
        canRequestSeasons.push(seasonNum);
      }
    }
    
    // If all selected seasons are already requested or available
    if (canRequestSeasons.length === 0 && (alreadyRequestedSeasons.length > 0 || alreadyAvailableSeasons.length > 0)) {
      // Check if current user is the original requester for any of the already requested seasons
      const userId = await getUserIdFromChatId(cfg, chatId, wahaClient);
      const userRequestInfo = checkUserRequestedSeasons(mediaDetails, userId, alreadyRequestedSeasons, is4k);
      
      // Only subscribe if user is NOT the original requester for any of these seasons (Seerr handles notifications for original requester)
      if (alreadyRequestedSeasons.length > 0) {
        const checkWasAlreadyRequester = (mediaDetails, userId, is4k) => {
          const userRequestInfo = checkUserRequestedSeasons(mediaDetails, userId, alreadyRequestedSeasons, is4k);
          return userRequestInfo.hasRequestedAny;
        };
        const { title } = formatMedia(tvShow);
        await subscribeToNotificationsIfNotRequester(
          cfg, wahaClient, chatId, mediaDetails, tvShow.id, 2, title, is4k, logger, checkWasAlreadyRequester,
          'seasons already requested by someone else'
        );
      }
      
      // Use message mapper for individual season messages
      const messages = [];
      for (const seasonNum of alreadyAvailableSeasons) {
        const message = getSeasonMessage({
          seasonNumber: seasonNum,
          tvShowTitle: chosenTitle,
          isRequested: true,
          isAvailable: true,
          hasNotification: false
        });
        messages.push(message);
      }
      for (const seasonNum of alreadyRequestedSeasons) {
        const message = getSeasonMessage({
          seasonNumber: seasonNum,
          tvShowTitle: chosenTitle,
          isRequested: true,
          isAvailable: false,
          hasNotification: false
        });
        messages.push(message);
      }
      if (messages.length > 0) {
        logger?.info(`ℹ️ All selected seasons for "${chosenTitle}" are already requested or available`);
        await sendMessage(wahaClient, cfg, chatId, messages.join('\n\n'));
      }
      return { allRequested: true };
    }
    
    // If some seasons are already requested/available, only request the ones that can be requested
    if (alreadyRequestedSeasons.length > 0 || alreadyAvailableSeasons.length > 0) {
      // Check if current user is the original requester for any of the already requested seasons
      const userId = await getUserIdFromChatId(cfg, chatId, wahaClient);
      const userRequestInfo = checkUserRequestedSeasons(mediaDetails, userId, alreadyRequestedSeasons, is4k);
      
      // Only subscribe if user is NOT the original requester for any of these seasons (Seerr handles notifications for original requester)
      if (alreadyRequestedSeasons.length > 0) {
        const checkWasAlreadyRequester = (mediaDetails, userId, is4k) => {
          const userRequestInfo = checkUserRequestedSeasons(mediaDetails, userId, alreadyRequestedSeasons, is4k);
          return userRequestInfo.hasRequestedAny;
        };
        const { title } = formatMedia(tvShow);
        await subscribeToNotificationsIfNotRequester(
          cfg, wahaClient, chatId, mediaDetails, tvShow.id, 2, title, is4k, logger, checkWasAlreadyRequester,
          'some seasons already requested by someone else'
        );
      }
      
      const messages = [];
      const hasNotification = false;
      for (const seasonNum of alreadyAvailableSeasons) {
        const message = getSeasonMessage({
          seasonNumber: seasonNum,
          tvShowTitle: chosenTitle,
          isRequested: true,
          isAvailable: true,
          hasNotification
        });
        messages.push(message);
      }
      for (const seasonNum of alreadyRequestedSeasons) {
        const message = getSeasonMessage({
          seasonNumber: seasonNum,
          tvShowTitle: chosenTitle,
          isRequested: true,
          isAvailable: false,
          hasNotification
        });
        messages.push(message);
      }
      logger?.info(`📋 Some seasons already requested/available, requesting only seasons ${canRequestSeasons.join(', ')}`);
      if (messages.length > 0) {
        await sendMessage(wahaClient, cfg, chatId, messages.join('\n\n'));
      }
      // If "all" was selected but some seasons are already requested, request only the remaining ones
      if (seasons === 'all' && canRequestSeasons.length > 0) {
        seasons = canRequestSeasons; // Update to only request requestable seasons
      } else if (seasons === 'all' && canRequestSeasons.length === 0) {
        // All seasons already requested/available, return early
        return { allRequested: true };
      } else if (Array.isArray(seasons)) {
        seasons = canRequestSeasons; // Update to only request requestable seasons
      }
    }
  }
  
  // Create request with selected seasons
  // Format seasons text for logging
  let seasonsText;
  if (seasons === 'all') {
    seasonsText = 'all seasons';
  } else if (Array.isArray(seasons)) {
    seasonsText = seasons.length === maxSeasons ? 'all seasons' : `season${seasons.length > 1 ? 's' : ''} ${seasons.join(', ')}`;
  } else {
    seasonsText = 'seasons';
  }
  logger?.info(`📨 Requesting "${chosenTitle}" (${seasonsText})${formatQualityText(is4k)}`);
  
  try {
    const res = await createRequest(jellyseerrClient, cfg, tvShow, seasons, is4k, logger, chatId, wahaClient);
    logger?.debug('Create TV request response received', { 
      status: res.status, 
      requestId: res.data?.id || res.data?.request_id,
      mediaId: tvShow.id,
      seasonsCount: Array.isArray(seasons) ? seasons.length : (seasons === 'all' ? 'all' : 0),
      is4k
    });
    logger?.trace('Create TV request full response', { status: res.status, data: res.data });
    
    // Subscribe user to notifications if request was successful
    // Only subscribe if this is a NEW request (not a duplicate), as Seerr handles notifications for original requesters
    const checkWasAlreadyRequester = createTvSeasonsRequesterChecker(seasons, mediaDetails);
    const { title } = formatMedia(tvShow);
    await subscribeToNotificationsIfNewRequest(
      cfg, wahaClient, chatId, res, mediaDetails, tvShow.id, 2, title, is4k, logger, checkWasAlreadyRequester
    );
    
    // Only send status message if request was not successful (suppress success messages)
    await sendStatusMessageIfNotSuccessful(wahaClient, cfg, chatId, res, 'TV', true, is4k, tvShow, seasons);
  } catch (err) {
    logger?.error('Failed to create request', {
      ...getErrorDetails(err, 'createTvRequest'),
      chosenTitle
    });
    const errorMsg = getGenericErrorMessage();
    await sendMessage(wahaClient, cfg, chatId, errorMsg);
  }
  
  return { success: true };
}

/**
 * Handles TV show selection - fetches seasons and shows selection
 * @param {Object} cfg - Configuration
 * @param {Object} jellyseerrClient - Jellyseerr API client
 * @param {Object} wahaClient - WAHA API client
 * @param {string} chatId - Chat ID
 * @param {Object} chosen - Selected TV show object
 * @param {Object} logger - Logger instance
 * @param {boolean} is4k - Whether this is a 4K request
 * @returns {Promise<Object|null>} Updated chosen object with seasons, or null if handled
 */
export async function handleTvShowSelection(cfg, jellyseerrClient, wahaClient, chatId, chosen, logger, is4k = false) {
  const { title: chosenTitle, year: chosenYear, typeStr } = formatMedia(chosen);
  
  // is4k flag propagates through all status checks, season formatting, and request creation
  logger?.info(`📺 TV selected: "${chosenTitle}" — fetching seasons...${formatQualityText(is4k)}`);
  await sendMessage(wahaClient, cfg, chatId, `📺 Loading seasons for "${chosenTitle}"...`);
  
  try {
    const mediaDetails = await getMediaDetails(jellyseerrClient, cfg, chosen.id, 2, logger);
    // Filter out season 0 (Specials) - never show or allow requesting specials
    const allSeasons = mediaDetails.seasons || [];
    const seasons = filterOutSpecials(allSeasons);
    logger?.debug('TV media details seasons processed', { 
      seasonCount: seasons.length, 
      totalIncludingSpecials: allSeasons.length,
      mediaId: chosen.id,
      title: chosenTitle
    });
    
    if (seasons.length === 0) {
      // No season info available, check overall status before requesting all seasons
      logger?.warn('No season info returned; checking overall status');
      const statusInfo = extractMediaStatus(mediaDetails, is4k);
      
      if (statusInfo) {
        const requested = isRequested(statusInfo.status);
        const available = isAvailable(statusInfo.status);
        
        if (available) {
          logger?.info(`✅ "${chosenTitle}" is already available in library`);
          const statusMsg = formatStatusMessage(statusInfo.status, 'TV Show', true, null);
          const message = getAllSeasonsStatusMessage({
            allSeasonsAvailable: true,
            showDetails: mediaDetails,
            statusMessage: statusMsg
          });
          await sendMessage(wahaClient, cfg, chatId, message);
          return null; // Handled, don't proceed
        } else if (requested) {
          // Check if current user is the original requester
          const userId = await getUserIdFromChatId(cfg, chatId, wahaClient);
          const wasAlreadyRequester = checkUserRequestedTvShow(mediaDetails, userId, is4k);
          
          // Only subscribe if user is NOT the original requester (Seerr handles notifications for original requester)
          const checkWasAlreadyRequester = checkUserRequestedTvShow;
          const { title } = formatMedia(chosen);
          await subscribeToNotificationsIfNotRequester(
            cfg, wahaClient, chatId, mediaDetails, chosen.id, 2, title, is4k, logger, checkWasAlreadyRequester,
            'already requested by someone else, no season info'
          );
          
          const hasNotification = false;
          // For TV shows without season info, use status message
          const statusMsg = formatStatusMessage(statusInfo.status, 'TV Show', true, null);
          const message = getAllSeasonsStatusMessage({
            allSeasonsAvailable: false,
            showDetails: mediaDetails,
            statusMessage: statusMsg
          });
          logger?.info(`📋 "${chosenTitle}" is already requested${wasAlreadyRequester ? ' (by this user)' : ''}`);
          await sendMessage(wahaClient, cfg, chatId, message);
          return null; // Handled, don't proceed
        }
      }
      
      // Can be requested - proceed
      // Attach mediaDetails to chosen object so createRequest can extract tvdbId if available
      const mediaWithDetails = { ...chosen, mediaDetails };
      const res = await createRequest(jellyseerrClient, cfg, mediaWithDetails, null, is4k, logger, chatId, wahaClient);
      
      // Subscribe user to notifications if request was successful
      // Only subscribe if this is a NEW request (not a duplicate), as Seerr handles notifications for original requesters
      const checkWasAlreadyRequester = checkUserRequestedTvShow;
      const { title } = formatMedia(chosen);
      await subscribeToNotificationsIfNewRequest(
        cfg, wahaClient, chatId, res, mediaDetails, chosen.id, 2, title, is4k, logger, checkWasAlreadyRequester
      );
      
      // Only send status message if request was not successful (suppress success messages)
      await sendStatusMessageIfNotSuccessful(wahaClient, cfg, chatId, res, typeStr, true, is4k, chosen, null);
      return null; // Handled, don't proceed
    }
    
    // Check season-level status
    const requestedSeasons = [];
    const canRequestSeasons = [];
    
    for (const season of seasons) {
      const seasonNum = getSeasonNumber(season);
      if (seasonNum === null) continue;
      
      const seasonStatus = checkSeasonRequestStatus(mediaDetails, seasonNum, is4k);
      
      if (seasonStatus.isRequested) {
        requestedSeasons.push({ seasonNum, status: seasonStatus });
      } else {
        canRequestSeasons.push(seasonNum);
      }
    }
    
    // If all seasons are already requested
    if (canRequestSeasons.length === 0 && requestedSeasons.length > 0) {
      // Check if current user is the original requester
      const userId = await getUserIdFromChatId(cfg, chatId, wahaClient);
      const wasAlreadyRequester = checkUserRequestedTvShow(mediaDetails, userId, is4k);
      
      const allAvailable = requestedSeasons.every(s => s.status.isAvailable);
      // Only subscribe if not all seasons are available AND user is NOT the original requester (Seerr handles notifications for original requester)
      if (!allAvailable) {
        const checkWasAlreadyRequester = checkUserRequestedTvShow;
        const { title } = formatMedia(chosen);
        await subscribeToNotificationsIfNotRequester(
          cfg, wahaClient, chatId, mediaDetails, chosen.id, 2, title, is4k, logger, checkWasAlreadyRequester,
          'all seasons already requested by someone else'
        );
      }
      
      logger?.info(`📋 All seasons of "${chosenTitle}" are already requested`);
      
      // Get status info to format the message properly
      const statusInfo = extractMediaStatus(mediaDetails, is4k);
      let statusMsg = '';
      if (statusInfo) {
        // Build season statuses array for formatting
        const seasonStatuses = statusInfo.seasons?.map(s => ({ status: s.status })) || null;
        statusMsg = formatStatusMessage(statusInfo.status, 'TV Show', true, seasonStatuses);
      }
      
      const message = getAllSeasonsStatusMessage({
        allSeasonsAvailable: allAvailable,
        showDetails: mediaDetails,
        statusMessage: statusMsg
      });
      await sendMessage(wahaClient, cfg, chatId, message);
      return null; // Handled, don't proceed
    }
    
    // Store TV show with all seasons for selection
    chosen.seasons = seasons;
    chosen.mediaDetails = mediaDetails;
    
    // Show season selection
    const { formatSeasons } = await import('./season-utils.js');
    const seasonsMessage = formatSeasons(chosen.seasons, mediaDetails, is4k);
    await sendMessage(wahaClient, cfg, chatId, seasonsMessage);
    // Store prompt timestamp after message is successfully sent
    // Timestamp-based filtering prevents selections made before the prompt is received
    const { getStateManager } = await import('./state/cache-state.js');
    const stateManager = getStateManager();
    stateManager.setPromptSentAt(chatId, Date.now());
    
    return chosen; // Return updated chosen object
  } catch (err) {
    logger?.error('Failed to get TV media details', {
      ...getErrorDetails(err, 'getMediaDetails'),
      chosenTitle
    });
    const errorMsg = getGenericErrorMessage();
    await sendMessage(wahaClient, cfg, chatId, errorMsg);
    return null; // Cancel the request
  }
}

/**
 * Handles movie selection - checks status and creates request
 * @param {Object} cfg - Configuration
 * @param {Object} jellyseerrClient - Jellyseerr API client
 * @param {Object} wahaClient - WAHA API client
 * @param {string} chatId - Chat ID
 * @param {Object} chosen - Selected movie object
 * @param {Object} logger - Logger instance
 * @param {boolean} is4k - Whether this is a 4K request
 * @returns {Promise<void>}
 */
export async function handleMovieSelection(cfg, jellyseerrClient, wahaClient, chatId, chosen, logger, is4k = false) {
  const { title: chosenTitle, year: chosenYear, typeStr } = formatMedia(chosen);
  
  // is4k flag propagates through all status checks and request creation
  logger?.info(`🔍 Checking status: "${chosenTitle}" (${chosenYear})${formatQualityText(is4k)}`);
  
  try {
    // Get media details to check current status
    const mediaDetails = await getMediaDetails(jellyseerrClient, cfg, chosen.id, 1, logger);
    const statusInfo = extractMediaStatus(mediaDetails, is4k);
    
    if (statusInfo) {
      const requested = isRequested(statusInfo.status);
      const available = isAvailable(statusInfo.status);
      
      // Check if can be requested (duplicate prevention)
      if (!canBeRequested(statusInfo.status)) {
        if (available) {
          // Already available in library
          logger?.info(`✅ "${chosenTitle}" is already available in library`);
          const message = getMovieMessage({
            movieTitle: chosenTitle,
            status: statusInfo.status,
            isRequested: false,
            isAvailable: true,
            hasNotification: false
          });
          await sendMessage(wahaClient, cfg, chatId, message);
          return;
        } else if (requested) {
          // Already requested but not available
          // Check if current user is the original requester
          const userId = await getUserIdFromChatId(cfg, chatId, wahaClient);
          let isSelfRequested = false;
          let requestDate = null;
          
          // Find request matching the user and quality (is4k)
          if (mediaDetails?.mediaInfo?.requests && Array.isArray(mediaDetails.mediaInfo.requests)) {
            const userRequest = mediaDetails.mediaInfo.requests.find(req => {
              const requestUserId = req.requestedBy?.id;
              const requestIs4k = req.is4k === true;
              return requestUserId === userId && requestIs4k === is4k;
            });
            
            if (userRequest) {
              isSelfRequested = true;
              requestDate = userRequest.createdAt || null;
              logger?.info('ℹ️ User is the original requester');
            }
          }
          
          // Only subscribe if user is NOT the original requester (Seerr handles notifications for original requester)
          if (!isSelfRequested) {
            const checkWasAlreadyRequester = createMovieRequesterChecker();
            const { title } = formatMedia(chosen);
            await subscribeToNotificationsIfNotRequester(
              cfg, wahaClient, chatId, mediaDetails, chosen.id, 1, title, is4k, logger, checkWasAlreadyRequester,
              'already requested by someone else'
            );
          }
          
          const hasNotification = false;
          const message = getMovieMessage({
            movieTitle: chosenTitle,
            status: statusInfo.status,
            isRequested: true,
            isAvailable: false,
            hasNotification,
            isSelfRequested,
            requestDate
          });
          logger?.info(`📋 "${chosenTitle}" is already requested${isSelfRequested ? ' (by this user)' : ''}`);
          await sendMessage(wahaClient, cfg, chatId, message);
          return;
        }
      }
    }
    
    // Can be requested - proceed with request
    logger?.info(`📨 Requesting ${typeStr}: "${chosenTitle}" (${chosenYear})${formatQualityText(is4k)}`);
    
    // Attach mediaDetails to chosen object so createRequest can extract tvdbId if available
    const mediaWithDetails = { ...chosen, mediaDetails };
    const res = await createRequest(jellyseerrClient, cfg, mediaWithDetails, null, is4k, logger, chatId, wahaClient);
    logger?.debug('Create movie request response received', {
      status: res.status,
      requestId: res.data?.id || res.data?.request_id,
      mediaId: chosen.id,
      is4k
    });
    logger?.trace('Create movie request full response', { status: res.status, data: res.data });
    
    // Subscribe user to notifications if request was successful
    // Only subscribe if this is a NEW request (not a duplicate), as Seerr handles notifications for original requesters
    const checkWasAlreadyRequester = createMovieRequesterChecker();
    const { title } = formatMedia(chosen);
    await subscribeToNotificationsIfNewRequest(
      cfg, wahaClient, chatId, res, mediaDetails, chosen.id, 1, title, is4k, logger, checkWasAlreadyRequester
    );
    
    // Only send status message if request was not successful (suppress success messages)
    await sendStatusMessageIfNotSuccessful(wahaClient, cfg, chatId, res, typeStr, false, is4k, chosen, null);
  } catch (err) {
    logger?.error('Failed to check status or create request', {
      ...getErrorDetails(err, 'handleMovieSelection'),
      chosenTitle
    });
    const errorMsg = getGenericErrorMessage();
    await sendMessage(wahaClient, cfg, chatId, errorMsg);
  }
}

