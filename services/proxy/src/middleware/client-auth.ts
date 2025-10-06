import { Context, Next } from 'hono'
import { logger } from './logger.js'
import { container } from '../container.js'
import { verifyTrainApiKey } from '@agent-prompttrain/shared/database/queries'

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
      // Get database pool from container
      const pool = container.getDbPool()
      if (!pool) {
        logger.error('Client auth middleware: Database pool not available', {
          requestId,
          trainId,
        })
        return c.json(
          {
            error: {
              type: 'internal_error',
              message: 'Database not configured. Authentication unavailable.',
            },
          },
          500
        )
      }

      logger.debug(`trainId: ${trainId}, requestId: ${requestId}`)

      // Verify the API key against the database
      const verifiedKey = await verifyTrainApiKey(pool, trainId, token)

      if (!verifiedKey) {
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
