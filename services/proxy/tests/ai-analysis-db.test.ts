import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import type { Pool, PoolClient, QueryResult } from 'pg'
import {
  claimJob,
  completeJob,
  failJob,
  resetStuckJobs,
  fetchConversationMessages,
  type ConversationAnalysisJob,
} from '../src/workers/ai-analysis/db.js'
import * as containerModule from '../src/container.js'
import { logger } from '../src/middleware/logger.js'
import { AI_WORKER_CONFIG } from '@agent-prompttrain/shared/config'

describe('AI Analysis DB Functions', () => {
  let mockPool: Partial<Pool>
  let mockClient: Partial<PoolClient>
  let mockQueryResult: <T = any>(rows: T[]) => QueryResult<T>
  let getDbPoolSpy: any

  beforeEach(() => {
    // Create mock query result helper
    mockQueryResult = <T = any>(rows: T[]) => ({
      rows,
      rowCount: rows.length,
      command: '',
      oid: 0,
      fields: [],
    })

    // Create mock client
    mockClient = {
      query: mock(() => Promise.resolve(mockQueryResult([]))),
      release: mock(() => {}),
    }

    // Create mock pool
    mockPool = {
      query: mock(() => Promise.resolve(mockQueryResult([]))),
      connect: mock(() => Promise.resolve(mockClient)),
    }

    // Mock the container's getDbPool method to return our mock pool
    getDbPoolSpy = spyOn(containerModule.container, 'getDbPool').mockReturnValue(mockPool as Pool)

    // Mock logger methods
    logger.error = mock(() => {})
    logger.debug = mock(() => {})
    logger.info = mock(() => {})
    logger.warn = mock(() => {})
  })

  afterEach(() => {
    // Restore the spy
    getDbPoolSpy.mockRestore()
  })

  describe('claimJob', () => {
    it('should claim a pending job successfully', async () => {
      const mockJob: ConversationAnalysisJob = {
        id: 1,
        conversation_id: 'conv-123',
        branch_id: 'main',
        status: 'processing',
        retry_count: 0,
        created_at: new Date(),
        updated_at: new Date(),
      }

      mockPool.query = mock(() => Promise.resolve(mockQueryResult([mockJob])))

      const result = await claimJob()

      expect(result).toEqual(mockJob)
      expect(mockPool.query).toHaveBeenCalled()
      const [query, params] = (mockPool.query as any).mock.calls[0]
      expect(query).toContain('UPDATE conversation_analyses')
      expect(params).toEqual([AI_WORKER_CONFIG.MAX_RETRIES]) // Use the actual configured value
    })

    it('should return null when no jobs are available', async () => {
      mockPool.query = mock(() => Promise.resolve(mockQueryResult([])))

      const result = await claimJob()

      expect(result).toBeNull()
    })

    it('should return null when database pool is not available', async () => {
      getDbPoolSpy.mockReturnValue(null)

      const result = await claimJob()

      expect(result).toBeNull()
    })

    it('should throw error on database error', async () => {
      const dbError = new Error('Database connection failed')
      mockPool.query = mock(() => Promise.reject(dbError))

      await expect(claimJob()).rejects.toThrow('Database connection failed')
    })
  })

  describe('completeJob', () => {
    it('should complete a job successfully', async () => {
      const analysisData = {
        summary: 'Test summary',
        keyTopics: ['topic1'],
        sentiment: 'positive' as const,
        userIntent: 'Test intent',
        outcomes: ['outcome1'],
        actionItems: [],
        promptingTips: [],
        interactionPatterns: {
          promptClarity: 7,
          contextCompleteness: 8,
          followUpEffectiveness: 'good' as const,
          commonIssues: [],
          strengths: [],
        },
        technicalDetails: {
          frameworks: ['framework1'],
          issues: [],
          solutions: [],
        },
        conversationQuality: {
          clarity: 'high' as const,
          completeness: 'complete' as const,
          effectiveness: 'effective' as const,
        },
      }

      mockPool.query = mock(() => Promise.resolve(mockQueryResult([])))

      await completeJob(
        1,
        'Test analysis content',
        analysisData,
        { raw: 'response' },
        'gemini-2.0-flash-exp',
        100,
        200,
        5000
      )

      expect(mockPool.query).toHaveBeenCalled()
      const [query, params] = (mockPool.query as any).mock.calls[0]
      expect(query).toContain('UPDATE conversation_analyses')
      expect(params).toEqual([
        'Test analysis content',
        JSON.stringify(analysisData),
        JSON.stringify({ raw: 'response' }),
        'gemini-2.0-flash-exp',
        100,
        200,
        5000,
        1,
      ])
    })

    it('should throw error when database pool is not available', async () => {
      getDbPoolSpy.mockReturnValue(null)

      await expect(
        completeJob(1, 'content', {} as any, {}, 'model', 100, 200, 5000)
      ).rejects.toThrow('Database pool not available')
    })
  })

  describe('failJob', () => {
    it('should retry job when retries remain', async () => {
      const job: ConversationAnalysisJob = {
        id: 1,
        conversation_id: 'conv-123',
        branch_id: 'main',
        status: 'processing',
        retry_count: 1,
        error_message: undefined,
        created_at: new Date(),
        updated_at: new Date(),
      }

      mockPool.query = mock(() => Promise.resolve(mockQueryResult([])))

      const error = new Error('Temporary failure')
      await failJob(job, error)

      expect(mockPool.query).toHaveBeenCalled()
      const [query, params] = (mockPool.query as any).mock.calls[0]
      expect(query).toContain("status = 'pending'")
      expect(params[0]).toContain('retry_2')
      expect(params[1]).toBe(1)
    })

    it('should permanently fail job when max retries exceeded', async () => {
      const job: ConversationAnalysisJob = {
        id: 1,
        conversation_id: 'conv-123',
        branch_id: 'main',
        status: 'processing',
        retry_count: AI_WORKER_CONFIG.MAX_RETRIES, // Set to MAX_RETRIES to trigger permanent failure
        error_message: undefined,
        created_at: new Date(),
        updated_at: new Date(),
      }

      mockPool.query = mock(() => Promise.resolve(mockQueryResult([])))

      const error = new Error('Permanent failure')
      await failJob(job, error)

      expect(mockPool.query).toHaveBeenCalled()
      const [query, params] = (mockPool.query as any).mock.calls[0]
      expect(query).toContain("status = 'failed'")
      expect(params[0]).toContain('final_error')
      expect(params[1]).toBe(1)
    })

    it('should handle JSON parse errors gracefully', async () => {
      const job: ConversationAnalysisJob = {
        id: 1,
        conversation_id: 'conv-123',
        branch_id: 'main',
        status: 'processing',
        retry_count: 1,
        error_message: 'invalid json',
        created_at: new Date(),
        updated_at: new Date(),
      }

      mockPool.query = mock(() => Promise.resolve(mockQueryResult([])))

      const error = new Error('New error')
      await failJob(job, error)

      expect(mockPool.query).toHaveBeenCalled()
      const [query, params] = (mockPool.query as any).mock.calls[0]
      expect(typeof query).toBe('string')
      expect(params[0]).toContain('parse_error')
      expect(params[1]).toBe(1)
    })
  })

  describe('resetStuckJobs', () => {
    it('should reset stuck jobs successfully', async () => {
      mockPool.query = mock(() =>
        Promise.resolve({
          ...mockQueryResult([]),
          rowCount: 3,
        })
      )

      const result = await resetStuckJobs()

      expect(result).toBe(3)
      expect(mockPool.query).toHaveBeenCalled()
      const [query] = (mockPool.query as any).mock.calls[0]
      expect(query).toContain('UPDATE conversation_analyses')
    })

    it('should return 0 when database pool is not available', async () => {
      getDbPoolSpy.mockReturnValue(null)

      const result = await resetStuckJobs()

      expect(result).toBe(0)
    })
  })

  describe('fetchConversationMessages', () => {
    it('should fetch and format messages correctly', async () => {
      const mockRows = [
        {
          request_body: {
            messages: [
              { role: 'user', content: 'Hello' },
              { role: 'assistant', content: 'Hi there' },
              { role: 'user', content: 'How are you?' },
            ],
          },
          response_body: {
            content: [{ type: 'text', text: 'I am doing well, thank you!' }],
          },
        },
        {
          request_body: {
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'What is ' },
                  { type: 'text', text: '2+2?' },
                ],
              },
            ],
          },
          response_body: {
            content: [
              { type: 'text', text: '2+2 equals 4' },
              { type: 'tool_use', name: 'calculator' },
            ],
          },
        },
      ]

      mockPool.query = mock(() => Promise.resolve(mockQueryResult(mockRows)))

      const result = await fetchConversationMessages('conv-123', 'main')

      expect(result).toEqual([
        { role: 'user', content: 'How are you?' },
        { role: 'model', content: 'I am doing well, thank you!' },
        { role: 'user', content: 'What is \n2+2?' },
        { role: 'model', content: '2+2 equals 4\n[Tool Use: calculator]' },
      ])
    })

    it('should handle empty results', async () => {
      mockPool.query = mock(() => Promise.resolve(mockQueryResult([])))

      const result = await fetchConversationMessages('conv-123', 'main')

      expect(result).toEqual([])
    })

    it('should throw error when database pool is not available', async () => {
      getDbPoolSpy.mockReturnValue(null)

      await expect(fetchConversationMessages('conv-123')).rejects.toThrow(
        'Database pool not available'
      )
    })
  })
})
