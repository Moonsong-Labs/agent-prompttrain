import { Context, Next } from 'hono'
import { logger } from './logger.js'

/**
 * Domain Extractor Middleware
 * Extracts domain from request and sets it in context
 */
export function domainExtractorMiddleware() {
  return async (c: Context, next: Next) => {
    // Extract domain from Host header
    const host = c.req.header('host')

    if (!host) {
      logger.warn('No host header in request', {
        path: c.req.path,
        ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
      })
      // Reject requests without Host header - HTTP/1.1 requires it
      return c.json(
        {
          error: {
            code: 'bad_request',
            message: 'Host header is required',
          },
        },
        400
      )
    } else {
      let trainId = host

      // Check if it's localhost or an IP address
      const isLocalhost = host.startsWith('localhost')
      const isIPAddress = /^(\d{1,3}\.){3}\d{1,3}/.test(host)

      if (isLocalhost || isIPAddress) {
        // For localhost and IP addresses, keep the port
        trainId = host
      } else {
        // For other domains, remove the port first
        trainId = host.split(':')[0]
      }

      c.set('trainId', trainId)
    }

    await next()
  }
}
