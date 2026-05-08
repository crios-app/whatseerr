/**
 * Fastify webhook server
 * Replaces the raw HTTP server with Fastify
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { getWebhookUrl, extractPhoneNumber, isLidFormat, setPatreonLinkForPhone } from './utils.js';
import { handleSeerrWebhook, handleReaction } from './webhook-helpers.js';
import { handleLibraryWebhook, validateLibraryToken, parseLibraryBody } from './webhook-library.js';
import { validateWahaWebhook, validateSeerrWebhook } from './validation/validators.js';
import { getStateManager } from './state/cache-state.js';
import { getQueueManager } from './queue/message-queue.js';
import { APIError, ValidationError } from './errors/custom-errors.js';
import { getErrorDetails } from './errors/error-formatter.js';
import { getOAuthStateCache } from './patreon/oauth-state.js';
import { exchangeCode, fetchIdentity, isOauthConfigured } from './patreon/oauth.js';
import { getPatreonTierCache } from './patreon/tier-cache.js';
import { getPhoneNumberByLid, sendMessage } from './waha-client.js';

/**
 * Creates and configures the Fastify webhook server
 */
export async function createServer(cfg, jellyseerrClient, wahaClient, handleMessage) {
  const logger = cfg.__logger;
  const requestsPort = cfg.webhook?.requests?.port || 3006;
  const requestsPath = cfg.webhook?.requests?.path;
  const seerrPath = cfg.webhook?.seerr?.path || '/seerr';
  const libraryPath = cfg.webhook?.library?.path || '/library';

  // Create Fastify instance
  const fastify = Fastify({
    logger: false, // We use our own logger
    disableRequestLogging: true // We'll handle logging ourselves
  });

  // Register CORS
  await fastify.register(cors, {
    origin: true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
  });

  // Register rate limiting
  const rateLimitConfig = cfg.rateLimit || {};
  await fastify.register(rateLimit, {
    max: rateLimitConfig.maxRequests || 100,
    timeWindow: rateLimitConfig.timeWindow || '1 minute',
    errorResponseBuilder: (request, context) => {
      return {
        error: 'Too Many Requests',
        message: 'Rate limit exceeded'
      };
    }
  });

  // Error handler
  fastify.setErrorHandler((error, request, reply) => {
    const errorDetails = getErrorDetails(error, `HTTP ${request.method} ${request.url}`);
    logger?.error('Fastify error', {
      ...errorDetails,
      url: request.url,
      method: request.method
    });

    if (error instanceof ValidationError) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: error?.message || 'Validation failed',
        field: error?.field || null
      });
    }

    if (error instanceof APIError) {
      return reply.code(error.statusCode || 500).send({
        error: 'API Error',
        message: error?.message || 'API request failed',
        endpoint: error?.endpoint || null
      });
    }

    return reply.code(500).send({
      error: 'Internal Server Error',
      message: error?.message || 'An unexpected error occurred'
    });
  });

  // Health check endpoint
  fastify.get('/', async (request, reply) => {
    return {
      status: 'ok',
      service: 'WhatsApp Jellyseerr Bot',
      endpoints: {
        requests: requestsPath,
        seerr: seerrPath,
        library: libraryPath,
        patreonCallback: '/patreon/callback'
      },
      port: requestsPort
    };
  });

  // Patreon OAuth callback. Patrons hit this after clicking the link from
  // the `link` command. We exchange the code for a Patreon access token,
  // pull their Patreon user id + email, then persist the link to the
  // matching `userIdMappings` entry. The response is plain HTML so the
  // browser renders something friendly; the actual confirmation reaches
  // the patron via WhatsApp DM.
  fastify.get('/patreon/callback', async (request, reply) => {
    if (!isOauthConfigured(cfg)) {
      return reply.code(503).type('text/html').send(
        '<h1>Patreon linking not configured</h1><p>This Whatseerr instance has no OAuth client set up.</p>'
      );
    }

    const { code, state, error: oauthError } = request.query || {};

    if (oauthError) {
      logger?.info(`Patreon OAuth callback denied by user: ${oauthError}`);
      return reply.type('text/html').send(
        '<h1>Linking cancelled</h1><p>You can close this tab and try again from WhatsApp by sending <code>link</code>.</p>'
      );
    }

    if (!code || !state) {
      return reply.code(400).type('text/html').send(
        '<h1>Bad request</h1><p>Missing <code>code</code> or <code>state</code> query parameters.</p>'
      );
    }

    const stateCache = getOAuthStateCache();
    const stateEntry = stateCache.consume(String(state));
    if (!stateEntry) {
      return reply.code(400).type('text/html').send(
        '<h1>Link expired</h1><p>This Patreon link has already been used or has expired. Send <code>link</code> in WhatsApp to get a new one.</p>'
      );
    }

    const { chatId } = stateEntry;

    try {
      const accessToken = await exchangeCode(cfg, String(code));
      const identity = await fetchIdentity(accessToken);

      // Resolve chatId -> phone number so we know which userIdMappings
      // entry to update.
      let phoneNumber = null;
      if (isLidFormat(chatId)) {
        const phoneChatId = await getPhoneNumberByLid(wahaClient, cfg, chatId);
        if (phoneChatId) phoneNumber = extractPhoneNumber(phoneChatId);
      } else {
        phoneNumber = extractPhoneNumber(chatId);
      }

      if (!phoneNumber) {
        logger?.warn('Patreon link callback: could not resolve phone for chat', { chatId });
        return reply.code(500).type('text/html').send(
          '<h1>Link failed</h1><p>We could not resolve your WhatsApp number on the server. Please contact the admin.</p>'
        );
      }

      const persisted = setPatreonLinkForPhone(cfg, phoneNumber, {
        patreonUserId: identity.patreonUserId,
        patreonEmail: identity.email
      }, logger);

      if (!persisted) {
        // Most common cause: this phone isn't in userIdMappings yet.
        logger?.warn('Patreon link callback: phone has no userIdMappings entry', { phoneNumber });
        try {
          await sendMessage(wahaClient, cfg, chatId,
            '⚠️ I received your Patreon authorization but your WhatsApp number isn\'t set up in this bot yet. Please contact the admin so they can add you.'
          );
        } catch {}
        return reply.code(404).type('text/html').send(
          '<h1>Link not saved</h1><p>Your WhatsApp number isn\'t configured on this bot yet. Please contact the admin.</p>'
        );
      }

      // Refresh the tier cache so the new link can be evaluated immediately.
      const tierCache = getPatreonTierCache();
      let allowed = false;
      let tierTitles = null;
      if (tierCache && tierCache.enabled) {
        await tierCache.refresh().catch(() => {});
        const lookup = tierCache.check({ patreonUserId: identity.patreonUserId, email: identity.email });
        allowed = lookup.allowed;
        tierTitles = lookup.tierTitles;
      }

      const tiersStr = tierTitles ? tierTitles.join(', ') : 'none';
      const dmMessage = allowed
        ? `✅ Patreon linked! Your tier${tierTitles && tierTitles.length > 1 ? 's' : ''}: *${tiersStr}*. You can now use the bot — try \`help\` to see what's available.`
        : `✅ Patreon authorization received, but your account is not currently on a Premium / Diamond tier (we see: *${tiersStr || 'none'}*). Upgrade your pledge and try again.`;
      try {
        await sendMessage(wahaClient, cfg, chatId, dmMessage);
      } catch (err) {
        logger?.warn('Failed to send Patreon link confirmation DM', getErrorDetails(err, 'sendLinkConfirmation'));
      }

      return reply.type('text/html').send(
        `<h1>Link complete</h1><p>You can close this tab. We've sent a confirmation to your WhatsApp.</p>`
      );
    } catch (err) {
      logger?.error('Patreon OAuth callback failed', {
        ...getErrorDetails(err, 'patreonOauthCallback'),
        chatId
      });
      try {
        await sendMessage(wahaClient, cfg, chatId,
          '❌ Sorry — your Patreon link failed on our end. Please send `link` again in a few minutes.'
        );
      } catch {}
      return reply.code(500).type('text/html').send(
        '<h1>Link failed</h1><p>Something went wrong while verifying your Patreon account. Please return to WhatsApp and send <code>link</code> again.</p>'
      );
    }
  });

  // Library webhook endpoint - accepts Plex / Sonarr / Radarr payloads.
  // Plex POSTs multipart/form-data, Sonarr/Radarr POST JSON. Fastify only
  // parses JSON by default, so we register a content-type parser for the
  // multipart and form-encoded variants that just buffers the raw body.
  fastify.addContentTypeParser(
    ['application/x-www-form-urlencoded', 'multipart/form-data'],
    { parseAs: 'buffer' },
    (req, body, done) => done(null, body)
  );

  fastify.post(libraryPath, async (request, reply) => {
    const tokenError = validateLibraryToken(cfg, request);
    if (tokenError) {
      logger?.warn(`Library webhook rejected: ${tokenError}`);
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const contentType = request.headers['content-type'] || '';
    let payload;
    try {
      // For JSON, request.body is already parsed. For multipart/form-encoded,
      // it's a Buffer thanks to the content-type parser above.
      payload = parseLibraryBody(request.body, contentType);
    } catch (err) {
      logger?.warn('Library webhook: body parse failed', getErrorDetails(err, 'parseLibraryBody'));
      return reply.code(400).send({ error: 'Invalid body' });
    }

    if (!payload) {
      return reply.code(400).send({ error: 'Empty or unparseable payload' });
    }

    logger?.info('📥 Library webhook received');
    if (cfg.logging?.apiResponse) {
      logger?.debug('🐛 [DEBUG] Library webhook payload', { payload });
    }

    // Process asynchronously so we ack the upstream quickly.
    const queueManager = getQueueManager();
    queueManager.addWebhookTask(() =>
      handleLibraryWebhook(cfg, wahaClient, payload, logger)
    ).catch((err) => {
      logger?.error('Error in handleLibraryWebhook', getErrorDetails(err, 'handleLibraryWebhook'));
    });

    return { received: true };
  });

  // Seerr webhook endpoint
  fastify.post(seerrPath, async (request, reply) => {
    logger?.info('📥 Seerr webhook received');

    // Debug: log full payload when apiResponse is enabled
    if (cfg.logging?.apiResponse) {
      logger?.debug('🐛 [DEBUG] Seerr webhook payload', {
        payload: request.body
      });
    }

    try {
      // Validate webhook data
      const seerrData = validateSeerrWebhook(request.body);

      // Process webhook asynchronously (don't block response)
      const queueManager = getQueueManager();
      // Fire and forget - process in background, catch errors
      queueManager.addWebhookTask(() => 
        handleSeerrWebhook(cfg, jellyseerrClient, wahaClient, seerrData, logger)
      ).catch((err) => {
        logger?.error('Error in handleSeerrWebhook', getErrorDetails(err, 'handleSeerrWebhook'));
      });

      return { received: true, message: 'Seerr notification logged' };
    } catch (err) {
      logger?.error('Error processing Seerr webhook', getErrorDetails(err, 'processSeerrWebhook'));
      throw err; // Will be caught by error handler
    }
  });

  // WAHA requests webhook endpoint
  fastify.post(requestsPath, async (request, reply) => {
    logger?.debug('WAHA requests webhook POST received', { url: request.url });

    // Debug: log full payload when apiResponse is enabled
    if (cfg.logging?.apiResponse) {
      logger?.debug('🐛 [DEBUG] WAHA webhook payload', {
        payload: request.body
      });
    }

    try {
      // Validate webhook data
      const webhookData = validateWahaWebhook(request.body);

      if (webhookData.event) {
        // Log webhook event with more details
        const logData = {
          event: webhookData.event,
          session: webhookData.session || 'unknown',
          hasPayload: !!webhookData.payload
        };
        
        // Add payload details for message events
        if (webhookData.event === 'message' && webhookData.payload) {
          const payload = webhookData.payload;
          logData.from = payload.from;
          logData.messageId = payload.id;
          logData.hasBody = !!payload.body;
          logData.messageLength = payload.body?.length || 0;
          if (payload.body) {
            const preview = payload.body.length > 100 
              ? payload.body.substring(0, 100) + '...'
              : payload.body;
            logData.messagePreview = preview;
          }
        }
        
        // Add payload details for reaction events
        if (webhookData.event === 'message.reaction' && webhookData.payload) {
          const payload = webhookData.payload;
          logData.reactor = payload.from;
          logData.reactionText = payload.reaction?.text || '(empty)';
          logData.messageId = payload.reaction?.messageId;
        }
        
        logger?.info(`📥 Webhook event: ${webhookData.event}`);
      } else {
        logger?.warn('Webhook data has no event field', {
          keys: Object.keys(webhookData || {}),
          session: webhookData.session || 'unknown'
        });
      }

      const queueManager = getQueueManager();

      // Handle message.reaction events for approval/decline
      if (webhookData.event === 'message.reaction' && webhookData.payload) {
        logger?.info('🔄 Processing message.reaction event', {
          reactor: webhookData.payload?.from,
          messageId: webhookData.payload?.reaction?.messageId,
          reactionText: webhookData.payload?.reaction?.text || '(empty)'
        });
        queueManager.addWebhookTask(() => 
          handleReaction(cfg, jellyseerrClient, wahaClient, webhookData)
        ).catch((err) => {
          logger?.error('Error in handleReaction', getErrorDetails(err, 'handleReaction'));
        });
      }
      // Process message events - prefer 'message.any' to avoid duplicates
      else if (webhookData.event === 'message.any' && webhookData.payload) {
        logger?.debug('Processing message.any event', {
          from: webhookData.payload?.from,
          messageId: webhookData.payload?.id,
          hasBody: !!webhookData.payload?.body
        });
        const chatId = webhookData.payload?.from; // Extract chatId for per-user queue
        
        const taskFn = () => handleMessage(cfg, jellyseerrClient, wahaClient, webhookData);
        
        if (chatId) {
          // Use per-user queue for sequential processing per user
          queueManager.addUserMessageTask(chatId, taskFn).catch((err) => {
            logger?.error('Error in handleMessage (user queue)', {
              ...getErrorDetails(err, 'handleMessage'),
              event: 'message.any',
              chatId
            });
          });
        } else {
          // Fallback to global queue if chatId is missing
          queueManager.addMessageTask(taskFn).catch((err) => {
            logger?.error('Error in handleMessage (global queue)', {
              ...getErrorDetails(err, 'handleMessage'),
              event: 'message.any'
            });
          });
        }
      } else if (webhookData.event === 'message' && webhookData.payload) {
        // Only process 'message' event if message ID wasn't already processed
        const messageId = webhookData.payload?.id;
        const stateManager = getStateManager();
        
        if (messageId && !stateManager.isMessageProcessed(messageId)) {
          // Log message queued for processing (detailed logging happens in middleware)
          logger?.debug('Message event queued for processing', {
            from: webhookData.payload?.from,
            messageId,
            hasBody: !!webhookData.payload?.body,
            messagePreview: webhookData.payload?.body?.substring(0, 50) || '(no body)'
          });
          const chatId = webhookData.payload?.from; // Extract chatId for per-user queue
          
          const taskFn = () => handleMessage(cfg, jellyseerrClient, wahaClient, webhookData);
          
          if (chatId) {
            // Use per-user queue for sequential processing per user
            queueManager.addUserMessageTask(chatId, taskFn).catch((err) => {
              logger?.error('Error in handleMessage (user queue)', {
                ...getErrorDetails(err, 'handleMessage'),
                event: 'message',
                chatId
              });
            });
          } else {
            // Fallback to global queue if chatId is missing
            queueManager.addMessageTask(taskFn).catch((err) => {
              logger?.error('Error in handleMessage (global queue)', {
                ...getErrorDetails(err, 'handleMessage'),
                event: 'message'
              });
            });
          }
        } else {
          logger?.info('🔄 Duplicate webhook event - already processed, skipping');
        }
      }

      return { received: true };
    } catch (err) {
      logger?.error('Error processing WAHA webhook', getErrorDetails(err, 'processWAHAWebhook'));
      throw err; // Will be caught by error handler
    }
  });

  // 404 handler
  fastify.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({ error: 'Not Found' });
  });

  // Start server
  try {
    await fastify.listen({ port: requestsPort, host: '0.0.0.0' });
    
    logger?.info(`🚀 Webhook server listening`);
    logger?.info(`📍 WAHA requests path: ${requestsPath}`);
    logger?.info(`📍 Seerr notifications path: ${seerrPath}`);
    logger?.info(`📍 Library notifications path: ${libraryPath} (Plex / Sonarr / Radarr)`);
    logger?.info(`🔌 Port: ${requestsPort}`);

    try {
      const webhookUrl = getWebhookUrl(cfg);
      logger?.info(`🔗 WAHA webhook URL: ${webhookUrl}`);
      if (cfg.protocol && cfg.host) {
        const externalPort = process.env.WEBHOOK_EXTERNAL_PORT
          ? parseInt(process.env.WEBHOOK_EXTERNAL_PORT, 10)
          : (cfg.webhook?.requests?.port || 3006);
        const seerrWebhookUrl = `${cfg.protocol}://${cfg.host}:${externalPort}${seerrPath}`;
        const libraryWebhookUrl = `${cfg.protocol}://${cfg.host}:${externalPort}${libraryPath}`;
        logger?.info(`🔗 Seerr webhook URL: ${seerrWebhookUrl}`);
        logger?.info(`🔗 Library webhook URL: ${libraryWebhookUrl}`);
      }
    } catch {
      logger?.warn('system.protocol/system.host not set; cannot print public webhook URLs. Set system.protocol + system.host, or configure manually.');
    }
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      logger?.error(`Port ${requestsPort} is already in use. Choose a different requests.port.`);
    } else {
      logger?.error('Server error', getErrorDetails(err, 'serverStartup'));
    }
    process.exit(1);
  }

  return fastify;
}

