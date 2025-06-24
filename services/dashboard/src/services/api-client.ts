import { logger } from '../middleware/logger.js'
import { getErrorMessage } from '@claude-nexus/shared'

interface StatsResponse {
  totalRequests: number
  totalTokens: number
  totalInputTokens: number
  totalOutputTokens: number
  averageResponseTime: number
  errorCount: number
  activeDomains: number
  requestsByModel: Record<string, number>
  requestsByType: Record<string, number>
}

interface RequestSummary {
  requestId: string
  domain: string
  model: string
  timestamp: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  durationMs: number
  responseStatus: number
  error?: string
  requestType?: string
  conversationId?: string
}

interface RequestsResponse {
  requests: RequestSummary[]
  pagination: {
    total: number
    limit: number
    offset: number
    hasMore: boolean
  }
}

interface RequestDetails extends RequestSummary {
  requestBody: any
  responseBody: any
  streamingChunks: Array<{
    chunkIndex: number
    timestamp: string
    data: string
    tokenCount: number
  }>
  // Optional fields that may be added in the future
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string>
  telemetry?: any
  method?: string
  endpoint?: string
  streaming?: boolean
}

interface DomainsResponse {
  domains: Array<{
    domain: string
    requestCount: number
  }>
}

interface TokenUsageWindow {
  accountId: string
  domain: string
  model: string
  windowStart: string
  windowEnd: string
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  totalRequests: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

interface DailyUsage {
  date: string
  accountId: string
  domain: string
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  totalRequests: number
}

interface RateLimitConfig {
  id: number
  accountId?: string
  domain?: string
  model?: string
  windowMinutes: number
  tokenLimit: number
  requestLimit?: number
  fallbackModel?: string
  enabled: boolean
}

interface ConversationSummary {
  conversationId: string
  domain: string
  accountId?: string
  firstMessageTime: string
  lastMessageTime: string
  messageCount: number
  totalTokens: number
  branchCount: number
  modelsUsed: string[]
  latestRequestId?: string
  isSubtask?: boolean
  parentTaskRequestId?: string
  parentConversationId?: string
  subtaskMessageCount?: number
}

/**
 * API client for communicating with the Proxy service
 */
export class ProxyApiClient {
  private baseUrl: string
  private apiKey: string | undefined

  constructor(baseUrl?: string, apiKey?: string) {
    this.baseUrl = baseUrl || process.env.PROXY_API_URL || 'http://localhost:3000'
    this.apiKey = apiKey || process.env.DASHBOARD_API_KEY || process.env.INTERNAL_API_KEY
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey
    }

    return headers
  }

  /**
   * Get aggregated statistics
   */
  async getStats(params?: { domain?: string; since?: string }): Promise<StatsResponse> {
    try {
      const url = new URL('/api/stats', this.baseUrl)
      if (params?.domain) {
        url.searchParams.set('domain', params.domain)
      }
      if (params?.since) {
        url.searchParams.set('since', params.since)
      }

      const response = await fetch(url.toString(), {
        headers: this.getHeaders(),
      })
      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`)
      }

      return (await response.json()) as StatsResponse
    } catch (error) {
      logger.error('Failed to fetch stats from proxy API', {
        error: getErrorMessage(error),
        params,
      })
      throw error
    }
  }

  /**
   * Get recent requests
   */
  async getRequests(params?: {
    domain?: string
    limit?: number
    offset?: number
  }): Promise<RequestsResponse> {
    try {
      const url = new URL('/api/requests', this.baseUrl)
      if (params?.domain) {
        url.searchParams.set('domain', params.domain)
      }
      if (params?.limit) {
        url.searchParams.set('limit', params.limit.toString())
      }
      if (params?.offset) {
        url.searchParams.set('offset', params.offset.toString())
      }

      const response = await fetch(url.toString(), {
        headers: this.getHeaders(),
      })
      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`)
      }

      return (await response.json()) as RequestsResponse
    } catch (error) {
      logger.error('Failed to fetch requests from proxy API', {
        error: getErrorMessage(error),
        params,
      })
      throw error
    }
  }

  /**
   * Get request details
   */
  async getRequestDetails(requestId: string): Promise<RequestDetails> {
    try {
      const url = new URL(`/api/requests/${requestId}`, this.baseUrl)

      const response = await fetch(url.toString(), {
        headers: this.getHeaders(),
      })
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Request not found')
        }
        throw new Error(`API error: ${response.status} ${response.statusText}`)
      }

      return (await response.json()) as RequestDetails
    } catch (error) {
      logger.error('Failed to fetch request details from proxy API', {
        error: getErrorMessage(error),
        requestId,
      })
      throw error
    }
  }

  /**
   * Get list of active domains with request counts
   */
  async getDomains(): Promise<DomainsResponse> {
    try {
      const url = new URL('/api/domains', this.baseUrl)

      const response = await fetch(url.toString(), {
        headers: this.getHeaders(),
      })
      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`)
      }

      const data = (await response.json()) as DomainsResponse
      // Return the full domain objects with request counts
      return data
    } catch (error) {
      logger.error('Failed to fetch domains from proxy API', {
        error: getErrorMessage(error),
      })
      throw error
    }
  }

  /**
   * Get current window token usage
   */
  async getTokenUsageWindow(params: {
    accountId: string
    window?: number // Window in minutes (default 300 = 5 hours)
    domain?: string
    model?: string
  }): Promise<TokenUsageWindow> {
    try {
      const url = new URL('/api/token-usage/current', this.baseUrl)
      url.searchParams.set('accountId', params.accountId)
      if (params.window) {
        url.searchParams.set('window', params.window.toString())
      }
      if (params.domain) {
        url.searchParams.set('domain', params.domain)
      }
      if (params.model) {
        url.searchParams.set('model', params.model)
      }

      const response = await fetch(url.toString(), {
        headers: this.getHeaders(),
      })
      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`)
      }

      return (await response.json()) as TokenUsageWindow
    } catch (error) {
      logger.error('Failed to fetch token usage window from proxy API', {
        error: getErrorMessage(error),
        params,
      })
      throw error
    }
  }

  /**
   * Get daily token usage
   */
  async getDailyTokenUsage(params: {
    accountId: string
    days?: number
    domain?: string
    aggregate?: boolean
  }): Promise<{ usage: DailyUsage[] }> {
    try {
      const url = new URL('/api/token-usage/daily', this.baseUrl)
      url.searchParams.set('accountId', params.accountId)
      if (params.days) {
        url.searchParams.set('days', params.days.toString())
      }
      if (params.domain) {
        url.searchParams.set('domain', params.domain)
      }
      if (params.aggregate !== undefined) {
        url.searchParams.set('aggregate', params.aggregate.toString())
      }

      const response = await fetch(url.toString(), {
        headers: this.getHeaders(),
      })
      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`)
      }

      return (await response.json()) as { usage: DailyUsage[] }
    } catch (error) {
      logger.error('Failed to fetch daily token usage from proxy API', {
        error: getErrorMessage(error),
        params,
      })
      throw error
    }
  }

  /**
   * Get token usage time series data
   */
  async getTokenUsageTimeSeries(params: {
    accountId: string
    window?: number // Window in hours (default 5)
    interval?: number // Interval in minutes (default 5)
  }): Promise<{
    accountId: string
    windowHours: number
    intervalMinutes: number
    tokenLimit: number
    timeSeries: Array<{
      time: string
      outputTokens: number
      cumulativeUsage: number
      remaining: number
      percentageUsed: number
    }>
  }> {
    try {
      const url = new URL('/api/token-usage/time-series', this.baseUrl)
      url.searchParams.set('accountId', params.accountId)
      if (params.window) {
        url.searchParams.set('window', params.window.toString())
      }
      if (params.interval) {
        url.searchParams.set('interval', params.interval.toString())
      }

      const response = await fetch(url.toString(), {
        headers: this.getHeaders(),
      })
      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`)
      }

      return (await response.json()) as {
        accountId: string
        windowHours: number
        intervalMinutes: number
        tokenLimit: number
        timeSeries: {
          time: string
          outputTokens: number
          cumulativeUsage: number
          remaining: number
          percentageUsed: number
        }[]
      }
    } catch (error) {
      logger.error('Failed to fetch token usage time series from proxy API', {
        error: getErrorMessage(error),
        params,
      })
      throw error
    }
  }

  /**
   * Get all accounts with their token usage
   */
  async getAccountsTokenUsage(): Promise<{
    accounts: Array<{
      accountId: string
      outputTokens: number
      inputTokens: number
      requestCount: number
      lastRequestTime: string
      remainingTokens: number
      percentageUsed: number
      domains: Array<{
        domain: string
        outputTokens: number
        requests: number
      }>
      miniSeries: Array<{
        time: string
        remaining: number
      }>
    }>
    tokenLimit: number
  }> {
    try {
      const url = new URL('/api/token-usage/accounts', this.baseUrl)

      const response = await fetch(url.toString(), {
        headers: this.getHeaders(),
      })
      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`)
      }

      return (await response.json()) as {
        accounts: {
          accountId: string
          outputTokens: number
          inputTokens: number
          requestCount: number
          lastRequestTime: string
          remainingTokens: number
          percentageUsed: number
          domains: {
            domain: string
            outputTokens: number
            requests: number
          }[]
          miniSeries: {
            time: string
            remaining: number
          }[]
        }[]
        tokenLimit: number
      }
    } catch (error) {
      logger.error('Failed to fetch accounts token usage from proxy API', {
        error: getErrorMessage(error),
      })
      throw error
    }
  }

  /**
   * Get rate limit configurations
   */
  async getRateLimitConfigs(params?: {
    accountId?: string
    domain?: string
    model?: string
  }): Promise<{ configs: RateLimitConfig[] }> {
    try {
      const url = new URL('/api/rate-limits', this.baseUrl)
      if (params?.accountId) {
        url.searchParams.set('accountId', params.accountId)
      }
      if (params?.domain) {
        url.searchParams.set('domain', params.domain)
      }
      if (params?.model) {
        url.searchParams.set('model', params.model)
      }

      const response = await fetch(url.toString(), {
        headers: this.getHeaders(),
      })
      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`)
      }

      return (await response.json()) as { configs: RateLimitConfig[] }
    } catch (error) {
      logger.error('Failed to fetch rate limit configs from proxy API', {
        error: getErrorMessage(error),
        params,
      })
      throw error
    }
  }

  /**
   * Get conversations with account information
   */
  async getConversations(params?: {
    domain?: string
    accountId?: string
    limit?: number
  }): Promise<{ conversations: ConversationSummary[] }> {
    try {
      const url = new URL('/api/conversations', this.baseUrl)
      if (params?.domain) {
        url.searchParams.set('domain', params.domain)
      }
      if (params?.accountId) {
        url.searchParams.set('accountId', params.accountId)
      }
      if (params?.limit) {
        url.searchParams.set('limit', params.limit.toString())
      }

      const response = await fetch(url.toString(), {
        headers: this.getHeaders(),
      })
      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`)
      }

      return (await response.json()) as { conversations: ConversationSummary[] }
    } catch (error) {
      logger.error('Failed to fetch conversations from proxy API', {
        error: getErrorMessage(error),
        params,
      })
      throw error
    }
  }

  /**
   * Convert API response to dashboard format for backward compatibility
   */
  convertToDashboardFormat(stats: StatsResponse, requests: RequestSummary[]) {
    return {
      stats: {
        totalRequests: stats.totalRequests,
        totalTokens: stats.totalTokens,
        estimatedCost: (stats.totalTokens / 1000) * 0.002, // Rough estimate
        activeDomains: stats.activeDomains,
      },
      requests: requests.map(req => ({
        request_id: req.requestId,
        domain: req.domain,
        model: req.model,
        total_tokens: req.totalTokens,
        input_tokens: req.inputTokens,
        output_tokens: req.outputTokens,
        timestamp: req.timestamp,
        response_status: req.responseStatus,
      })),
    }
  }
}
