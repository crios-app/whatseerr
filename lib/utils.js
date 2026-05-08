#!/usr/bin/env node

/**
 * Shared utilities for Jellyseerr requester
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './logger.js';
import { getPhoneNumberByLid } from './waha-client.js';
import { getErrorDetails } from './errors/error-formatter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Config is expected at /config/config.json (primary location for Docker containers)
// Falls back to root directory config.json for local development
export function getConfigPath() {
  // Primary location: /config/config.json (used in Docker containers)
  const primaryConfigPath = '/config/config.json';
  if (fs.existsSync(primaryConfigPath)) {
    return primaryConfigPath;
  }
  // Fallback: root directory config.json (for local development)
  return path.join(__dirname, '..', 'config.json');
}

function buildBaseUrl({ protocol, host, port }) {
  if (!protocol || !host || !port) return null;
  return `${protocol}://${host}:${port}`;
}

function buildOverseerrApiBaseUrl(baseUrl) {
  if (!baseUrl) return null;
  const u = new URL(baseUrl);
  const normalizedPath = u.pathname.replace(/\/+$/, '');
  if (normalizedPath.endsWith('/api/v1')) {
    u.pathname = normalizedPath;
  } else {
    u.pathname = `${normalizedPath}/api/v1`;
  }
  // IMPORTANT: Ensure trailing slash so URL resolution keeps the /api/v1/ prefix.
  // (new URL("request", "http://host/api/v1/") => http://host/api/v1/request)
  return u.toString().replace(/\/+$/, '') + '/';
}

function normalizeConfig(rawCfg) {
  const cfg = { ...rawCfg };

  // Extract service objects from services.* structure
  cfg.jellyseerr = cfg.services?.jellyseerr || {};
  cfg.waha = cfg.services?.waha || {};
  
  // Extract system settings (for protocol/host used in URL building)
  if (cfg.system) {
    cfg.protocol = cfg.system.protocol;
    cfg.host = cfg.system.host;
    cfg.logging = cfg.system.logging;
  }

  // Build base URLs from protocol+host+port if baseUrl not explicitly provided
  if (!cfg.jellyseerr.baseUrl && cfg.protocol && cfg.host && cfg.jellyseerr?.port) {
    cfg.jellyseerr.baseUrl = buildBaseUrl({ protocol: cfg.protocol, host: cfg.host, port: cfg.jellyseerr.port });
  }
  if (!cfg.waha.baseUrl && cfg.protocol && cfg.host && cfg.waha?.port) {
    cfg.waha.baseUrl = buildBaseUrl({ protocol: cfg.protocol, host: cfg.host, port: cfg.waha.port });
  }

  // Derived API base URL for Overseerr/Jellyseerr that includes the /api/v1 prefix.
  // This lets call sites use paths like "/request" to match the official API reference.
  if (cfg.jellyseerr?.baseUrl) {
    cfg.jellyseerr.apiBaseUrl = buildOverseerrApiBaseUrl(cfg.jellyseerr.baseUrl);
  }

  return cfg;
}

/**
 * Loads and validates configuration from config.json
 * @param {Object} options - Options for config loading
 * @param {boolean} options.requireWaha - Whether WAHA config is required
 * @param {boolean} options.requireWebhook - Whether webhook config is required
 * @param {boolean} options.requireWebhookHost - Whether protocol+host are required to build a public webhook URL
 * @returns {Object} Configuration object
 */
export function loadConfig(options = {}) {
  const { requireWaha = false, requireWebhook = false, requireWebhookHost = false } = options;
  const logger = createLogger({ logging: { level: 'error' } });

  const configPath = getConfigPath();
  
  // Log which config path is being used (at debug level to avoid noise)
  logger?.debug(`Loading config from: ${configPath}`);
  
  if (!fs.existsSync(configPath)) {
    logger?.error(`Config file not found at ${configPath}. Please create config.json and fill it in.`);
    if (configPath === '/config/config.json') {
      logger?.error('Expected config at /config/config.json (Docker container). Make sure config volume is mounted correctly.');
    }
    process.exit(1);
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const cfg = normalizeConfig(JSON.parse(raw));

    if (!cfg.jellyseerr?.baseUrl || !cfg.jellyseerr?.apiKey) {
      logger?.error('config.json missing Jellyseerr config. Provide either services.jellyseerr.baseUrl+apiKey or system.protocol+system.host+services.jellyseerr.port+apiKey.');
      process.exit(1);
    }

    if (requireWaha && !cfg.waha?.baseUrl) {
      logger?.error('config.json missing WAHA config. Provide either services.waha.baseUrl or system.protocol+system.host+services.waha.port.');
      process.exit(1);
    }

    if (requireWebhook) {
      // Port is optional - defaults to 3006
      if (!cfg.webhook?.requests?.path || typeof cfg.webhook?.requests?.path !== 'string') {
        logger?.error('config.json must contain webhook.requests.path (string).');
        process.exit(1);
      }
    }

    if (requireWebhookHost) {
      if (!cfg.protocol || typeof cfg.protocol !== 'string') {
        logger?.error('config.json must contain system.protocol (string), e.g. "http" or "https".');
        process.exit(1);
      }
      if (!cfg.host || typeof cfg.host !== 'string') {
        logger?.error('config.json must contain system.host (string), e.g. "192.168.1.10".');
        process.exit(1);
      }
    }

    return cfg;
  } catch (err) {
    logger?.error('Failed to read config.json', getErrorDetails(err, 'loadConfig'));
    process.exit(1);
  }
}

/**
 * Gets the webhook URL from config, with optional host override
 * @param {Object} cfg - Configuration object
 * @param {string} hostOverride - Optional host override (if provided, takes precedence over config.host)
 * @returns {string} Webhook URL
 */
export function getWebhookUrl(cfg, hostOverride = null) {
  const protocol = cfg.protocol;
  const host = hostOverride || cfg.host;
  // Port priority: WEBHOOK_EXTERNAL_PORT env var > config.webhook.requests.port > default 3006
  const port = process.env.WEBHOOK_EXTERNAL_PORT 
    ? parseInt(process.env.WEBHOOK_EXTERNAL_PORT, 10)
    : (cfg.webhook?.requests?.port || 3006);
  const webhookPath = cfg.webhook?.requests?.path;
  if (!protocol || !host || !webhookPath) {
    throw new Error('Missing webhook config: expected system.protocol, system.host, webhook.requests.path in config.json (port defaults to 3006 or use WEBHOOK_EXTERNAL_PORT env var)');
  }
  return `${protocol}://${host}:${port}${webhookPath}`;
}

/**
 * Gets the default user ID from config
 * @param {Object} cfg - Configuration object
 * @returns {number|null} Default user ID or null
 */
function getDefaultUserId(cfg) {
  return cfg.jellyseerr?.defaultUserId || null;
}

/**
 * Gets identifier type information for logging
 * @param {string} chatId - WAHA chatId
 * @returns {Object} Identifier type information
 */
/**
 * Checks if a chatId is in LID format
 * @param {string} chatId - WAHA chatId
 * @returns {boolean} True if chatId is in LID format
 */
export function isLidFormat(chatId) {
  if (!chatId || typeof chatId !== 'string') {
    return false;
  }
  return chatId.endsWith('@lid');
}

/**
 * Extracts phone number from WAHA chatId
 * ChatId format: "96566674323@c.us" -> "96566674323"
 * @param {string} chatId - WAHA chatId
 * @returns {string|null} Phone number or null if not found
 */
export function extractPhoneNumber(chatId) {
  if (!chatId || typeof chatId !== 'string') {
    return null;
  }
  // Match phone number before @c.us
  const match = chatId.match(/^(\d+)@c\.us$/);
  return match ? match[1] : null;
}

/**
 * Gets LID format chatId from phone number format using lidMappings (synchronous lookup)
 * @param {Object} cfg - Configuration object
 * @param {string} phoneChatId - Phone number format chatId (e.g., "96566674323@c.us")
 * @returns {string|null} LID format chatId (e.g., "151169980723349@lid") or null if not found
 */
export function getLidFromPhoneNumber(cfg, phoneChatId) {
  if (!phoneChatId || typeof phoneChatId !== 'string' || !phoneChatId.endsWith('@c.us')) {
    return null;
  }
  
  const lidMappings = cfg.mappings?.lidMappings || {};
  return lidMappings[phoneChatId] || null;
}

/**
 * Ensures chatId is in LID format. If phone number format, looks up LID from config or returns null.
 * This is a synchronous lookup that only checks config mappings.
 * For async lookup via WAHA API (including fallback to API if not in config), use ensureLidFormatForMessaging in waha-client.js.
 * @param {Object} cfg - Configuration object
 * @param {string} chatId - Chat ID in any format
 * @returns {string|null} LID format chatId or null if phone format and no mapping found
 */
export function ensureLidFormat(cfg, chatId) {
  if (!chatId || typeof chatId !== 'string') {
    return null;
  }
  
  // Already in LID format
  if (chatId.endsWith('@lid')) {
    return chatId;
  }
  
  // Phone number format - look up LID mapping
  if (chatId.endsWith('@c.us')) {
    return getLidFromPhoneNumber(cfg, chatId) || null;
  }
  
  // Unknown format
  return null;
}

/**
 * Sets LID mapping for a phone number and saves to config file
 * @param {Object} cfg - Configuration object (will be updated in-place)
 * @param {string} phoneChatId - Phone number format chatId (e.g., "96566674323@c.us")
 * @param {string} lidChatId - LID format chatId (e.g., "151169980723349@lid")
 * @param {Object} logger - Logger instance
 * @returns {boolean} True if successfully saved, false otherwise
 */
export function setLidMapping(cfg, phoneChatId, lidChatId, logger = null) {
  if (!phoneChatId || !lidChatId || typeof phoneChatId !== 'string' || typeof lidChatId !== 'string') {
    logger?.warn('Invalid parameters for setLidMapping', { phoneChatId, lidChatId });
    return false;
  }
  
  if (!phoneChatId.endsWith('@c.us') || !lidChatId.endsWith('@lid')) {
    logger?.warn('Invalid chatId format for setLidMapping', { phoneChatId, lidChatId });
    return false;
  }
  
  // Initialize mappings.lidMappings if it doesn't exist
  if (!cfg.mappings) {
    cfg.mappings = {};
  }
  if (!cfg.mappings.lidMappings) {
    cfg.mappings.lidMappings = {};
  }
  
  // Only update if mapping doesn't exist or is different
  if (cfg.mappings.lidMappings[phoneChatId] === lidChatId) {
    logger?.trace('LID mapping already exists', { phoneChatId, lidChatId });
    return true;
  }
  
  cfg.mappings.lidMappings[phoneChatId] = lidChatId;
  logger?.trace('Updated LID mapping in memory', { phoneChatId, lidChatId });
  
  // Save to config file
  try {
    const configPath = getConfigPath();
    const configContent = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configContent);
    
    if (!config.mappings) {
      config.mappings = {};
    }
    if (!config.mappings.lidMappings) {
      config.mappings.lidMappings = {};
    }
    
    config.mappings.lidMappings[phoneChatId] = lidChatId;
    
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    logger?.info(`💾 Saved LID mapping: ${phoneChatId.split('@')[0]} → ${lidChatId.split('@')[0]}`);
    return true;
  } catch (err) {
    logger?.warn('Failed to save LID mapping to config file', getErrorDetails(err, 'setLidMapping'));
    logger?.info(`⚠️  Manually add to config.json: "mappings": { "lidMappings": { "${phoneChatId}": "${lidChatId}" } }`);
    return false;
  }
}

/**
 * Persists Patreon link info (patreonUserId + email) into a phone number's
 * userIdMappings entry, writing the change back to config.json so it
 * survives a restart. The userIdMappings entry must already exist —
 * this function won't create new users out of thin air.
 *
 * @param {Object} cfg - Configuration object (mutated in place)
 * @param {string} phoneNumber - Phone number key (no @c.us suffix)
 * @param {Object} fields - { patreonUserId, patreonEmail? }
 * @param {Object} logger - Logger instance (optional)
 * @returns {boolean} True if persisted, false otherwise
 */
export function setPatreonLinkForPhone(cfg, phoneNumber, fields, logger = null) {
  if (!phoneNumber || typeof phoneNumber !== 'string') {
    logger?.warn('Invalid phone number for setPatreonLinkForPhone', { phoneNumber });
    return false;
  }
  const { patreonUserId, patreonEmail } = fields || {};
  if (!patreonUserId) {
    logger?.warn('patreonUserId is required for setPatreonLinkForPhone', { phoneNumber });
    return false;
  }

  if (!cfg.mappings) cfg.mappings = {};
  if (!cfg.mappings.userIdMappings) cfg.mappings.userIdMappings = {};
  const existing = cfg.mappings.userIdMappings[phoneNumber];
  if (!existing || typeof existing !== 'object') {
    logger?.warn('Cannot link Patreon — phone has no userIdMappings entry', { phoneNumber });
    return false;
  }

  // Persist to disk FIRST. We only mutate the in-memory `cfg` after the file
  // write succeeds — that way a disk error doesn't leave in-memory state
  // diverged from what's on disk (which a later reloadMappings() would clobber).
  try {
    const configPath = getConfigPath();
    const configContent = fs.readFileSync(configPath, 'utf8');
    const onDisk = JSON.parse(configContent);
    if (!onDisk.mappings) onDisk.mappings = {};
    if (!onDisk.mappings.userIdMappings) onDisk.mappings.userIdMappings = {};
    const onDiskEntry = onDisk.mappings.userIdMappings[phoneNumber];
    if (!onDiskEntry || typeof onDiskEntry !== 'object') {
      logger?.warn('Cannot link Patreon — phone missing on disk', { phoneNumber });
      return false;
    }
    onDiskEntry.patreonUserId = String(patreonUserId);
    if (patreonEmail) onDiskEntry.patreonEmail = patreonEmail;
    fs.writeFileSync(configPath, JSON.stringify(onDisk, null, 2) + '\n', 'utf8');
  } catch (err) {
    logger?.warn('Failed to save Patreon link to config file', getErrorDetails(err, 'setPatreonLinkForPhone'));
    return false;
  }

  // Disk write succeeded — now reflect the change in the live cfg.
  existing.patreonUserId = String(patreonUserId);
  if (patreonEmail) existing.patreonEmail = patreonEmail;

  logger?.info(`💾 Saved Patreon link: ${phoneNumber} → patreonUserId ${patreonUserId}${patreonEmail ? ` (${patreonEmail})` : ''}`);
  return true;
}

/**
 * Reloads mappings from config file into the cfg object
 * This ensures mappings are always up-to-date with any manual config file changes
 * @param {Object} cfg - Configuration object to update
 * @param {Object} logger - Logger instance (optional)
 */
export function reloadMappings(cfg, logger = null) {
  try {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) {
      logger?.warn('Config file not found during mappings reload', { configPath });
      return;
    }

    const configContent = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configContent);

    // Update mappings in the cfg object
    if (config.mappings) {
      cfg.mappings = config.mappings;
      logger?.trace('Reloaded mappings from config file', {
        lidMappingsCount: Object.keys(cfg.mappings.lidMappings || {}).length,
        userIdMappingsCount: Object.keys(cfg.mappings.userIdMappings || {}).length,
        emailMappingsCount: Object.keys(cfg.mappings.emailMappings || {}).length
      });
    }
  } catch (err) {
    logger?.warn('Failed to reload mappings from config file', getErrorDetails(err, 'reloadMappings'));
  }
}

/**
 * Checks if a phone number is configured in userIdMappings
 * For userIdMappings lookup, converts LID to phone number if needed (userIdMappings use phone numbers as keys).
 * @param {Object} cfg - Configuration object
 * @param {string} chatId - WAHA chatId (e.g., "96566674323@c.us" or "151169980723349@lid")
 * @param {Object} wahaClient - Optional WAHA client for LID resolution (required if chatId is in LID format)
 * @returns {Promise<boolean>} True if phone number is configured in userIdMappings, false otherwise
 */
export async function isPhoneNumberConfigured(cfg, chatId, wahaClient = null) {
  const logger = cfg.__logger;
  
  if (!chatId) {
    logger?.debug('No chatId provided for configuration check');
    return false;
  }

  let phoneNumber = null;

  // Check if chatId is in LID format - if so, resolve to phone number for userIdMappings lookup
  if (isLidFormat(chatId)) {
    logger?.trace('LID format detected, resolving to phone number for configuration check', { chatId });
    
    if (wahaClient) {
      const resolvedPhoneNumber = await getPhoneNumberByLid(wahaClient, cfg, chatId);
      
      if (resolvedPhoneNumber) {
        phoneNumber = extractPhoneNumber(resolvedPhoneNumber);
        logger?.trace('LID successfully resolved to phone number for configuration check', { 
          chatId, 
          resolvedPhoneNumber, 
          phoneNumber 
        });
      } else {
        logger?.trace('Failed to resolve LID to phone number for configuration check', { chatId });
        return false;
      }
    } else {
      // No wahaClient provided, cannot resolve LID
      logger?.trace('LID format detected but no wahaClient provided for configuration check', { chatId });
      return false;
    }
  } else {
    // Not LID format, extract phone number directly
    phoneNumber = extractPhoneNumber(chatId);
    logger?.debug('Extracted phone number from chatId for configuration check', { chatId, phoneNumber });
  }

  if (!phoneNumber) {
    logger?.debug('Could not extract phone number from chatId for configuration check', { chatId });
    return false;
  }

  // Reload mappings from file to get latest changes (dynamic mapping updates)
  reloadMappings(cfg, logger);

  // Check userIdMappings using the phone number (not LID)
  const mappings = cfg.mappings?.userIdMappings || {};
  logger?.debug('Checking userIdMappings for configuration [USES PHONE NUMBER]', { 
    phoneNumber, 
    hasMappings: Object.keys(mappings).length > 0,
    availableMappings: Object.keys(mappings),
    originalChatId: chatId,
    identifierType: 'phoneNumber',
    phoneNumberInMappings: mappings[phoneNumber] !== undefined
  });
  
  if (mappings[phoneNumber] !== undefined) {
    const mapping = mappings[phoneNumber];
    // Validate mapping structure
    if (!mapping || typeof mapping !== 'object' || typeof mapping.userId !== 'number') {
      logger?.warn('Invalid userIdMappings structure for phone number', { 
        phoneNumber, 
        mapping,
        originalChatId: chatId
      });
      return false;
    }
    logger?.debug('Phone number is configured in userIdMappings', { 
      phoneNumber, 
      userId: mapping.userId,
      originalChatId: chatId
    });
    return true;
  }

  logger?.warn('Phone number is not configured in userIdMappings', { 
    phoneNumber,
    availableMappings: Object.keys(mappings),
    originalChatId: chatId
  });
  return false;
}

/**
 * Gets userId from mappings based on chatId.
 * For userIdMappings lookup, converts LID to phone number if needed (userIdMappings use phone numbers as keys).
 * Note: This function should only be called for configured phone numbers (verified via isPhoneNumberConfigured).
 * Returns null if no mapping is found (which should not happen for configured numbers).
 * @param {Object} cfg - Configuration object
 * @param {string} chatId - WAHA chatId (e.g., "96566674323@c.us" or "151169980723349@lid")
 * @param {Object} wahaClient - Optional WAHA client for LID resolution
 * @returns {Promise<number|null>} User ID or null if not found
 */
export async function getUserIdFromChatId(cfg, chatId, wahaClient = null) {
  const logger = cfg.__logger;
  
  if (!chatId) {
    logger?.warn('No chatId provided to getUserIdFromChatId', { chatId });
    return null;
  }

  logger?.debug('Resolving userId from chatId', { chatId, isLidFormat: isLidFormat(chatId) });

  let phoneNumber = null;

  // Check if chatId is in LID format - if so, resolve to phone number for userIdMappings lookup
  if (isLidFormat(chatId)) {
    logger?.trace('LID format detected, resolving to phone number for userIdMappings lookup', { chatId });
    
    if (wahaClient) {
      const resolvedPhoneNumber = await getPhoneNumberByLid(wahaClient, cfg, chatId);
      
      if (resolvedPhoneNumber) {
        // Extract phone number from @c.us format
        // Note: getPhoneNumberByLid already logs the extraction, so we don't log again here
        phoneNumber = extractPhoneNumber(resolvedPhoneNumber);
        logger?.trace('LID successfully resolved to phone number', { 
          chatId, 
          resolvedPhoneNumber, 
          phoneNumber 
        });
        
        // Create reverse mapping: phone number -> LID (for future lookups)
        if (phoneNumber && chatId.endsWith('@lid')) {
          const phoneChatId = `${phoneNumber}@c.us`;
          setLidMapping(cfg, phoneChatId, chatId, logger);
        }
      } else {
        logger?.warn('Failed to resolve LID to phone number', { chatId });
        return null;
      }
    } else {
      // No wahaClient provided, cannot resolve LID
      logger?.warn('LID format detected but no wahaClient provided', { chatId });
      return null;
    }
  } else {
    // Not LID format, extract phone number directly
    phoneNumber = extractPhoneNumber(chatId);
    logger?.debug('Extracted phone number from chatId', { chatId, phoneNumber });
    if (phoneNumber) {
      logger?.info(`📞 Resolved phone number: ${phoneNumber}`);
    }
  }

  if (!phoneNumber) {
    // Invalid chatId format or failed to resolve
    logger?.warn('Could not extract phone number from chatId', { chatId });
    return null;
  }

  // Reload mappings from file to get latest changes (dynamic mapping updates)
  reloadMappings(cfg, logger);
  
  // Check userIdMappings using the phone number (not LID)
  const mappings = cfg.mappings?.userIdMappings || {};
  logger?.debug('Checking userIdMappings [USES PHONE NUMBER]', { 
    phoneNumber, 
    hasMappings: Object.keys(mappings).length > 0,
    originalChatId: chatId,
    identifierType: 'phoneNumber'
  });
  
  if (mappings[phoneNumber] !== undefined) {
    const mapping = mappings[phoneNumber];
    // Validate mapping structure
    if (!mapping || typeof mapping !== 'object' || typeof mapping.userId !== 'number') {
      logger?.error('Invalid userIdMappings structure for phone number, expected object with userId property', { 
        phoneNumber, 
        mapping,
        originalChatId: chatId
      });
      return null;
    }
    const userId = mapping.userId;
    logger?.debug('Found userId in mappings [USES PHONE NUMBER]', { 
      phoneNumber, 
      userId, 
      originalChatId: chatId,
      identifierType: 'phoneNumber'
    });
    logger?.info(`👤 User ID: ${userId}`);
    return userId;
  }

  // No mapping found - this should not happen for configured numbers
  logger?.error('No mapping found for phone number in userIdMappings (this should not happen for configured numbers)', { 
    phoneNumber,
    originalChatId: chatId,
    availableMappings: Object.keys(mappings)
  });
  return null;
}

/**
 * Gets username from mappings based on chatId
 * For userIdMappings lookup, converts LID to phone number if needed.
 * @param {Object} cfg - Configuration object
 * @param {string} chatId - WAHA chatId (e.g., "96566674323@c.us" or "151169980723349@lid")
 * @param {Object} wahaClient - Optional WAHA client for LID resolution
 * @returns {Promise<string|null>} Username or null if not found or empty
 */
export async function getUsernameFromChatId(cfg, chatId, wahaClient = null) {
  const logger = cfg.__logger;
  
  if (!chatId) {
    logger?.debug('No chatId provided for username lookup');
    return null;
  }

  logger?.debug('Resolving username from chatId', { chatId, isLidFormat: isLidFormat(chatId) });

  let phoneNumber = null;

  // Check if chatId is in LID format - if so, resolve to phone number for userIdMappings lookup
  if (isLidFormat(chatId)) {
    logger?.trace('LID format detected, resolving to phone number for username lookup', { chatId });
    
    if (wahaClient) {
      const resolvedPhoneNumber = await getPhoneNumberByLid(wahaClient, cfg, chatId);
      
      if (resolvedPhoneNumber) {
        phoneNumber = extractPhoneNumber(resolvedPhoneNumber);
        logger?.trace('LID successfully resolved to phone number for username lookup', { 
          chatId, 
          resolvedPhoneNumber, 
          phoneNumber 
        });
      } else {
        logger?.trace('Failed to resolve LID to phone number for username lookup', { chatId });
        return null;
      }
    } else {
      // No wahaClient provided, cannot resolve LID
      logger?.trace('LID format detected but no wahaClient provided for username lookup', { chatId });
      return null;
    }
  } else {
    // Not LID format, extract phone number directly
    phoneNumber = extractPhoneNumber(chatId);
    logger?.debug('Extracted phone number from chatId for username lookup', { chatId, phoneNumber });
  }

  if (!phoneNumber) {
    logger?.debug('Could not extract phone number from chatId for username lookup', { chatId });
    return null;
  }

  // Reload mappings from file to get latest changes (dynamic mapping updates)
  reloadMappings(cfg, logger);

  // Check userIdMappings using the phone number (not LID)
  const mappings = cfg.mappings?.userIdMappings || {};
  logger?.debug('Checking userIdMappings for username [USES PHONE NUMBER]', { 
    phoneNumber, 
    hasMappings: Object.keys(mappings).length > 0,
    originalChatId: chatId,
    identifierType: 'phoneNumber'
  });
  
  if (mappings[phoneNumber] !== undefined) {
    const mapping = mappings[phoneNumber];
    // Validate mapping structure
    if (!mapping || typeof mapping !== 'object') {
      logger?.debug('Invalid userIdMappings structure for phone number in username lookup', { 
        phoneNumber, 
        mapping,
        originalChatId: chatId
      });
      return null;
    }
    const username = mapping.username;
    // Return username only if it's a non-empty string
    if (username && typeof username === 'string' && username.trim() !== '') {
      logger?.debug('Found username in mappings [USES PHONE NUMBER]', { 
        phoneNumber, 
        username, 
        originalChatId: chatId,
        identifierType: 'phoneNumber'
      });
      return username.trim();
    }
    logger?.debug('Username not set or empty in mappings', { phoneNumber, username });
    return null;
  }

  logger?.debug('No mapping found for phone number in username lookup', { 
    phoneNumber, 
    availableMappings: Object.keys(mappings)
  });
  return null;
}

/**
 * Gets user ID from email address by fetching all users from Overseerr/Jellyseerr API
 * @param {Object} cfg - Configuration object
 * @param {Object} jellyseerrClient - Jellyseerr API client
 * @param {string} email - Email address to look up
 * @returns {Promise<number|null>} User ID or null if not found
 */
export async function getUserIdFromEmail(cfg, jellyseerrClient, email) {
  const logger = cfg.__logger;
  
  if (!email || typeof email !== 'string') {
    logger?.warn('Invalid email provided for user lookup', { email });
    return null;
  }

  // Check email mappings first (faster lookup)
  const emailMappings = cfg.mappings?.emailMappings || {};
  if (emailMappings[email] !== undefined) {
    const userId = emailMappings[email];
    logger?.debug('Found userId in emailMappings', { email, userId });
    logger?.info(`👤 User ID: ${userId} (from email: ${email})`);
    return userId;
  }

  logger?.debug('Email not in mappings, fetching from API', { email });

  try {
    const headers = {
      'X-Api-Key': cfg.jellyseerr.apiKey,
    };

    // Fetch all users (with pagination if needed)
    // Start with a reasonable page size
    let allUsers = [];
    let page = 1;
    const pageSize = 100;
    let hasMore = true;

    while (hasMore) {
      const res = await jellyseerrClient.request('GET', 'user', {
        headers,
        query: {
          take: pageSize,
          skip: (page - 1) * pageSize
        }
      });

      if (res.status !== 200) {
        logger?.error('Failed to fetch users from API', { status: res.status });
        break;
      }

      const data = res.data || {};
      const users = data.results || [];
      allUsers = allUsers.concat(users);

      // Check if there are more pages using PageInfo schema
      // PageInfo: { page: number, pages: number, results: number }
      const pageInfo = data.pageInfo || {};
      const currentPage = pageInfo.page || page;
      const totalPages = pageInfo.pages || 1;
      const totalResults = pageInfo.results || users.length;
      
      logger?.debug('Pagination info', { 
        currentPage, 
        totalPages, 
        totalResults, 
        fetchedSoFar: allUsers.length,
        usersInThisPage: users.length 
      });
      
      // Determine if there are more pages:
      // Primary check: current page < total pages
      // Secondary check: ensure we haven't fetched all results yet
      hasMore = currentPage < totalPages && allUsers.length < totalResults;
      page++;

      // Safety limit to prevent infinite loops
      if (page > 100) {
        logger?.warn('Reached pagination limit while fetching users', { totalFetched: allUsers.length });
        break;
      }
    }

    logger?.debug('Fetched users from API', { totalUsers: allUsers.length, email });

    // Find user by email
    const user = allUsers.find(u => u.email && u.email.toLowerCase() === email.toLowerCase());
    
    if (user && user.id) {
      const userId = user.id;
      logger?.info(`👤 User ID: ${userId} (found via API for ${email})`);
      
      // Update email mappings in memory (config file update handled by caller)
      if (!cfg.mappings) {
        cfg.mappings = {};
      }
      if (!cfg.mappings.emailMappings) {
        cfg.mappings.emailMappings = {};
      }
      cfg.mappings.emailMappings[email] = userId;
      
      return userId;
    }

    logger?.warn('User not found by email', { email, totalUsersChecked: allUsers.length });
    return null;

  } catch (err) {
    logger?.error('Error fetching users from API', getErrorDetails(err, 'getUserIdFromEmail'));
    return null;
  }
}

/**
 * Gets phone number from user ID by reverse lookup in userIdMappings
 * @param {Object} cfg - Configuration object
 * @param {number} userId - User ID to look up
 * @returns {string|null} Phone number or null if not found
 */
export function getPhoneNumberFromUserId(cfg, userId) {
  const logger = cfg.__logger;
  
  if (!userId || typeof userId !== 'number') {
    logger?.warn('Invalid userId provided for phone number lookup', { userId });
    return null;
  }

  // Reload mappings from file to get latest changes (dynamic mapping updates)
  reloadMappings(cfg, logger);

  const mappings = cfg.mappings?.userIdMappings || {};
  
  // Reverse lookup: find phone number where userId matches
  for (const [phoneNumber, mapping] of Object.entries(mappings)) {
    // Validate mapping structure before accessing userId
    if (mapping && typeof mapping === 'object' && typeof mapping.userId === 'number' && mapping.userId === userId) {
      logger?.debug('Found phone number in userIdMappings', { userId, phoneNumber });
      return phoneNumber;
    }
  }

  logger?.debug('No phone number found for userId in mappings', { 
    userId, 
    availableMappings: Object.keys(mappings).length
  });
  return null;
}

/**
 * Checks if a userId has admin flag in userIdMappings
 * @param {Object} cfg - Configuration object
 * @param {number} userId - User ID to check
 * @returns {boolean} True if userId has admin flag set to true, false otherwise
 */
export function isUserIdAdmin(cfg, userId) {
  if (!userId || typeof userId !== 'number') {
    return false;
  }

  // Reload mappings from file to get latest changes (dynamic mapping updates)
  const logger = cfg.__logger;
  reloadMappings(cfg, logger);

  const mappings = cfg.mappings?.userIdMappings || {};
  
  // Check if any mapping has this userId with admin flag
  for (const [phoneNumber, mapping] of Object.entries(mappings)) {
    if (mapping && typeof mapping === 'object' && typeof mapping.userId === 'number' && mapping.userId === userId) {
      return mapping.admin === true;
    }
  }

  return false;
}

/**
 * Gets the first admin phone number from userIdMappings
 * @param {Object} cfg - Configuration object
 * @returns {string|null} Phone number of first admin user or null if no admin found
 */
export function getAdminPhoneNumber(cfg) {
  // Reload mappings from file to get latest changes (dynamic mapping updates)
  const logger = cfg.__logger;
  reloadMappings(cfg, logger);
  
  const mappings = cfg.mappings?.userIdMappings || {};
  
  // Find first user with admin flag set to true
  for (const [phoneNumber, mapping] of Object.entries(mappings)) {
    if (mapping && typeof mapping === 'object' && mapping.admin === true) {
      return phoneNumber;
    }
  }
  
  return null;
}

/**
 * Validates if a chatId belongs to an admin user (checks userIdMappings for admin flag)
 * @param {Object} cfg - Configuration object
 * @param {string} chatId - Chat ID to validate (can be phone format or LID format)
 * @param {Object} wahaClient - WAHA client for LID resolution (optional)
 * @param {Object} logger - Logger instance (optional)
 * @returns {Promise<boolean>} True if chatId belongs to an admin user, false otherwise
 */
export async function isAdminChatId(cfg, chatId, wahaClient = null, logger = null) {
  if (!chatId) {
    return false;
  }

  let phoneNumber = null;

  // Check if chatId is in LID format - if so, resolve to phone number
  if (isLidFormat(chatId)) {
    if (wahaClient) {
      logger?.debug('Resolving LID format to phone number for admin validation', { chatId });
      const resolvedPhone = await getPhoneNumberByLid(wahaClient, cfg, chatId);
      if (resolvedPhone) {
        phoneNumber = extractPhoneNumber(resolvedPhone);
      }
    } else {
      logger?.trace('LID format detected but no wahaClient provided for admin validation', { chatId });
      return false;
    }
  } else {
    // Not LID format, extract phone number directly
    phoneNumber = extractPhoneNumber(chatId);
  }

  if (!phoneNumber) {
    return false;
  }

  // Reload mappings from file to get latest changes (dynamic mapping updates)
  reloadMappings(cfg, logger);
  
  // Check if phone number belongs to a user with admin flag in userIdMappings
  const mappings = cfg.mappings?.userIdMappings || {};
  const mapping = mappings[phoneNumber];
  
  if (mapping && typeof mapping === 'object' && mapping.admin === true) {
    logger?.debug('Admin validation: chatId belongs to admin user', { chatId, phoneNumber });
    return true;
  }

  return false;
}

