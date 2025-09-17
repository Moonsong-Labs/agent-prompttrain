import { ProxyRequest } from '../domain/entities/ProxyRequest'
import { ProxyResponse } from '../domain/entities/ProxyResponse'
import { RequestContext } from '../domain/value-objects/RequestContext'
import { AuthenticationService, AuthResult } from './AuthenticationService'
import { ClaudeApiClient } from './ClaudeApiClient'
import { NotificationService } from './NotificationService'
import { MetricsService } from './MetricsService'
import { ClaudeMessagesRequest, generateConversationId, config } from '@agent-prompttrain/shared'
import { logger } from '../middleware/logger'
import { testSampleCollector } from './TestSampleCollector'
import { StorageAdapter } from '../storage/StorageAdapter.js'

/**
 * Main proxy service that orchestrates the request flow
 * This is the core business logic separated from HTTP concerns
 */
export class ProxyService {
  constructor(
    private authService: AuthenticationService,
    private apiClient: ClaudeApiClient,
    private notificationService: NotificationService,
    private metricsService: MetricsService,
    private storageAdapter?: StorageAdapter
  ) {}

  /**
   * Handle a proxy request
   */
  async handleRequest(
    rawRequest: ClaudeMessagesRequest,
    context: RequestContext
  ): Promise<Response> {
    const log = {
      debug: (message: string, metadata?: Record<string, any>) => {
        logger.debug(message, {
          requestId: context.requestId,
          trainId: context.trainId,
          metadata,
        })
      },
      info: (message: string, metadata?: Record<string, any>) => {
        logger.info(message, {
          requestId: context.requestId,
          trainId: context.trainId,
          metadata,
        })
      },
      warn: (message: string, metadata?: Record<string, any>) => {
        logger.warn(message, {
          requestId: context.requestId,
          trainId: context.trainId,
          metadata,
        })
      },
      error: (message: string, error?: Error, metadata?: Record<string, any>) => {
        logger.error(message, {
          requestId: context.requestId,
          trainId: context.trainId,
          error: error
            ? {
                message: error.message,
                stack: error.stack,
                code: (error as any).code,
              }
            : undefined,
          metadata,
        })
      },
    }

    // Create domain entities
    const request = new ProxyRequest(rawRequest, context.trainId, context.requestId, context.apiKey)

    const response = new ProxyResponse(context.requestId, request.isStreaming)

    // Collect test sample if enabled
    let sampleId: string | undefined
    if (context.honoContext) {
      sampleId = await testSampleCollector.collectSample(
        context.honoContext,
        rawRequest,
        request.requestType
      )
    }

    // Extract conversation data if storage is enabled
    let conversationData:
      | {
          currentMessageHash: string
          parentMessageHash: string | null
          conversationId: string
          systemHash: string | null
          branchId?: string
          parentRequestId?: string
          parentTaskRequestId?: string
          isSubtask?: boolean
        }
      | undefined

    if (this.storageAdapter && rawRequest.messages && rawRequest.messages.length > 0) {
      try {
        // Use the new ConversationLinker through StorageAdapter
        const linkingResult = await this.storageAdapter.linkConversation(
          context.trainId,
          rawRequest.messages,
          rawRequest.system,
          context.requestId,
          new Date(context.startTime) // Pass the request timestamp
        )

        // If no conversation ID was found, generate a new one
        const conversationId = linkingResult.conversationId || generateConversationId()

        conversationData = {
          currentMessageHash: linkingResult.currentMessageHash,
          parentMessageHash: linkingResult.parentMessageHash,
          conversationId,
          systemHash: linkingResult.systemHash,
          branchId: linkingResult.branchId,
          parentRequestId: linkingResult.parentRequestId || undefined,
          parentTaskRequestId: linkingResult.parentTaskRequestId || undefined,
          isSubtask: linkingResult.isSubtask || undefined,
        }

        log.debug('Conversation tracking', {
          currentMessageHash: linkingResult.currentMessageHash,
          parentMessageHash: linkingResult.parentMessageHash,
          conversationId,
          branchId: linkingResult.branchId,
          isNewConversation: !linkingResult.conversationId,
          parentRequestId: linkingResult.parentRequestId,
          parentTaskRequestId: linkingResult.parentTaskRequestId,
          isSubtask: linkingResult.isSubtask,
        })
      } catch (error) {
        log.warn('Failed to extract conversation data', error as Error)
      }
    }

    try {
      // Authenticate
      let auth: AuthResult

      // Passthrough mode when client auth disabled and Bearer token present
      if (config.features.enableClientAuth === false && context.apiKey?.startsWith('Bearer ')) {
        log.debug('Using passthrough authentication (client auth disabled)', {
          trainId: context.trainId,
          hasToken: true,
        })

        auth = {
          type: 'oauth',
          headers: {
            Authorization: context.apiKey,
            'anthropic-beta': 'oauth-2025-04-20',
          },
          key: context.apiKey.replace('Bearer ', ''),
          betaHeader: 'oauth-2025-04-20',
        }
      } else {
        // Existing domain-based routing
        auth = context.trainId.toLowerCase().includes('personal')
          ? await this.authService.authenticatePersonalDomain(context)
          : await this.authService.authenticateNonPersonalDomain(context)
      }

      // Forward to Claude
      log.info('Forwarding request to Claude', {
        model: request.model,
        streaming: request.isStreaming,
        requestType: request.requestType,
        authSource: context.apiKey ? 'passthrough from request' : 'train credential file',
      })

      const claudeResponse = await this.apiClient.forward(request, auth)

      // Process response based on streaming mode
      let finalResponse: Response

      if (request.isStreaming) {
        finalResponse = await this.handleStreamingResponse(
          claudeResponse,
          request,
          response,
          context,
          auth,
          conversationData,
          sampleId
        )
      } else {
        finalResponse = await this.handleNonStreamingResponse(
          claudeResponse,
          request,
          response,
          context,
          auth,
          conversationData,
          sampleId
        )
      }

      return finalResponse
    } catch (error) {
      // Track error metrics
      await this.metricsService.trackError(
        request,
        error instanceof Error ? error : new Error(String(error)),
        context,
        (error as any).statusCode || 500
      )

      // Notify about error
      await this.notificationService.notifyError(
        error instanceof Error ? error : new Error(String(error)),
        context
      )

      throw error
    }
  }

  /**
   * Handle non-streaming response
   */
  private async handleNonStreamingResponse(
    claudeResponse: Response,
    request: ProxyRequest,
    response: ProxyResponse,
    context: RequestContext,
    auth: any,
    conversationData?: {
      currentMessageHash: string
      parentMessageHash: string | null
      conversationId: string
      systemHash: string | null
      branchId?: string
      parentRequestId?: string
      parentTaskRequestId?: string
      isSubtask?: boolean
    },
    sampleId?: string
  ): Promise<Response> {
    const log = {
      debug: (message: string, metadata?: Record<string, any>) => {
        logger.debug(message, {
          requestId: context.requestId,
          trainId: context.trainId,
          metadata,
        })
      },
      info: (message: string, metadata?: Record<string, any>) => {
        logger.info(message, {
          requestId: context.requestId,
          trainId: context.trainId,
          metadata,
        })
      },
      warn: (message: string, metadata?: Record<string, any>) => {
        logger.warn(message, {
          requestId: context.requestId,
          trainId: context.trainId,
          metadata,
        })
      },
      error: (message: string, error?: Error, metadata?: Record<string, any>) => {
        logger.error(message, {
          requestId: context.requestId,
          trainId: context.trainId,
          error: error
            ? {
                message: error.message,
                stack: error.stack,
                code: (error as any).code,
              }
            : undefined,
          metadata,
        })
      },
    }

    // Process the response
    const jsonResponse = await this.apiClient.processResponse(claudeResponse, response)

    log.debug('Non-streaming response processed', {
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      toolCalls: response.toolCallCount,
    })

    // Extract response headers
    const responseHeaders: Record<string, string> = {}
    claudeResponse.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })

    // Track metrics with full response data
    await this.metricsService.trackRequest(
      request,
      response,
      context,
      claudeResponse.status,
      conversationData,
      responseHeaders,
      jsonResponse,
      auth.accountId
    )

    // Update test sample with response if enabled
    if (sampleId) {
      await testSampleCollector.updateSampleWithResponse(sampleId, claudeResponse, jsonResponse, {
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        toolCalls: response.toolCallCount,
      })
    }

    // Return the response
    return new Response(JSON.stringify(jsonResponse), {
      status: claudeResponse.status,
      headers: {
        'Content-Type': 'application/json',
        ...this.getCorsHeaders(),
      },
    })
  }

  /**
   * Handle streaming response
   */
  private async handleStreamingResponse(
    claudeResponse: Response,
    request: ProxyRequest,
    response: ProxyResponse,
    context: RequestContext,
    auth: any,
    conversationData?: {
      currentMessageHash: string
      parentMessageHash: string | null
      conversationId: string
      systemHash: string | null
      branchId?: string
      parentRequestId?: string
      parentTaskRequestId?: string
      isSubtask?: boolean
    },
    sampleId?: string
  ): Promise<Response> {
    const log = {
      debug: (message: string, metadata?: Record<string, any>) => {
        logger.debug(message, { requestId: context.requestId, trainId: context.trainId, metadata })
      },
      info: (message: string, metadata?: Record<string, any>) => {
        logger.info(message, { requestId: context.requestId, trainId: context.trainId, metadata })
      },
      warn: (message: string, metadata?: Record<string, any>) => {
        logger.warn(message, { requestId: context.requestId, trainId: context.trainId, metadata })
      },
      error: (message: string, error?: Error, metadata?: Record<string, any>) => {
        logger.error(message, {
          requestId: context.requestId,
          trainId: context.trainId,
          error: error
            ? {
                message: error.message,
                stack: error.stack,
                code: (error as any).code,
              }
            : undefined,
          metadata,
        })
      },
    }

    // Create a transform stream to process events
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()

    // Process stream in background
    this.processStream(
      claudeResponse,
      response,
      writer,
      context,
      request,
      auth,
      conversationData,
      sampleId
    ).catch(async error => {
      log.error(
        'Stream processing error',
        error instanceof Error ? error : new Error(String(error))
      )

      // Try to send error to client in SSE format
      try {
        const encoder = new TextEncoder()
        const errorEvent = {
          type: 'error',
          error: {
            type: 'stream_error',
            message: error instanceof Error ? error.message : String(error),
          },
        }
        await writer.write(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`))
      } catch (writeError) {
        log.error(
          'Failed to write error to stream',
          writeError instanceof Error ? writeError : undefined
        )
      }
    })

    // Return streaming response immediately
    return new Response(readable, {
      status: claudeResponse.status,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...this.getCorsHeaders(),
      },
    })
  }

  /**
   * Process streaming response
   */
  private async processStream(
    claudeResponse: Response,
    response: ProxyResponse,
    writer: WritableStreamDefaultWriter,
    context: RequestContext,
    request: ProxyRequest,
    auth: any,
    conversationData?: {
      currentMessageHash: string
      parentMessageHash: string | null
      conversationId: string
      systemHash: string | null
      branchId?: string
      parentRequestId?: string
      parentTaskRequestId?: string
      isSubtask?: boolean
    },
    sampleId?: string
  ): Promise<void> {
    const log = {
      debug: (message: string, metadata?: Record<string, any>) => {
        logger.debug(message, { requestId: context.requestId, trainId: context.trainId, metadata })
      },
      info: (message: string, metadata?: Record<string, any>) => {
        logger.info(message, { requestId: context.requestId, trainId: context.trainId, metadata })
      },
      warn: (message: string, metadata?: Record<string, any>) => {
        logger.warn(message, { requestId: context.requestId, trainId: context.trainId, metadata })
      },
      error: (message: string, error?: Error, metadata?: Record<string, any>) => {
        logger.error(message, {
          requestId: context.requestId,
          trainId: context.trainId,
          error: error
            ? {
                message: error.message,
                stack: error.stack,
                code: (error as any).code,
              }
            : undefined,
          metadata,
        })
      },
    }

    try {
      const encoder = new TextEncoder()
      const streamingChunks: any[] = []

      // Process each chunk
      for await (const chunk of this.apiClient.processStreamingResponse(claudeResponse, response)) {
        await writer.write(encoder.encode(chunk))

        // Always collect chunks for response reconstruction
        try {
          // Parse SSE data
          const lines = chunk.split('\n')
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.substring(6)
              if (data !== '[DONE]' && data.trim()) {
                streamingChunks.push(JSON.parse(data))
              }
            }
          }
        } catch (_parseError) {
          // Ignore parsing errors
        }
      }

      // Stream completed - now track metrics and send notifications
      log.debug('Stream completed', {
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        toolCalls: response.toolCallCount,
      })

      // Reconstruct the full response from chunks
      const fullResponse = this.reconstructResponseFromChunks(streamingChunks)

      // Update test sample with streaming response if enabled
      if (sampleId) {
        await testSampleCollector.updateSampleWithResponse(sampleId, claudeResponse, fullResponse, {
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          toolCalls: response.toolCallCount,
          streamingChunks: streamingChunks,
        })
      }

      // Extract response headers
      const responseHeaders: Record<string, string> = {}
      claudeResponse.headers.forEach((value, key) => {
        responseHeaders[key] = value
      })

      // Track metrics after streaming completes with full response data
      await this.metricsService.trackRequest(
        request,
        response,
        context,
        claudeResponse.status,
        conversationData,
        responseHeaders,
        fullResponse,
        auth.accountId
      )

      // Send notifications after streaming completes
      await this.notificationService.notify(request, response, context, auth)
    } catch (error) {
      // Track error metrics
      await this.metricsService.trackError(
        request,
        error instanceof Error ? error : new Error(String(error)),
        context,
        (error as any).statusCode || 500
      )

      // Notify about error
      await this.notificationService.notifyError(
        error instanceof Error ? error : new Error(String(error)),
        context
      )

      throw error
    } finally {
      await writer.close()
    }
  }

  /**
   * Get CORS headers
   */
  private getCorsHeaders(): Record<string, string> {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    }
  }

  /**
   * Reconstruct a full response object from streaming chunks
   */
  private reconstructResponseFromChunks(chunks: any[]): any {
    const response: any = {
      id: '',
      type: 'message',
      role: 'assistant',
      content: [],
      model: '',
      stop_reason: null,
      stop_sequence: null,
      usage: {},
    }

    let currentTextContent = ''
    let currentToolUse: any = null

    for (const chunk of chunks) {
      if (chunk.type === 'message_start' && chunk.message) {
        response.id = chunk.message.id
        response.model = chunk.message.model
        response.role = chunk.message.role
        response.usage = chunk.message.usage || {}
      }

      if (chunk.type === 'content_block_start') {
        if (chunk.content_block.type === 'text') {
          // Start collecting text
          currentTextContent = chunk.content_block.text || ''
        } else if (chunk.content_block.type === 'tool_use') {
          currentToolUse = {
            type: 'tool_use',
            id: chunk.content_block.id,
            name: chunk.content_block.name,
            input: {},
          }
        }
      }

      if (chunk.type === 'content_block_delta') {
        if (chunk.delta.type === 'text_delta') {
          currentTextContent += chunk.delta.text
        } else if (chunk.delta.type === 'input_json_delta' && currentToolUse) {
          // Accumulate tool input (simplified - real implementation would need proper JSON parsing)
          if (!currentToolUse.input._raw) {
            currentToolUse.input._raw = ''
          }
          currentToolUse.input._raw += chunk.delta.partial_json
        }
      }

      if (chunk.type === 'content_block_stop') {
        if (currentTextContent) {
          response.content.push({
            type: 'text',
            text: currentTextContent,
          })
          currentTextContent = ''
        } else if (currentToolUse) {
          // Try to parse the accumulated JSON
          try {
            if (currentToolUse.input._raw) {
              currentToolUse.input = JSON.parse(currentToolUse.input._raw)
            }
          } catch {
            // Keep the raw input if parsing fails
          }
          response.content.push(currentToolUse)
          currentToolUse = null
        }
      }

      if (chunk.type === 'message_delta') {
        if (chunk.delta.stop_reason) {
          response.stop_reason = chunk.delta.stop_reason
        }
        if (chunk.delta.stop_sequence) {
          response.stop_sequence = chunk.delta.stop_sequence
        }
        if (chunk.usage) {
          response.usage = { ...response.usage, ...chunk.usage }
        }
      }

      if (chunk.type === 'message_stop') {
        // Final usage update
        if (chunk.amazon_bedrock_invocationMetrics) {
          response.amazon_bedrock_invocationMetrics = chunk.amazon_bedrock_invocationMetrics
        }
      }
    }

    return response
  }
}
