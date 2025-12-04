import { Context } from 'hono'
import { RequestContext } from '../domain/value-objects/RequestContext.js'
import { AuthenticationService } from '../services/AuthenticationService.js'
import { BedrockApiClient } from '../services/BedrockApiClient.js'
import { MetricsService } from '../services/MetricsService.js'
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
    private bedrockClient: BedrockApiClient,
    private metricsService: MetricsService
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

      // For streaming responses, intercept to track metrics
      if (isStream && response.ok && response.body) {
        logger.info('Streaming native Bedrock response', {
          requestId: requestContext.requestId,
          status: response.status,
        })

        // Parse request body for metrics tracking
        let requestJson: Record<string, unknown> = {}
        try {
          requestJson = JSON.parse(body) as Record<string, unknown>
        } catch {
          // Ignore parse errors for request body
        }

        // Extract response headers for tracking
        const responseHeaders: Record<string, string> = {}
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value
        })

        // Create stream tracker to intercept usage data
        const streamTracker = this.createStreamTracker(
          requestContext,
          decodedModelId,
          requestJson,
          authResult.accountId,
          responseHeaders,
          logger
        )

        // Pipe response through tracker
        const trackedStream = response.body.pipeThrough(streamTracker)

        // Return the streaming response with appropriate headers
        return new Response(trackedStream, {
          status: response.status,
          headers: {
            'content-type': response.headers.get('content-type') || 'application/json',
            'transfer-encoding': 'chunked',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        })
      }

      // For non-streaming responses, parse and track metrics
      const responseText = await response.text()

      // Track metrics for successful non-streaming responses
      if (response.ok) {
        try {
          const responseJson = JSON.parse(responseText) as Record<string, unknown>
          const requestJson = JSON.parse(body) as Record<string, unknown>

          // Extract response headers
          const responseHeaders: Record<string, string> = {}
          response.headers.forEach((value, key) => {
            responseHeaders[key] = value
          })

          await this.metricsService.trackNativeBedrockRequest(
            requestContext,
            decodedModelId,
            requestJson,
            responseJson,
            response.status,
            authResult.accountId,
            responseHeaders
          )
        } catch (parseError) {
          logger.warn('Failed to parse response for metrics tracking', {
            requestId: requestContext.requestId,
            error: parseError instanceof Error ? parseError.message : String(parseError),
          })
        }
      }

      // Build response headers
      const clientResponseHeaders: Record<string, string> = {
        'content-type': response.headers.get('content-type') || 'application/json',
      }

      // For error responses (4xx/5xx), forward important Bedrock headers to the client
      // These headers are essential for clients to understand and handle errors properly
      if (!response.ok) {
        const bedrockErrorHeaders = [
          'x-amzn-errortype', // Error type (e.g., ServiceUnavailableException)
          'x-amzn-requestid', // AWS request ID for debugging
          'retry-after', // Retry guidance for rate limits and service unavailable
        ]
        for (const header of bedrockErrorHeaders) {
          const value = response.headers.get(header)
          if (value) {
            clientResponseHeaders[header] = value
          }
        }
      }

      return new Response(responseText, {
        status: response.status,
        headers: clientResponseHeaders,
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

  /**
   * Create a TransformStream that intercepts SSE events to extract usage data
   * while passing through all data unchanged to the client
   */
  private createStreamTracker(
    requestContext: RequestContext,
    modelId: string,
    requestBody: Record<string, unknown>,
    accountId: string,
    responseHeaders: Record<string, string>,
    log: ReturnType<typeof getRequestLogger>
  ): TransformStream<Uint8Array, Uint8Array> {
    const decoder = new TextDecoder()
    let buffer = ''

    // Accumulated usage data from stream events
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }
    const responseContent: Array<{ type: string; text?: string }> = []
    const metricsService = this.metricsService

    return new TransformStream({
      transform(chunk, controller) {
        // Pass through chunk unchanged
        controller.enqueue(chunk)

        // Parse chunk to extract usage data
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) {
            continue
          }
          const data = line.slice(6).trim()
          if (data === '[DONE]') {
            continue
          }

          try {
            const event = JSON.parse(data) as {
              type: string
              message?: {
                usage?: {
                  input_tokens?: number
                  output_tokens?: number
                  cache_creation_input_tokens?: number
                  cache_read_input_tokens?: number
                }
                content?: Array<{ type: string; text?: string }>
              }
              usage?: {
                output_tokens?: number
                cache_creation_input_tokens?: number
                cache_read_input_tokens?: number
              }
              content_block?: { type: string }
              delta?: { type: string; text?: string }
            }

            // Extract usage from message_start
            if (event.type === 'message_start' && event.message?.usage) {
              usage.input_tokens = event.message.usage.input_tokens || 0
              if (event.message.usage.cache_creation_input_tokens) {
                usage.cache_creation_input_tokens = event.message.usage.cache_creation_input_tokens
              }
              if (event.message.usage.cache_read_input_tokens) {
                usage.cache_read_input_tokens = event.message.usage.cache_read_input_tokens
              }
            }

            // Extract usage from message_delta
            if (event.type === 'message_delta' && event.usage) {
              usage.output_tokens = event.usage.output_tokens || usage.output_tokens
              if (event.usage.cache_creation_input_tokens !== undefined) {
                usage.cache_creation_input_tokens = event.usage.cache_creation_input_tokens
              }
              if (event.usage.cache_read_input_tokens !== undefined) {
                usage.cache_read_input_tokens = event.usage.cache_read_input_tokens
              }
            }

            // Accumulate text content
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
              const lastContent = responseContent[responseContent.length - 1]
              if (lastContent && lastContent.type === 'text') {
                lastContent.text = (lastContent.text || '') + (event.delta.text || '')
              }
            }

            if (event.type === 'content_block_start' && event.content_block) {
              responseContent.push({ type: event.content_block.type })
            }
          } catch {
            // Ignore parse errors for individual events
          }
        }
      },

      async flush() {
        // Stream complete - track metrics
        const responseBody: Record<string, unknown> = {
          usage,
          content: responseContent,
        }

        try {
          await metricsService.trackNativeBedrockRequest(
            requestContext,
            modelId,
            requestBody,
            responseBody,
            200,
            accountId,
            responseHeaders
          )
        } catch (error) {
          log.warn('Failed to track streaming metrics', {
            requestId: requestContext.requestId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    })
  }
}
