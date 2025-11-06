import { Context, Next } from 'hono'
import { logger } from './logger.js'
import { container } from '../container.js'
import { verifyApiKeyAndGetTrain } from '@agent-prompttrain/shared/database/queries'

/**
 * Client API Authentication Middleware
 * Validates train-scoped API keys for proxy access
 * Identifies the project from the API key (no MSL-Project-Id header required)
 */
export function clientAuthMiddleware() {
  return async (c: Context, next: Next) => {
    const authorization = c.req.header('Authorization')
    const requestId = c.get('requestId')

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

    try {
      // Get database pool from container
      const pool = container.getDbPool()
      if (!pool) {
        logger.error('Client auth middleware: Database pool not available', {
          requestId,
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

      // Verify the API key and get the associated train ID
      const verification = await verifyApiKeyAndGetTrain(pool, token)

      logger.debug('Client auth middleware: API key verification result', {
        requestId,
        projectId: verification?.projectId || 'none',
        metadata: {
          hasVerification: !!verification,
          tokenPreview: token.substring(0, 13) + '...' + token.substring(token.length - 4),
        },
      })

      if (!verification) {
        logger.warn('Client auth middleware: Invalid API key', {
          requestId,
          path: c.req.path,
          ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
          metadata: {
            tokenPreview: token.substring(0, 13) + '...' + token.substring(token.length - 4),
          },
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

      // Set the project ID in context based on the API key
      c.set('projectId', verification.projectId)

      logger.debug('Client auth middleware: Authentication successful, projectId set', {
        requestId,
        projectId: verification.projectId,
        metadata: {
          contextProjectId: c.get('projectId'),
        },
      })

      // Authentication successful, proceed to next middleware
      await next()
    } catch (error) {
      logger.error('Client auth middleware: Error verifying token', {
        requestId,
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
