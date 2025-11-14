import { ProxyRequest } from '../domain/entities/ProxyRequest'
import { ProxyResponse } from '../domain/entities/ProxyResponse'
import {
  UpstreamError,
  TimeoutError,
  ClaudeMessagesResponse,
  ClaudeStreamEvent,
  isClaudeError,
  getErrorMessage,
} from '@agent-prompttrain/shared'
import { logger } from '../middleware/logger'
import { retryWithBackoff, retryConfigs } from '../utils/retry'
import { mapToBedrockModel } from '@agent-prompttrain/shared/config/model-mapping'

export interface BedrockApiConfig {
  region: string
  timeout: number
}

export interface BedrockAuthHeaders {
  'x-api-key': string
  [key: string]: string
}

/**
 * Client for communicating with AWS Bedrock API
 * Handles both streaming and non-streaming requests
 */
export class BedrockApiClient {
  constructor(private config: BedrockApiConfig) {}

  /**
   * Forward a request to Bedrock API
   */
  async forward(
    request: ProxyRequest,
    authHeaders: BedrockAuthHeaders,
    clientHeaders?: Record<string, string>
  ): Promise<Response> {
    // Map the model ID to Bedrock format
    const bedrockModelId = mapToBedrockModel(request.raw.model)

    // Construct Bedrock URL
    const streamSuffix = request.raw.stream ? '-with-response-stream' : ''
    const url = `https://bedrock-runtime.${this.config.region}.amazonaws.com/model/${bedrockModelId}/invoke${streamSuffix}`

    // Prepare Bedrock-specific headers
    // Blacklist headers that should not be forwarded to Bedrock
    const blacklistedHeaders = ['authorization', 'host', 'content-length', 'connection']

    // Start with client headers if provided, otherwise use minimal set
    const baseHeaders = clientHeaders || request.createHeaders({})

    // Filter out blacklisted headers
    const filteredHeaders: Record<string, string> = {}
    for (const [key, value] of Object.entries(baseHeaders)) {
      if (!blacklistedHeaders.includes(key.toLowerCase())) {
        filteredHeaders[key] = value
      }
    }

    // Add Bedrock authentication
    const headers = {
      ...filteredHeaders,
      ...authHeaders, // Contains x-api-key
    }

    // Use retry logic for transient failures
    return retryWithBackoff(
      async () => this.makeRequest(url, request, headers),
      retryConfigs.standard,
      { requestId: request.requestId, operation: 'bedrock_api_call' }
    )
  }

  /**
   * Make the actual HTTP request to Bedrock
   */
  private async makeRequest(
    url: string,
    request: ProxyRequest,
    headers: Record<string, string>
  ): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeout)

    try {
      // Add Bedrock-specific version to the request body
      // Remove 'stream' and 'model' fields as they are not permitted in Bedrock API
      // - 'model' is specified in the URL path
      // - 'stream' is determined by the endpoint suffix (/invoke vs /invoke-with-response-stream)
      const { stream: _stream, model: _model, ...bedrockRequestBody } = request.raw
      const bedrockBody = {
        ...bedrockRequestBody,
        anthropic_version: 'bedrock-2023-05-31',
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(bedrockBody),
        signal: controller.signal,
      })

      clearTimeout(timeout)

      // Check for errors
      if (!response.ok) {
        const errorBody = await response.text()
        let errorMessage = `Bedrock API error: ${response.status}`
        let parsedError: unknown

        try {
          parsedError = JSON.parse(errorBody)
          if (isClaudeError(parsedError)) {
            errorMessage = `${parsedError.error.type}: ${parsedError.error.message}`
          }
        } catch {
          // Use text error if not JSON
          errorMessage = errorBody || errorMessage
          parsedError = { error: { message: errorBody, type: 'api_error' } }
        }

        // Log detailed error info for debugging
        logger.error('Bedrock API error response', {
          requestId: request.requestId,
          metadata: {
            status: response.status,
            url: url,
            errorBody: errorBody.substring(0, 500), // First 500 chars
            headers: Object.fromEntries(response.headers.entries()),
          },
        })

        throw new UpstreamError(
          errorMessage,
          response.status,
          {
            requestId: request.requestId,
            status: response.status,
            body: errorBody,
          },
          parsedError
        )
      }

      return response
    } catch (error) {
      clearTimeout(timeout)

      if (error instanceof Error && error.name === 'AbortError') {
        throw new TimeoutError('Bedrock API request timeout', {
          requestId: request.requestId,
          timeout: this.config.timeout,
        })
      }

      throw error
    }
  }

  /**
   * Process a non-streaming response
   */
  async processResponse(
    response: Response,
    proxyResponse: ProxyResponse
  ): Promise<ClaudeMessagesResponse> {
    const json = (await response.json()) as ClaudeMessagesResponse

    logger.debug('Bedrock API raw response', {
      requestId: proxyResponse.requestId,
      metadata: {
        usage: json.usage,
        hasContent: !!json.content,
        contentLength: json.content?.length,
        model: json.model,
        stopReason: json.stop_reason,
      },
    })

    // Check for empty Bedrock responses (both usage and content are empty)
    const hasEmptyUsage =
      !json.usage ||
      Object.keys(json.usage).length === 0 ||
      (json.usage.input_tokens === 0 && json.usage.output_tokens === 0)
    const hasEmptyContent = !json.content || json.content.length === 0

    if (hasEmptyUsage && hasEmptyContent) {
      logger.warn('Bedrock returned empty response - discarding', {
        requestId: proxyResponse.requestId,
        metadata: {
          usage: json.usage,
          content: json.content,
          id: json.id,
          model: json.model,
          stop_reason: json.stop_reason,
        },
      })

      throw new UpstreamError(
        'Bedrock returned empty response with no usage or content',
        response.status,
        {
          requestId: proxyResponse.requestId,
          status: response.status,
          body: JSON.stringify(json),
        },
        { error: { type: 'empty_response', message: 'Empty response from Bedrock API' } }
      )
    }

    proxyResponse.processResponse(json)
    return json
  }

  /**
   * Process a streaming response
   */
  async *processStreamingResponse(
    response: Response,
    proxyResponse: ProxyResponse
  ): AsyncGenerator<string, void, unknown> {
    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('No response body reader available')
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let hasReceivedContent = false
    let hasReceivedUsage = false

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.trim() === '') {
            continue
          }

          if (line.startsWith('data: ')) {
            const data = line.slice(6)

            if (data === '[DONE]') {
              yield 'data: [DONE]\n\n'
              continue
            }

            try {
              const event = JSON.parse(data) as ClaudeStreamEvent

              // Track if we receive any content or usage
              if (event.type === 'content_block_delta' || event.type === 'content_block_start') {
                hasReceivedContent = true
              }
              if (event.type === 'message_start' && event.message?.usage) {
                const usage = event.message.usage
                if (usage.input_tokens > 0 || usage.output_tokens > 0) {
                  hasReceivedUsage = true
                }
              }
              if (event.type === 'message_delta' && event.usage) {
                if (event.usage.output_tokens && event.usage.output_tokens > 0) {
                  hasReceivedUsage = true
                }
              }

              proxyResponse.processStreamEvent(event)
              yield `data: ${data}\n\n`
            } catch (error) {
              logger.warn('Failed to parse streaming event', {
                requestId: proxyResponse.requestId,
                error: getErrorMessage(error),
                data,
              })
              // Still forward the data even if we can't parse it
              yield `data: ${data}\n\n`
            }
          } else {
            // Forward non-data lines as-is (like event: types)
            yield line + '\n'
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        yield buffer + '\n'
      }

      // Check if we received an empty streaming response
      if (!hasReceivedContent && !hasReceivedUsage) {
        logger.warn('Bedrock returned empty streaming response - discarding', {
          requestId: proxyResponse.requestId,
        })

        throw new UpstreamError(
          'Bedrock returned empty streaming response with no usage or content',
          response.status,
          {
            requestId: proxyResponse.requestId,
            status: response.status,
          },
          {
            error: { type: 'empty_response', message: 'Empty streaming response from Bedrock API' },
          }
        )
      }
    } finally {
      reader.releaseLock()
    }
  }
}
