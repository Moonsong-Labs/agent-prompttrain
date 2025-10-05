import { Context, Next } from 'hono'
import { timingSafeEqual as cryptoTimingSafeEqual } from 'crypto'
import { logger } from './logger.js'
import { container } from '../container.js'

/**
 * Client API Authentication Middleware
 * Validates train-scoped API keys for proxy access
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

    if (!trainId) {
      logger.error('Client auth middleware: Train ID not found in context', {
        requestId,
        path: c.req.path,
      })
      return c.json(
        {
          error: {
            type: 'internal_error',
            message: 'Train ID context not found. This is an internal proxy error.',
          },
        },
        500
      )
    }

    try {
      // Get the authentication service from container
      const authService = container.getAuthenticationService()
      logger.debug(`trainId: ${trainId}, requestId: ${requestId}`)
      const clientApiKeys = await authService.getClientApiKeys(trainId)

      if (!clientApiKeys.length) {
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
              message: `No client API keys configured for train "${trainId}". Add client API keys to the database or disable client authentication.`,
            },
          },
          401,
          {
            'WWW-Authenticate': 'Bearer realm="Agent Prompt Train"',
          }
        )
      }

      // Use timing-safe comparison with SHA-256 hashing to prevent timing attacks
      // The clientApiKeys from database are already SHA-256 hashed (hex-encoded)
      // So we hash the provided token and compare with the stored hashes
      const encoder = new TextEncoder()
      const tokenBuffer = encoder.encode(token)

      // Hash the provided token
      const tokenHash = await crypto.subtle.digest('SHA-256', tokenBuffer)
      const tokenHashHex = Buffer.from(tokenHash).toString('hex')

      let isValid = false
      for (const storedHash of clientApiKeys) {
        // If stored key looks like a hash (64 hex chars), compare directly
        // Otherwise treat it as plaintext and hash it (filesystem mode compatibility)
        const isHexHash = /^[0-9a-f]{64}$/i.test(storedHash)

        if (isHexHash) {
          // Database mode: compare hash with hash
          if (
            tokenHashHex.length === storedHash.length &&
            cryptoTimingSafeEqual(Buffer.from(tokenHashHex), Buffer.from(storedHash))
          ) {
            isValid = true
            break
          }
        } else {
          // Filesystem mode: hash the plaintext key and compare
          const keyBuffer = encoder.encode(storedHash)
          const keyHash = await crypto.subtle.digest('SHA-256', keyBuffer)
          const keyHashBuffer = Buffer.from(keyHash)
          const tokenHashBuffer = Buffer.from(tokenHash)

          if (
            keyHashBuffer.length === tokenHashBuffer.length &&
            cryptoTimingSafeEqual(tokenHashBuffer, keyHashBuffer)
          ) {
            isValid = true
            break
          }
        }
      }

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
