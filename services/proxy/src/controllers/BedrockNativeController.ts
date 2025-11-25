import { Context } from 'hono'
import { RequestContext } from '../domain/value-objects/RequestContext.js'
import { AuthenticationService } from '../services/AuthenticationService.js'
import { BedrockApiClient } from '../services/BedrockApiClient.js'
import { extractBedrockRegion } from '@agent-prompttrain/shared/config/model-mapping'
import { getRequestLogger } from '../middleware/logger.js'

/**
 * Controller for handling native Bedrock Runtime API endpoints.
 * These endpoints use the Bedrock-native URL format:
 * - POST /model/{modelId}/invoke
 * - POST /model/{modelId}/invoke-with-response-stream
 *
 * Unlike /v1/messages which transforms requests to Bedrock format,
 * these endpoints expect the request body to already be in Bedrock format
 * and forward it with minimal processing.
 */
export class BedrockNativeController {
  constructor(
    private authService: AuthenticationService,
    private bedrockClient: BedrockApiClient
  ) {}

  /**
   * Handle non-streaming Bedrock invoke request
   * POST /model/:modelId/invoke
   */
  async handleInvoke(c: Context): Promise<Response> {
    return this.handleRequest(c, false)
  }

  /**
   * Handle streaming Bedrock invoke request
   * POST /model/:modelId/invoke-with-response-stream
   */
  async handleInvokeStream(c: Context): Promise<Response> {
    return this.handleRequest(c, true)
  }

  /**
   * Common handler for both streaming and non-streaming requests
   */
  private async handleRequest(c: Context, isStream: boolean): Promise<Response> {
    const logger = getRequestLogger(c)
    const requestContext = RequestContext.fromHono(c)
    const modelId = c.req.param('modelId')

    if (!modelId) {
      return c.json(
        {
          error: {
            type: 'invalid_request_error',
            message: 'Model ID is required in the URL path',
            request_id: requestContext.requestId,
          },
        },
        400
      )
    }

    // Decode and validate the model ID
    let decodedModelId: string
    try {
      decodedModelId = decodeURIComponent(modelId)
    } catch {
      return c.json(
        {
          error: {
            type: 'invalid_request_error',
            message: 'Invalid modelId encoding',
            request_id: requestContext.requestId,
          },
        },
        400
      )
    }

    // Validate model ID format and length to prevent malformed inputs
    // Bedrock model IDs follow pattern: {region}.anthropic.{model_name}
    const MODEL_ID_MAX_LENGTH = 256
    const MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]+$/

    if (decodedModelId.length > MODEL_ID_MAX_LENGTH || !MODEL_ID_PATTERN.test(decodedModelId)) {
      return c.json(
        {
          error: {
            type: 'invalid_request_error',
            message: 'Invalid modelId format',
            request_id: requestContext.requestId,
          },
        },
        400
      )
    }

    try {
      // Authenticate to get Bedrock credentials
      const authResult = await this.authService.authenticate(requestContext)

      // Verify this is a Bedrock account
      if (authResult.provider !== 'bedrock') {
        logger.warn('Non-Bedrock account used for native Bedrock endpoint', {
          projectId: requestContext.projectId,
          provider: authResult.provider,
        })

        return c.json(
          {
            error: {
              type: 'invalid_request_error',
              message:
                'Native Bedrock endpoints require a Bedrock account. Use /v1/messages for Anthropic accounts.',
              request_id: requestContext.requestId,
            },
          },
          400
        )
      }

      // Extract region from model ID or use account default
      // Priority: model ID prefix > account region > default
      const region = extractBedrockRegion(decodedModelId, authResult.region || 'us-east-1')

      // Get the raw request body
      const body = await c.req.text()

      logger.info('Processing native Bedrock request', {
        requestId: requestContext.requestId,
        projectId: requestContext.projectId,
        metadata: {
          modelId: decodedModelId,
          region,
          isStream,
          accountName: authResult.accountName,
        },
      })

      // Forward to Bedrock using auth headers from authentication service
      // Bedrock API Gateway expects Authorization: Bearer <api_key>
      const response = await this.bedrockClient.forwardNative(
        decodedModelId,
        body,
        authResult.headers,
        isStream,
        requestContext.requestId,
        region
      )

      // For streaming responses, we need to handle the response differently
      if (isStream && response.ok && response.body) {
        logger.info('Streaming native Bedrock response', {
          requestId: requestContext.requestId,
          status: response.status,
        })

        // Return the streaming response with appropriate headers
        return new Response(response.body, {
          status: response.status,
          headers: {
            'content-type': response.headers.get('content-type') || 'application/json',
            'transfer-encoding': 'chunked',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        })
      }

      // For non-streaming or error responses, return as-is
      const responseBody = await response.text()
      return new Response(responseBody, {
        status: response.status,
        headers: {
          'content-type': response.headers.get('content-type') || 'application/json',
        },
      })
    } catch (error) {
      logger.error('Native Bedrock request failed', error instanceof Error ? error : undefined, {
        modelId: decodedModelId,
        projectId: requestContext.projectId,
      })

      const statusCode = (error as { statusCode?: number }).statusCode || 500
      const message = error instanceof Error ? error.message : 'Failed to process Bedrock request'

      return c.json(
        {
          error: {
            type: 'proxy_error',
            message,
            request_id: requestContext.requestId,
          },
        },
        statusCode as 500
      )
    }
  }
}
