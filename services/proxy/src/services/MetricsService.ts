import { ProxyRequest, RequestType } from '../domain/entities/ProxyRequest'
import { ProxyResponse } from '../domain/entities/ProxyResponse'
import { RequestContext } from '../domain/value-objects/RequestContext'
import { tokenTracker } from './tokenTracker.js'
import { StorageAdapter } from '../storage/StorageAdapter.js'
import { TokenUsageService } from './TokenUsageService.js'
import { logger } from '../middleware/logger'
import { broadcastConversation, broadcastMetrics } from '../dashboard/sse.js'
import { generateConversationId, ClaudeMessage } from '@agent-prompttrain/shared'

/**
 * System prompt prefixes that indicate internal Claude Code helper requests
 * These requests should not be stored in the database as they're internal operations
 */
const INTERNAL_SYSTEM_PROMPT_PREFIXES = [
  'Extract any file paths that this command reads or modifies',
  'Summarize this coding conversation in under 50 characters',
  'Please write a 5-10 word title for the following conversation',
  'Your task is to process Bash commands that an AI coding agent wants to run',
  'You are a file search specialist for Claude Code, Anthropic',
  'Analyze if this message indicates a new conversation topic',
  'You are an interactive CLI tool that helps users with software engineering tasks',
  'You are a software architect and planning specialist for Claude Code',
]

export interface MetricsConfig {
  enableTokenTracking: boolean
  enableStorage: boolean
  enableTelemetry: boolean
}

export interface TelemetryData {
  requestId: string
  timestamp: number
  projectId: string
  apiKey?: string
  model: string
  inputTokens?: number
  outputTokens?: number
  duration?: number
  status: number
  error?: string
  toolCallCount?: number
  requestType?: string
}

// Request types that should not be stored in the database
const NON_STORABLE_REQUEST_TYPES = new Set<RequestType>([
  'query_evaluation',
  'quota',
  'internal_operation',
])

/**
 * Service responsible for metrics collection and tracking
 * Handles token tracking, storage, and telemetry
 */
export class MetricsService {
  constructor(
    private config: MetricsConfig = {
      enableTokenTracking: true,
      enableStorage: true,
      enableTelemetry: true,
    },
    private storageService?: StorageAdapter,
    private telemetryEndpoint?: string,
    private tokenUsageService?: TokenUsageService
  ) {}

  /**
   * Track metrics for a successful request
   */
  async trackRequest(
    request: ProxyRequest,
    response: ProxyResponse,
    context: RequestContext,
    status: number = 200,
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
    responseHeaders?: Record<string, string>,
    fullResponseBody?: any,
    accountId?: string
  ): Promise<void> {
    const metrics = response.getMetrics()

    // logger.debug('Tracking metrics for request', {
    //   requestId: context.requestId,
    //   projectId: context.projectId,
    //   metrics: metrics,
    //   requestType: request.requestType,
    //   isStreaming: request.isStreaming
    // })

    // Track tokens
    if (this.config.enableTokenTracking) {
      tokenTracker.track(
        context.projectId,
        metrics.inputTokens,
        metrics.outputTokens,
        request.requestType === 'quota' ? undefined : request.requestType,
        metrics.toolCallCount
      )

      // Also track in persistent storage if available
      if (this.tokenUsageService && accountId) {
        await this.tokenUsageService.recordUsage({
          accountId,
          projectId: context.projectId,
          model: request.model,
          requestType: request.requestType,
          inputTokens: metrics.inputTokens,
          outputTokens: metrics.outputTokens,
          totalTokens: metrics.inputTokens + metrics.outputTokens,
          cacheCreationInputTokens: metrics.cacheCreationInputTokens || 0,
          cacheReadInputTokens: metrics.cacheReadInputTokens || 0,
          requestCount: 1,
        })
      }
    }

    // Store in database
    if (this.config.enableStorage && this.storageService) {
      await this.storeRequest(
        request,
        response,
        context,
        status,
        conversationData,
        responseHeaders,
        fullResponseBody,
        accountId
      )
    }

    // Send telemetry
    if (this.config.enableTelemetry && this.telemetryEndpoint) {
      await this.sendTelemetry({
        requestId: context.requestId,
        timestamp: Date.now(),
        projectId: context.projectId,
        apiKey: this.maskApiKey(context.apiKey),
        model: request.model,
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        duration: context.getElapsedTime(),
        status,
        toolCallCount: metrics.toolCallCount,
        requestType: request.requestType,
      })
    }

    // Log metrics
    logger.info('Request processed', {
      requestId: context.requestId,
      projectId: context.projectId,
      model: request.model,
      metadata: {
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        duration: context.getElapsedTime(),
        requestType: request.requestType,
        stored: request.requestType === 'inference' && this.config.enableStorage,
      },
    })

    // Broadcast to dashboard
    try {
      // Broadcast conversation update
      broadcastConversation({
        id: context.requestId,
        projectId: context.projectId,
        model: request.model,
        tokens: metrics.inputTokens + metrics.outputTokens,
        timestamp: new Date().toISOString(),
      })

      // Broadcast metrics update
      const stats = tokenTracker.getStats()
      const trainStats = stats[context.projectId]
      if (trainStats) {
        broadcastMetrics({
          projectId: context.projectId,
          requests: trainStats.requestCount,
          tokens: trainStats.inputTokens + trainStats.outputTokens,
          activeUsers: Object.keys(stats).length,
        })
      }
    } catch (e) {
      // Don't fail request if broadcast fails
      logger.debug('Failed to broadcast metrics', {
        metadata: { error: e instanceof Error ? e.message : String(e) },
      })
    }
  }

  /**
   * Track metrics for a native Bedrock request (already in Bedrock format)
   * This is a simplified tracking method for requests that bypass ProxyRequest/ProxyResponse
   */
  async trackNativeBedrockRequest(
    context: RequestContext,
    model: string,
    requestBody: Record<string, unknown>,
    responseBody: Record<string, unknown>,
    status: number,
    accountId: string,
    responseHeaders?: Record<string, string>
  ): Promise<void> {
    // Extract usage from response
    const usage = responseBody.usage as
      | {
          input_tokens?: number
          output_tokens?: number
          cache_creation_input_tokens?: number
          cache_read_input_tokens?: number
        }
      | undefined

    const inputTokens = usage?.input_tokens || 0
    const outputTokens = usage?.output_tokens || 0
    const cacheCreationInputTokens = usage?.cache_creation_input_tokens || 0
    const cacheReadInputTokens = usage?.cache_read_input_tokens || 0
    const totalTokens = inputTokens + outputTokens

    // Count tool calls in response
    const content = responseBody.content as Array<{ type: string }> | undefined
    const toolCallCount = content?.filter(c => c.type === 'tool_use').length || 0

    // Track tokens
    if (this.config.enableTokenTracking) {
      tokenTracker.track(context.projectId, inputTokens, outputTokens, 'inference', toolCallCount)

      // Track in persistent storage
      if (this.tokenUsageService && accountId) {
        await this.tokenUsageService.recordUsage({
          accountId,
          projectId: context.projectId,
          model,
          requestType: 'inference',
          inputTokens,
          outputTokens,
          totalTokens,
          cacheCreationInputTokens,
          cacheReadInputTokens,
          requestCount: 1,
        })
      }
    }

    // Store in database
    if (this.config.enableStorage && this.storageService) {
      await this.storeNativeBedrockRequest(
        context,
        model,
        requestBody,
        responseBody,
        status,
        accountId,
        {
          inputTokens,
          outputTokens,
          totalTokens,
          cacheCreationInputTokens,
          cacheReadInputTokens,
          toolCallCount,
        },
        responseHeaders
      )
    }

    // Log metrics
    logger.info('Native Bedrock request processed', {
      requestId: context.requestId,
      projectId: context.projectId,
      model,
      metadata: {
        inputTokens,
        outputTokens,
        duration: context.getElapsedTime(),
        stored: this.config.enableStorage,
      },
    })

    // Broadcast to dashboard
    try {
      broadcastConversation({
        id: context.requestId,
        projectId: context.projectId,
        model,
        tokens: totalTokens,
        timestamp: new Date().toISOString(),
      })

      const stats = tokenTracker.getStats()
      const trainStats = stats[context.projectId]
      if (trainStats) {
        broadcastMetrics({
          projectId: context.projectId,
          requests: trainStats.requestCount,
          tokens: trainStats.inputTokens + trainStats.outputTokens,
          activeUsers: Object.keys(stats).length,
        })
      }
    } catch (e) {
      logger.debug('Failed to broadcast metrics', {
        metadata: { error: e instanceof Error ? e.message : String(e) },
      })
    }
  }

  /**
   * Track error metrics
   */
  async trackError(
    request: ProxyRequest,
    error: Error,
    context: RequestContext,
    status: number = 500
  ): Promise<void> {
    // Track in token stats (error counts)
    if (this.config.enableTokenTracking) {
      tokenTracker.track(
        context.projectId,
        0,
        0,
        request.requestType === 'quota' ? undefined : request.requestType,
        0
      )
    }

    // Send telemetry
    if (this.config.enableTelemetry && this.telemetryEndpoint) {
      await this.sendTelemetry({
        requestId: context.requestId,
        timestamp: Date.now(),
        projectId: context.projectId,
        apiKey: this.maskApiKey(context.apiKey),
        model: request.model,
        duration: context.getElapsedTime(),
        status,
        error: error.message,
        requestType: request.requestType,
      })
    }

    logger.error('Request error tracked', {
      requestId: context.requestId,
      projectId: context.projectId,
      metadata: {
        error: error.message,
        status,
      },
    })
  }

  /**
   * Get token statistics
   */
  getStats(projectId?: string) {
    const allStats = tokenTracker.getStats()
    if (projectId) {
      return allStats[projectId] || null
    }
    return allStats
  }

  /**
   * Store request in database
   */
  private async storeRequest(
    request: ProxyRequest,
    response: ProxyResponse,
    context: RequestContext,
    status: number,
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
    responseHeaders?: Record<string, string>,
    fullResponseBody?: any,
    accountId?: string
  ): Promise<void> {
    if (!this.storageService) {
      return
    }

    // Skip storing requests based on type
    if (NON_STORABLE_REQUEST_TYPES.has(request.requestType)) {
      logger.debug('Skipping storage for non-storable request type', {
        requestId: context.requestId,
        requestType: request.requestType,
        projectId: context.projectId,
      })
      return
    }

    // Skip storing internal Claude Code helper requests
    if (this.isInternalClaudeCodeRequest(request.raw)) {
      logger.debug('Skipping storage for internal Claude Code request', {
        requestId: context.requestId,
      })
      return
    }

    try {
      const metrics = response.getMetrics()

      // Calculate message count from request body
      let messageCount = 0
      if (request.raw.messages && Array.isArray(request.raw.messages)) {
        messageCount = request.raw.messages.length
      }

      await this.storageService.storeRequest({
        id: context.requestId,
        projectId: context.projectId,
        accountId: accountId,
        timestamp: new Date(context.startTime),
        method: context.method,
        path: context.path,
        headers: context.headers,
        body: request.raw,
        request_type: request.requestType,
        model: request.model,
        input_tokens: metrics.inputTokens,
        output_tokens: metrics.outputTokens,
        total_tokens: metrics.totalTokens,
        cache_creation_input_tokens: metrics.cacheCreationInputTokens,
        cache_read_input_tokens: metrics.cacheReadInputTokens,
        usage_data: metrics.fullUsageData,
        tool_call_count: metrics.toolCallCount,
        processing_time: context.getElapsedTime(),
        status_code: status,
        currentMessageHash: conversationData?.currentMessageHash,
        parentMessageHash: conversationData?.parentMessageHash,
        conversationId: conversationData?.conversationId,
        branchId: conversationData?.branchId,
        systemHash: conversationData?.systemHash,
        messageCount: messageCount,
        parentRequestId: conversationData?.parentRequestId,
        parentTaskRequestId: conversationData?.parentTaskRequestId,
        isSubtask: conversationData?.isSubtask,
      })

      // Store response
      await this.storageService.storeResponse({
        request_id: context.requestId,
        status_code: status,
        headers: responseHeaders || {}, // Store full response headers
        body: fullResponseBody || { content: response.content }, // Store full response body if available, fallback to content
        timestamp: new Date(),
        input_tokens: metrics.inputTokens,
        output_tokens: metrics.outputTokens,
        total_tokens: metrics.totalTokens,
        cache_creation_input_tokens: metrics.cacheCreationInputTokens,
        cache_read_input_tokens: metrics.cacheReadInputTokens,
        usage_data: metrics.fullUsageData,
        tool_call_count: metrics.toolCallCount,
        processing_time: context.getElapsedTime(),
      })

      // Process Task tool invocations if we have the full response body
      if (fullResponseBody) {
        await this.storageService.processTaskToolInvocations(
          context.requestId,
          fullResponseBody,
          context.projectId
        )
      }
    } catch (error) {
      logger.error('Failed to store request/response', {
        requestId: context.requestId,
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  /**
   * Store a native Bedrock request in database
   * Simplified storage for requests that bypass ProxyRequest/ProxyResponse
   */
  private async storeNativeBedrockRequest(
    context: RequestContext,
    model: string,
    requestBody: Record<string, unknown>,
    responseBody: Record<string, unknown>,
    status: number,
    accountId: string,
    metrics: {
      inputTokens: number
      outputTokens: number
      totalTokens: number
      cacheCreationInputTokens: number
      cacheReadInputTokens: number
      toolCallCount: number
    },
    responseHeaders?: Record<string, string>
  ): Promise<void> {
    if (!this.storageService) {
      return
    }

    // Check if this is an internal Claude Code helper request that should not be stored
    if (this.isInternalClaudeCodeRequest(requestBody)) {
      logger.debug('Skipping storage for internal Claude Code request', {
        requestId: context.requestId,
      })
      return
    }

    try {
      // Extract messages and system from request body (Bedrock uses same message format as Anthropic)
      const messages = requestBody.messages as ClaudeMessage[] | undefined
      const systemPrompt = requestBody.system as
        | string
        | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[]
        | undefined
      const messageCount = messages?.length || 0

      // Perform conversation linking if we have messages
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

      if (messages && messages.length > 0) {
        try {
          const linkingResult = await this.storageService.linkConversation(
            context.projectId,
            messages,
            systemPrompt,
            context.requestId,
            new Date(context.startTime)
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

          logger.debug('Native Bedrock conversation linking', {
            requestId: context.requestId,
            metadata: {
              conversationId,
              branchId: linkingResult.branchId,
              isNewConversation: !linkingResult.conversationId,
            },
          })
        } catch (error) {
          logger.warn('Failed to link conversation for native Bedrock request', {
            requestId: context.requestId,
            metadata: {
              error: error instanceof Error ? error.message : String(error),
            },
          })
        }
      }

      await this.storageService.storeRequest({
        id: context.requestId,
        projectId: context.projectId,
        accountId: accountId,
        timestamp: new Date(context.startTime),
        method: context.method,
        path: context.path,
        headers: context.headers,
        body: requestBody,
        request_type: 'inference',
        model: model,
        input_tokens: metrics.inputTokens,
        output_tokens: metrics.outputTokens,
        total_tokens: metrics.totalTokens,
        cache_creation_input_tokens: metrics.cacheCreationInputTokens,
        cache_read_input_tokens: metrics.cacheReadInputTokens,
        usage_data: responseBody.usage as Record<string, unknown> | undefined,
        tool_call_count: metrics.toolCallCount,
        processing_time: context.getElapsedTime(),
        status_code: status,
        currentMessageHash: conversationData?.currentMessageHash,
        parentMessageHash: conversationData?.parentMessageHash,
        conversationId: conversationData?.conversationId,
        branchId: conversationData?.branchId,
        systemHash: conversationData?.systemHash,
        messageCount: messageCount,
        parentRequestId: conversationData?.parentRequestId,
        parentTaskRequestId: conversationData?.parentTaskRequestId,
        isSubtask: conversationData?.isSubtask,
      })

      // Store response
      await this.storageService.storeResponse({
        request_id: context.requestId,
        status_code: status,
        headers: responseHeaders || {},
        body: responseBody,
        timestamp: new Date(),
        input_tokens: metrics.inputTokens,
        output_tokens: metrics.outputTokens,
        total_tokens: metrics.totalTokens,
        cache_creation_input_tokens: metrics.cacheCreationInputTokens,
        cache_read_input_tokens: metrics.cacheReadInputTokens,
        usage_data: responseBody.usage as Record<string, unknown> | undefined,
        tool_call_count: metrics.toolCallCount,
        processing_time: context.getElapsedTime(),
      })

      // Process Task tool invocations
      await this.storageService.processTaskToolInvocations(
        context.requestId,
        responseBody,
        context.projectId
      )
    } catch (error) {
      logger.error('Failed to store native Bedrock request/response', {
        requestId: context.requestId,
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  /**
   * Check if the request is an internal Claude Code helper request
   * These are utility requests for file path extraction, conversation summarization, etc.
   */
  private isInternalClaudeCodeRequest(requestBody: Record<string, unknown>): boolean {
    const system = requestBody.system

    // Handle string system prompt
    if (typeof system === 'string') {
      return INTERNAL_SYSTEM_PROMPT_PREFIXES.some(prefix => system.startsWith(prefix))
    }

    // Handle array of system prompt blocks
    if (Array.isArray(system)) {
      for (const block of system) {
        if (
          typeof block === 'object' &&
          block !== null &&
          'text' in block &&
          typeof block.text === 'string'
        ) {
          if (INTERNAL_SYSTEM_PROMPT_PREFIXES.some(prefix => block.text.startsWith(prefix))) {
            return true
          }
        }
      }
    }

    return false
  }

  /**
   * Send telemetry data
   */
  private async sendTelemetry(data: TelemetryData): Promise<void> {
    if (!this.telemetryEndpoint) {
      return
    }

    try {
      const response = await fetch(this.telemetryEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(5000), // 5 second timeout
      })

      if (!response.ok) {
        logger.warn('Telemetry request failed', {
          metadata: {
            status: response.status,
            endpoint: this.telemetryEndpoint,
          },
        })
      }
    } catch (error) {
      // Don't fail the request if telemetry fails
      logger.debug('Failed to send telemetry', {
        metadata: {
          error: error instanceof Error ? error.message : String(error),
          endpoint: this.telemetryEndpoint,
        },
      })
    }
  }

  /**
   * Mask API key for telemetry
   */
  private maskApiKey(key?: string): string | undefined {
    if (!key || key.length < 8) {
      return undefined
    }
    if (key.length <= 10) {
      return key
    }
    return `...${key.slice(-10)}`
  }
}
