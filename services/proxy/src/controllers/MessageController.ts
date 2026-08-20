import { Context } from 'hono'
import { ProxyService } from '../services/ProxyService'
import { RequestContext } from '../domain/value-objects/RequestContext'
import {
  validateClaudeRequest,
  ValidationError,
  serializeError,
  UpstreamError,
} from '@agent-prompttrain/shared'
import { getRequestLogger } from '../middleware/logger'
import { AccountPoolExhaustedError } from '../services/account-pool-service'

/**
 * Controller for handling /v1/messages endpoint
 * Separates HTTP concerns from business logic
 */
export class MessageController {
  constructor(private proxyService: ProxyService) {}

  /**
   * Handle POST /v1/messages
   */
  async handle(c: Context): Promise<Response> {
    const logger = getRequestLogger(c)
    const requestContext = RequestContext.fromHono(c)

    try {
      // Get validated body (from validation middleware)
      const body = c.get('validatedBody') || (await c.req.json())

      // Additional validation if not done by middleware
      if (!validateClaudeRequest(body)) {
        throw new ValidationError('Invalid Claude API request format')
      }

      logger.debug('Processing message request', {
        model: body.model,
        messageCount: body.messages.length,
        streaming: body.stream || false,
        hasSystemField: !!body.system,
        systemFieldType: Array.isArray(body.system) ? 'array' : typeof body.system,
        systemFieldLength: Array.isArray(body.system) ? body.system.length : body.system ? 1 : 0,
        messageRoles: body.messages.map(m => m.role),
      })

      // Delegate to service
      const response = await this.proxyService.handleRequest(body, requestContext)

      // Set request context for middleware
      c.set('inputTokens', c.get('inputTokens') || 0)
      c.set('outputTokens', c.get('outputTokens') || 0)

      return response
    } catch (error) {
      logger.error('Request failed', error instanceof Error ? error : undefined, {
        model: c.get('validatedBody')?.model,
        streaming: c.get('validatedBody')?.stream,
      })

      // Handle account pool exhaustion with Claude API error format
      if (error instanceof AccountPoolExhaustedError) {
        if (error.retryAfterSeconds !== null) {
          c.header('Retry-After', String(error.retryAfterSeconds))
        }
        return c.json(
          {
            type: 'error',
            error: {
              type: 'rate_limit_error',
              message: error.message,
              estimated_reset: error.estimatedReset,
            },
          },
          429
        )
      }

      // Serialize error for response
      const errorObj = error instanceof Error ? error : new Error(String(error))
      const errorResponse = serializeError(errorObj)

      if (error instanceof UpstreamError && error.upstreamHeaders) {
        for (const [name, value] of Object.entries(error.upstreamHeaders)) {
          const normalized = name.toLowerCase()
          if (
            normalized === 'retry-after' ||
            normalized === 'request-id' ||
            normalized === 'x-request-id' ||
            normalized.startsWith('anthropic-ratelimit-')
          ) {
            c.header(name, value)
          }
        }
      }

      // Determine status code
      let statusCode = 500
      if (error instanceof ValidationError) {
        statusCode = 400
      } else if ((error as any).statusCode) {
        statusCode = (error as any).statusCode
      } else if ((error as any).upstreamStatus) {
        statusCode = (error as any).upstreamStatus
      }

      return c.json(errorResponse, statusCode as any)
    }
  }

  /**
   * Handle OPTIONS /v1/messages (CORS preflight)
   */
  async handleOptions(_c: Context): Promise<Response> {
    return new Response('', {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
        'Access-Control-Max-Age': '86400',
      },
    })
  }
}
