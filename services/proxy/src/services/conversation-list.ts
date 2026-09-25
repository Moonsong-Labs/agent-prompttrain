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

export interface OlderConversationCountCacheOptions {
  ttlMs?: number
  now?: () => number
  maxEntries?: number
}

/** How long the count of conversations idle for over 7 days is reused */
export const OLDER_CONVERSATION_COUNT_TTL_MS = 60 * 60 * 1000

/**
 * Caches the number of conversations without activity in the recent window.
 * Concurrent misses for one key share a single computation; a failed
 * computation is not cached.
 */
export class OlderConversationCountCache {
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly maxEntries: number
  private readonly entries = new Map<string, { count: number; expiresAt: number }>()
  private readonly inFlight = new Map<string, Promise<number>>()

  constructor(options: OlderConversationCountCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? OLDER_CONVERSATION_COUNT_TTL_MS
    this.now = options.now ?? Date.now
    this.maxEntries = options.maxEntries ?? 1000
  }

  get(key: string, compute: () => Promise<number>): Promise<number> {
    const entry = this.entries.get(key)
    if (entry && this.now() < entry.expiresAt) {
      return Promise.resolve(entry.count)
    }

    const pending = this.inFlight.get(key)
    if (pending) {
      return pending
    }

    // compute runs on a later microtask, after the promise is registered, so
    // even a synchronous throw settles through finally and leaves inFlight
    const computation = Promise.resolve()
      .then(compute)
      .then(count => {
        this.store(key, count)
        return count
      })
      .finally(() => {
        this.inFlight.delete(key)
      })
    this.inFlight.set(key, computation)
    return computation
  }

  private store(key: string, count: number): void {
    this.entries.delete(key)
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) {
        this.entries.delete(oldest)
      }
    }
    this.entries.set(key, { count, expiresAt: this.now() + this.ttlMs })
  }
}

/** Shared by default so every request reuses the hourly older count */
export const olderConversationCountCache = new OlderConversationCountCache()

export interface ListConversationsOptions {
  olderCountCache?: OlderConversationCountCache
}

/** Conversations active here sort before every conversation that is not */
const RECENT_WINDOW = `ar.timestamp >= NOW() - INTERVAL '7 days'`

const ACCESSIBLE_PROJECTS_CTE = `accessible_projects AS (
        SELECT DISTINCT p.project_id
        FROM projects p
        LEFT JOIN project_members pm
          ON p.id = pm.project_id
          AND LOWER(pm.user_email) = $1
        WHERE (p.is_private = false OR pm.user_email IS NOT NULL)
      )`

/** Project/account/privacy/date filters applied identically to every query */
interface ConversationFilter {
  /** Positional values; $1 is the principal when there is one */
  values: unknown[]
  conditions: string[]
  ctes: string[]
  join: string
}

function buildFilter(params: ConversationListParams, principal?: string): ConversationFilter {
  const values: unknown[] = []
  const conditions = ['ar.conversation_id IS NOT NULL']
  const add = (condition: (ref: string) => string, value: unknown) => {
    values.push(value)
    conditions.push(condition(`$${values.length}`))
  }

  if (principal) {
    values.push(principal)
  }
  if (params.projectId) {
    add(ref => `ar.project_id = ${ref}`, params.projectId)
  }
  if (params.accountId) {
    add(ref => `ar.account_id = ${ref}`, params.accountId)
  }
  if (params.dateFrom) {
    add(ref => `ar.timestamp >= ${ref}`, params.dateFrom)
  }
  if (params.dateTo) {
    add(ref => `ar.timestamp <= ${ref}`, params.dateTo)
  }

  return {
    values,
    conditions,
    ctes: principal ? [ACCESSIBLE_PROJECTS_CTE] : [],
    join: principal ? 'JOIN accessible_projects ap ON ar.project_id = ap.project_id' : '',
  }
}

function withClause(filter: ConversationFilter, ...ctes: string[]): string {
  const all = [...filter.ctes, ...ctes]
  return all.length > 0 ? `WITH ${all.join(',\n      ')}` : ''
}

function whereClause(filter: ConversationFilter, ...extra: string[]): string {
  return `WHERE ${[...filter.conditions, ...extra].join(' AND ')}`
}

const hasExplicitDates = (params: ConversationListParams) => !!(params.dateFrom || params.dateTo)

/** Blank principals are anonymous; emails compare case-insensitively */
const normalizePrincipal = (principal?: string) => principal?.trim().toLowerCase() || undefined

/**
 * Key for caching a whole GET /api/conversations response. JSON keeps an
 * anonymous caller (null) apart from any principal string and cannot be
 * confused by separators inside values; empty filters equal absent ones.
 */
export function conversationListCacheKey(
  params: ConversationListParams,
  principal?: string
): string {
  return `conversations:${JSON.stringify([
    normalizePrincipal(principal) ?? null,
    params.projectId || null,
    params.accountId || null,
    params.dateFrom || null,
    params.dateTo || null,
    params.limit,
    params.offset,
  ])}`
}

/**
 * Lists one page of conversations visible to `principal` (an authenticated
 * user email; anonymous callers see every project).
 *
 * Without explicit dates the page is selected from the last 7 days first:
 * every conversation active there sorts before every one that is not, so a
 * full windowed page equals the same page over full history. Only a short
 * windowed page falls back to scanning full history. Per-conversation
 * details are always computed over full history for the selected IDs.
 */
export async function listConversations(
  pool: ConversationListPool,
  params: ConversationListParams,
  principal?: string,
  options: ListConversationsOptions = {}
): Promise<ConversationListResult> {
  const normalizedPrincipal = normalizePrincipal(principal)
  const filter = buildFilter(params, normalizedPrincipal)
  const olderCountCache = options.olderCountCache ?? olderConversationCountCache

  const [rows, total] = await Promise.all([
    selectPage(pool, filter, params).then(ids => fetchDetails(pool, filter, ids)),
    hasExplicitDates(params)
      ? countExact(pool, filter)
      : countRecentPlusOlder(pool, filter, olderCountCache, [
          normalizedPrincipal ?? null,
          params.projectId || null,
          params.accountId || null,
        ]),
  ])

  return {
    conversations: rows.map(toConversationListItem),
    pagination: {
      total,
      limit: params.limit,
      offset: params.offset,
      hasMore: params.offset + params.limit < total,
      page: Math.floor(params.offset / params.limit) + 1,
      totalPages: Math.ceil(total / params.limit),
    },
  }
}

async function selectPage(
  pool: ConversationListPool,
  filter: ConversationFilter,
  params: ConversationListParams
): Promise<string[]> {
  if (hasExplicitDates(params)) {
    return selectPageIds(pool, filter, params, false)
  }

  const recent = await selectPageIds(pool, filter, params, true)
  if (recent.length >= params.limit) {
    return recent
  }
  return selectPageIds(pool, filter, params, false)
}

async function selectPageIds(
  pool: ConversationListPool,
  filter: ConversationFilter,
  params: ConversationListParams,
  recentOnly: boolean
): Promise<string[]> {
  const values = [...filter.values, params.limit, params.offset]
  const query = `
      ${withClause(filter)}
      SELECT
        ar.conversation_id,
        MAX(ar.timestamp) AS last_message_time
      FROM api_requests ar
      ${filter.join}
      ${recentOnly ? whereClause(filter, RECENT_WINDOW) : whereClause(filter)}
      GROUP BY ar.conversation_id
      ORDER BY last_message_time DESC, ar.conversation_id DESC
      LIMIT $${values.length - 1}
      OFFSET $${values.length}
    `
  const result = await pool.query(query, values)
  return result.rows.map((row: { conversation_id: string }) => row.conversation_id)
}

async function fetchDetails(
  pool: ConversationListPool,
  filter: ConversationFilter,
  conversationIds: string[]
): Promise<ConversationRow[]> {
  if (conversationIds.length === 0) {
    return []
  }

  const values = [...filter.values, conversationIds]
  const where = whereClause(filter, `ar.conversation_id = ANY($${values.length})`)
  const query = `
      ${withClause(
        filter,
        `conversation_rollups AS (
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
        ${filter.join}
        ${where}
        GROUP BY ar.conversation_id
      )`,
        `latest_requests AS (
        SELECT DISTINCT ON (ar.conversation_id)
          ar.conversation_id,
          ar.request_id AS latest_request_id,
          ar.model AS latest_model,
          ar.response_body AS latest_response_body
        FROM api_requests ar
        ${filter.join}
        ${where}
        ORDER BY ar.conversation_id, ar.timestamp DESC, ar.request_id DESC
      )`,
        `first_subtasks AS (
        SELECT DISTINCT ON (ar.conversation_id)
          ar.conversation_id,
          ar.parent_task_request_id
        FROM api_requests ar
        ${filter.join}
        ${where}
          AND ar.is_subtask = true
        ORDER BY ar.conversation_id, ar.timestamp ASC, ar.request_id ASC
      )`
      )}
      SELECT
        cr.*,
        lr.latest_request_id,
        lr.latest_model,
        lr.latest_response_body,
        fs.parent_task_request_id,
        parent_req.conversation_id AS parent_conversation_id
      FROM conversation_rollups cr
      LEFT JOIN latest_requests lr ON lr.conversation_id = cr.conversation_id
      LEFT JOIN first_subtasks fs ON fs.conversation_id = cr.conversation_id
      LEFT JOIN api_requests parent_req ON fs.parent_task_request_id = parent_req.request_id
      ORDER BY cr.last_message_time DESC, cr.conversation_id DESC
    `
  const result = await pool.query(query, values)
  return result.rows
}

async function countExact(pool: ConversationListPool, filter: ConversationFilter): Promise<number> {
  const result = await pool.query(
    `
      ${withClause(filter)}
      SELECT COUNT(DISTINCT ar.conversation_id) AS total
      FROM api_requests ar
      ${filter.join}
      ${whereClause(filter)}
    `,
    filter.values
  )
  return parseInt(result.rows[0]?.total || '0')
}

/**
 * Live count of conversations active in the window plus the cached count of
 * the rest; both terms are exact when computed, the older one may lag by up
 * to the cache TTL.
 */
async function countRecentPlusOlder(
  pool: ConversationListPool,
  filter: ConversationFilter,
  cache: OlderConversationCountCache,
  keyParts: Array<string | null>
): Promise<number> {
  const recentQuery = pool.query(
    `
      ${withClause(filter)}
      SELECT COUNT(DISTINCT ar.conversation_id) AS recent_total
      FROM api_requests ar
      ${filter.join}
      ${whereClause(filter, RECENT_WINDOW)}
    `,
    filter.values
  )

  // Total minus recent in one statement, so both terms share one snapshot
  const olderCount = cache.get(JSON.stringify(keyParts), async () => {
    const result = await pool.query(
      `
      ${withClause(filter)}
      SELECT
        COUNT(DISTINCT ar.conversation_id)
          - COUNT(DISTINCT ar.conversation_id) FILTER (WHERE ${RECENT_WINDOW}) AS older_total
      FROM api_requests ar
      ${filter.join}
      ${whereClause(filter)}
    `,
      filter.values
    )
    return parseInt(result.rows[0]?.older_total || '0')
  })

  const [recent, older] = await Promise.all([recentQuery, olderCount])
  return parseInt(recent.rows[0]?.recent_total || '0') + older
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
