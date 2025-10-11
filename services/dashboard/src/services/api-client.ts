import { logger } from '../middleware/logger.js'
import { getErrorMessage } from '@agent-prompttrain/shared'
import { HttpError } from '../errors/HttpError.js'

interface StatsResponse {
  totalRequests: number
  totalTokens: number
  totalInputTokens: number
  totalOutputTokens: number
  averageResponseTime: number
  errorCount: number
  activeTrainIds: number
  requestsByModel: Record<string, number>
  requestsByType: Record<string, number>
}

interface RequestSummary {
  requestId: string
  projectId: string
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
  requestBody: unknown
  responseBody: unknown
  streamingChunks: Array<{
    chunkIndex: number
    timestamp: string
    data: string
    tokenCount: number
  }>
  parentRequestId?: string
  branchId?: string
  // Optional fields that may be added in the future
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string>
  telemetry?: unknown
  method?: string
  endpoint?: string
  streaming?: boolean
}

interface TrainIdsResponse {
  trainIds?: Array<{
    projectId: string
    requestCount: number
  }>
}

interface TokenUsageWindow {
  accountId: string
  projectId: string
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
  projectId: string
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  totalRequests: number
}

interface RateLimitConfig {
  id: number
  accountId?: string
  projectId?: string
  model?: string
  windowMinutes: number
  tokenLimit: number
  requestLimit?: number
  fallbackModel?: string
  enabled: boolean
}

interface ConversationSummary {
  conversationId: string
  trainIds: string[]
  accountIds: string[]
  // Backward compatibility - deprecated
  projectId: string
  accountId?: string
  firstMessageTime: string
  lastMessageTime: string
  messageCount: number
  totalTokens: number
  branchCount: number
  // New branch type counts
  subtaskBranchCount?: number
  compactBranchCount?: number
  userBranchCount?: number
  modelsUsed: string[]
  latestRequestId?: string
  latestModel?: string
  latestContextTokens?: number
  isSubtask?: boolean
  parentTaskRequestId?: string
  parentConversationId?: string
  subtaskMessageCount?: number
  isPrivate?: boolean
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

  private getHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extraHeaders,
    }

    if (this.apiKey) {
      headers['X-Dashboard-Key'] = this.apiKey
    }

    return headers
  }

  /**
   * Get aggregated statistics
   */
  async getStats(params?: { projectId?: string; since?: string }): Promise<StatsResponse> {
    try {
      const url = new URL('/api/stats', this.baseUrl)
      if (params?.projectId) {
        url.searchParams.set('projectId', params.projectId)
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

      const stats = (await response.json()) as StatsResponse & { activeTrains?: number }

      return stats
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
    projectId?: string
    limit?: number
    offset?: number
  }): Promise<RequestsResponse> {
    try {
      const url = new URL('/api/requests', this.baseUrl)
      if (params?.projectId) {
        url.searchParams.set('projectId', params.projectId)
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

      const json = (await response.json()) as any
      const mapped: RequestsResponse = {
        requests: (json.requests || []).map((req: any) => ({
          requestId: req.requestId,
          projectId: req.projectId,
          model: req.model,
          timestamp: req.timestamp,
          inputTokens: req.inputTokens,
          outputTokens: req.outputTokens,
          totalTokens: req.totalTokens,
          durationMs: req.durationMs,
          responseStatus: req.responseStatus,
          error: req.error,
          requestType: req.requestType,
          conversationId: req.conversationId,
        })),
        pagination: json.pagination,
      }

      return mapped
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

      const json = (await response.json()) as any
      const details: RequestDetails = {
        requestId: json.requestId,
        projectId: json.projectId,
        model: json.model,
        timestamp: json.timestamp,
        inputTokens: json.inputTokens,
        outputTokens: json.outputTokens,
        totalTokens: json.totalTokens,
        durationMs: json.durationMs,
        responseStatus: json.responseStatus,
        error: json.error,
        requestType: json.requestType,
        conversationId: json.conversationId,
        requestBody: json.requestBody,
        responseBody: json.responseBody,
        streamingChunks: json.streamingChunks || [],
        parentRequestId: json.parentRequestId,
        branchId: json.branchId,
        requestHeaders: json.requestHeaders,
        responseHeaders: json.responseHeaders,
        telemetry: json.telemetry,
        method: json.method,
        endpoint: json.endpoint,
        streaming: json.streaming,
      }

      return details
    } catch (error) {
      logger.error('Failed to fetch request details from proxy API', {
        error: getErrorMessage(error),
        requestId,
      })
      throw error
    }
  }

  /**
   * Get list of active train IDs with request counts
   */
  async getTrainIds(): Promise<TrainIdsResponse> {
    try {
      const url = new URL('/api/train-ids', this.baseUrl)

      const response = await fetch(url.toString(), {
        headers: this.getHeaders(),
      })
      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`)
      }

      const data = (await response.json()) as TrainIdsResponse

      return data
    } catch (error) {
      logger.error('Failed to fetch train IDs from proxy API', {
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
    projectId?: string
    model?: string
  }): Promise<TokenUsageWindow> {
    try {
      const url = new URL('/api/token-usage/current', this.baseUrl)
      url.searchParams.set('accountId', params.accountId)
      if (params.window) {
        url.searchParams.set('window', params.window.toString())
      }
      if (params.projectId) {
        url.searchParams.set('projectId', params.projectId)
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

      const json = (await response.json()) as any
      return {
        accountId: json.accountId,
        projectId: json.projectId,
        model: json.model,
        windowStart: json.windowStart,
        windowEnd: json.windowEnd,
        totalInputTokens: json.totalInputTokens,
        totalOutputTokens: json.totalOutputTokens,
        totalTokens: json.totalTokens,
        totalRequests: json.totalRequests,
        cacheCreationInputTokens: json.cacheCreationInputTokens,
        cacheReadInputTokens: json.cacheReadInputTokens,
      }
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
    projectId?: string
    aggregate?: boolean
  }): Promise<{ usage: DailyUsage[] }> {
    try {
      const url = new URL('/api/token-usage/daily', this.baseUrl)
      url.searchParams.set('accountId', params.accountId)
      if (params.days) {
        url.searchParams.set('days', params.days.toString())
      }
      if (params.projectId) {
        url.searchParams.set('projectId', params.projectId)
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

      const json = (await response.json()) as { usage: DailyUsage[] }
      json.usage = json.usage.map(entry => ({
        ...entry,
        projectId: entry.projectId,
      }))
      return json
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
   * Get sliding window token usage with rate limit status
   */
  async getSlidingWindowUsage(params: {
    accountId: string
    days?: number
    bucketMinutes?: number
    windowHours?: number
  }): Promise<{
    accountId: string
    params: {
      days: number
      bucketMinutes: number
      windowHours: number
    }
    data: Array<{
      time_bucket: string
      sliding_window_tokens: number
      rate_limit_warning_in_window: boolean
    }>
  }> {
    try {
      const url = new URL('/api/analytics/token-usage/sliding-window', this.baseUrl)
      url.searchParams.set('accountId', params.accountId)
      if (params.days) {
        url.searchParams.set('days', params.days.toString())
      }
      if (params.bucketMinutes) {
        url.searchParams.set('bucketMinutes', params.bucketMinutes.toString())
      }
      if (params.windowHours) {
        url.searchParams.set('windowHours', params.windowHours.toString())
      }

      const response = await fetch(url.toString(), {
        headers: this.getHeaders(),
      })
      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`)
      }

      return (await response.json()) as {
        accountId: string
        params: {
          days: number
          bucketMinutes: number
          windowHours: number
        }
        data: Array<{
          time_bucket: string
          sliding_window_tokens: number
          rate_limit_warning_in_window: boolean
        }>
      }
    } catch (error) {
      logger.error('Failed to fetch sliding window usage from proxy API', {
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
      trainIds: Array<{
        projectId: string
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

      const json = (await response.json()) as any

      const accounts = (json.accounts || []).map((account: any) => ({
        accountId: account.accountId,
        outputTokens: account.outputTokens,
        inputTokens: account.inputTokens,
        requestCount: account.requestCount,
        lastRequestTime: account.lastRequestTime,
        remainingTokens: account.remainingTokens,
        percentageUsed: account.percentageUsed,
        trainIds: (account.trainIds || []).map((item: any) => ({
          projectId: item.projectId,
          outputTokens: item.outputTokens,
          requests: item.requests,
        })),
        miniSeries: account.miniSeries || [],
      }))

      return {
        accounts,
        tokenLimit: json.tokenLimit,
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
    projectId?: string
    model?: string
  }): Promise<{ configs: RateLimitConfig[] }> {
    try {
      const url = new URL('/api/rate-limits', this.baseUrl)
      if (params?.accountId) {
        url.searchParams.set('accountId', params.accountId)
      }
      if (params?.projectId) {
        url.searchParams.set('projectId', params.projectId)
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

      const json = (await response.json()) as any
      json.configs = (json.configs || []).map((cfg: any) => ({
        ...cfg,
        projectId: cfg.projectId,
      }))
      return json
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
    projectId?: string
    accountId?: string
    limit?: number
    offset?: number
    dateFrom?: string
    dateTo?: string
    userEmail?: string // Add userEmail for privacy filtering
  }): Promise<{
    conversations: ConversationSummary[]
    pagination?: {
      total: number
      limit: number
      offset: number
      hasMore: boolean
      page: number
      totalPages: number
    }
  }> {
    try {
      const url = new URL('/api/conversations', this.baseUrl)
      if (params?.projectId) {
        url.searchParams.set('projectId', params.projectId)
      }
      if (params?.accountId) {
        url.searchParams.set('accountId', params.accountId)
      }
      if (params?.limit) {
        url.searchParams.set('limit', params.limit.toString())
      }
      if (params?.offset) {
        url.searchParams.set('offset', params.offset.toString())
      }
      if (params?.dateFrom) {
        url.searchParams.set('dateFrom', params.dateFrom)
      }
      if (params?.dateTo) {
        url.searchParams.set('dateTo', params.dateTo)
      }

      const headers: Record<string, string> = {}
      // Pass the authenticated user email in the header for privacy filtering
      if (params?.userEmail) {
        headers['X-Auth-Principal'] = params.userEmail
      }

      const response = await fetch(url.toString(), {
        headers: this.getHeaders(headers),
      })
      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`)
      }

      const data = (await response.json()) as any
      // Handle both old and new response formats for backward compatibility
      if (data.pagination) {
        return data as { conversations: ConversationSummary[]; pagination: any }
      }
      return { conversations: data.conversations }
    } catch (error) {
      logger.error('Failed to fetch conversations from proxy API', {
        error: getErrorMessage(error),
        params,
      })
      throw error
    }
  }

  /**
   * Get aggregated dashboard statistics
   */
  async getDashboardStats(params?: { projectId?: string; accountId?: string }): Promise<{
    totalConversations: number
    activeUsers: number
    totalRequests: number
    totalTokens: number
    totalBranches: number
    subtaskBranches: number
    compactBranches: number
    modelsUsed: string[]
    modelsUsedCount: number
    last24Hours: {
      requests: number
      conversations: number
      activeUsers: number
    }
    hourlyActivity: Array<{
      hour: string
      requestCount: number
      tokenCount: number
    }>
  }> {
    try {
      const url = new URL('/api/dashboard/stats', this.baseUrl)
      if (params?.projectId) {
        url.searchParams.set('projectId', params.projectId)
      }
      if (params?.accountId) {
        url.searchParams.set('accountId', params.accountId)
      }

      const response = await fetch(url.toString(), {
        headers: this.getHeaders(),
      })
      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`)
      }

      return (await response.json()) as {
        totalConversations: number
        activeUsers: number
        totalRequests: number
        totalTokens: number
        totalBranches: number
        subtaskBranches: number
        compactBranches: number
        modelsUsed: string[]
        modelsUsedCount: number
        last24Hours: {
          requests: number
          conversations: number
          activeUsers: number
        }
        hourlyActivity: Array<{
          hour: string
          requestCount: number
          tokenCount: number
        }>
      }
    } catch (error) {
      logger.error('Failed to fetch dashboard stats from proxy API', {
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
        activeTrainIds: stats.activeTrainIds,
      },
      requests: requests.map(req => ({
        request_id: req.requestId,
        projectId: req.projectId,
        model: req.model,
        total_tokens: req.totalTokens,
        input_tokens: req.inputTokens,
        output_tokens: req.outputTokens,
        timestamp: req.timestamp,
        response_status: req.responseStatus,
      })),
    }
  }

  /**
   * Generic GET method for API calls
   */
  async get<T = unknown>(path: string): Promise<T> {
    try {
      const url = new URL(path, this.baseUrl)
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: this.getHeaders(),
      })

      if (!response.ok) {
        throw await HttpError.fromResponse(response)
      }

      return (await response.json()) as T
    } catch (error) {
      // If it's already an HttpError, just re-throw it
      if (HttpError.isHttpError(error)) {
        throw error
      }

      logger.error('API GET request failed', {
        error: getErrorMessage(error),
        path,
      })
      throw error
    }
  }

  /**
   * Generic POST method for API calls
   */
  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    try {
      const url = new URL(path, this.baseUrl)
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: this.getHeaders(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })

      if (!response.ok) {
        throw await HttpError.fromResponse(response)
      }

      return (await response.json()) as T
    } catch (error) {
      // If it's already an HttpError, just re-throw it
      if (HttpError.isHttpError(error)) {
        throw error
      }

      logger.error('API POST request failed', {
        error: getErrorMessage(error),
        path,
      })
      throw error
    }
  }

  /**
   * Make a generic fetch request to the proxy API
   */
  async fetch(path: string, options?: RequestInit): Promise<Response> {
    try {
      const url = new URL(path, this.baseUrl)

      const response = await fetch(url.toString(), {
        ...options,
        headers: {
          ...this.getHeaders(),
          ...(options?.headers as Record<string, string>),
        },
      })

      return response
    } catch (error) {
      logger.error('API fetch request failed', {
        error: getErrorMessage(error),
        path,
      })
      throw error
    }
  }
}
