import { ProxyRequest, RequestType } from '../domain/entities/ProxyRequest'
import { ProxyResponse } from '../domain/entities/ProxyResponse'
import { RequestContext } from '../domain/value-objects/RequestContext'
import { tokenTracker } from './tokenTracker.js'
import { StorageAdapter } from '../storage/StorageAdapter.js'
import { logger } from '../middleware/logger'
import { broadcastConversation, broadcastMetrics } from '../dashboard/sse.js'

export interface MetricsConfig {
  enableTokenTracking: boolean
  enableStorage: boolean
  enableTelemetry: boolean
}

export interface TelemetryData {
  requestId: string
  timestamp: number
  domain: string
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
const NON_STORABLE_REQUEST_TYPES = new Set<RequestType>(['query_evaluation', 'quota'])

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
    private telemetryEndpoint?: string
  ) {}

  /**
   * Track metrics for a successful request
   */
  async trackRequest(
    request: ProxyRequest,
    response: ProxyResponse,
    context: RequestContext,
    status: number = 200
  ): Promise<void> {
    const metrics = response.getMetrics()

    // logger.debug('Tracking metrics for request', {
    //   requestId: context.requestId,
    //   domain: context.host,
    //   metrics: metrics,
    //   requestType: request.requestType,
    //   isStreaming: request.isStreaming
    // })

    // Track tokens
    if (this.config.enableTokenTracking) {
      tokenTracker.track(
        context.host,
        metrics.inputTokens,
        metrics.outputTokens,
        request.requestType === 'quota' ? undefined : request.requestType,
        metrics.toolCallCount
      )
    }

    // Store in database
    if (this.config.enableStorage && this.storageService) {
      await this.storeRequest(request, response, context, status)
    }

    // Send telemetry
    if (this.config.enableTelemetry && this.telemetryEndpoint) {
      await this.sendTelemetry({
        requestId: context.requestId,
        timestamp: Date.now(),
        domain: context.host,
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
      domain: context.host,
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
        domain: context.host,
        model: request.model,
        tokens: metrics.inputTokens + metrics.outputTokens,
        timestamp: new Date().toISOString(),
      })

      // Broadcast metrics update
      const stats = tokenTracker.getStats()
      const domainStats = stats[context.host]
      if (domainStats) {
        broadcastMetrics({
          domain: context.host,
          requests: domainStats.requestCount,
          tokens: domainStats.inputTokens + domainStats.outputTokens,
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
        context.host,
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
        domain: context.host,
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
      domain: context.host,
      metadata: {
        error: error.message,
        status,
      },
    })
  }

  /**
   * Get token statistics
   */
  getStats(domain?: string) {
    const allStats = tokenTracker.getStats()
    if (domain) {
      return allStats[domain] || null
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
    status: number
  ): Promise<void> {
    if (!this.storageService) return

    // Skip storing requests based on type
    if (NON_STORABLE_REQUEST_TYPES.has(request.requestType)) {
      logger.debug('Skipping storage for non-storable request type', {
        requestId: context.requestId,
        requestType: request.requestType,
        domain: context.host,
      })
      return
    }

    try {
      const metrics = response.getMetrics()

      await this.storageService.storeRequest({
        id: context.requestId,
        domain: context.host,
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
      })

      // Store response
      await this.storageService.storeResponse({
        request_id: context.requestId,
        status_code: status,
        headers: {}, // Response headers if needed
        body: { content: response.content }, // Store as JSON
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
   * Send telemetry data
   */
  private async sendTelemetry(data: TelemetryData): Promise<void> {
    if (!this.telemetryEndpoint) return

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
    if (!key || key.length < 8) return undefined
    if (key.length <= 10) return key
    return `...${key.slice(-10)}`
  }
}
