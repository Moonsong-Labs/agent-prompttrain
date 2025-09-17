import { Hono } from 'hono'
import { z } from 'zod'
import { Pool } from 'pg'
import { logger } from '../middleware/logger.js'
import { getErrorMessage, getErrorStack } from '@agent-prompttrain/shared'
import { container } from '../container.js'

// Query parameter schemas
const statsQuerySchema = z.object({
  trainId: z.string().optional(),
  since: z.string().datetime().optional(),
})

const requestsQuerySchema = z.object({
  trainId: z.string().optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).default('100'),
  offset: z.string().regex(/^\d+$/).transform(Number).default('0'),
})

const conversationsQuerySchema = z.object({
  trainId: z.string().optional(),
  accountId: z.string().optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).default('50'),
  offset: z.string().regex(/^\d+$/).transform(Number).default('0'),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
})

// Response types
interface StatsResponse {
  totalRequests: number
  totalTokens: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheCreationTokens: number
  totalCacheReadTokens: number
  averageResponseTime: number
  errorCount: number
  activeTrains: number
  requestsByModel: Record<string, number>
  requestsByType: Record<string, number>
}

interface RequestSummary {
  requestId: string
  trainId: string
  model: string
  timestamp: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  durationMs: number
  responseStatus: number
  error?: string
  requestType?: string
}

interface RequestDetails extends RequestSummary {
  requestBody: any
  responseBody: any
  usageData?: any
  streamingChunks: Array<{
    chunkIndex: number
    timestamp: string
    data: string
    tokenCount: number
  }>
  conversationId?: string
  branchId?: string
  parentRequestId?: string
}

export const apiRoutes = new Hono<{
  Variables: {
    pool?: Pool
  }
}>()

/**
 * GET /api/stats - Get aggregated statistics
 */
apiRoutes.get('/stats', async c => {
  let pool = c.get('pool')

  // Fallback: try to get pool from container if not in context
  if (!pool) {
    const { container } = await import('../container.js')
    pool = container.getDbPool()

    if (!pool) {
      logger.warn('API stats requested but pool is not available', {
        metadata: {
          hasPool: !!pool,
          poolType: typeof pool,
          path: c.req.path,
        },
      })
      return c.json({ error: 'Database not configured' }, 503)
    }
  }

  try {
    const query = c.req.query()
    const params = statsQuerySchema.parse(query)

    const conditions = []
    const values = []
    let paramCount = 0

    if (params.trainId) {
      conditions.push(`train_id = $${++paramCount}`)
      values.push(params.trainId)
    }

    if (params.since) {
      conditions.push(`timestamp > $${++paramCount}`)
      values.push(params.since)
    } else {
      // Default to last 24 hours
      conditions.push(`timestamp > NOW() - INTERVAL '24 hours'`)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // Get base statistics
    const statsQuery = `
      SELECT
        COUNT(*) as total_requests,
        COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) as total_tokens,
        COALESCE(SUM(input_tokens), 0) as total_input_tokens,
        COALESCE(SUM(output_tokens), 0) as total_output_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) as total_cache_creation_tokens,
        COALESCE(SUM(cache_read_input_tokens), 0) as total_cache_read_tokens,
        COALESCE(AVG(duration_ms), 0) as avg_response_time,
        COUNT(*) FILTER (WHERE error IS NOT NULL) as error_count,
        COUNT(DISTINCT train_id) as active_trains
      FROM api_requests
      ${whereClause}
    `

    const statsResult = await pool.query(statsQuery, values)
    const stats = statsResult.rows[0]

    // Get model breakdown
    const modelQuery = `
      SELECT model, COUNT(*) as count
      FROM api_requests
      ${whereClause}
      GROUP BY model
      ORDER BY count DESC
    `
    const modelResult = await pool.query(modelQuery, values)
    const requestsByModel = Object.fromEntries(
      modelResult.rows.map(row => [row.model, parseInt(row.count)])
    )

    // Get request type breakdown
    const typeQuery = `
      SELECT request_type, COUNT(*) as count
      FROM api_requests
      ${whereClause}
      ${whereClause ? ' AND' : ' WHERE'} request_type IS NOT NULL
      GROUP BY request_type
      ORDER BY count DESC
    `
    const typeResult = await pool.query(typeQuery, values)
    const requestsByType = Object.fromEntries(
      typeResult.rows.map(row => [row.request_type, parseInt(row.count)])
    )

    const response: StatsResponse = {
      totalRequests: parseInt(stats.total_requests) || 0,
      totalTokens: parseInt(stats.total_tokens) || 0,
      totalInputTokens: parseInt(stats.total_input_tokens) || 0,
      totalOutputTokens: parseInt(stats.total_output_tokens) || 0,
      totalCacheCreationTokens: parseInt(stats.total_cache_creation_tokens) || 0,
      totalCacheReadTokens: parseInt(stats.total_cache_read_tokens) || 0,
      averageResponseTime: parseFloat(stats.avg_response_time) || 0,
      errorCount: parseInt(stats.error_count) || 0,
      activeTrains: parseInt(stats.active_trains) || 0,
      requestsByModel,
      requestsByType,
    }

    return c.json(response)
  } catch (error) {
    logger.error('Failed to get stats', { error: getErrorMessage(error) })
    return c.json({ error: 'Failed to retrieve statistics' }, 500)
  }
})

/**
 * GET /api/dashboard/stats - Get aggregated dashboard statistics
 * Optimized endpoint for dashboard overview page
 */
apiRoutes.get('/dashboard/stats', async c => {
  let pool = c.get('pool')

  if (!pool) {
    const { container } = await import('../container.js')
    pool = container.getDbPool()

    if (!pool) {
      return c.json({ error: 'Database not configured' }, 503)
    }
  }

  try {
    const query = c.req.query()
    const trainId = query.trainId
    const accountId = query.accountId

    const conditions: string[] = []
    const values: any[] = []
    let paramCount = 0

    if (trainId) {
      conditions.push(`train_id = $${++paramCount}`)
      values.push(trainId)
    }

    if (accountId) {
      conditions.push(`account_id = $${++paramCount}`)
      values.push(accountId)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // Single optimized query to get all dashboard statistics
    const statsQuery = `
      WITH conversation_stats AS (
        SELECT 
          COUNT(DISTINCT conversation_id) as total_conversations,
          COUNT(DISTINCT account_id) as active_users,
          COUNT(*) as total_requests,
          SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) as total_tokens,
          COUNT(DISTINCT branch_id) as total_branches,
          COUNT(DISTINCT branch_id) FILTER (WHERE branch_id LIKE 'subtask_%') as subtask_branches,
          COUNT(DISTINCT branch_id) FILTER (WHERE branch_id LIKE 'compact_%') as compact_branches,
          COUNT(DISTINCT model) as models_used_count,
          ARRAY_AGG(DISTINCT model) FILTER (WHERE model IS NOT NULL) as models_used
        FROM api_requests
        ${whereClause}
        ${whereClause ? 'AND' : 'WHERE'} conversation_id IS NOT NULL
      ),
      recent_activity AS (
        SELECT 
          COUNT(*) as requests_last_24h,
          COUNT(DISTINCT conversation_id) as conversations_last_24h,
          COUNT(DISTINCT account_id) as active_users_last_24h
        FROM api_requests
        ${whereClause}
        ${whereClause ? 'AND' : 'WHERE'} timestamp > NOW() - INTERVAL '24 hours'
        AND conversation_id IS NOT NULL
      ),
      hourly_activity AS (
        SELECT 
          date_trunc('hour', timestamp) as hour,
          COUNT(*) as request_count,
          SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) as token_count
        FROM api_requests
        ${whereClause}
        ${whereClause ? 'AND' : 'WHERE'} timestamp > NOW() - INTERVAL '24 hours'
        AND conversation_id IS NOT NULL
        GROUP BY date_trunc('hour', timestamp)
        ORDER BY hour DESC
        LIMIT 24
      )
      SELECT 
        cs.*,
        ra.requests_last_24h,
        ra.conversations_last_24h,
        ra.active_users_last_24h,
        COALESCE(json_agg(
          json_build_object(
            'hour', ha.hour,
            'requestCount', ha.request_count,
            'tokenCount', ha.token_count
          ) ORDER BY ha.hour DESC
        ) FILTER (WHERE ha.hour IS NOT NULL), '[]'::json) as hourly_activity
      FROM conversation_stats cs
      CROSS JOIN recent_activity ra
      LEFT JOIN hourly_activity ha ON true
      GROUP BY 
        cs.total_conversations,
        cs.active_users,
        cs.total_requests,
        cs.total_tokens,
        cs.total_branches,
        cs.subtask_branches,
        cs.compact_branches,
        cs.models_used_count,
        cs.models_used,
        ra.requests_last_24h,
        ra.conversations_last_24h,
        ra.active_users_last_24h
    `

    const result = await pool.query(statsQuery, values)
    const stats = result.rows[0] || {
      total_conversations: 0,
      active_users: 0,
      total_requests: 0,
      total_tokens: 0,
      total_branches: 0,
      subtask_branches: 0,
      compact_branches: 0,
      models_used_count: 0,
      models_used: [],
      requests_last_24h: 0,
      conversations_last_24h: 0,
      active_users_last_24h: 0,
      hourly_activity: [],
    }

    return c.json({
      totalConversations: parseInt(stats.total_conversations),
      activeUsers: parseInt(stats.active_users),
      totalRequests: parseInt(stats.total_requests),
      totalTokens: parseInt(stats.total_tokens),
      totalBranches: parseInt(stats.total_branches),
      subtaskBranches: parseInt(stats.subtask_branches),
      compactBranches: parseInt(stats.compact_branches),
      modelsUsed: stats.models_used || [],
      modelsUsedCount: parseInt(stats.models_used_count),
      last24Hours: {
        requests: parseInt(stats.requests_last_24h),
        conversations: parseInt(stats.conversations_last_24h),
        activeUsers: parseInt(stats.active_users_last_24h),
      },
      hourlyActivity: stats.hourly_activity || [],
    })
  } catch (error) {
    logger.error('Failed to get dashboard stats', { error: getErrorMessage(error) })
    return c.json({ error: 'Failed to retrieve dashboard statistics' }, 500)
  }
})

/**
 * GET /api/requests - Get recent requests
 */
apiRoutes.get('/requests', async c => {
  let pool = c.get('pool')

  // Fallback: try to get pool from container if not in context
  if (!pool) {
    const { container } = await import('../container.js')
    pool = container.getDbPool()

    if (!pool) {
      return c.json({ error: 'Database not configured' }, 503)
    }
  }

  try {
    const query = c.req.query()
    const params = requestsQuerySchema.parse(query)

    const conditions = []
    const values = []
    let paramCount = 0

    if (params.trainId) {
      conditions.push(`train_id = $${++paramCount}`)
      values.push(params.trainId)
    }

    // Add limit and offset
    values.push(params.limit)
    values.push(params.offset)

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const requestsQuery = `
      SELECT 
        request_id,
        train_id,
        model,
        timestamp,
        COALESCE(input_tokens, 0) as input_tokens,
        COALESCE(output_tokens, 0) as output_tokens,
        COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) as total_tokens,
        COALESCE(duration_ms, 0) as duration_ms,
        COALESCE(response_status, 0) as response_status,
        error,
        request_type
      FROM api_requests
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT $${values.length - 1}
      OFFSET $${values.length}
    `

    const result = await pool.query(requestsQuery, values)

    const requests: RequestSummary[] = result.rows.map(row => ({
      requestId: row.request_id,
      trainId: row.train_id,
      model: row.model,
      timestamp: row.timestamp,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
      durationMs: row.duration_ms,
      responseStatus: row.response_status,
      error: row.error,
      requestType: row.request_type,
    }))

    // Get total count for pagination
    const countQuery = `
      SELECT COUNT(*) as total
      FROM api_requests
      ${whereClause}
    `
    const countResult = await pool.query(countQuery, values.slice(0, -2)) // Exclude limit/offset
    const totalCount = parseInt(countResult.rows[0].total) || 0

    return c.json({
      requests,
      pagination: {
        total: totalCount,
        limit: params.limit,
        offset: params.offset,
        hasMore: params.offset + params.limit < totalCount,
      },
    })
  } catch (error) {
    logger.error('Failed to get requests', { error: getErrorMessage(error) })
    return c.json({ error: 'Failed to retrieve requests' }, 500)
  }
})

/**
 * GET /api/requests/:id - Get request details
 */
apiRoutes.get('/requests/:id', async c => {
  let pool = c.get('pool')

  // Fallback: try to get pool from container if not in context
  if (!pool) {
    const { container } = await import('../container.js')
    pool = container.getDbPool()

    if (!pool) {
      return c.json({ error: 'Database not configured' }, 503)
    }
  }

  const requestId = c.req.param('id')

  try {
    // Get request details
    const requestQuery = `
      SELECT 
        request_id,
        train_id,
        model,
        timestamp,
        COALESCE(input_tokens, 0) as input_tokens,
        COALESCE(output_tokens, 0) as output_tokens,
        COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) as total_tokens,
        COALESCE(duration_ms, 0) as duration_ms,
        COALESCE(response_status, 0) as response_status,
        error,
        request_type,
        conversation_id,
        branch_id,
        parent_request_id,
        body as request_body,
        response_body,
        usage_data
      FROM api_requests 
      WHERE request_id = $1
    `
    const requestResult = await pool.query(requestQuery, [requestId])

    if (requestResult.rows.length === 0) {
      return c.json({ error: 'Request not found' }, 404)
    }

    const row = requestResult.rows[0]

    // Get streaming chunks if any
    const chunksQuery = `
      SELECT chunk_index, timestamp, data
      FROM streaming_chunks 
      WHERE request_id = $1 
      ORDER BY chunk_index
    `
    const chunksResult = await pool.query(chunksQuery, [requestId])

    const details: RequestDetails = {
      requestId: row.request_id,
      trainId: row.train_id,
      model: row.model,
      timestamp: row.timestamp,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
      durationMs: row.duration_ms,
      responseStatus: row.response_status,
      error: row.error,
      requestType: row.request_type,
      conversationId: row.conversation_id,
      branchId: row.branch_id,
      parentRequestId: row.parent_request_id,
      requestBody: row.request_body,
      responseBody: row.response_body,
      usageData: row.usage_data,
      streamingChunks: chunksResult.rows.map(chunk => ({
        chunkIndex: chunk.chunk_index,
        timestamp: chunk.timestamp,
        data: chunk.data,
        tokenCount: 0, // token_count not in schema
      })),
    }

    return c.json(details)
  } catch (error) {
    logger.error('Failed to get request details', {
      error: getErrorMessage(error),
      stack: getErrorStack(error),
      requestId,
    })
    return c.json(
      {
        error: 'Failed to retrieve request details',
        details: getErrorMessage(error),
      },
      500
    )
  }
})

/**
 * GET /api/train-ids - Get list of active train identifiers
 */
apiRoutes.get('/train-ids', async c => {
  let pool = c.get('pool')

  // Fallback: try to get pool from container if not in context
  if (!pool) {
    const { container } = await import('../container.js')
    pool = container.getDbPool()

    if (!pool) {
      // Return empty list when database is not configured
      logger.debug('Train IDs API called but database not configured')
      return c.json({ trainIds: [] })
    }
  }

  try {
    const query = `
      SELECT DISTINCT train_id, COUNT(*) as request_count
      FROM api_requests
      WHERE timestamp > NOW() - INTERVAL '7 days'
      GROUP BY train_id
      ORDER BY request_count DESC
    `

    const result = await pool.query(query)
    const trainIds = result.rows.map(row => ({
      trainId: row.train_id,
      requestCount: parseInt(row.request_count),
    }))

    return c.json({ trainIds })
  } catch (error) {
    logger.error('Failed to get train IDs', { error: getErrorMessage(error) })
    return c.json({ error: 'Failed to retrieve train IDs' }, 500)
  }
})

/**
 * GET /api/conversations - Get conversations with account information
 */
apiRoutes.get('/conversations', async c => {
  let pool = c.get('pool')

  if (!pool) {
    const { container } = await import('../container.js')
    pool = container.getDbPool()

    if (!pool) {
      return c.json({ error: 'Database not configured' }, 503)
    }
  }

  try {
    const query = c.req.query()
    const params = conversationsQuerySchema.parse(query)

    const conditions: string[] = []
    const values: any[] = []
    let paramCount = 0

    if (params.trainId) {
      conditions.push(`train_id = $${++paramCount}`)
      values.push(params.trainId)
    }

    if (params.accountId) {
      conditions.push(`account_id = $${++paramCount}`)
      values.push(params.accountId)
    }

    if (params.dateFrom) {
      conditions.push(`timestamp >= $${++paramCount}`)
      values.push(params.dateFrom)
    }

    if (params.dateTo) {
      conditions.push(`timestamp <= $${++paramCount}`)
      values.push(params.dateTo)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // Get conversations grouped by conversation_id with account info and subtask status
    // Optimized query using "limit first, aggregate second" approach
    const conversationsQuery = `
      -- STEP 1: Get only the conversation IDs we need for this page
      WITH paginated_conversations AS (
        SELECT DISTINCT 
          conversation_id,
          MAX(timestamp) as last_message_time
        FROM api_requests
        ${whereClause}
        ${whereClause ? 'AND' : 'WHERE'} conversation_id IS NOT NULL
        GROUP BY conversation_id
        ORDER BY last_message_time DESC
        LIMIT $${++paramCount}
        OFFSET $${++paramCount}
      ),
      -- STEP 2: Get all request data ONLY for those paginated conversations
      relevant_requests AS (
        SELECT 
          r.request_id,
          r.conversation_id,
          r.train_id,
          r.account_id,
          r.timestamp,
          r.input_tokens,
          r.output_tokens,
          r.branch_id,
          r.model,
          r.is_subtask,
          r.parent_task_request_id,
          r.response_body,
          ROW_NUMBER() OVER (PARTITION BY r.conversation_id ORDER BY r.timestamp DESC, r.request_id DESC) as rn,
          ROW_NUMBER() OVER (PARTITION BY r.conversation_id, r.is_subtask ORDER BY r.timestamp ASC, r.request_id ASC) as subtask_rn
        FROM api_requests r
        INNER JOIN paginated_conversations pc ON r.conversation_id = pc.conversation_id
      ),
      -- STEP 3: Aggregate data only for the paginated conversations
      conversation_summary AS (
        SELECT 
          conversation_id,
          train_id,
          account_id,
          MIN(timestamp) as first_message_time,
          MAX(timestamp) as last_message_time,
          COUNT(*) as message_count,
          SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) as total_tokens,
          COUNT(DISTINCT branch_id) as branch_count,
          -- Add branch type counts for the new feature
          COUNT(DISTINCT branch_id) FILTER (WHERE branch_id LIKE 'subtask_%') as subtask_branch_count,
          COUNT(DISTINCT branch_id) FILTER (WHERE branch_id LIKE 'compact_%') as compact_branch_count,
          COUNT(DISTINCT branch_id) FILTER (WHERE branch_id IS NOT NULL AND branch_id NOT LIKE 'subtask_%' AND branch_id NOT LIKE 'compact_%' AND branch_id != 'main') as user_branch_count,
          ARRAY_AGG(DISTINCT model) FILTER (WHERE model IS NOT NULL) as models_used,
          (array_agg(request_id ORDER BY rn) FILTER (WHERE rn = 1))[1] as latest_request_id,
          (array_agg(model ORDER BY rn) FILTER (WHERE rn = 1))[1] as latest_model,
          (array_agg(response_body ORDER BY rn) FILTER (WHERE rn = 1))[1] as latest_response_body,
          BOOL_OR(is_subtask) as is_subtask,
          -- Get the parent_task_request_id from the first subtask in the conversation
          (array_agg(parent_task_request_id ORDER BY subtask_rn) FILTER (WHERE is_subtask = true AND subtask_rn = 1))[1] as parent_task_request_id,
          COUNT(CASE WHEN is_subtask THEN 1 END) as subtask_message_count
        FROM relevant_requests
        GROUP BY conversation_id, train_id, account_id
      )
      -- STEP 4: Final select with parent conversation lookup and preserve order
      SELECT 
        cs.*,
        parent_req.conversation_id as parent_conversation_id
      FROM conversation_summary cs
      LEFT JOIN api_requests parent_req ON cs.parent_task_request_id = parent_req.request_id
      -- Join with paginated_conversations to preserve the original sort order
      INNER JOIN paginated_conversations pc ON cs.conversation_id = pc.conversation_id
      ORDER BY pc.last_message_time DESC
    `

    values.push(params.limit)
    values.push(params.offset)

    // Get total count for pagination
    const countQuery = `
      SELECT COUNT(DISTINCT conversation_id) as total
      FROM api_requests
      ${whereClause}
      ${whereClause ? 'AND' : 'WHERE'} conversation_id IS NOT NULL
    `

    // Execute both queries in parallel
    const [conversationsResult, countResult] = await Promise.all([
      pool.query(conversationsQuery, values),
      pool.query(countQuery, values.slice(0, values.length - 2)), // Don't include limit/offset in count query
    ])

    const totalCount = parseInt(countResult.rows[0]?.total || 0)
    const hasMore = params.offset + params.limit < totalCount

    const conversations = conversationsResult.rows.map(row => {
      // Calculate context tokens from the latest response
      let latestContextTokens = 0
      if (row.latest_response_body?.usage) {
        const usage = row.latest_response_body.usage
        latestContextTokens =
          (usage.input_tokens || 0) +
          (usage.cache_read_input_tokens || 0) +
          (usage.cache_creation_input_tokens || 0)
      }

      return {
        conversationId: row.conversation_id,
        trainId: row.train_id,
        accountId: row.account_id,
        firstMessageTime: row.first_message_time,
        lastMessageTime: row.last_message_time,
        messageCount: parseInt(row.message_count),
        totalTokens: parseInt(row.total_tokens),
        branchCount: parseInt(row.branch_count),
        // Add new branch type counts
        subtaskBranchCount: parseInt(row.subtask_branch_count || 0),
        compactBranchCount: parseInt(row.compact_branch_count || 0),
        userBranchCount: parseInt(row.user_branch_count || 0),
        modelsUsed: row.models_used,
        latestRequestId: row.latest_request_id,
        latestModel: row.latest_model,
        latestContextTokens,
        isSubtask: row.is_subtask,
        parentTaskRequestId: row.parent_task_request_id,
        parentConversationId: row.parent_conversation_id,
        subtaskMessageCount: parseInt(row.subtask_message_count || 0),
      }
    })

    return c.json({
      conversations,
      pagination: {
        total: totalCount,
        limit: params.limit,
        offset: params.offset,
        hasMore,
        page: Math.floor(params.offset / params.limit) + 1,
        totalPages: Math.ceil(totalCount / params.limit),
      },
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Invalid parameters', details: error.errors }, 400)
    }
    logger.error('Failed to get conversations', { error: getErrorMessage(error) })
    return c.json({ error: 'Failed to retrieve conversations' }, 500)
  }
})

// Token usage query schemas
const tokenUsageWindowSchema = z.object({
  accountId: z.string(),
  trainId: z.string().optional(),
  model: z.string().optional(),
  window: z.string().regex(/^\d+$/).transform(Number).default('300'), // Default 5 hours (300 minutes)
})

const tokenUsageDailySchema = z.object({
  accountId: z.string(),
  trainId: z.string().optional(),
  days: z.string().regex(/^\d+$/).transform(Number).default('30'),
  aggregate: z
    .string()
    .transform(v => v === 'true')
    .default('false'),
})

/**
 * GET /api/token-usage/current - Get current window token usage
 */
apiRoutes.get('/token-usage/current', async c => {
  const tokenUsageService = container.getTokenUsageService()

  if (!tokenUsageService) {
    return c.json({ error: 'Token usage tracking not configured' }, 503)
  }

  try {
    const query = c.req.query()
    const params = tokenUsageWindowSchema.parse(query)

    const windowHours = params.window / 60 // Convert minutes to hours
    const usage = await tokenUsageService.getUsageWindow(
      params.accountId,
      windowHours,
      params.trainId,
      params.model
    )

    return c.json(usage)
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Invalid parameters', details: error.errors }, 400)
    }
    logger.error('Failed to get token usage window', { error: getErrorMessage(error) })
    return c.json({ error: 'Failed to retrieve token usage' }, 500)
  }
})

/**
 * GET /api/token-usage/daily - Get daily token usage
 */
apiRoutes.get('/token-usage/daily', async c => {
  const tokenUsageService = container.getTokenUsageService()

  if (!tokenUsageService) {
    return c.json({ error: 'Token usage tracking not configured' }, 503)
  }

  try {
    const query = c.req.query()
    const params = tokenUsageDailySchema.parse(query)

  const usage = params.aggregate
    ? await tokenUsageService.getAggregatedDailyUsage(
        params.accountId,
        params.days,
        params.trainId
      )
      : await tokenUsageService.getDailyUsage(params.accountId, params.days, params.trainId)

    return c.json({ usage })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Invalid parameters', details: error.errors }, 400)
    }
    logger.error('Failed to get daily token usage', { error: getErrorMessage(error) })
    return c.json({ error: 'Failed to retrieve daily usage' }, 500)
  }
})

/**
 * GET /api/token-usage/time-series - Get token usage time series with 5-minute granularity
 */
apiRoutes.get('/token-usage/time-series', async c => {
  const tokenUsageService = container.getTokenUsageService()

  if (!tokenUsageService) {
    return c.json({ error: 'Token usage tracking not configured' }, 503)
  }

  try {
    const query = c.req.query()
    const accountId = query.accountId
    const windowHours = parseInt(query.window || '5')
    const intervalMinutes = parseInt(query.interval || '5')

    if (!accountId) {
      return c.json({ error: 'accountId is required' }, 400)
    }

    let pool = c.get('pool')
    if (!pool) {
      pool = container.getDbPool()
      if (!pool) {
        return c.json({ error: 'Database not configured' }, 503)
      }
    }

    // Get time series data with specified interval
    const timeSeriesQuery = `
      WITH time_buckets AS (
        SELECT 
          generate_series(
            NOW() - ($2 * INTERVAL '1 hour'),
            NOW(),
            $3 * INTERVAL '1 minute'
          ) AS bucket_time
      )
      SELECT 
        tb.bucket_time,
        (
          SELECT COALESCE(SUM(output_tokens), 0)
          FROM api_requests
          WHERE account_id = $1
            AND timestamp > tb.bucket_time - ($2 * INTERVAL '1 hour')
            AND timestamp <= tb.bucket_time
        ) AS cumulative_output_tokens
      FROM time_buckets tb
      ORDER BY tb.bucket_time ASC
    `

    const result = await pool.query(timeSeriesQuery, [accountId, windowHours, intervalMinutes])

    // Calculate tokens remaining from limit
    const tokenLimit = 140000 // 5-hour limit

    const timeSeries = result.rows.map(row => {
      const cumulativeUsage = parseInt(row.cumulative_output_tokens) || 0
      const remaining = tokenLimit - cumulativeUsage

      return {
        time: row.bucket_time,
        outputTokens: cumulativeUsage,
        cumulativeUsage,
        remaining: Math.max(0, remaining),
        percentageUsed: (cumulativeUsage / tokenLimit) * 100,
      }
    })

    return c.json({
      accountId,
      windowHours,
      intervalMinutes,
      tokenLimit,
      timeSeries,
    })
  } catch (error) {
    logger.error('Failed to get token usage time series', { error: getErrorMessage(error) })
    return c.json({ error: 'Failed to retrieve time series data' }, 500)
  }
})

/**
 * GET /api/token-usage/accounts - Get all accounts with their current token usage
 */
apiRoutes.get('/token-usage/accounts', async c => {
  let pool = c.get('pool')

  if (!pool) {
    pool = container.getDbPool()
    if (!pool) {
      return c.json({ error: 'Database not configured' }, 503)
    }
  }

  try {
    // Get all accounts with usage in the last 5 hours
    const accountsQuery = `
      WITH account_usage AS (
        SELECT 
          account_id,
          SUM(output_tokens) as total_output_tokens,
          SUM(input_tokens) as total_input_tokens,
          COUNT(*) as request_count,
          MAX(timestamp) as last_request_time
        FROM api_requests
        WHERE account_id IS NOT NULL
          AND timestamp >= NOW() - INTERVAL '5 hours'
        GROUP BY account_id
      ),
      train_usage AS (
        SELECT 
          account_id,
          train_id,
          SUM(output_tokens) as train_output_tokens,
          COUNT(*) as train_requests
        FROM api_requests
        WHERE account_id IS NOT NULL
          AND timestamp >= NOW() - INTERVAL '5 hours'
        GROUP BY account_id, train_id
      )
      SELECT 
        au.account_id,
        au.total_output_tokens,
        au.total_input_tokens,
        au.request_count,
        au.last_request_time,
        COALESCE(
          json_agg(
            json_build_object(
              'trainId', tu.train_id,
              'outputTokens', tu.train_output_tokens,
              'requests', tu.train_requests
            ) ORDER BY tu.train_output_tokens DESC
          ) FILTER (WHERE tu.train_id IS NOT NULL),
          '[]'::json
        ) as train_ids
      FROM account_usage au
      LEFT JOIN train_usage tu ON au.account_id = tu.account_id
      GROUP BY au.account_id, au.total_output_tokens, au.total_input_tokens, 
               au.request_count, au.last_request_time
      ORDER BY au.total_output_tokens DESC
    `

    const result = await pool.query(accountsQuery)

    const tokenLimit = 140000 // 5-hour limit

    const accounts = result.rows.map(row => ({
      accountId: row.account_id,
      outputTokens: parseInt(row.total_output_tokens) || 0,
      inputTokens: parseInt(row.total_input_tokens) || 0,
      requestCount: parseInt(row.request_count) || 0,
      lastRequestTime: row.last_request_time,
      remainingTokens: Math.max(0, tokenLimit - (parseInt(row.total_output_tokens) || 0)),
      percentageUsed: ((parseInt(row.total_output_tokens) || 0) / tokenLimit) * 100,
      trainIds: row.train_ids || [],
    }))

    // Fetch time series data for all accounts in a single query
    const accountIds = accounts.map(acc => acc.accountId)

    const timeSeriesQuery = `
      WITH time_buckets AS (
        SELECT 
          generate_series(
            NOW() - INTERVAL '5 hours',
            NOW(),
            INTERVAL '15 minutes'
          ) AS bucket_time
      ),
      account_cumulative AS (
        SELECT 
          au.account_id,
          tb.bucket_time,
          COALESCE(
            SUM(ar.output_tokens) FILTER (
              WHERE ar.timestamp > tb.bucket_time - INTERVAL '5 hours' 
              AND ar.timestamp <= tb.bucket_time
            ),
            0
          ) AS cumulative_output_tokens
        FROM (SELECT unnest($1::text[]) AS account_id) au
        CROSS JOIN time_buckets tb
        LEFT JOIN api_requests ar ON ar.account_id = au.account_id
        GROUP BY au.account_id, tb.bucket_time
      )
      SELECT 
        account_id,
        bucket_time,
        cumulative_output_tokens
      FROM account_cumulative
      ORDER BY account_id, bucket_time ASC
    `

    const seriesResult = await pool.query(timeSeriesQuery, [accountIds])

    // Group time series data by account
    const seriesByAccount = new Map<string, Array<{ time: Date; remaining: number }>>()

    for (const row of seriesResult.rows) {
      const accountId = row.account_id
      const remaining = Math.max(0, tokenLimit - (parseInt(row.cumulative_output_tokens) || 0))

      if (!seriesByAccount.has(accountId)) {
        seriesByAccount.set(accountId, [])
      }

      seriesByAccount.get(accountId)!.push({
        time: row.bucket_time,
        remaining: remaining,
      })
    }

    // Merge mini series data with accounts
    const accountsWithSeries = accounts.map(account => ({
      ...account,
      miniSeries: seriesByAccount.get(account.accountId) || [],
    }))

    return c.json({
      accounts: accountsWithSeries,
      tokenLimit,
    })
  } catch (error) {
    logger.error('Failed to get accounts token usage', { error: getErrorMessage(error) })
    return c.json({ error: 'Failed to retrieve accounts data' }, 500)
  }
})

/**
 * GET /api/usage/requests/hourly - Get hourly request counts by train ID
 */
apiRoutes.get('/usage/requests/hourly', async c => {
  let pool = c.get('pool')

  if (!pool) {
    pool = container.getDbPool()
    if (!pool) {
      return c.json({ error: 'Database not configured' }, 503)
    }
  }

  try {
    const query = c.req.query()
    const trainId = query.trainId
    const days = parseInt(query.days || '7')

    // Validate days parameter
    if (days < 1 || days > 30) {
      return c.json({ error: 'Days parameter must be between 1 and 30' }, 400)
    }

    const conditions = []
    const values = []
    let paramCount = 0

    // Base condition for time range - using parameterized query for security
    conditions.push(`timestamp >= NOW() - ($${++paramCount} * INTERVAL '1 day')`)
    values.push(days)

    // Optional train filter
    if (trainId) {
      conditions.push(`train_id = $${++paramCount}`)
      values.push(trainId)
    }

    const whereClause = conditions.join(' AND ')

    // Query to get hourly request counts grouped by train ID
    const hourlyQuery = `
      SELECT
        train_id,
        DATE_TRUNC('hour', timestamp AT TIME ZONE 'UTC') as hour,
        COUNT(*) as request_count
      FROM
        api_requests
      WHERE
        ${whereClause}
      GROUP BY
        train_id,
        hour
      ORDER BY
        train_id,
        hour
    `

    const result = await pool.query(hourlyQuery, values)

    // Transform the flat result into nested structure by train ID
    const data: Record<string, Array<{ hour: string; count: number }>> = {}

    result.rows.forEach(row => {
      const trainKey = row.train_id || 'unknown'
      if (!data[trainKey]) {
        data[trainKey] = []
      }
      data[trainKey].push({
        hour: row.hour,
        count: parseInt(row.request_count),
      })
    })

    return c.json({
      data,
      query: {
        trainId: trainId || null,
        days,
      },
    })
  } catch (error) {
    logger.error('Failed to get hourly usage data', {
      error: getErrorMessage(error),
      stack: getErrorStack(error),
    })
    return c.json({ error: 'Failed to retrieve hourly usage data' }, 500)
  }
})

/**
 * GET /api/usage/tokens/hourly - Get hourly token counts by train ID (output tokens only)
 */
apiRoutes.get('/usage/tokens/hourly', async c => {
  let pool = c.get('pool')

  if (!pool) {
    pool = container.getDbPool()
    if (!pool) {
      return c.json({ error: 'Database not configured' }, 503)
    }
  }

  try {
    const query = c.req.query()
    const trainId = query.trainId
    const days = parseInt(query.days || '7')

    // Validate days parameter
    if (days < 1 || days > 30) {
      return c.json({ error: 'Days parameter must be between 1 and 30' }, 400)
    }

    const conditions = []
    const values = []
    let paramCount = 0

    // Base condition for time range
    conditions.push(`timestamp >= NOW() - ($${++paramCount} * INTERVAL '1 day')`)
    values.push(days)

    // Optional train filter
    if (trainId) {
      conditions.push(`train_id = $${++paramCount}`)
      values.push(trainId)
    }

    const whereClause = conditions.join(' AND ')

    // Query to get hourly token sums grouped by train ID (output tokens only)
    const hourlyQuery = `
      SELECT
        train_id,
        DATE_TRUNC('hour', timestamp AT TIME ZONE 'UTC') as hour,
        COALESCE(SUM(output_tokens), 0) as token_count
      FROM
        api_requests
      WHERE
        ${whereClause}
      GROUP BY
        train_id,
        hour
      ORDER BY
        train_id,
        hour
    `

    const { rows } = await pool.query(hourlyQuery, values)

    // Group results by train ID
    const data: Record<string, Array<{ hour: string; count: number }>> = {}

    for (const row of rows) {
      const trainName = row.train_id || 'unknown'
      if (!data[trainName]) {
        data[trainName] = []
      }

      data[trainName].push({
        hour: row.hour.toISOString(),
        count: parseInt(row.token_count),
      })
    }

    return c.json({
      data,
      query: {
        trainId: trainId || null,
        days,
      },
    })
  } catch (error) {
    logger.error('Failed to get hourly token usage', { error: getErrorMessage(error) })
    return c.json({ error: 'Failed to retrieve hourly token usage data' }, 500)
  }
})

/**
 * GET /api/analytics/token-usage/sliding-window - Get sliding window token usage with rate limit status
 */
apiRoutes.get('/analytics/token-usage/sliding-window', async c => {
  const tokenUsageService = container.getTokenUsageService()
  if (!tokenUsageService) {
    return c.json({ error: 'Token usage tracking not configured' }, 503)
  }

  try {
    const query = c.req.query()
    const accountId = query.accountId

    if (!accountId) {
      return c.json({ error: 'accountId is required' }, 400)
    }

    const days = parseInt(query.days || '7')
    const bucketMinutes = parseInt(query.bucketMinutes || '10')
    const windowHours = parseInt(query.windowHours || '5')

    // Validate parameters including NaN checks
    if (isNaN(days) || days < 1 || days > 30) {
      return c.json({ error: 'days must be a valid number between 1 and 30' }, 400)
    }
    if (isNaN(bucketMinutes) || bucketMinutes < 1 || bucketMinutes > 60) {
      return c.json({ error: 'bucketMinutes must be a valid number between 1 and 60' }, 400)
    }
    if (isNaN(windowHours) || windowHours < 1 || windowHours > 24) {
      return c.json({ error: 'windowHours must be a valid number between 1 and 24' }, 400)
    }

    const result = await tokenUsageService.getSlidingWindowUsage(
      accountId,
      days,
      bucketMinutes,
      windowHours
    )

    return c.json(result)
  } catch (error) {
    logger.error('Failed to get sliding window usage', { error: getErrorMessage(error) })
    return c.json({ error: 'Failed to retrieve sliding window usage data' }, 500)
  }
})
