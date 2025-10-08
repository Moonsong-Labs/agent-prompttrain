/**
 * Auto-generated API client for Agent Prompt Train AI Analysis API
 * Generated from: docs/api/openapi-analysis.yaml
 * Generated on: 2025-07-07T14:38:58.717Z
 */

export interface CreateAnalysisRequest {
  conversationId: string
  branchId: string
  customPrompt?: string
}

export interface CreateAnalysisResponse {
  message: string
  analysisId: number
  status: 'pending' | 'processing' | 'completed' | 'failed'
}

export interface RegenerateAnalysisRequest {
  customPrompt?: string
}

export interface RegenerateAnalysisResponse {
  message: string
  analysisId: number
  status: 'pending' | 'processing' | 'completed' | 'failed'
}

export interface GetAnalysisResponse {
  id: number
  conversationId: string
  branchId: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  content?: string
  data?: ConversationAnalysis
  error?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
  tokenUsage: {
    prompt: number | null
    completion: number | null
    total: number
  }
}

export interface RegenerateAnalysisResponse {
  message: string
  analysisId: number
  status: 'pending' | 'processing' | 'completed' | 'failed'
}

export interface ConversationAnalysis {
  summary: string
  keyTopics: string[]
  sentiment: 'positive' | 'neutral' | 'negative' | 'mixed'
  userIntent: string
  outcomes: string[]
  actionItems: string[]
  technicalDetails: {
    frameworks: string[]
    issues: string[]
    solutions: string[]
  }
  conversationQuality: {
    clarity: 'high' | 'medium' | 'low'
    completeness: 'complete' | 'partial' | 'incomplete'
    effectiveness: 'highly effective' | 'effective' | 'needs improvement'
  }
}

export interface ApiClientOptions {
  baseUrl: string
  apiKey: string
  headers?: Record<string, string>
}

export class AnalysisApiClient {
  private baseUrl: string
  private headers: Record<string, string>

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.headers = {
      'Content-Type': 'application/json',
      'X-Dashboard-Key': options.apiKey,
      ...options.headers,
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }))
      throw new Error(`API Error (${response.status}): ${JSON.stringify(error)}`)
    }

    return response.json() as Promise<T>
  }

  /**
   * Create a new analysis request
   */
  async createAnalysis(request: CreateAnalysisRequest): Promise<CreateAnalysisResponse> {
    return this.request<CreateAnalysisResponse>('POST', '/api/analyses', request)
  }

  /**
   * Get analysis result
   */
  async getAnalysis(conversationId: string, branchId: string): Promise<GetAnalysisResponse> {
    return this.request<GetAnalysisResponse>('GET', `/api/analyses/${conversationId}/${branchId}`)
  }

  /**
   * Regenerate analysis
   */
  async regenerateAnalysis(
    conversationId: string,
    branchId: string,
    request?: RegenerateAnalysisRequest
  ): Promise<RegenerateAnalysisResponse> {
    return this.request<RegenerateAnalysisResponse>(
      'POST',
      `/api/analyses/${conversationId}/${branchId}/regenerate`,
      request
    )
  }

  /**
   * Poll for analysis completion
   * @param conversationId - Conversation ID
   * @param branchId - Branch ID
   * @param options - Polling options
   * @returns Completed analysis
   */
  async waitForAnalysis(
    conversationId: string,
    branchId: string,
    options: {
      pollingInterval?: number
      timeout?: number
      onProgress?: (status: string) => void
    } = {}
  ): Promise<GetAnalysisResponse> {
    const { pollingInterval = 2000, timeout = 300000, onProgress } = options
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      const analysis = await this.getAnalysis(conversationId, branchId)

      if (onProgress) {
        onProgress(analysis.status)
      }

      if (analysis.status === 'completed' || analysis.status === 'failed') {
        return analysis
      }

      await new Promise(resolve => setTimeout(resolve, pollingInterval))
    }

    throw new Error('Analysis timeout exceeded')
  }
}

// Export a factory function for convenience
export function createAnalysisClient(options: ApiClientOptions): AnalysisApiClient {
  return new AnalysisApiClient(options)
}
