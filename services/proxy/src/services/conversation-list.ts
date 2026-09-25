import type { Pool } from 'pg'

/**
 * Conversation list queries behind GET /api/conversations.
 */

export type ConversationListPool = Pick<Pool, 'query'>

export interface ConversationListParams {
  projectId?: string
  accountId?: string
  limit: number
  offset: number
  dateFrom?: string
  dateTo?: string
}

export interface ConversationListItem {
  conversationId: string
  trainIds: string[]
  accountIds: string[]
  projectId: string
  accountId: string | null
  firstMessageTime: Date | string
  lastMessageTime: Date | string
  messageCount: number
  totalTokens: number
  branchCount: number
  subtaskBranchCount: number
  compactBranchCount: number
  userBranchCount: number
  modelsUsed: string[] | null
  latestRequestId: string | null
  latestModel: string | null
  latestContextTokens: number
  isSubtask: boolean | null
  parentTaskRequestId: string | null
  parentConversationId: string | null
  subtaskMessageCount: number
}

/** One row of the details query (BIGINT counts arrive as strings) */
interface ConversationRow {
  conversation_id: string
  train_ids: string[] | null
  account_ids: string[] | null
  first_message_time: Date | string
  last_message_time: Date | string
  message_count: string
  total_tokens: string
  branch_count: string
  subtask_branch_count: string | null
  compact_branch_count: string | null
  user_branch_count: string | null
  models_used: string[] | null
  is_subtask: boolean | null
  subtask_message_count: string | null
  latest_request_id: string | null
  latest_model: string | null
  latest_response_body: {
    usage?: {
      input_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  } | null
  parent_task_request_id: string | null
  parent_conversation_id: string | null
}

export interface ConversationListPagination {
  total: number
  limit: number
  offset: number
  hasMore: boolean
  page: number
  totalPages: number
}

export interface ConversationListResult {
  conversations: ConversationListItem[]
  pagination: ConversationListPagination
}

const accessibleProjectsCte = `
      accessible_projects AS (
        SELECT DISTINCT p.project_id
        FROM projects p
        LEFT JOIN project_members pm
          ON p.id = pm.project_id
          AND LOWER(pm.user_email) = $1
        WHERE (p.is_private = false OR pm.user_email IS NOT NULL)
      )`

/**
 * Lists one page of conversations visible to `principal` (an authenticated
 * user email; anonymous callers see every project).
 */
export async function listConversations(
  pool: ConversationListPool,
  params: ConversationListParams,
  principal?: string
): Promise<ConversationListResult> {
  const normalizedUserEmail = principal?.trim().toLowerCase()
  const conditions: string[] = []
  const values: unknown[] = []
  let paramCount = 0

  if (normalizedUserEmail) {
    values.push(normalizedUserEmail)
    paramCount++
  }

  if (params.projectId) {
    conditions.push(`ar.project_id = $${++paramCount}`)
    values.push(params.projectId)
  }

  if (params.accountId) {
    conditions.push(`ar.account_id = $${++paramCount}`)
    values.push(params.accountId)
  }

  if (params.dateFrom) {
    conditions.push(`ar.timestamp >= $${++paramCount}`)
    values.push(params.dateFrom)
  }

  if (params.dateTo) {
    conditions.push(`ar.timestamp <= $${++paramCount}`)
    values.push(params.dateTo)
  }

  const needsRows = params.offset + params.limit
  const useTimeBound =
    !normalizedUserEmail && !params.dateFrom && !params.dateTo && needsRows <= 200
  const baseFilters = ['ar.conversation_id IS NOT NULL', ...conditions]
  if (useTimeBound) {
    baseFilters.push(`ar.timestamp >= NOW() - INTERVAL '7 days'`)
  }
  const whereClause = `WHERE ${baseFilters.join(' AND ')}`

  const privacyCte = normalizedUserEmail ? `${accessibleProjectsCte},` : ''
  const privacyJoin = normalizedUserEmail
    ? 'JOIN accessible_projects ap ON ar.project_id = ap.project_id'
    : ''

  const conversationsQuery = `
      WITH
      ${privacyCte}
      paginated_conversations AS (
        SELECT
          ar.conversation_id,
          MAX(ar.timestamp) AS last_message_time
        FROM api_requests ar
        ${privacyJoin}
        ${whereClause}
        GROUP BY ar.conversation_id
        ORDER BY last_message_time DESC
        LIMIT $${++paramCount}
        OFFSET $${++paramCount}
      ),
      conversation_rollups AS (
        SELECT
          ar.conversation_id,
          ARRAY_AGG(DISTINCT ar.project_id) FILTER (WHERE ar.project_id IS NOT NULL) AS train_ids,
          ARRAY_AGG(DISTINCT ar.account_id) FILTER (WHERE ar.account_id IS NOT NULL) AS account_ids,
          MIN(ar.timestamp) AS first_message_time,
          MAX(ar.timestamp) AS last_message_time,
          COUNT(*) AS message_count,
          SUM(COALESCE(ar.input_tokens, 0) + COALESCE(ar.output_tokens, 0)) AS total_tokens,
          COUNT(DISTINCT ar.branch_id) AS branch_count,
          COUNT(DISTINCT ar.branch_id) FILTER (WHERE ar.branch_id LIKE 'subtask_%') AS subtask_branch_count,
          COUNT(DISTINCT ar.branch_id) FILTER (WHERE ar.branch_id LIKE 'compact_%') AS compact_branch_count,
          COUNT(DISTINCT ar.branch_id) FILTER (
            WHERE ar.branch_id IS NOT NULL
              AND ar.branch_id NOT LIKE 'subtask_%'
              AND ar.branch_id NOT LIKE 'compact_%'
              AND ar.branch_id != 'main'
          ) AS user_branch_count,
          ARRAY_AGG(DISTINCT ar.model) FILTER (WHERE ar.model IS NOT NULL) AS models_used,
          BOOL_OR(ar.is_subtask) AS is_subtask,
          COUNT(*) FILTER (WHERE ar.is_subtask) AS subtask_message_count
        FROM api_requests ar
        ${privacyJoin}
        INNER JOIN paginated_conversations pc ON ar.conversation_id = pc.conversation_id
        ${whereClause}
        GROUP BY ar.conversation_id
      ),
      latest_requests AS (
        SELECT DISTINCT ON (ar.conversation_id)
          ar.conversation_id,
          ar.request_id AS latest_request_id,
          ar.model AS latest_model,
          ar.response_body AS latest_response_body
        FROM api_requests ar
        ${privacyJoin}
        INNER JOIN paginated_conversations pc ON ar.conversation_id = pc.conversation_id
        ${whereClause}
        ORDER BY ar.conversation_id, ar.timestamp DESC, ar.request_id DESC
      ),
      first_subtasks AS (
        SELECT DISTINCT ON (ar.conversation_id)
          ar.conversation_id,
          ar.parent_task_request_id
        FROM api_requests ar
        ${privacyJoin}
        INNER JOIN paginated_conversations pc ON ar.conversation_id = pc.conversation_id
        ${whereClause}
          AND ar.is_subtask = true
        ORDER BY ar.conversation_id, ar.timestamp ASC, ar.request_id ASC
      )
      SELECT
        cr.*,
        lr.latest_request_id,
        lr.latest_model,
        lr.latest_response_body,
        fs.parent_task_request_id,
        parent_req.conversation_id AS parent_conversation_id
      FROM conversation_rollups cr
      INNER JOIN paginated_conversations pc ON cr.conversation_id = pc.conversation_id
      LEFT JOIN latest_requests lr ON lr.conversation_id = cr.conversation_id
      LEFT JOIN first_subtasks fs ON fs.conversation_id = cr.conversation_id
      LEFT JOIN api_requests parent_req ON fs.parent_task_request_id = parent_req.request_id
      ORDER BY pc.last_message_time DESC
    `

  values.push(params.limit)
  values.push(params.offset)

  const countQuery = normalizedUserEmail
    ? `
      WITH
      ${accessibleProjectsCte}
      SELECT COUNT(DISTINCT ar.conversation_id) AS total
      FROM api_requests ar
      JOIN accessible_projects ap ON ar.project_id = ap.project_id
      ${whereClause}
    `
    : `
      SELECT COUNT(DISTINCT ar.conversation_id) AS total
      FROM api_requests ar
      ${whereClause}
    `

  const countValues = values.slice(0, values.length - 2)
  const [conversationsResult, countResult] = await Promise.all([
    pool.query(conversationsQuery, values),
    pool.query(countQuery, countValues),
  ])

  const totalCount = parseInt(countResult.rows[0]?.total || 0)
  const hasMore = params.offset + params.limit < totalCount

  return {
    conversations: conversationsResult.rows.map(toConversationListItem),
    pagination: {
      total: totalCount,
      limit: params.limit,
      offset: params.offset,
      hasMore,
      page: Math.floor(params.offset / params.limit) + 1,
      totalPages: Math.ceil(totalCount / params.limit),
    },
  }
}

function toConversationListItem(row: ConversationRow): ConversationListItem {
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
    trainIds: row.train_ids || [],
    accountIds: row.account_ids || [],
    // Keep backward compatibility with single projectId/accountId (use first one)
    projectId: (row.train_ids && row.train_ids[0]) || '',
    accountId: (row.account_ids && row.account_ids[0]) || null,
    firstMessageTime: row.first_message_time,
    lastMessageTime: row.last_message_time,
    messageCount: parseInt(row.message_count),
    totalTokens: parseInt(row.total_tokens),
    branchCount: parseInt(row.branch_count),
    // Add new branch type counts
    subtaskBranchCount: parseInt(row.subtask_branch_count || '0'),
    compactBranchCount: parseInt(row.compact_branch_count || '0'),
    userBranchCount: parseInt(row.user_branch_count || '0'),
    modelsUsed: row.models_used,
    latestRequestId: row.latest_request_id,
    latestModel: row.latest_model,
    latestContextTokens,
    isSubtask: row.is_subtask,
    parentTaskRequestId: row.parent_task_request_id,
    parentConversationId: row.parent_conversation_id,
    subtaskMessageCount: parseInt(row.subtask_message_count || '0'),
  }
}
