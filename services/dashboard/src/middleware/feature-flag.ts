/**
 * Feature flag middleware for database credentials
 *
 * Runtime check for USE_DATABASE_CREDENTIALS flag.
 * Returns 404 if the feature is disabled.
 */

import { createMiddleware } from 'hono/factory'

/**
 * Middleware to require database credentials feature flag
 *
 * Returns 404 if USE_DATABASE_CREDENTIALS is not 'true'
 */
export const requireDbCredentials = createMiddleware(async (c, next) => {
  if (process.env.USE_DATABASE_CREDENTIALS !== 'true') {
    return c.notFound()
  }
  await next()
})
