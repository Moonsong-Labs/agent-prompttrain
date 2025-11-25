import { Context } from 'hono'
import { RequestContext } from '../domain/value-objects/RequestContext.js'
import { BedrockEmulationService } from '../services/BedrockEmulationService.js'
import { ClaudeApiClient } from '../services/ClaudeApiClient.js'
import { AuthenticationService } from '../services/AuthenticationService.js'
import { getRequestLogger } from '../middleware/logger.js'

/**
 * Controller for handling generic proxy requests to arbitrary /v1/* endpoints.
 * Routes based on provider:
 * - Claude accounts: Proxies directly to Anthropic API
 * - Bedrock accounts: Emulates unsupported endpoints or returns 501
 */
export class GenericProxyController {
  constructor(
    private authService: AuthenticationService,
    private claudeClient: ClaudeApiClient,
    private bedrockEmulationService: BedrockEmulationService
  ) {}

  async handle(c: Context): Promise<Response> {
    const logger = getRequestLogger(c)
    const requestContext = RequestContext.fromHono(c)
    const path = c.req.path

    try {
      // Authenticate to determine provider
      const authResult = await this.authService.authenticate(requestContext)

      logger.info('Handling generic proxy request', {
        path,
        provider: authResult.provider,
        method: c.req.method,
      })

      if (authResult.provider === 'bedrock') {
        // Bedrock: Route to emulation or return 501
        if (path === '/v1/messages/count_tokens') {
          return this.bedrockEmulationService.handleCountTokens(c)
        }

        // For any other endpoint, Bedrock doesn't support it
        logger.warn('Unsupported Bedrock endpoint requested', { path })

        return c.json(
          {
            error: {
              type: 'not_supported_error',
              message: `The endpoint '${path}' is not supported for Bedrock accounts. Bedrock only supports '/v1/messages' for model invocation.`,
            },
          },
          501
        )
      } else {
        // Claude/Anthropic: Proxy to actual API
        const response = await this.claudeClient.genericForward(c, authResult)

        logger.info('Generic proxy request forwarded', {
          path,
          provider: authResult.provider,
          status: response.status,
        })

        return response
      }
    } catch (error) {
      logger.error('Generic proxy request failed', error instanceof Error ? error : undefined, {
        path,
      })

      const statusCode = (error as any).statusCode || 500
      return c.json(
        {
          error: {
            type: 'proxy_error',
            message: 'Failed to proxy request',
          },
        },
        statusCode as any
      )
    }
  }
}
