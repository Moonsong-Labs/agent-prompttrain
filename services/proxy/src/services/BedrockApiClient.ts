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
   * Marks empty responses with a custom header (common Bedrock issue)
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

    const response = await this.makeRequest(url, request, headers)

    // Check for empty responses (common Bedrock issue) and mark them
    if (!request.raw.stream && response.ok) {
      const responseClone = response.clone()
      try {
        const json = (await responseClone.json()) as ClaudeMessagesResponse
        const hasEmptyUsage =
          !json.usage ||
          Object.keys(json.usage).length === 0 ||
          (json.usage.input_tokens === 0 && json.usage.output_tokens === 0)
        const hasEmptyContent = !json.content || json.content.length === 0

        if (hasEmptyUsage && hasEmptyContent) {
          logger.warn('Bedrock returned empty response - passing through without storage', {
            requestId: request.requestId,
            metadata: {
              usage: json.usage,
              content: json.content,
              id: json.id,
              model: json.model,
            },
          })

          // Create a new response with marker header to skip storage
          const newHeaders = new Headers(response.headers)
          newHeaders.set('x-bedrock-empty-response', 'true')

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          })
        }
      } catch (error) {
        // JSON parse error or other issue, return original response
        logger.debug('Failed to check for empty response', {
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return response
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
    } finally {
      reader.releaseLock()
    }
  }
}
