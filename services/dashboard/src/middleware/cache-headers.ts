import { Context, Next } from 'hono'
import { config } from '@agent-prompttrain/shared'

/**
 * Middleware to set appropriate cache headers for dashboard API responses
 * This prevents browser caching when server-side caching is disabled
 */
export const cacheHeadersMiddleware = () => {
  return async (c: Context, next: Next) => {
    await next()

    // Don't overwrite existing Cache-Control headers
    const existing = c.res.headers.get('Cache-Control')
    if (existing) {
      return
    }

    // Only set cache headers for HTML and JSON responses
    const contentType = c.res.headers.get('Content-Type')
    if (contentType?.includes('text/html') || contentType?.includes('application/json')) {
      // Use the configured cache control header
      c.header('Cache-Control', config.httpCache.dashboardApiCacheControl)

      // Additional headers based on cache configuration
      if (config.httpCache.dashboardApiMaxAge === 0) {
        c.header('Pragma', 'no-cache')
        c.header('Expires', '0')
      } else {
        // Add Vary header for authenticated content when caching is enabled
        c.header('Vary', 'Authorization, Cookie')
      }
    }
  }
}
