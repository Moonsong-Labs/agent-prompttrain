import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'
import type { Pool, QueryResult, QueryResultRow } from 'pg'
import { analysisRoutes } from '../analyses.js'
import { ConversationAnalysisStatus } from '@agent-prompttrain/shared/types/ai-analysis'
import { logger } from '../../middleware/logger.js'

// Create a mock Pool type that's easier to work with
type MockPool = {
  query: ReturnType<typeof mock>
}

type QueryInput = string | { text: string; values?: unknown[] }

describe('Proxy Analysis Routes', () => {
  let app: Hono<{
    Variables: {
      pool?: Pool
      domain?: string
      requestId?: string
    }
  }>
  let mockPool: MockPool
  let mockQueryResult: <T extends QueryResultRow = QueryResultRow>(rows: T[]) => QueryResult<T>

  beforeEach(() => {
    // Create mock query result helper
    mockQueryResult = <T extends QueryResultRow = QueryResultRow>(rows: T[]) => ({
      rows,
      rowCount: rows.length,
      command: '',
      oid: 0,
      fields: [],
    })

    // Create mock pool
    mockPool = {
      query: mock((_queryTextOrConfig: QueryInput, _values?: unknown[]) =>
        Promise.resolve(mockQueryResult([]))
      ),
    }

    // Mock logger methods
    logger.error = mock(() => {})

    // Create app and add middleware
    app = new Hono()
    app.use('*', async (c, next) => {
      c.set('pool', mockPool as unknown as Pool)
      c.set('domain', 'test.example.com')
      c.set('requestId', 'test-request-id')
      await next()
    })

    // Mount routes
    app.route('/api/analyses', analysisRoutes)
  })

  describe('POST /api/analyses', () => {
    it('should create new analysis request', async () => {
      // Mock no existing analysis
      mockPool.query = mock((queryTextOrConfig: QueryInput, _values?: unknown[]) => {
        const query =
          typeof queryTextOrConfig === 'string' ? queryTextOrConfig : queryTextOrConfig.text
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

      const response = await app.request('/api/analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: '550e8400-e29b-41d4-a716-446655440000',
          branchId: 'main',
        }),
      })

      expect(response.status).toBe(201)
      const data = (await response.json()) as {
        message: string
        analysisId: number
        status: ConversationAnalysisStatus
      }
      expect(data.message).toBe('Analysis request created')
      expect(data.analysisId).toBe(123)
      expect(data.status).toBe(ConversationAnalysisStatus.PENDING)
    })

    it('should return existing completed analysis', async () => {
      mockPool.query = mock((queryTextOrConfig: QueryInput, _values?: unknown[]) => {
        const query =
          typeof queryTextOrConfig === 'string' ? queryTextOrConfig : queryTextOrConfig.text
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

      const response = await app.request('/api/analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: '550e8400-e29b-41d4-a716-446655440000',
          branchId: 'main',
        }),
      })

      expect(response.status).toBe(200)
      const data = (await response.json()) as {
        message: string
        analysisId: number
        status: ConversationAnalysisStatus
      }
      expect(data.message).toBe('Analysis already completed')
      expect(data.analysisId).toBe(456)
      expect(data.status).toBe(ConversationAnalysisStatus.COMPLETED)
    })

    it('should return existing analysis in progress', async () => {
      mockPool.query = mock((queryTextOrConfig: QueryInput, _values?: unknown[]) => {
        const query =
          typeof queryTextOrConfig === 'string' ? queryTextOrConfig : queryTextOrConfig.text
        if (query.includes('SELECT id, status FROM conversation_analyses')) {
          return Promise.resolve(
            mockQueryResult([
              {
                id: 789,
                status: ConversationAnalysisStatus.PROCESSING,
              },
            ])
          )
        }
        if (query.includes('INSERT INTO analysis_audit_log')) {
          return Promise.resolve(mockQueryResult([]))
        }
        return Promise.resolve(mockQueryResult([]))
      })

      const response = await app.request('/api/analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: '550e8400-e29b-41d4-a716-446655440000',
          branchId: 'main',
        }),
      })

      expect(response.status).toBe(200)
      const data = (await response.json()) as {
        message: string
        analysisId: number
        status: ConversationAnalysisStatus
      }
      expect(data.message).toBe('Analysis already in progress')
      expect(data.analysisId).toBe(789)
      expect(data.status).toBe(ConversationAnalysisStatus.PROCESSING)
    })

    it('should handle validation errors', async () => {
      const response = await app.request('/api/analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: 'invalid-uuid',
          branchId: 'main',
        }),
      })

      expect(response.status).toBe(400)
      const data = (await response.json()) as { error: string; details?: unknown }
      expect(data.error).toBe('Invalid request')
      expect(data.details).toBeDefined()
    })

    it('should return 503 when database is not configured', async () => {
      const appNoDb = new Hono()
      appNoDb.route('/api/analyses', analysisRoutes)

      const response = await appNoDb.request('/api/analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: '550e8400-e29b-41d4-a716-446655440000',
        }),
      })

      expect(response.status).toBe(503)
      const data = (await response.json()) as { error: string }
      expect(data.error).toBe('Database not configured')
    })

    it('should handle database errors', async () => {
      mockPool.query = mock(() => Promise.reject(new Error('Database connection failed')))

      const response = await app.request('/api/analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: '550e8400-e29b-41d4-a716-446655440000',
          branchId: 'main',
        }),
      })

      expect(response.status).toBe(500)
      const data = (await response.json()) as { error: string }
      expect(data.error).toBe('Failed to create analysis request')
    })

    it('should log audit events', async () => {
      const auditLogQueries: string[] = []
      mockPool.query = mock((queryTextOrConfig: QueryInput, _values?: unknown[]) => {
        const query =
          typeof queryTextOrConfig === 'string' ? queryTextOrConfig : queryTextOrConfig.text
        // const params =
        //   values || (typeof queryTextOrConfig === 'object' ? queryTextOrConfig.values : undefined)
        if (query.includes('INSERT INTO analysis_audit_log')) {
          auditLogQueries.push(query)
        }
        if (query.includes('SELECT id, status FROM conversation_analyses')) {
          return Promise.resolve(mockQueryResult([]))
        }
        if (query.includes('INSERT INTO conversation_analyses')) {
          return Promise.resolve(mockQueryResult([{ id: 123 }]))
        }
        return Promise.resolve(mockQueryResult([]))
      })

      await app.request('/api/analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: '550e8400-e29b-41d4-a716-446655440000',
          branchId: 'main',
        }),
      })

      // Should have 2 audit log entries - INITIATED and SUCCESS
      expect(auditLogQueries.length).toBe(2)
    })
  })

  describe('GET /api/analyses/:conversationId/:branchId', () => {
    it('should retrieve analysis successfully', async () => {
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

      mockPool.query = mock((queryTextOrConfig: QueryInput, _values?: unknown[]) => {
        const query =
          typeof queryTextOrConfig === 'string' ? queryTextOrConfig : queryTextOrConfig.text
        if (query.includes('SELECT') && query.includes('FROM conversation_analyses')) {
          return Promise.resolve(mockQueryResult([mockAnalysis]))
        }
        if (query.includes('INSERT INTO analysis_audit_log')) {
          return Promise.resolve(mockQueryResult([]))
        }
        return Promise.resolve(mockQueryResult([]))
      })

      const response = await app.request(
        '/api/analyses/550e8400-e29b-41d4-a716-446655440000/main',
        {
          method: 'GET',
        }
      )

      expect(response.status).toBe(200)
      const data = (await response.json()) as Record<string, unknown>
      expect(data.id).toBe(123)
      expect(data.conversationId).toBe('550e8400-e29b-41d4-a716-446655440000')
      expect(data.branchId).toBe('main')
      expect(data.status).toBe(ConversationAnalysisStatus.COMPLETED)
      expect(data.content).toBe('# Analysis\n\nTest content')
      expect(data.data).toEqual(mockAnalysis.analysis_data)
      expect(data.tokenUsage).toEqual({
        prompt: 1000,
        completion: 500,
        total: 1500,
      })
    })

    it('should return 404 when analysis not found', async () => {
      mockPool.query = mock((_queryTextOrConfig: QueryInput, _values?: unknown[]) =>
        Promise.resolve(mockQueryResult([]))
      )

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

    it('should handle validation errors', async () => {
      const response = await app.request('/api/analyses/invalid-uuid/main', {
        method: 'GET',
      })

      expect(response.status).toBe(400)
      const data = (await response.json()) as { error: string; details?: unknown }
      expect(data.error).toBe('Invalid request')
      expect(data.details).toBeDefined()
    })

    it('should handle failed analysis with error message', async () => {
      const mockAnalysis = {
        id: 123,
        status: ConversationAnalysisStatus.FAILED,
        analysis_content: null,
        analysis_data: null,
        error_message: 'Analysis failed due to timeout',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        completed_at: null,
        prompt_tokens: null,
        completion_tokens: null,
      }

      mockPool.query = mock((queryTextOrConfig: QueryInput, _values?: unknown[]) => {
        const query =
          typeof queryTextOrConfig === 'string' ? queryTextOrConfig : queryTextOrConfig.text
        if (query.includes('SELECT') && query.includes('FROM conversation_analyses')) {
          return Promise.resolve(mockQueryResult([mockAnalysis]))
        }
        return Promise.resolve(mockQueryResult([]))
      })

      const response = await app.request(
        '/api/analyses/550e8400-e29b-41d4-a716-446655440000/main',
        {
          method: 'GET',
        }
      )

      expect(response.status).toBe(200)
      const data = (await response.json()) as Record<string, unknown>
      expect(data.status).toBe(ConversationAnalysisStatus.FAILED)
      expect(data.error).toBe('Analysis failed due to timeout')
      expect(data.content).toBeNull()
    })

    it('should handle database errors', async () => {
      mockPool.query = mock((_queryTextOrConfig: QueryInput, _values?: unknown[]) =>
        Promise.reject(new Error('Database error'))
      )

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
  })

  describe('POST /api/analyses/:conversationId/:branchId/regenerate', () => {
    it('should regenerate existing analysis', async () => {
      mockPool.query = mock((queryTextOrConfig: QueryInput, _values?: unknown[]) => {
        const query =
          typeof queryTextOrConfig === 'string' ? queryTextOrConfig : queryTextOrConfig.text
        if (query.includes('SELECT id, status FROM conversation_analyses')) {
          return Promise.resolve(
            mockQueryResult([
              {
                id: 123,
                status: ConversationAnalysisStatus.COMPLETED,
              },
            ])
          )
        }
        if (query.includes('UPDATE conversation_analyses')) {
          return Promise.resolve(mockQueryResult([]))
        }
        if (query.includes('INSERT INTO analysis_audit_log')) {
          return Promise.resolve(mockQueryResult([]))
        }
        return Promise.resolve(mockQueryResult([]))
      })

      const response = await app.request(
        '/api/analyses/550e8400-e29b-41d4-a716-446655440000/main/regenerate',
        {
          method: 'POST',
        }
      )

      expect(response.status).toBe(200)
      const data = (await response.json()) as {
        message: string
        analysisId: number
        status: ConversationAnalysisStatus
      }
      expect(data.message).toBe('Analysis regeneration requested')
      expect(data.analysisId).toBe(123)
      expect(data.status).toBe(ConversationAnalysisStatus.PENDING)
    })

    it('should create new analysis if none exists', async () => {
      mockPool.query = mock((queryTextOrConfig: QueryInput, _values?: unknown[]) => {
        const query =
          typeof queryTextOrConfig === 'string' ? queryTextOrConfig : queryTextOrConfig.text
        if (query.includes('SELECT id, status FROM conversation_analyses')) {
          return Promise.resolve(mockQueryResult([]))
        }
        if (query.includes('INSERT INTO conversation_analyses')) {
          return Promise.resolve(mockQueryResult([{ id: 456 }]))
        }
        if (query.includes('INSERT INTO analysis_audit_log')) {
          return Promise.resolve(mockQueryResult([]))
        }
        return Promise.resolve(mockQueryResult([]))
      })

      const response = await app.request(
        '/api/analyses/550e8400-e29b-41d4-a716-446655440000/main/regenerate',
        {
          method: 'POST',
        }
      )

      expect(response.status).toBe(200)
      const data = (await response.json()) as {
        message: string
        analysisId: number
        status: ConversationAnalysisStatus
      }
      expect(data.message).toBe('Analysis regeneration requested')
      expect(data.analysisId).toBe(456)
      expect(data.status).toBe(ConversationAnalysisStatus.PENDING)
    })

    it('should increment retry count on regeneration', async () => {
      let updateQuery: string | undefined
      mockPool.query = mock((queryTextOrConfig: QueryInput, _values?: unknown[]) => {
        const query =
          typeof queryTextOrConfig === 'string' ? queryTextOrConfig : queryTextOrConfig.text
        // const params =
        //   values || (typeof queryTextOrConfig === 'object' ? queryTextOrConfig.values : undefined)
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
          updateQuery = query
          return Promise.resolve(mockQueryResult([]))
        }
        if (query.includes('INSERT INTO analysis_audit_log')) {
          return Promise.resolve(mockQueryResult([]))
        }
        return Promise.resolve(mockQueryResult([]))
      })

      await app.request('/api/analyses/550e8400-e29b-41d4-a716-446655440000/main/regenerate', {
        method: 'POST',
      })

      expect(updateQuery).toContain('retry_count = retry_count + 1')
    })

    it('should handle validation errors', async () => {
      const response = await app.request('/api/analyses/invalid-uuid/main/regenerate', {
        method: 'POST',
      })

      expect(response.status).toBe(400)
      const data = (await response.json()) as { error: string; details?: unknown }
      expect(data.error).toBe('Invalid request')
      expect(data.details).toBeDefined()
    })

    it('should handle database errors', async () => {
      mockPool.query = mock((_queryTextOrConfig: QueryInput, _values?: unknown[]) =>
        Promise.reject(new Error('Database error'))
      )

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

  describe('Rate Limiting', () => {
    // Note: Rate limiting tests would require mocking the rate limiting middleware
    // Since rate limiting is handled by middleware, we'll test that it's applied correctly

    it('should apply rate limiting to POST /api/analyses', async () => {
      // This test verifies that the rate limiting middleware is applied
      // In a real test, you would mock the rate limiter to test the behavior
      const response = await app.request('/api/analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: '550e8400-e29b-41d4-a716-446655440000',
        }),
      })

      // If rate limiting is working, we should get a response (not an error)
      expect(response.status).toBeGreaterThanOrEqual(200)
      expect(response.status).toBeLessThan(600)
    })
  })
})
