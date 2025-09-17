import { Pool } from 'pg'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { logger } from '../middleware/logger.js'

interface StorageRequest {
  requestId: string
  trainId: string
  accountId?: string // Account identifier from credentials
  timestamp: Date
  method: string
  path: string
  headers: Record<string, string>
  body: any
  apiKey: string
  model: string
  requestType?: string
  currentMessageHash?: string
  parentMessageHash?: string | null
  conversationId?: string
  branchId?: string
  systemHash?: string | null
  messageCount?: number
  parentTaskRequestId?: string
  isSubtask?: boolean
  taskToolInvocation?: any
  parentRequestId?: string // Parent request in conversation chain
}

interface StorageResponse {
  requestId: string
  statusCode: number
  headers: Record<string, string>
  body?: any
  streaming: boolean
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  usageData?: any
  firstTokenMs?: number
  durationMs: number
  error?: string
  toolCallCount?: number
}

interface StreamingChunk {
  requestId: string
  chunkIndex: number
  timestamp: Date
  data: string
  tokenCount?: number
}

/**
 * Storage writer service for persisting requests to the database
 * Write-only operations for the proxy service
 */
export class StorageWriter {
  private batchQueue: any[] = []
  private batchTimer?: NodeJS.Timeout
  private readonly BATCH_SIZE = 100
  private readonly BATCH_INTERVAL = 1000 // 1 second

  constructor(private pool: Pool) {
    this.startBatchProcessor()
  }

  /**
   * Store a request (write-only)
   */
  async storeRequest(request: StorageRequest): Promise<void> {
    try {
      // Mask sensitive headers instead of removing them
      const sanitizedHeaders = this.maskSensitiveHeaders(request.headers)

      // Check if this is a new conversation that matches a recent Task invocation
      let parentTaskRequestId = request.parentTaskRequestId
      let isSubtask = request.isSubtask || false

      // Check if this conversation is already marked as a sub-task
      if (request.conversationId && request.parentMessageHash) {
        // This is a continuation of an existing conversation
        const existingConv = await this.pool.query(
          'SELECT parent_task_request_id, is_subtask FROM api_requests WHERE conversation_id = $1 AND is_subtask = true LIMIT 1',
          [request.conversationId]
        )
        if (existingConv.rows.length > 0 && existingConv.rows[0].is_subtask) {
          parentTaskRequestId = existingConv.rows[0].parent_task_request_id
          isSubtask = true
          // Continuing sub-task conversation
        }
      } else if (!request.parentMessageHash && request.body?.messages?.length > 0) {
        // Only check for sub-task matching if this is the first message in a conversation
        const firstMessage = request.body.messages[0]
        if (firstMessage?.role === 'user') {
          const userContent = this.extractUserMessageContent(firstMessage)
          // Extracted user content for sub-task matching
          if (userContent) {
            const match = await this.findMatchingTaskInvocation(userContent, request.timestamp)
            if (match) {
              parentTaskRequestId = match.request_id
              isSubtask = true
              logger.info('Found matching Task invocation for new conversation', {
                requestId: request.requestId,
                metadata: {
                  parentTaskRequestId: match.request_id,
                  contentLength: userContent.length,
                  timeGapSeconds: Math.round(
                    (request.timestamp.getTime() - new Date(match.timestamp).getTime()) / 1000
                  ),
                },
              })
            }
          }
        }
      }

      // Use the branch ID determined by ConversationLinker
      // Do NOT override it with local detection as that can cause race conditions
      // The ConversationLinker already handles branch detection properly by:
      // 1. Excluding the current request when checking for existing children
      // 2. Maintaining consistency across the conversation linking logic
      // Previously, detectBranch() here was causing the first child to incorrectly
      // get a branch ID instead of inheriting "main" from its parent
      const branchId = request.branchId || 'main'

      const query = `
        INSERT INTO api_requests (
          request_id, train_id, account_id, timestamp, method, path, headers, body, 
          api_key_hash, model, request_type, current_message_hash, 
          parent_message_hash, conversation_id, branch_id, system_hash, message_count,
          parent_task_request_id, is_subtask, task_tool_invocation, parent_request_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
        ON CONFLICT (request_id) DO NOTHING
      `

      const values = [
        request.requestId,
        request.trainId,
        request.accountId || null,
        request.timestamp,
        request.method,
        request.path,
        JSON.stringify(sanitizedHeaders),
        JSON.stringify(request.body),
        this.hashApiKey(request.apiKey),
        request.model,
        request.requestType,
        request.currentMessageHash || null,
        request.parentMessageHash || null,
        request.conversationId || null,
        branchId,
        request.systemHash || null,
        request.messageCount || 0,
        parentTaskRequestId || null,
        isSubtask,
        request.taskToolInvocation ? JSON.stringify(request.taskToolInvocation) : null,
        request.parentRequestId || null,
      ]

      await this.pool.query(query, values)
    } catch (error) {
      logger.error('Failed to store request', {
        requestId: request.requestId,
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  /**
   * Store a response (write-only)
   */
  async storeResponse(response: StorageResponse): Promise<void> {
    try {
      const query = `
        UPDATE api_requests SET
          response_status = $2,
          response_headers = $3,
          response_body = $4,
          response_streaming = $5,
          input_tokens = $6,
          output_tokens = $7,
          total_tokens = $8,
          first_token_ms = $9,
          duration_ms = $10,
          error = $11,
          tool_call_count = $12,
          cache_creation_input_tokens = $13,
          cache_read_input_tokens = $14,
          usage_data = $15
        WHERE request_id = $1
      `

      const values = [
        response.requestId,
        response.statusCode,
        JSON.stringify(response.headers),
        response.body ? JSON.stringify(response.body) : null,
        response.streaming,
        response.inputTokens || 0,
        response.outputTokens || 0,
        response.totalTokens || 0,
        response.firstTokenMs,
        response.durationMs,
        response.error,
        response.toolCallCount || 0,
        response.cacheCreationInputTokens || 0,
        response.cacheReadInputTokens || 0,
        response.usageData ? JSON.stringify(response.usageData) : null,
      ]

      await this.pool.query(query, values)
    } catch (error) {
      logger.error('Failed to store response', {
        requestId: response.requestId,
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  /**
   * Store streaming chunks (batch operation)
   */
  async storeStreamingChunk(chunk: StreamingChunk): Promise<void> {
    this.batchQueue.push(chunk)

    if (this.batchQueue.length >= this.BATCH_SIZE) {
      await this.flushBatch()
    }
  }

  /**
   * Start batch processor for streaming chunks
   */
  private startBatchProcessor(): void {
    this.batchTimer = setInterval(async () => {
      if (this.batchQueue.length > 0) {
        await this.flushBatch()
      }
    }, this.BATCH_INTERVAL)
  }

  /**
   * Flush batch of streaming chunks
   */
  private async flushBatch(): Promise<void> {
    if (this.batchQueue.length === 0) {
      return
    }

    const chunks = [...this.batchQueue]
    this.batchQueue = []

    try {
      const values = chunks.map(chunk => [
        chunk.requestId,
        chunk.chunkIndex,
        chunk.timestamp,
        chunk.data,
        chunk.tokenCount || 0,
      ])

      // Use COPY for bulk insert
      const query = `
        INSERT INTO streaming_chunks (
          request_id, chunk_index, timestamp, data, token_count
        ) VALUES ${values
          .map(
            (_, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`
          )
          .join(', ')}
        ON CONFLICT DO NOTHING
      `

      await this.pool.query(query, values.flat())
    } catch (error) {
      logger.error('Failed to store streaming chunks batch', {
        metadata: {
          count: chunks.length,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  /**
   * Find parent requests based on criteria
   * Used by ConversationLinker
   */
  async findParentRequests(criteria: {
    trainId: string
    messageCount?: number
    parentMessageHash?: string
    currentMessageHash?: string
    systemHash?: string | null
    excludeRequestId?: string
    beforeTimestamp?: Date
    conversationId?: string
  }): Promise<
    Array<{
      request_id: string
      conversation_id: string
      branch_id: string
      current_message_hash: string
      system_hash: string | null
    }>
  > {
    try {
      const conditions: string[] = ['train_id = $1']
      const values: any[] = [criteria.trainId]
      let paramCount = 1

      if (criteria.currentMessageHash) {
        paramCount++
        conditions.push(`current_message_hash = $${paramCount}`)
        values.push(criteria.currentMessageHash)
      }

      if (criteria.parentMessageHash) {
        paramCount++
        conditions.push(`parent_message_hash = $${paramCount}`)
        values.push(criteria.parentMessageHash)
      }

      if (criteria.systemHash) {
        paramCount++
        conditions.push(`system_hash = $${paramCount}`)
        values.push(criteria.systemHash)
      }

      if (criteria.messageCount !== undefined) {
        paramCount++
        conditions.push(`message_count = $${paramCount}`)
        values.push(criteria.messageCount)
      }

      if (criteria.excludeRequestId) {
        paramCount++
        conditions.push(`request_id != $${paramCount}`)
        values.push(criteria.excludeRequestId)
      }

      if (criteria.beforeTimestamp) {
        paramCount++
        conditions.push(`timestamp < $${paramCount}`)
        values.push(criteria.beforeTimestamp)
      }

      if (criteria.conversationId) {
        paramCount++
        conditions.push(`conversation_id = $${paramCount}`)
        values.push(criteria.conversationId)
      }

      const query = `
        SELECT 
          request_id,
          conversation_id,
          branch_id,
          current_message_hash,
          system_hash
        FROM api_requests
        WHERE ${conditions.join(' AND ')}
        ORDER BY timestamp DESC
        LIMIT 100
      `

      const result = await this.pool.query(query, values)
      return result.rows
    } catch (error) {
      logger.error('Failed to find parent requests', {
        metadata: {
          criteria,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      return []
    }
  }

  /**
   * Find parent request by searching response content
   * Used for compact conversation detection
   */
  async findParentByResponseContent(
    trainId: string,
    summaryContent: string,
    afterTimestamp: Date,
    beforeTimestamp?: Date
  ): Promise<{
    request_id: string
    conversation_id: string
    branch_id: string
    current_message_hash: string
    system_hash: string | null
  } | null> {
    try {
      // Clean up the summary content for better matching
      const cleanSummary = summaryContent
        .toLocaleLowerCase()
        .replace(/^Analysis:/i, '<analysis>')
        .replace(/\n\nSummary:/i, '\n</analysis>\n\n<summary>')
        .trim()

      const query = `
        SELECT 
          request_id,
          conversation_id,
          branch_id,
          current_message_hash,
          system_hash,
          response_body
        FROM api_requests
        WHERE train_id = $1
          AND timestamp >= $2
          ${beforeTimestamp ? 'AND timestamp < $4' : ''}
          AND request_type = 'inference'
          AND response_body IS NOT NULL
          AND jsonb_typeof(response_body->'content') = 'array'
          AND (
            starts_with(LOWER(response_body->'content'->0->>'text'), $3)
          )
        ORDER BY timestamp DESC
        LIMIT 1
      `

      const params = [trainId, afterTimestamp, cleanSummary]

      if (beforeTimestamp) {
        params.push(beforeTimestamp)
      }

      const result = await this.pool.query(query, params)

      if (result.rows.length > 0) {
        logger.info('Found parent conversation by response content match', {
          metadata: {
            trainId,
            parentRequestId: result.rows[0].request_id,
            conversationId: result.rows[0].conversation_id,
          },
        })
      }

      return result.rows[0] || null
    } catch (error) {
      logger.error('Failed to find parent by response content', {
        metadata: {
          trainId,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      return null
    }
  }

  /**
   * Find conversation ID by parent message hash
   * When multiple conversations have the same parent hash, pick the one with fewer requests
   * @param parentHash - The parent message hash to search for
   * @param beforeTimestamp - Timestamp to only consider conversations before this time
   */
  async findConversationByParentHash(
    parentHash: string,
    beforeTimestamp: Date
  ): Promise<string | null> {
    try {
      // First, find all conversations that have this parent hash
      const query = `
        WITH conversation_counts AS (
          SELECT 
            r.conversation_id,
            COUNT(*) as request_count
          FROM api_requests r
          WHERE r.conversation_id IN (
            SELECT DISTINCT conversation_id 
            FROM api_requests 
            WHERE current_message_hash = $1 
            AND conversation_id IS NOT NULL
            AND timestamp < $2
          )
          AND r.timestamp < $2
          GROUP BY r.conversation_id
        )
        SELECT 
          ar.conversation_id
        FROM api_requests ar
        JOIN conversation_counts cc ON ar.conversation_id = cc.conversation_id
        WHERE ar.current_message_hash = $1 
        AND ar.conversation_id IS NOT NULL
        AND ar.timestamp < $2
        ORDER BY cc.request_count ASC, ar.timestamp DESC
        LIMIT 1
      `

      const result = await this.pool.query(query, [parentHash, beforeTimestamp])

      // Log if we're choosing between multiple conversations
      if (result.rows.length > 0) {
        // Check how many conversations actually have this parent hash
        const countResult = await this.pool.query(
          `SELECT COUNT(DISTINCT conversation_id) as count 
           FROM api_requests 
           WHERE current_message_hash = $1 
           AND conversation_id IS NOT NULL`,
          [parentHash]
        )

        if (countResult.rows[0].count > 1) {
          logger.info(
            'Multiple conversations found with same parent hash, selecting the one with fewer requests',
            {
              metadata: {
                parentHash,
                conversationCount: countResult.rows[0].count,
                selectedConversation: result.rows[0].conversation_id,
              },
            }
          )
        }
      }

      return result.rows[0]?.conversation_id || null
    } catch (error) {
      logger.error('Failed to find conversation by parent hash', {
        metadata: {
          parentHash,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      return null
    }
  }

  /**
   * Hash API key for storage
   */
  private hashApiKey(apiKey: string): string {
    if (!apiKey) {
      return ''
    }
    // Use SHA-256 with a salt for secure hashing
    const salt = process.env.API_KEY_SALT || 'agent-prompttrain-proxy-default-salt'
    return createHash('sha256')
      .update(apiKey + salt)
      .digest('hex')
  }

  /**
   * Mask sensitive headers
   */
  private maskSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
    const masked = { ...headers }
    const sensitiveHeaders = ['authorization', 'x-api-key']

    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase()
      if (sensitiveHeaders.includes(lowerKey) && typeof value === 'string') {
        if (value.length > 6) {
          // Show only last 6 characters
          masked[key] = '*'.repeat(Math.max(0, value.length - 6)) + value.slice(-6)
        } else {
          // For short values, mask entirely
          masked[key] = '***'
        }
      }
    }

    return masked
  }

  /**
   * Find Task tool invocations in a response
   */
  findTaskToolInvocations(responseBody: any): Array<{ id: string; name: string; input: any }> {
    const taskInvocations: Array<{ id: string; name: string; input: any }> = []

    if (!responseBody || !responseBody.content || !Array.isArray(responseBody.content)) {
      return taskInvocations
    }

    for (const content of responseBody.content) {
      if (content.type === 'tool_use' && content.name === 'Task') {
        taskInvocations.push({
          id: content.id,
          name: content.name,
          input: content.input,
        })
      }
    }

    return taskInvocations
  }

  /**
   * Mark requests that have Task tool invocations
   */
  async markTaskToolInvocations(requestId: string, taskInvocations: any[]): Promise<void> {
    if (taskInvocations.length === 0) {
      return
    }

    try {
      // Store task invocations in a separate tracking table or update the request
      const query = `
        UPDATE api_requests 
        SET task_tool_invocation = $2
        WHERE request_id = $1
      `

      await this.pool.query(query, [requestId, JSON.stringify(taskInvocations)])

      logger.info('Marked request with Task tool invocations', {
        requestId,
        metadata: {
          taskCount: taskInvocations.length,
        },
      })
    } catch (error) {
      logger.error('Failed to mark task tool invocations', {
        requestId,
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  /**
   * Extract user message content from various message formats
   */
  private extractUserMessageContent(message: any): string | null {
    if (!message || message.role !== 'user') {
      return null
    }

    // Handle string content
    if (typeof message.content === 'string') {
      return message.content
    }

    // Handle array content
    if (Array.isArray(message.content)) {
      // Look for text content in the array, skipping system reminders
      for (const item of message.content) {
        if (item.type === 'text' && item.text) {
          // Skip system reminder messages
          if (item.text.includes('<system-reminder>')) {
            continue
          }
          return item.text
        }
      }

      // If all text items were system reminders, return the first text item
      for (const item of message.content) {
        if (item.type === 'text' && item.text) {
          return item.text
        }
      }
    }

    return null
  }

  /**
   * Find a matching Task invocation in the last 60 seconds
   */
  async findMatchingTaskInvocation(
    userContent: string,
    timestamp: Date
  ): Promise<{ request_id: string; timestamp: Date } | null> {
    try {
      // Looking for matching Task invocation

      // Look for Task invocations in the last 30 seconds
      // Using 30-second window to match migration script for consistency
      const query = `
        SELECT request_id, timestamp
        FROM api_requests
        WHERE task_tool_invocation IS NOT NULL
        AND timestamp >= $1::timestamp - interval '12 hours'
        AND timestamp < $1::timestamp
        AND jsonb_path_exists(
          task_tool_invocation,
          '$[*] ? (@.input.prompt == $prompt || @.input.description == $prompt)',
          jsonb_build_object('prompt', $2::text)
        )
        ORDER BY timestamp DESC
        LIMIT 1
      `

      const result = await this.pool.query(query, [
        timestamp.toISOString(),
        userContent.replace(/\\n/g, '\n'),
      ])

      if (result.rows.length > 0) {
        // Found matching Task invocation
        return result.rows[0]
      }

      // No matching Task invocation found

      return null
    } catch (error) {
      logger.error('Failed to find matching task invocation', {
        metadata: {
          error: error instanceof Error ? error.message : String(error),
          query: error instanceof Error && 'message' in error ? error.message : undefined,
        },
      })
      return null
    }
  }

  /**
   * Get request details for linking
   */
  async getRequestDetails(requestId: string): Promise<{
    request_id: string
    conversation_id: string
    branch_id: string
    current_message_hash?: string
    system_hash?: string
  } | null> {
    try {
      const query = `
        SELECT request_id, conversation_id, branch_id, current_message_hash, system_hash
        FROM api_requests
        WHERE request_id = $1
        LIMIT 1
      `

      const result = await this.pool.query(query, [requestId])

      if (result.rows.length > 0) {
        return result.rows[0]
      }

      return null
    } catch (error) {
      logger.error('Failed to get request details', {
        metadata: {
          requestId,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      return null
    }
  }

  /**
   * Get the maximum subtask sequence number for a conversation
   * @param conversationId - The conversation ID to search for
   * @param beforeTimestamp - Timestamp to only consider subtasks before this time
   */
  async getMaxSubtaskSequence(conversationId: string, beforeTimestamp: Date): Promise<number> {
    const query = `
      SELECT COALESCE(
        MAX(CAST(SUBSTRING(branch_id FROM 'subtask_(\\d+)') AS INTEGER)), 
        0
      ) as max_sequence
      FROM api_requests 
      WHERE conversation_id = $1 
        AND branch_id LIKE 'subtask_%'
        AND timestamp < $2
    `

    const result = await this.pool.query(query, [conversationId, beforeTimestamp])
    return result.rows[0]?.max_sequence || 0
  }

  /**
   * Cleanup
   */
  async cleanup(): Promise<void> {
    if (this.batchTimer) {
      clearInterval(this.batchTimer)
    }
    await this.flushBatch()
  }
}

/**
 * Initialize database schema
 */
export async function initializeDatabase(pool: Pool): Promise<void> {
  try {
    // Check if tables exist
    const result = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'api_requests'
      )
    `)

    if (!result.rows[0].exists) {
      logger.info('Database tables not found, creating schema...')

      // Read and execute the init-database.sql file
      // In production, the working directory should be the project root
      // In development, we might be running from various locations
      const possiblePaths = [
        join(process.cwd(), 'scripts', 'init-database.sql'),
        join(process.cwd(), '..', '..', 'scripts', 'init-database.sql'), // If running from services/proxy
        join(__dirname, '..', '..', '..', '..', 'scripts', 'init-database.sql'), // Relative to this file
      ]

      let sqlContent: string | null = null
      let foundPath: string | null = null

      for (const sqlPath of possiblePaths) {
        try {
          sqlContent = readFileSync(sqlPath, 'utf-8')
          foundPath = sqlPath
          break
        } catch {
          // Continue to next path
        }
      }

      if (!sqlContent || !foundPath) {
        logger.error('Database initialization SQL file not found', {
          metadata: {
            triedPaths: possiblePaths,
            cwd: process.cwd(),
            dirname: __dirname,
          },
        })

        throw new Error(
          'Could not find init-database.sql file. Tried paths: ' + possiblePaths.join(', ')
        )
      }

      logger.info('Using init-database.sql from', { path: foundPath })

      // Execute the SQL file
      await pool.query(sqlContent)

      logger.info('Database schema created successfully')
    } else {
      // Verify all required tables exist
      const requiredTables = ['api_requests', 'streaming_chunks']
      const tableCheck = await pool.query(
        `
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = ANY($1)
      `,
        [requiredTables]
      )

      const foundTables = tableCheck.rows.map(row => row.table_name)
      const missingTables = requiredTables.filter(table => !foundTables.includes(table))

      if (missingTables.length > 0) {
        logger.error('Missing required database tables', {
          metadata: { missingTables },
        })
        throw new Error(
          `Missing required tables: ${missingTables.join(', ')}. Please run database migrations.`
        )
      }

      logger.info('Database schema verified successfully')
    }
  } catch (error) {
    logger.error('Failed to initialize database', {
      metadata: { error: error instanceof Error ? error.message : String(error) },
    })
    throw error
  }
}
