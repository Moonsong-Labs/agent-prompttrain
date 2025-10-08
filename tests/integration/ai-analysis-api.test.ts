import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import { analysisRoutes as proxyRoutes } from '../../services/proxy/src/routes/analyses.js'
import { analysisRoutes as dashboardRoutes } from '../../services/dashboard/src/routes/analysis-api.js'
import { ProxyApiClient } from '../../services/dashboard/src/services/api-client.js'
import { ConversationAnalysisStatus } from '../../packages/shared/src/types/ai-analysis.js'
import { initializeAnalysisRateLimiters } from '../../services/proxy/src/middleware/analysis-rate-limit.js'
import type {
  CreateAnalysisResponse,
  GetAnalysisResponse,
  RegenerateAnalysisResponse,
} from '../../packages/shared/src/types/ai-analysis.js'

// Initialize rate limiters for tests
initializeAnalysisRateLimiters()

/**
 * Note: This test file may fail when run in parallel with other tests due to a known issue
 * with Bun's test runner and Hono's _Response object serialization. If you encounter
 * "Expected a Response object, but received '_Response'" errors, run this test file
 * separately or use the scripts/test-integration.sh script.
 *
 * See: https://github.com/honojs/hono/issues/[issue-number]
 */
describe('AI Analysis API Integration Tests', () => {
  let proxyApp: Hono
  let dashboardApp: Hono
  let proxyServer: any
  let mockPool: any
  let proxyPort: number
  let apiClient: ProxyApiClient

  // Helper to create mock query result
  const mockQueryResult = <T = any>(rows: T[]) => ({
    rows,
    rowCount: rows.length,
    command: '',
    oid: 0,
    fields: [],
  })

  beforeEach(async () => {
    // Create mock pool
    mockPool = {
      query: mock(() => Promise.resolve(mockQueryResult([]))),
    }

    // Setup proxy app
    proxyApp = new Hono()
    proxyApp.use('*', async (c, next) => {
      c.set('pool', mockPool as Pool)
      c.set('projectId', 'test.example.com')
      c.set('requestId', 'test-request-id')
      await next()
    })
    proxyApp.route('/api/analyses', proxyRoutes)

    // Use a more predictable port for CI
    proxyPort = 0 // Let the OS assign a port

    // Start proxy server with retry logic for CI environments
    let retries = 3
    while (retries > 0) {
      try {
        proxyServer = Bun.serve({
          port: proxyPort,
          fetch: proxyApp.fetch,
          hostname: '127.0.0.1', // Bind to localhost only
        })
        proxyPort = proxyServer.port // Get the actual assigned port
        break
      } catch (error) {
        retries--
        if (retries === 0) {
          console.error(`Failed to start test server after 3 attempts: ${error}`)
          throw error
        }
        // Wait a bit before retrying
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }

    // Create API client
    apiClient = new ProxyApiClient(`http://127.0.0.1:${proxyPort}`, 'test-dashboard-key')

    // Setup dashboard app
    dashboardApp = new Hono()
    dashboardApp.use('*', async (c, next) => {
      c.set('apiClient', apiClient)
      await next()
    })
    dashboardApp.route('/api', dashboardRoutes)
  })

  afterEach(() => {
    proxyServer?.stop()
  })

  describe('End-to-End Request Flow', () => {
    it('should create analysis through dashboard to proxy', async () => {
      // Setup proxy mock responses
      mockPool.query = mock((query: string) => {
        if (query.includes('SELECT id, status FROM conversation_analyses')) {
          return Promise.resolve(mockQueryResult([]))
        }
        if (query.includes('INSERT INTO conversation_analyses')) {
          return Promise.resolve(mockQueryResult([{ id: 123 }]))
        }
        if (query.includes('INSERT INTO analysis_audit_log')) {
          return Promise.resolve(mockQueryResult([]))
        }
        return Promise.resolve(mockQueryResult([]))
      })

      // Make request through dashboard
      const response = await dashboardApp.request('/api/analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: '550e8400-e29b-41d4-a716-446655440000',
          branchId: 'main',
        }),
      })

      expect(response.status).toBe(201)
      const data = await response.json()
      expect(data.message).toBe('Analysis request created')
      expect(data.analysisId).toBe(123)
      expect(data.status).toBe(ConversationAnalysisStatus.PENDING)

      // Verify proxy was called correctly
      expect(mockPool.query).toHaveBeenCalled()
    })

    it('should retrieve analysis through dashboard from proxy', async () => {
      const mockAnalysis = {
        id: 123,
        status: ConversationAnalysisStatus.COMPLETED,
        analysis_content: '# Analysis\n\nTest content',
        analysis_data: {
          summary: 'Test summary',
          keyTopics: ['topic1'],
          sentiment: 'positive',
          userIntent: 'test',
          outcomes: [],
          actionItems: [],
          technicalDetails: {
            frameworks: [],
            issues: [],
            solutions: [],
          },
          conversationQuality: {
            clarity: 'high',
            completeness: 'complete',
            effectiveness: 'effective',
          },
        },
        error_message: null,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        completed_at: '2024-01-01T00:00:00Z',
        prompt_tokens: 1000,
        completion_tokens: 500,
      }

      mockPool.query = mock((query: string) => {
        if (query.includes('SELECT') && query.includes('FROM conversation_analyses')) {
          return Promise.resolve(mockQueryResult([mockAnalysis]))
        }
        if (query.includes('INSERT INTO analysis_audit_log')) {
          return Promise.resolve(mockQueryResult([]))
        }
        return Promise.resolve(mockQueryResult([]))
      })

      const response = await dashboardApp.request(
        '/api/analyses/550e8400-e29b-41d4-a716-446655440000/main',
        {
          method: 'GET',
        }
      )

      expect(response.status).toBe(200)
      const data: GetAnalysisResponse = await response.json()
      expect(data.id).toBe(123)
      expect(data.conversationId).toBe('550e8400-e29b-41d4-a716-446655440000')
      expect(data.branchId).toBe('main')
      expect(data.status).toBe(ConversationAnalysisStatus.COMPLETED)
    })

    it('should handle 404 error propagation', async () => {
      mockPool.query = mock(() => Promise.resolve(mockQueryResult([])))

      const response = await dashboardApp.request(
        '/api/analyses/550e8400-e29b-41d4-a716-446655440000/main',
        {
          method: 'GET',
        }
      )

      expect(response.status).toBe(404)
      const data = await response.json()
      expect(data.error).toBe('Analysis not found')
    })

    it('should handle 409 conflict propagation', async () => {
      mockPool.query = mock((query: string) => {
        if (query.includes('SELECT id, status FROM conversation_analyses')) {
          return Promise.resolve(
            mockQueryResult([
              {
                id: 456,
                status: ConversationAnalysisStatus.COMPLETED,
              },
            ])
          )
        }
        if (query.includes('INSERT INTO analysis_audit_log')) {
          return Promise.resolve(mockQueryResult([]))
        }
        return Promise.resolve(mockQueryResult([]))
      })

      // This should return the existing analysis, not a 409
      const response = await dashboardApp.request('/api/analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: '550e8400-e29b-41d4-a716-446655440000',
          branchId: 'main',
        }),
      })

      expect(response.status).toBe(201) // Dashboard always returns 201 for POST success
      const data = await response.json()
      expect(data.message).toBe('Analysis already completed')
      expect(data.analysisId).toBe(456)
    })

    it('should handle regeneration flow', async () => {
      let updateCalled = false
      mockPool.query = mock((query: string) => {
        if (query.includes('SELECT id, status FROM conversation_analyses')) {
          return Promise.resolve(
            mockQueryResult([
              {
                id: 123,
                status: ConversationAnalysisStatus.FAILED,
              },
            ])
          )
        }
        if (query.includes('UPDATE conversation_analyses')) {
          updateCalled = true
          return Promise.resolve(mockQueryResult([]))
        }
        if (query.includes('INSERT INTO analysis_audit_log')) {
          return Promise.resolve(mockQueryResult([]))
        }
        return Promise.resolve(mockQueryResult([]))
      })

      const response = await dashboardApp.request(
        '/api/analyses/550e8400-e29b-41d4-a716-446655440000/main/regenerate',
        {
          method: 'POST',
        }
      )

      expect(response.status).toBe(200)
      const data: RegenerateAnalysisResponse = await response.json()
      expect(data.message).toBe('Analysis regeneration requested')
      expect(data.analysisId).toBe(123)
      expect(data.status).toBe(ConversationAnalysisStatus.PENDING)
      expect(updateCalled).toBe(true)
    })

    it('should handle validation errors at dashboard level', async () => {
      const response = await dashboardApp.request('/api/analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: 'not-a-uuid',
          branchId: 'main',
        }),
      })

      expect(response.status).toBe(400)
      const data = await response.json()
      expect(data.error).toBe('Invalid request data')
      expect(data.details).toBeDefined()

      // Proxy should not have been called
      expect(mockPool.query).not.toHaveBeenCalled()
    })

    it('should handle proxy server errors', async () => {
      // Temporarily stop the proxy server to simulate connection error
      const originalFetch = apiClient.fetch
      apiClient.fetch = async () => {
        throw new Error('Connection refused')
      }

      const response = await dashboardApp.request('/api/analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: '550e8400-e29b-41d4-a716-446655440000',
          branchId: 'main',
        }),
      })

      expect(response.status).toBe(500)
      const data = await response.json()
      expect(data.error).toBe('Failed to create analysis')

      // Restore original fetch
      apiClient.fetch = originalFetch
    })
  })

  describe('Response Validation', () => {
    it('should return properly formatted analysis response', async () => {
      const mockAnalysis = {
        id: 123,
        status: ConversationAnalysisStatus.COMPLETED,
        analysis_content: '# Conversation Analysis\n\nDetailed analysis here...',
        analysis_data: {
          summary: 'User discussed implementing a new feature',
          keyTopics: ['feature implementation', 'architecture', 'testing'],
          sentiment: 'positive' as const,
          userIntent: 'Implement new authentication system',
          outcomes: ['Design approved', 'Implementation plan created'],
          actionItems: ['Create database schema', 'Write unit tests'],
          technicalDetails: {
            frameworks: ['React', 'Node.js'],
            issues: ['Token expiration handling'],
            solutions: ['Use refresh tokens'],
          },
          conversationQuality: {
            clarity: 'high' as const,
            completeness: 'complete' as const,
            effectiveness: 'effective' as const,
          },
        },
        error_message: null,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:05:00Z',
        completed_at: '2024-01-01T00:05:00Z',
        prompt_tokens: 2500,
        completion_tokens: 1500,
      }

      mockPool.query = mock((query: string) => {
        if (query.includes('SELECT') && query.includes('FROM conversation_analyses')) {
          return Promise.resolve(mockQueryResult([mockAnalysis]))
        }
        return Promise.resolve(mockQueryResult([]))
      })

      const response = await dashboardApp.request(
        '/api/analyses/550e8400-e29b-41d4-a716-446655440000/main',
        {
          method: 'GET',
        }
      )

      expect(response.status).toBe(200)
      const data = await response.json()

      // Validate response structure matches GetAnalysisResponse interface
      expect(data).toMatchObject({
        id: expect.any(Number),
        conversationId: expect.any(String),
        branchId: expect.any(String),
        status: expect.stringMatching(/^(pending|processing|completed|failed)$/),
        content: expect.any(String),
        data: expect.objectContaining({
          summary: expect.any(String),
          keyTopics: expect.arrayContaining([expect.any(String)]),
          sentiment: expect.stringMatching(/^(positive|neutral|negative|mixed)$/),
          userIntent: expect.any(String),
          outcomes: expect.any(Array),
          actionItems: expect.any(Array),
          technicalDetails: expect.objectContaining({
            frameworks: expect.any(Array),
            issues: expect.any(Array),
            solutions: expect.any(Array),
          }),
          conversationQuality: expect.objectContaining({
            clarity: expect.stringMatching(/^(high|medium|low)$/),
            completeness: expect.stringMatching(/^(complete|partial|incomplete)$/),
            effectiveness: expect.stringMatching(
              /^(highly effective|effective|needs improvement)$/
            ),
          }),
        }),
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        completedAt: expect.any(String),
      })

      // Token usage is optional in the response
      if (data.tokenUsage) {
        expect(data.tokenUsage).toMatchObject({
          total: expect.any(Number),
        })
      }
    })

    it('should handle pending analysis response', async () => {
      const mockAnalysis = {
        id: 123,
        status: ConversationAnalysisStatus.PENDING,
        analysis_content: null,
        analysis_data: null,
        error_message: null,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        completed_at: null,
        prompt_tokens: null,
        completion_tokens: null,
      }

      mockPool.query = mock((query: string) => {
        if (query.includes('SELECT') && query.includes('FROM conversation_analyses')) {
          return Promise.resolve(mockQueryResult([mockAnalysis]))
        }
        return Promise.resolve(mockQueryResult([]))
      })

      const response = await dashboardApp.request(
        '/api/analyses/550e8400-e29b-41d4-a716-446655440000/main',
        {
          method: 'GET',
        }
      )

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.status).toBe(ConversationAnalysisStatus.PENDING)
      expect(data.content).toBeNull() // API returns null for pending analyses
      expect(data.data).toBeNull()
      expect(data.tokenUsage.total).toBe(0)
    })
  })

  describe('Audit Logging', () => {
    it('should create audit logs for all operations', async () => {
      const auditLogs: any[] = []
      mockPool.query = mock((query: string, params?: any[]) => {
        if (query.includes('INSERT INTO analysis_audit_log')) {
          auditLogs.push({
            event_type: params?.[0],
            outcome: params?.[1],
            conversation_id: params?.[2],
            branch_id: params?.[3],
            domain: params?.[4],
            request_id: params?.[5],
          })
          return Promise.resolve(mockQueryResult([]))
        }
        if (query.includes('SELECT id, status FROM conversation_analyses')) {
          return Promise.resolve(mockQueryResult([]))
        }
        if (query.includes('INSERT INTO conversation_analyses')) {
          return Promise.resolve(mockQueryResult([{ id: 123 }]))
        }
        return Promise.resolve(mockQueryResult([]))
      })

      // Create analysis
      await dashboardApp.request('/api/analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: '550e8400-e29b-41d4-a716-446655440000',
          branchId: 'main',
        }),
      })

      // Should have INITIATED and SUCCESS audit logs
      expect(auditLogs).toHaveLength(2)
      expect(auditLogs[0]).toMatchObject({
        event_type: 'ANALYSIS_REQUEST',
        outcome: 'INITIATED',
        conversation_id: '550e8400-e29b-41d4-a716-446655440000',
        branch_id: 'main',
        domain: 'test.example.com',
      })
      expect(auditLogs[1]).toMatchObject({
        event_type: 'ANALYSIS_REQUEST',
        outcome: 'SUCCESS',
      })
    })
  })
})
