import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Pool } from 'pg'
import {
  listConversations,
  OlderConversationCountCache,
  type ConversationListItem,
  type ConversationListParams,
  type ConversationListPool,
} from '../../services/proxy/src/services/conversation-list'

// Only ever runs against an explicitly named local *_test database
const databaseUrl = process.env.CONVERSATION_LIST_TEST_DATABASE_URL
const enabled = !!databaseUrl && new URL(databaseUrl).pathname.endsWith('_test')

const PUBLIC_PROJECT = 'convlist-test-public'
const PRIVATE_PROJECT = 'convlist-test-private' // the viewer is not a member
const MEMBER_PROJECT = 'convlist-test-member' // private, the viewer is a member
const VIEWER = 'Viewer@ConvList.test'
const OTHER_MEMBER = 'someone-else@convlist.test'
const ACCOUNT_A = 'convlist-acc-a'
const ACCOUNT_B = 'convlist-acc-b'
const ACCOUNT_OLD = 'convlist-acc-old'

const HOUR = 3_600_000
const TIED = [49, 50]
const DAY = 24 * HOUR
const conv = (n: number) => `c0ffee00-0000-4000-8000-${String(n).padStart(12, '0')}`
const req = (n: number) => `c0ffee01-0000-4000-8000-${String(n).padStart(12, '0')}`
/** Request numbers: the index-th request (in insertion order) of a conversation */
const requestNumber = (conversation: number, index: number) => 1000 + conversation * 10 + index

interface SeedRequest {
  conversation: number
  project: string
  at: number
  account: string
  model: string
  branch?: string
  parentTask?: string
}

interface VisibleRow {
  request_id: string
  conversation_id: string
  project_id: string
  account_id: string | null
  timestamp: Date
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  branch_id: string | null
  is_subtask: boolean | null
  parent_task_request_id: string | null
  parent_conversation_id: string | null
  response_body: {
    usage?: {
      input_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  } | null
}

type Filters = Omit<ConversationListParams, 'limit' | 'offset'>

describe.skipIf(!enabled)('conversation list against PostgreSQL', () => {
  let pool: Pool
  const now = Date.now()
  const privateConversations: string[] = []
  const memberConversations: string[] = []

  const cleanUp = async () => {
    await pool.query(
      `DELETE FROM api_requests
       WHERE conversation_id::text LIKE 'c0ffee00-%' OR request_id::text LIKE 'c0ffee01-%'`
    )
    await pool.query(`DELETE FROM projects WHERE project_id LIKE 'convlist-test-%'`)
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl })
    await cleanUp()

    for (const [projectId, isPrivate] of [
      [PUBLIC_PROJECT, false],
      [PRIVATE_PROJECT, true],
      [MEMBER_PROJECT, true],
    ] as const) {
      await pool.query(
        `INSERT INTO projects (project_id, name, is_private, api_key) VALUES ($1, $1, $2, $3)`,
        [projectId, isPrivate, `${projectId}-key`]
      )
    }
    for (const [projectId, email] of [
      [PRIVATE_PROJECT, OTHER_MEMBER],
      [MEMBER_PROJECT, VIEWER],
    ]) {
      await pool.query(
        `INSERT INTO project_members (project_id, user_email, role, added_by)
         SELECT id, $2, 'member', 'conversation-list-test' FROM projects WHERE project_id = $1`,
        [projectId, email]
      )
    }

    const requests: SeedRequest[] = []
    const add = (request: SeedRequest) => requests.push(request)

    // 40 public conversations whose last activity is 10-30 days old (inserted
    // first: recent sub-tasks point at their requests)
    for (let c = 60; c < 100; c++) {
      const last = now - 10 * DAY - (c - 60) * 12 * HOUR
      add({
        conversation: c,
        project: PUBLIC_PROJECT,
        at: last - HOUR,
        account: ACCOUNT_OLD,
        model: 'claude-old',
      })
      add({
        conversation: c,
        project: PUBLIC_PROJECT,
        at: last,
        account: ACCOUNT_A,
        model: 'claude-old',
      })
    }

    // 60 public conversations active within the last 5 days; every fifth one
    // also has requests from 20+ days ago, outside the recent window
    for (let c = 0; c < 60; c++) {
      // Conversations 49 and 50 tie on last activity at positions 49/50,
      // straddling the page-1 (windowed) / page-2 (fallback) boundary
      const last = TIED.includes(c)
        ? now - 99 * HOUR - 30 * 60_000
        : now - c * 2 * HOUR - 30 * 60_000
      const account = c % 2 === 0 ? ACCOUNT_A : ACCOUNT_B
      // Every tenth one has sub-task requests both before and inside the window
      const subtask = c % 4 === 1 || c % 10 === 0
      if (c % 5 === 0) {
        const old = now - 20 * DAY - c * HOUR
        add({
          conversation: c,
          project: PUBLIC_PROJECT,
          at: old,
          account: ACCOUNT_OLD,
          model: 'claude-old',
          branch: c % 10 === 0 ? 'subtask_1' : 'branch_old',
          parentTask: c % 10 === 0 ? req(requestNumber(60 + (c % 40), 0)) : undefined,
        })
        add({
          conversation: c,
          project: PUBLIC_PROJECT,
          at: old + HOUR,
          account: ACCOUNT_OLD,
          model: 'claude-older',
          branch: 'compact_1',
        })
      }
      add({
        conversation: c,
        project: PUBLIC_PROJECT,
        at: last - 20 * 60_000,
        account,
        model: 'claude-recent',
      })
      add({
        conversation: c,
        project: PUBLIC_PROJECT,
        at: last - 10 * 60_000,
        account,
        model: 'claude-recent',
        branch: subtask ? 'subtask_2' : c % 4 === 3 ? 'branch_2' : 'main',
        parentTask: subtask ? req(requestNumber(60 + ((c + 7) % 40), 1)) : undefined,
      })
      add({ conversation: c, project: PUBLIC_PROJECT, at: last, account, model: 'claude-recent' })
    }

    // Private project the viewer cannot see: recent and old conversations
    for (let c = 100; c < 108; c++) {
      const last = c < 105 ? now - (c - 100) * 3 * HOUR - 15 * 60_000 : now - 12 * DAY - c * HOUR
      add({
        conversation: c,
        project: PRIVATE_PROJECT,
        at: last,
        account: ACCOUNT_A,
        model: 'claude-recent',
      })
      privateConversations.push(conv(c))
    }

    // Private project the viewer is a member of
    for (let c = 110; c < 114; c++) {
      add({
        conversation: c,
        project: MEMBER_PROJECT,
        at: now - (c - 110) * 5 * HOUR - 45 * 60_000,
        account: ACCOUNT_B,
        model: 'claude-recent',
      })
      memberConversations.push(conv(c))
    }

    const seenPerConversation = new Map<number, number>()
    for (const request of requests) {
      const index = seenPerConversation.get(request.conversation) ?? 0
      seenPerConversation.set(request.conversation, index + 1)
      const n = requestNumber(request.conversation, index)
      const tokens = (request.conversation % 7) + index + 1
      await pool.query(
        `INSERT INTO api_requests (
           request_id, project_id, timestamp, method, path, headers, body, model, request_type,
           response_status, response_body, input_tokens, output_tokens, total_tokens, duration_ms,
           conversation_id, branch_id, account_id, is_subtask, parent_task_request_id
         ) VALUES ($1, $2, $3, 'POST', '/v1/messages', '{}', '{}', $4, 'inference',
           200, $5, $6, $7, $8, 100, $9, $10, $11, $12, $13)`,
        [
          req(n),
          request.project,
          new Date(request.at).toISOString(),
          request.model,
          JSON.stringify({
            usage: {
              input_tokens: tokens,
              cache_read_input_tokens: tokens * 2,
              cache_creation_input_tokens: 3,
            },
          }),
          tokens,
          tokens * 2,
          tokens * 3,
          conv(request.conversation),
          request.branch ?? 'main',
          request.account,
          !!request.parentTask,
          request.parentTask ?? null,
        ]
      )
    }
  })

  afterAll(async () => {
    await cleanUp()
    await pool.end()
  })

  const visibility = `
         ($1::text IS NULL OR ar.project_id IN (
           SELECT p.project_id FROM projects p
           WHERE NOT p.is_private
              OR EXISTS (
                SELECT 1 FROM project_members pm
                WHERE pm.project_id = p.id AND LOWER(pm.user_email) = LOWER($1)
              )
         ))
         AND ($2::text IS NULL OR ar.project_id = $2)
         AND ($3::text IS NULL OR ar.account_id = $3)
         AND ($4::timestamptz IS NULL OR ar.timestamp >= $4)
         AND ($5::timestamptz IS NULL OR ar.timestamp <= $5)`
  const visibilityValues = (principal: string | undefined, filters: Filters) => [
    principal ?? null,
    filters.projectId ?? null,
    filters.accountId ?? null,
    filters.dateFrom ?? null,
    filters.dateTo ?? null,
  ]
  const isSeeded = (conversationId: string) => conversationId.startsWith('c0ffee00-')

  /** Exact count of every visible conversation, seeded or not */
  const visibleCount = async (principal: string | undefined, filters: Filters = {}) => {
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT ar.conversation_id)::int AS total
       FROM api_requests ar
       WHERE ar.conversation_id IS NOT NULL AND ${visibility}`,
      visibilityValues(principal, filters)
    )
    return rows[0].total as number
  }

  /**
   * Full-history reference for the seeded conversations only, written
   * independently of the code under test (other rows in the database
   * cannot change it)
   */
  const reference = async (principal: string | undefined, filters: Filters = {}) => {
    const { rows } = await pool.query<VisibleRow>(
      `SELECT ar.request_id, ar.conversation_id, ar.project_id, ar.account_id, ar.timestamp,
              ar.model, ar.input_tokens, ar.output_tokens, ar.branch_id, ar.is_subtask,
              ar.parent_task_request_id, ar.response_body,
              parent.conversation_id AS parent_conversation_id
       FROM api_requests ar
       LEFT JOIN api_requests parent ON parent.request_id = ar.parent_task_request_id
       WHERE ar.conversation_id::text LIKE 'c0ffee00-%' AND ${visibility}`,
      visibilityValues(principal, filters)
    )

    const byConversation = new Map<string, VisibleRow[]>()
    for (const row of rows) {
      const list = byConversation.get(row.conversation_id) ?? []
      list.push(row)
      byConversation.set(row.conversation_id, list)
    }

    const distinctSorted = (values: Array<string | null>) =>
      [...new Set(values.filter((v): v is string => v !== null))].sort()
    const byTimeThenId = (a: VisibleRow, b: VisibleRow) =>
      a.timestamp.getTime() - b.timestamp.getTime() ||
      (a.request_id < b.request_id ? -1 : a.request_id > b.request_id ? 1 : 0)

    const items = [...byConversation.entries()].map(([conversationId, list]) => {
      const ordered = [...list].sort(byTimeThenId)
      const latest = ordered[ordered.length - 1]
      const firstSubtask = ordered.find(r => r.is_subtask)
      const branches = distinctSorted(list.map(r => r.branch_id))
      const trainIds = distinctSorted(list.map(r => r.project_id))
      const accountIds = distinctSorted(list.map(r => r.account_id))
      const usage = latest.response_body?.usage
      return {
        conversationId,
        trainIds,
        accountIds,
        projectId: trainIds[0] ?? '',
        accountId: accountIds[0] ?? null,
        firstMessageTime: ordered[0].timestamp.toISOString(),
        lastMessageTime: latest.timestamp.toISOString(),
        messageCount: list.length,
        totalTokens: list.reduce(
          (sum, r) => sum + (r.input_tokens ?? 0) + (r.output_tokens ?? 0),
          0
        ),
        branchCount: branches.length,
        subtaskBranchCount: branches.filter(b => b.startsWith('subtask_')).length,
        compactBranchCount: branches.filter(b => b.startsWith('compact_')).length,
        userBranchCount: branches.filter(
          b => !b.startsWith('subtask_') && !b.startsWith('compact_') && b !== 'main'
        ).length,
        // ARRAY_AGG over zero non-null models is NULL, not an empty array
        modelsUsed: distinctSorted(list.map(r => r.model)).length
          ? distinctSorted(list.map(r => r.model))
          : null,
        latestRequestId: latest.request_id,
        latestModel: latest.model,
        latestContextTokens: usage
          ? (usage.input_tokens || 0) +
            (usage.cache_read_input_tokens || 0) +
            (usage.cache_creation_input_tokens || 0)
          : 0,
        isSubtask: list.some(r => r.is_subtask),
        parentTaskRequestId: firstSubtask?.parent_task_request_id ?? null,
        parentConversationId: firstSubtask ? firstSubtask.parent_conversation_id : null,
        subtaskMessageCount: list.filter(r => r.is_subtask).length,
      }
    })

    return items.sort(
      (a, b) =>
        b.lastMessageTime.localeCompare(a.lastMessageTime) ||
        (a.conversationId < b.conversationId ? 1 : a.conversationId > b.conversationId ? -1 : 0)
    )
  }

  const normalize = (item: ConversationListItem) => ({
    ...item,
    trainIds: [...item.trainIds].sort(),
    accountIds: [...item.accountIds].sort(),
    modelsUsed: item.modelsUsed ? [...item.modelsUsed].sort() : item.modelsUsed,
    firstMessageTime: new Date(item.firstMessageTime).toISOString(),
    lastMessageTime: new Date(item.lastMessageTime).toISOString(),
  })

  const list = async (principal: string | undefined, params: ConversationListParams) => {
    const statements: string[] = []
    const spy = {
      query: (sql: string, values?: unknown[]) => {
        statements.push(sql)
        return pool.query(sql, values)
      },
    } as unknown as ConversationListPool
    const result = await listConversations(spy, params, principal, {
      olderCountCache: new OlderConversationCountCache(),
    })
    return {
      ...result,
      items: result.conversations.map(normalize),
      statements,
      idQueries: statements.filter(sql => /LIMIT \$\d+/.test(sql) && !sql.includes('= ANY(')),
    }
  }

  it('serves page 1 from the recent window with full-history aggregates', async () => {
    const expected = await reference(VIEWER, { projectId: PUBLIC_PROJECT })
    expect(expected).toHaveLength(100)

    const result = await list(VIEWER, { projectId: PUBLIC_PROJECT, limit: 50, offset: 0 })

    expect(result.idQueries).toHaveLength(1)
    expect(result.idQueries[0]).toContain("INTERVAL '7 days'")
    expect(result.items).toEqual(expected.slice(0, 50))
    expect(result.pagination).toEqual({
      total: 100,
      limit: 50,
      offset: 0,
      hasMore: true,
      page: 1,
      totalPages: 2,
    })
  })

  it('falls back to full history past the recent window', async () => {
    const expected = await reference(VIEWER, { projectId: PUBLIC_PROJECT })

    const result = await list(VIEWER, { projectId: PUBLIC_PROJECT, limit: 50, offset: 50 })

    expect(result.idQueries).toHaveLength(2)
    expect(result.idQueries[1]).not.toContain('INTERVAL')
    expect(result.items).toEqual(expected.slice(50, 100))
    expect(result.pagination.total).toBe(100)
    expect(result.pagination.hasMore).toBe(false)
    expect(result.pagination.page).toBe(2)
  })

  it('applies account filters to both the window and the fallback', async () => {
    for (const accountId of [ACCOUNT_A, ACCOUNT_OLD]) {
      const expected = await reference(VIEWER, { projectId: PUBLIC_PROJECT, accountId })
      const result = await list(VIEWER, {
        projectId: PUBLIC_PROJECT,
        accountId,
        limit: 20,
        offset: 0,
      })
      expect(result.items).toEqual(expected.slice(0, 20))
      expect(result.pagination.total).toBe(expected.length)
    }
  })

  it('never shows private projects to a non-member and matches every page', async () => {
    // Unscoped: rows outside the seed may be listed too; they are counted
    // exactly and must not disturb the seeded conversations' order or values
    const expected = await reference(VIEWER)
    const expectedTotal = await visibleCount(VIEWER)
    const seen: ReturnType<typeof normalize>[] = []

    for (let offset = 0; offset < expectedTotal + 50; offset += 50) {
      const result = await list(VIEWER, { limit: 50, offset })
      expect(result.pagination.total).toBe(expectedTotal)
      seen.push(...result.items)
    }

    const seenIds = seen.map(item => item.conversationId)
    expect(seenIds).toHaveLength(expectedTotal)
    expect(new Set(seenIds).size).toBe(expectedTotal)
    expect(seen.filter(item => isSeeded(item.conversationId))).toEqual(expected)
    expect(seenIds.filter(id => privateConversations.includes(id))).toEqual([])
    expect(memberConversations.every(id => seenIds.includes(id))).toBe(true)

    const hidden = await list(VIEWER, { projectId: PRIVATE_PROJECT, limit: 50, offset: 0 })
    expect(hidden.conversations).toEqual([])
    expect(hidden.pagination.total).toBe(0)
  })

  it('gives anonymous callers full-history aggregates and totals', async () => {
    const expected = await reference(undefined, { projectId: PUBLIC_PROJECT })

    const result = await list(undefined, { projectId: PUBLIC_PROJECT, limit: 50, offset: 0 })

    expect(result.items).toEqual(expected.slice(0, 50))
    expect(result.pagination.total).toBe(100)

    // Anonymous callers are not privacy-filtered
    const privateExpected = await reference(undefined, { projectId: PRIVATE_PROJECT })
    const privateResult = await list(undefined, {
      projectId: PRIVATE_PROJECT,
      limit: 50,
      offset: 0,
    })
    expect(privateResult.items).toEqual(privateExpected)
    expect(privateResult.items.map(item => item.conversationId).sort()).toEqual(
      [...privateConversations].sort()
    )
    expect(privateResult.pagination.total).toBe(privateConversations.length)
  })

  it('breaks last-message ties by conversation id across the fallback boundary', async () => {
    const first = await list(VIEWER, { projectId: PUBLIC_PROJECT, limit: 50, offset: 0 })
    const second = await list(VIEWER, { projectId: PUBLIC_PROJECT, limit: 50, offset: 50 })

    expect(first.idQueries).toHaveLength(1) // page 1 from the window
    expect(second.idQueries).toHaveLength(2) // page 2 falls back
    const [lastOfFirst, firstOfSecond] = [first.items[49], second.items[0]]
    expect(lastOfFirst.lastMessageTime).toBe(firstOfSecond.lastMessageTime)
    expect([lastOfFirst.conversationId, firstOfSecond.conversationId]).toEqual([
      conv(TIED[1]),
      conv(TIED[0]),
    ])

    const ids = [...first.items, ...second.items].map(item => item.conversationId)
    expect(new Set(ids).size).toBe(100)
    expect([...ids].sort()).toEqual(Array.from({ length: 100 }, (_, c) => conv(c)).sort())
  })

  it('selects and counts exactly within explicit date bounds', async () => {
    const filters = {
      projectId: PUBLIC_PROJECT,
      dateFrom: new Date(now - 25 * DAY).toISOString(),
      dateTo: new Date(now - 3 * DAY).toISOString(),
    }
    const expected = await reference(VIEWER, filters)

    const result = await list(VIEWER, { ...filters, limit: 50, offset: 0 })

    expect(result.statements.every(sql => !sql.includes('INTERVAL'))).toBe(true)
    expect(result.idQueries).toHaveLength(1)
    expect(result.items).toEqual(expected.slice(0, 50))
    expect(result.pagination.total).toBe(expected.length)
  })
})
