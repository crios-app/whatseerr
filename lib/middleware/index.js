/**
 * Middleware pipeline orchestrator
 */

import { createLoggingMiddleware } from './logging.js';
import { createDuplicateDetectionMiddleware } from './duplicate-detection.js';
import { createNormalizationMiddleware } from './message-normalization.js';
import { createAdminAuthMiddleware } from './admin-auth.js';
import { createPatreonTierGateMiddleware } from './patreon-tier-gate.js';

/**
 * Creates the middleware pipeline.
 *
 * Order matters:
 *   1. Logging — first so we capture everything
 *   2. Duplicate detection — drop replays before any side effects
 *   3. Normalization — strip prefixes / lowercase
 *   4. Patreon tier gate — block non-Premium/Diamond users (admins + `help`
 *      bypass). Runs *before* admin-auth so non-admin commands are gated by
 *      tier, while privileged admin commands still get the admin-auth check.
 *   5. Admin auth — for commands that explicitly set `requiresAdmin`
 */
export function createMiddlewarePipeline(cfg, wahaClient, logger) {
  const middleware = [
    createLoggingMiddleware(logger),
    createDuplicateDetectionMiddleware(logger),
    createNormalizationMiddleware(),
    createPatreonTierGateMiddleware(wahaClient, logger),
    createAdminAuthMiddleware(wahaClient, logger)
  ];

  /**
   * Executes middleware pipeline
   */
  return async function executePipeline(context) {
    let index = 0;

    async function next() {
      if (index >= middleware.length) {
        return;
      }

      const mw = middleware[index++];
      await mw(context, next);
    }

    await next();
    return context;
  };
}

