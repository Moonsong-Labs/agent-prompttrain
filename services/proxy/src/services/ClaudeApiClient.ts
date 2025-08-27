import { ProxyRequest } from '../domain/entities/ProxyRequest'
import { ProxyResponse } from '../domain/entities/ProxyResponse'
import { AuthResult } from './AuthenticationService'
import {
  UpstreamError,
  TimeoutError,
  ClaudeMessagesResponse,
  ClaudeStreamEvent,
  isClaudeError,
  getErrorMessage,
} from '@claude-nexus/shared'
import { logger } from '../middleware/logger'
import { retryWithBackoff, retryConfigs } from '../utils/retry'

export interface ClaudeApiConfig {
  baseUrl: string
  timeout: number
}

/**
 * Client for communicating with Claude API
 * Handles both streaming and non-streaming requests
 */
export class ClaudeApiClient {
  constructor(
    private config: ClaudeApiConfig = {
      baseUrl: 'https://api.anthropic.com',
      timeout: 600000, // 10 minutes
    }
  ) {}

  /**
   * Forward a request to Claude API
   */
  async forward(request: ProxyRequest, auth: AuthResult): Promise<Response> {
    const url = `${this.config.baseUrl}/v1/messages`
    const headers = request.createHeaders(auth.headers)

    // Use retry logic for transient failures
    return retryWithBackoff(
      async () => this.makeRequest(url, request, headers),
      retryConfigs.standard,
      { requestId: request.requestId, operation: 'claude_api_call' }
    )
  }

  /**
   * Forward a token count request to Claude API
   */
  async forwardTokenCount(rawRequest: any, auth: AuthResult, requestId: string): Promise<Response> {
    const url = `${this.config.baseUrl}/v1/messages/count_tokens`

    // Build headers for token count request
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...auth.headers,
    }

    // Make the request without retry logic as it's read-only
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000) // 30 second timeout for token counting

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(rawRequest),
        signal: controller.signal,
      })

      clearTimeout(timeout)

      // Check for errors
      if (!response.ok) {
        const errorBody = await response.text()
        let errorMessage = `Claude API token count error: ${response.status}`
        let parsedError: any

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

        logger.error('Token count request failed', {
          requestId,
          metadata: {
            status: response.status,
            error: errorMessage,
          },
        })

        // Return error response directly to client
        return new Response(JSON.stringify(parsedError), {
          status: response.status,
          headers: {
            'Content-Type': 'application/json',
          },
        })
      }

      // Return successful response directly
      const responseBody = await response.text()
      return new Response(responseBody, {
        status: response.status,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    } catch (error) {
      clearTimeout(timeout)

      if (error instanceof Error && error.name === 'AbortError') {
        logger.error('Token count request timeout', {
          requestId,
          metadata: {
            timeout: 30000,
          },
        })
        return new Response(
          JSON.stringify({
            error: {
              type: 'timeout_error',
              message: 'Token count request timed out',
            },
          }),
          {
            status: 504,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        )
      }

      logger.error('Token count request failed with exception', {
        requestId,
        error: getErrorMessage(error),
      })

      return new Response(
        JSON.stringify({
          error: {
            type: 'internal_error',
            message: 'Failed to process token count request',
          },
        }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    }
  }

  /**
   * Make the actual HTTP request
   */
  private async makeRequest(
    url: string,
    request: ProxyRequest,
    headers: Record<string, string>
  ): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeout)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request.raw),
        signal: controller.signal,
      })

      clearTimeout(timeout)

      // Check for errors
      if (!response.ok) {
        const errorBody = await response.text()
        let errorMessage = `Claude API error: ${response.status}`
        let parsedError: any

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
        throw new TimeoutError('Claude API request timeout', {
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

    logger.debug('Claude API raw response', {
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
