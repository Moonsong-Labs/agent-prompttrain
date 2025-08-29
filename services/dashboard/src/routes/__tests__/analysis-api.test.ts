import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'
import { analysisRoutes } from '../analysis-api.js'
import { ProxyApiClient } from '../../services/api-client.js'
import type {
  CreateAnalysisResponse,
  GetAnalysisResponse,
  RegenerateAnalysisResponse,
} from '@agent-prompttrain/shared'
import { HttpError } from '../../errors/HttpError.js'

describe('Analysis API Routes', () => {
  let app: Hono<{
    Variables: {
      apiClient?: ProxyApiClient
    }
  }>
  let mockApiClient: Partial<ProxyApiClient>

  beforeEach(() => {
    // Create a new Hono app and mount the routes
    app = new Hono()

    // Create mock API client - use 'as any' to bypass strict typing for tests
    mockApiClient = {
      post: mock(() => Promise.resolve({})) as any,
      get: mock(() => Promise.resolve({})) as any,
    }

    // Add middleware to inject the API client
    app.use('*', async (c, next) => {
      c.set('apiClient', mockApiClient as ProxyApiClient)
      await next()
    })

    // Mount the routes
    app.route('/api', analysisRoutes)
  })

  describe('POST /api/analyses', () => {
    it('should create analysis request successfully', async () => {
      const mockResponse: CreateAnalysisResponse = {
        id: 123,
        conversationId: '550e8400-e29b-41d4-a716-446655440000',
        branchId: 'main',
        status: 'pending',
        createdAt: '2024-01-01T00:00:00Z',
      }

      mockApiClient.post = mock(() => Promise.resolve(mockResponse)) as any

      const response = await app.request('/api/analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: '550e8400-e29b-41d4-a716-446655440000',
          branchId: 'main',
        }),
      })

      expect(response.status).toBe(201)
      const data = await response.json()
      expect(data).toEqual(mockResponse)
      expect(mockApiClient.post).toHaveBeenCalledWith('/api/analyses', {
        conversationId: '550e8400-e29b-41d4-a716-446655440000',
        branchId: 'main',
      })
    })

    it('should return 400 for invalid request data', async () => {
      const response = await app.request('/api/analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: 'invalid-uuid',
          branchId: 'main',
        }),
      })

      expect(response.status).toBe(400)
      const data = (await response.json()) as { error: string; details?: Array<{ path: string[] }> }
      expect(data.error).toBe('Invalid request data')
      expect(data.details).toBeDefined()
      expect(data.details![0].path).toContain('conversationId')
    })

    it('should return 409 when analysis already exists', async () => {
      const conflictError = new HttpError('Analysis already exists', 409, {
        error: 'Analysis already exists',
      })

      mockApiClient.post = mock(() => Promise.reject(conflictError)) as any

      const response = await app.request('/api/analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: '550e8400-e29b-41d4-a716-446655440000',
          branchId: 'main',
        }),
      })

      expect(response.status).toBe(409)
      const data = (await response.json()) as { error: string }
      expect(data.error).toBe('Analysis already exists')
    })

    it('should return 503 when API client is not configured', async () => {
      // Create app without API client
      const appNoClient = new Hono()
      appNoClient.route('/api', analysisRoutes)

      const response = await appNoClient.request('/api/analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: '550e8400-e29b-41d4-a716-446655440000',
        }),
      })

      expect(response.status).toBe(503)
      const data = (await response.json()) as { error: string }
      expect(data.error).toBe('API client not configured')
    })

    it('should handle API client failures', async () => {
      mockApiClient.post = mock(() => Promise.reject(new Error('Network error'))) as any

      const response = await app.request('/api/analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: '550e8400-e29b-41d4-a716-446655440000',
        }),
      })

      expect(response.status).toBe(500)
      const data = (await response.json()) as { error: string }
      expect(data.error).toBe('Failed to create analysis')
    })

    it('should handle missing request body', async () => {
      const response = await app.request('/api/analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}), // Empty body
      })

      expect(response.status).toBe(400)
      const data = (await response.json()) as { error: string; details?: Array<{ path: string[] }> }
      expect(data.error).toBe('Invalid request data')
      expect(data.details).toBeDefined()
    })

    it('should use default branchId when not provided', async () => {
      const mockResponse: CreateAnalysisResponse = {
        id: 123,
        conversationId: '550e8400-e29b-41d4-a716-446655440000',
        branchId: 'main',
        status: 'pending',
        createdAt: '2024-01-01T00:00:00Z',
      }

      mockApiClient.post = mock(() => Promise.resolve(mockResponse)) as any

      const response = await app.request('/api/analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: '550e8400-e29b-41d4-a716-446655440000',
        }),
      })

      expect(response.status).toBe(201)
      expect(mockApiClient.post).toHaveBeenCalledWith('/api/analyses', {
        conversationId: '550e8400-e29b-41d4-a716-446655440000',
        branchId: 'main',
      })
    })
  })

  describe('GET /api/analyses/:conversationId/:branchId', () => {
    it('should retrieve analysis successfully', async () => {
      const mockResponse: GetAnalysisResponse = {
        id: 123,
        conversationId: '550e8400-e29b-41d4-a716-446655440000',
        branchId: 'main',
        status: 'completed',
        content: '# Analysis\n\nTest analysis content',
        data: {
          summary: 'Test summary',
          keyTopics: ['topic1', 'topic2'],
          sentiment: 'positive',
          userIntent: 'test intent',
          outcomes: ['outcome1'],
          actionItems: [{ type: 'task' as const, description: 'action1' }],
          promptingTips: [],
          interactionPatterns: {
            promptClarity: 8,
            contextCompleteness: 7,
            followUpEffectiveness: 'good' as const,
            commonIssues: [],
            strengths: [],
          },
          technicalDetails: {
            frameworks: ['framework1'],
            issues: ['issue1'],
            solutions: ['solution1'],
          },
          conversationQuality: {
            clarity: 'high' as const,
            completeness: 'complete' as const,
            effectiveness: 'effective' as const,
          },
        },
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        completedAt: '2024-01-01T00:00:00Z',
        tokenUsage: {
          prompt: 1000,
          completion: 500,
          total: 1500,
        },
      }

      mockApiClient.get = mock(() => Promise.resolve(mockResponse)) as any

      const response = await app.request(
        '/api/analyses/550e8400-e29b-41d4-a716-446655440000/main',
        {
          method: 'GET',
        }
      )

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data).toEqual(mockResponse)
      expect(mockApiClient.get).toHaveBeenCalledWith(
        '/api/analyses/550e8400-e29b-41d4-a716-446655440000/main'
      )
    })

    it('should return 400 for invalid UUID format', async () => {
      const response = await app.request('/api/analyses/invalid-uuid/main', {
        method: 'GET',
      })

      expect(response.status).toBe(400)
      const data = (await response.json()) as { error: string }
      expect(data.error).toBe('Invalid conversation ID format')
    })

    it('should return 404 when analysis not found', async () => {
      const notFoundError = new HttpError('Analysis not found', 404)
      mockApiClient.get = mock(() => Promise.reject(notFoundError)) as any

      const response = await app.request(
        '/api/analyses/550e8400-e29b-41d4-a716-446655440000/main',
        {
          method: 'GET',
        }
      )

      expect(response.status).toBe(404)
      const data = (await response.json()) as { error: string }
      expect(data.error).toBe('Analysis not found')
    })

    it('should return 503 when API client is not configured', async () => {
      const appNoClient = new Hono()
      appNoClient.route('/api', analysisRoutes)

      const response = await appNoClient.request(
        '/api/analyses/550e8400-e29b-41d4-a716-446655440000/main',
        {
          method: 'GET',
        }
      )

      expect(response.status).toBe(503)
      const data = (await response.json()) as { error: string }
      expect(data.error).toBe('API client not configured')
    })

    it('should handle API client failures', async () => {
      mockApiClient.get = mock(() => Promise.reject(new Error('Network error'))) as any

      const response = await app.request(
        '/api/analyses/550e8400-e29b-41d4-a716-446655440000/main',
        {
          method: 'GET',
        }
      )

      expect(response.status).toBe(500)
      const data = (await response.json()) as { error: string }
      expect(data.error).toBe('Failed to retrieve analysis')
    })

    it('should handle special branch IDs', async () => {
      const mockResponse: GetAnalysisResponse = {
        id: 123,
        conversationId: '550e8400-e29b-41d4-a716-446655440000',
        branchId: 'feature/new-feature',
        status: 'pending',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      }

      mockApiClient.get = mock(() => Promise.resolve(mockResponse)) as any

      const response = await app.request(
        '/api/analyses/550e8400-e29b-41d4-a716-446655440000/feature%2Fnew-feature',
        {
          method: 'GET',
        }
      )

      expect(response.status).toBe(200)
      expect(mockApiClient.get).toHaveBeenCalledWith(
        '/api/analyses/550e8400-e29b-41d4-a716-446655440000/feature/new-feature'
      )
    })
  })

  describe('POST /api/analyses/:conversationId/:branchId/regenerate', () => {
    it('should regenerate analysis successfully', async () => {
      const mockResponse: RegenerateAnalysisResponse = {
        id: 123,
        status: 'pending',
        message: 'Analysis regeneration requested',
      }

      mockApiClient.post = mock(() => Promise.resolve(mockResponse)) as any

      const response = await app.request(
        '/api/analyses/550e8400-e29b-41d4-a716-446655440000/main/regenerate',
        {
          method: 'POST',
        }
      )

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data).toEqual(mockResponse)
      expect(mockApiClient.post).toHaveBeenCalledWith(
        '/api/analyses/550e8400-e29b-41d4-a716-446655440000/main/regenerate'
      )
    })

    it('should return 400 for invalid UUID format', async () => {
      const response = await app.request('/api/analyses/invalid-uuid/main/regenerate', {
        method: 'POST',
      })

      expect(response.status).toBe(400)
      const data = (await response.json()) as { error: string }
      expect(data.error).toBe('Invalid conversation ID format')
    })

    it('should return 404 when conversation not found', async () => {
      const notFoundError = new HttpError('Conversation not found', 404)
      mockApiClient.post = mock(() => Promise.reject(notFoundError)) as any

      const response = await app.request(
        '/api/analyses/550e8400-e29b-41d4-a716-446655440000/main/regenerate',
        {
          method: 'POST',
        }
      )

      expect(response.status).toBe(404)
      const data = (await response.json()) as { error: string }
      expect(data.error).toBe('Conversation not found')
    })

    it('should return 503 when API client is not configured', async () => {
      const appNoClient = new Hono()
      appNoClient.route('/api', analysisRoutes)

      const response = await appNoClient.request(
        '/api/analyses/550e8400-e29b-41d4-a716-446655440000/main/regenerate',
        {
          method: 'POST',
        }
      )

      expect(response.status).toBe(503)
      const data = (await response.json()) as { error: string }
      expect(data.error).toBe('API client not configured')
    })

    it('should handle API client failures', async () => {
      mockApiClient.post = mock(() => Promise.reject(new Error('Network error'))) as any

      const response = await app.request(
        '/api/analyses/550e8400-e29b-41d4-a716-446655440000/main/regenerate',
        {
          method: 'POST',
        }
      )

      expect(response.status).toBe(500)
      const data = (await response.json()) as { error: string }
      expect(data.error).toBe('Failed to regenerate analysis')
    })
  })
})
