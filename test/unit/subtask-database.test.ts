import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { StorageWriter } from '../../services/proxy/src/storage/writer'
import { Pool } from 'pg'

// Mock pg Pool
const mockPool = {
  query: mock(() => Promise.resolve({ rows: [] })),
  connect: mock(() =>
    Promise.resolve({
      release: mock(() => {}),
      query: mock(() => Promise.resolve({ rows: [] })),
    })
  ),
}

describe('Sub-task Database Logic', () => {
  let writer: StorageWriter

  beforeEach(() => {
    // Reset mocks
    mockPool.query.mockClear()
    writer = new StorageWriter(mockPool as any)
  })

  describe('findMatchingTaskInvocation', () => {
    it('should find matching task invocation by prompt', async () => {
      const userContent = 'Analyze this test data and provide a summary'
      const timestamp = new Date('2024-01-20T12:00:00Z')
      const expectedResult = {
        request_id: 'parent-uuid-123',
        timestamp: new Date('2024-01-20T11:59:50Z'),
      }

      // Mock the database response
      mockPool.query.mockResolvedValueOnce({
        rows: [expectedResult],
        rowCount: 1,
      })

      // Call the private method using type assertion
      const result = await (writer as any).findMatchingTaskInvocation(userContent, timestamp)

      // Verify the query
      expect(mockPool.query).toHaveBeenCalledTimes(1)
      const [query, params] = mockPool.query.mock.calls[0]

      // Check query structure
      expect(query).toContain('jsonb_path_exists')
      expect(query).toContain('task_tool_invocation')
      expect(query).toContain("timestamp >= $1::timestamp - interval '12 hours'")
      expect(query).toContain('timestamp < $1::timestamp')

      // Check parameters
      expect(params).toHaveLength(2)
      expect(params[0]).toEqual(timestamp.toISOString())
      expect(params[1]).toEqual(userContent)

      // Check result
      expect(result).toEqual(expectedResult)
    })

    it('should return null when no matching task found', async () => {
      const userContent = 'No matching task'
      const timestamp = new Date()

      // Mock empty database response
      mockPool.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      })

      const result = await (writer as any).findMatchingTaskInvocation(userContent, timestamp)

      expect(mockPool.query).toHaveBeenCalledTimes(1)
      expect(result).toBeNull()
    })

    it('should handle database errors gracefully', async () => {
      const userContent = 'Test content'
      const timestamp = new Date()

      // Mock database error
      mockPool.query.mockRejectedValueOnce(new Error('Database connection failed'))

      const result = await (writer as any).findMatchingTaskInvocation(userContent, timestamp)

      expect(result).toBeNull()
    })
  })

  describe('storeRequest with sub-task detection', () => {
    it('should link sub-task when matching parent task exists', async () => {
      const parentTaskId = 'parent-task-uuid'
      const parentTimestamp = new Date('2024-01-20T11:59:50Z')

      // First mock: findMatchingTaskInvocation query
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            request_id: parentTaskId,
            timestamp: parentTimestamp,
          },
        ],
        rowCount: 1,
      })

      // Second mock: INSERT query (no branch detection since parentMessageHash is null)
      mockPool.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      })

      const request = {
        requestId: 'new-subtask-uuid',
        projectId: 'test.com',
        timestamp: new Date('2024-01-20T12:00:00Z'),
        method: 'POST',
        path: '/v1/messages',
        headers: {},
        body: {
          messages: [
            {
              role: 'user',
              content: 'Analyze this test data and provide a summary',
            },
          ],
        },
        apiKey: '',
        model: 'claude-3-opus',
        requestType: 'inference',
        conversationId: 'new-conversation-id',
        currentMessageHash: 'hash123',
        parentMessageHash: null, // First message in conversation
      }

      await writer.storeRequest(request)

      // Verify all queries were called
      expect(mockPool.query).toHaveBeenCalledTimes(2)

      // Check the INSERT query (second call)
      const insertCall = mockPool.query.mock.calls[1]
      const insertQuery = insertCall[0]
      const insertValues = insertCall[1]

      // Verify sub-task fields were set
      expect(insertQuery).toContain('parent_task_request_id')
      expect(insertQuery).toContain('is_subtask')

      // Check that parent_task_request_id was set (18th value, index 17)
      expect(insertValues[17]).toEqual(parentTaskId)
      // Check that is_subtask was set to true (19th value, index 18)
      expect(insertValues[18]).toBe(true)
    })

    it('should not link sub-task when no matching parent exists', async () => {
      // Mock no matching task found
      mockPool.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      })

      // Mock INSERT query
      mockPool.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      })

      const request = {
        requestId: 'standalone-uuid',
        projectId: 'test.com',
        timestamp: new Date(),
        method: 'POST',
        path: '/v1/messages',
        headers: {},
        body: {
          messages: [
            {
              role: 'user',
              content: 'This is a standalone request',
            },
          ],
        },
        apiKey: '',
        model: 'claude-3-opus',
        requestType: 'inference',
        conversationId: 'standalone-conversation',
        currentMessageHash: 'hash456',
        parentMessageHash: null,
      }

      await writer.storeRequest(request)

      // Check the INSERT query
      const insertCall = mockPool.query.mock.calls[1]
      const insertValues = insertCall[1]

      // Verify sub-task fields were NOT set
      expect(insertValues[17]).toBeNull() // parent_task_request_id
      expect(insertValues[18]).toBe(false) // is_subtask
    })

    it('should skip sub-task detection for non-first messages', async () => {
      const request = {
        requestId: 'continuation-uuid',
        projectId: 'test.com',
        timestamp: new Date(),
        method: 'POST',
        path: '/v1/messages',
        headers: {},
        body: {
          messages: [
            {
              role: 'user',
              content: 'This is a continuation',
            },
          ],
        },
        apiKey: '',
        model: 'claude-3-opus',
        requestType: 'inference',
        conversationId: 'existing-conversation',
        currentMessageHash: 'hash789',
        parentMessageHash: 'parent-hash-123', // Has parent, not first message
      }

      // Mock check for existing sub-task conversation
      mockPool.query.mockResolvedValueOnce({
        rows: [], // No existing sub-task
        rowCount: 0,
      })

      // Then INSERT query
      mockPool.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      })

      await writer.storeRequest(request)

      // Two queries: check sub-task and one INSERT (detectBranch was removed)
      expect(mockPool.query).toHaveBeenCalledTimes(2)

      const insertCall = mockPool.query.mock.calls[1]
      const insertValues = insertCall[1]

      // Verify defaults were used (indices 17 and 18)
      expect(insertValues[17]).toBeNull() // parent_task_request_id
      expect(insertValues[18]).toBe(false) // is_subtask
    })

    it('should handle array message content with system reminders', async () => {
      // Mock matching task found
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            request_id: 'parent-with-reminder',
            timestamp: new Date(),
          },
        ],
        rowCount: 1,
      })

      // No branch detection needed since parentMessageHash is null

      // Mock INSERT
      mockPool.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      })

      const request = {
        requestId: 'subtask-with-reminder',
        projectId: 'test.com',
        timestamp: new Date(),
        method: 'POST',
        path: '/v1/messages',
        headers: {},
        body: {
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: '<system-reminder>This is a system reminder</system-reminder>',
                },
                { type: 'text', text: 'Analyze this test data and provide a summary' },
              ],
            },
          ],
        },
        apiKey: '',
        model: 'claude-3-opus',
        requestType: 'inference',
        conversationId: 'new-with-reminder',
        currentMessageHash: 'hash-reminder',
        parentMessageHash: null,
      }

      await writer.storeRequest(request)

      // Verify the findMatchingTaskInvocation was called with the correct content
      // (skipping the system reminder)
      const queryCall = mockPool.query.mock.calls[0]
      expect(queryCall[1][1]).toBe('Analyze this test data and provide a summary')
    })
  })

  describe('markTaskToolInvocations', () => {
    it('should update task_tool_invocation field', async () => {
      const requestId = 'request-with-task'
      const taskInvocations = [
        {
          id: 'task-123',
          name: 'Task',
          input: {
            prompt: 'Do something',
            description: 'Task description',
          },
        },
      ]

      mockPool.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      })

      await writer.markTaskToolInvocations(requestId, taskInvocations)

      expect(mockPool.query).toHaveBeenCalledTimes(1)

      const [query, values] = mockPool.query.mock.calls[0]
      expect(query).toContain('UPDATE api_requests')
      expect(query).toContain('SET task_tool_invocation = $2')
      expect(values[0]).toBe(requestId)
      expect(values[1]).toBe(JSON.stringify(taskInvocations))
    })
  })
})
