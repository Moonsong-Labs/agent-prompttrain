import { Context, Next } from 'hono'
import { timingSafeEqual as cryptoTimingSafeEqual } from 'crypto'
import { logger } from './logger.js'
import { container } from '../container.js'

/**
 * Client API Authentication Middleware
 * Validates domain-specific API keys for proxy access
 */
export function clientAuthMiddleware() {
  return async (c: Context, next: Next) => {
    const authorization = c.req.header('Authorization')

    if (!authorization) {
      return c.json(
        {
          error: {
            type: 'authentication_error',
            message: 'Missing Authorization header. Please provide a Bearer token.',
          },
        },
        401,
        {
          'WWW-Authenticate': 'Bearer realm="Agent Prompt Train"',
        }
      )
    }

    const match = authorization.match(/^Bearer\s+(.+)$/i)
    if (!match) {
      return c.json(
        {
          error: {
            type: 'authentication_error',
            message: 'Invalid Authorization header format. Expected: Bearer <token>',
          },
        },
        401,
        {
          'WWW-Authenticate': 'Bearer realm="Agent Prompt Train"',
        }
      )
    }

    const token = match[1]
    const trainId = c.get('trainId')
    const requestId = c.get('requestId')

    if (!domain) {
      logger.error('Client auth middleware: Domain not found in context', {
        requestId,
        path: c.req.path,
      })
      return c.json(
        {
          error: {
            type: 'internal_error',
            message: 'Domain context not found. This is an internal proxy error.',
          },
        },
        500
      )
    }

    try {
      // Get the authentication service from container
      const authService = container.getAuthenticationService()
      logger.debug(`trainId: ${domain}, requestId: ${requestId}`)
      const clientApiKey = await authService.getClientApiKey(domain)

      if (!clientApiKey) {
        logger.warn('Client auth middleware: No client API key configured', {
          requestId,
          trainId,
          path: c.req.path,
          ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
        })
        return c.json(
          {
            error: {
              type: 'authentication_error',
              message: `No client API key configured for domain "${domain}". Please add "client_api_key" to your credential file or disable client authentication.`,
            },
          },
          401,
          {
            'WWW-Authenticate': 'Bearer realm="Agent Prompt Train"',
          }
        )
      }

      // Use timing-safe comparison with SHA-256 hashing to prevent timing attacks
      // This ensures both inputs are always the same length (32 bytes)
      const encoder = new TextEncoder()
      const tokenBuffer = encoder.encode(token)
      const keyBuffer = encoder.encode(clientApiKey)

      // Hash both values before comparison
      const tokenHash = await crypto.subtle.digest('SHA-256', tokenBuffer)
      const keyHash = await crypto.subtle.digest('SHA-256', keyBuffer)

      // Convert ArrayBuffer to Buffer for Node's timingSafeEqual
      const tokenHashBuffer = Buffer.from(tokenHash)
      const keyHashBuffer = Buffer.from(keyHash)

      const isValid = cryptoTimingSafeEqual(tokenHashBuffer, keyHashBuffer)

      if (!isValid) {
        logger.warn('Client auth middleware: Invalid API key', {
          requestId,
          trainId,
          path: c.req.path,
          ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
        })
        return c.json(
          {
            error: {
              type: 'authentication_error',
              message: 'Invalid client API key. Please check your Bearer token.',
            },
          },
          401,
          {
            'WWW-Authenticate': 'Bearer realm="Agent Prompt Train"',
          }
        )
      }

      logger.debug('Client auth middleware: Authentication successful', {
        requestId,
        trainId,
      })

      // Authentication successful, proceed to next middleware
      await next()
    } catch (error) {
      logger.error('Client auth middleware: Error verifying token', {
        requestId,
        trainId,
        error: error instanceof Error ? { message: error.message } : { message: String(error) },
      })
      return c.json(
        {
          error: {
            type: 'internal_error',
            message: 'An error occurred while verifying authentication. Please try again.',
          },
        },
        500
      )
    }
  }
}
