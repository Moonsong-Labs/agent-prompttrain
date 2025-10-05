/**
 * Feature flag middleware for database credentials
 *
 * Database credentials are now always enabled (ADR-026).
 * This middleware is kept for compatibility but no longer performs any checks.
 */

import { createMiddleware } from 'hono/factory'

/**
 * Middleware to require database credentials feature flag
 *
 * Database credentials are always enabled (ADR-026).
 * This middleware is a no-op for backward compatibility.
 */
export const requireDbCredentials = createMiddleware(async (c, next) => {
  // Database credentials are always enabled (ADR-026)
  await next()
})
