import { Context } from 'hono'
import { ProxyService } from '../services/ProxyService'
import { RequestContext } from '../domain/value-objects/RequestContext'
import { ValidationError, serializeError } from '@claude-nexus/shared'
import { getRequestLogger } from '../middleware/logger'

/**
 * Controller for handling /v1/messages/count_tokens endpoint
 * Simply forwards token counting requests to Claude API without validation
 */
export class TokenCountController {
  constructor(private proxyService: ProxyService) {}

  /**
   * Handle POST /v1/messages/count_tokens
   */
  async handle(c: Context): Promise<Response> {
    const logger = getRequestLogger(c)
    const requestContext = RequestContext.fromHono(c)

    try {
      // Get the request body - no validation, let Anthropic handle it
      const body = await c.req.json()

      logger.debug('Processing token count request', {
        model: body?.model,
        messageCount: body?.messages?.length,
        hasSystemField: !!body?.system,
      })

      // Forward the request to Claude API for token counting
      const response = await this.proxyService.handleTokenCountRequest(body, requestContext)

      return response
    } catch (error) {
      logger.error('Token count request failed', error instanceof Error ? error : undefined)

      // Serialize error for response
      const errorObj = error instanceof Error ? error : new Error(String(error))
      const errorResponse = serializeError(errorObj)

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
   * Handle OPTIONS /v1/messages/count_tokens (CORS preflight)
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
