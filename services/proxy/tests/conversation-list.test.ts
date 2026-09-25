import { describe, it, expect } from 'bun:test'
import {
  listConversations,
  OlderConversationCountCache,
  type ConversationListParams,
  type ConversationListPool,
} from '../src/services/conversation-list'

const WINDOW = "NOW() - INTERVAL '7 days'"

type QueryKind = 'ids' | 'details' | 'recent' | 'older' | 'exact'

interface RecordedQuery {
  kind: QueryKind
  sql: string
  values: unknown[]
}

interface PoolState {
  /** IDs returned by the page-ID query, given whether it was windowed */
  ids: (query: { windowed: boolean; limit: number; offset: number }) => string[]
  recent: number
  older: () => number | Promise<number>
  exact: number
}

function classify(sql: string): QueryKind {
  if (sql.includes('= ANY(')) {
    return 'details'
  }
  if (sql.includes('AS older_total')) {
    return 'older'
  }
  if (sql.includes('AS recent_total')) {
    return 'recent'
  }
  if (sql.includes('COUNT(DISTINCT ar.conversation_id) AS total')) {
    return 'exact'
  }
  if (/LIMIT \$\d+/.test(sql)) {
    return 'ids'
  }
  throw new Error(`Unexpected query: ${sql}`)
}

function detailRow(conversationId: string) {
  return {
    conversation_id: conversationId,
    train_ids: ['project-a'],
    account_ids: ['account-1'],
    first_message_time: new Date('2026-01-01T00:00:00Z'),
    last_message_time: new Date('2026-09-20T00:00:00Z'),
    message_count: '12',
    total_tokens: '345',
    branch_count: '3',
    subtask_branch_count: '1',
    compact_branch_count: '1',
    user_branch_count: '0',
    models_used: ['claude-test'],
    is_subtask: false,
    subtask_message_count: '2',
    latest_request_id: `req-${conversationId}`,
    latest_model: 'claude-test',
    latest_response_body: {
      usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 },
    },
    parent_task_request_id: null,
    parent_conversation_id: null,
  }
}

const idsFrom = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}-${i}`)

function createPool(overrides: Partial<PoolState> = {}) {
  const state: PoolState = {
    ids: ({ limit }) => idsFrom('conv', limit),
    recent: 30,
    older: () => 45,
    exact: 99,
    ...overrides,
  }
  const calls: RecordedQuery[] = []

  const pool = {
    async query(sql: string, values: unknown[] = []) {
      const kind = classify(sql)
      calls.push({ kind, sql, values })

      switch (kind) {
        case 'ids': {
          const match = sql.match(/LIMIT \$(\d+)\s+OFFSET \$(\d+)/)
          if (!match) {
            throw new Error('page ID query without LIMIT/OFFSET placeholders')
          }
          const limit = Number(values[Number(match[1]) - 1])
          const offset = Number(values[Number(match[2]) - 1])
          const ids = state.ids({ windowed: sql.includes(WINDOW), limit, offset })
          return {
            rows: ids.map((id, i) => ({
              conversation_id: id,
              last_message_time: new Date(Date.UTC(2026, 8, 20) - i * 60_000),
            })),
          }
        }
        case 'details': {
          const ids = values.find(Array.isArray) as string[]
          return { rows: ids.map(detailRow) }
        }
        case 'recent':
          return { rows: [{ recent_total: String(state.recent) }] }
        case 'older':
          return { rows: [{ older_total: String(await state.older()) }] }
        case 'exact':
          return { rows: [{ total: String(state.exact) }] }
      }
    },
  }

  return {
    pool: pool as unknown as ConversationListPool,
    calls,
    state,
    of: (kind: QueryKind) => calls.filter(call => call.kind === kind),
  }
}

const page = (overrides: Partial<ConversationListParams> = {}): ConversationListParams => ({
  limit: 50,
  offset: 0,
  ...overrides,
})

async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 50; i++) {
    if (condition()) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('condition not met')
}

describe('listConversations', () => {
  it('selects signed-in page IDs from the 7-day window and details over full history', async () => {
    const { pool, of } = createPool()

    const result = await listConversations(
      pool,
      page({ projectId: 'project-a', accountId: 'account-1' }),
      ' Alice@Example.com ',
      { olderCountCache: new OlderConversationCountCache() }
    )

    const ids = of('ids')
    expect(ids).toHaveLength(1)
    expect(ids[0].sql).toContain(WINDOW)
    expect(ids[0].sql).toContain('accessible_projects')
    expect(ids[0].values).toEqual(
      expect.arrayContaining(['alice@example.com', 'project-a', 'account-1', 50, 0])
    )

    const details = of('details')
    expect(details).toHaveLength(1)
    expect(details[0].sql).toContain('= ANY(')
    expect(details[0].sql).not.toContain('INTERVAL')
    expect(details[0].sql).toContain('accessible_projects')
    expect(details[0].values).toEqual(
      expect.arrayContaining(['alice@example.com', 'project-a', 'account-1'])
    )
    expect(details[0].values).toContainEqual(idsFrom('conv', 50))

    expect(result.conversations.map(c => c.conversationId)).toEqual(idsFrom('conv', 50))
  })

  it('falls back to full-history page IDs when the window has fewer than limit', async () => {
    const { pool, of } = createPool({
      ids: ({ windowed }) => (windowed ? idsFrom('recent', 10) : idsFrom('full', 50)),
    })

    const result = await listConversations(pool, page({ offset: 50 }), 'alice@example.com', {
      olderCountCache: new OlderConversationCountCache(),
    })

    const ids = of('ids')
    expect(ids).toHaveLength(2)
    expect(ids[0].sql).toContain(WINDOW)
    expect(ids[1].sql).not.toContain('INTERVAL')
    expect(ids[1].values).toEqual(expect.arrayContaining(['alice@example.com', 50, 50]))
    expect(of('details')[0].values).toContainEqual(idsFrom('full', 50))
    expect(result.conversations.map(c => c.conversationId)).toEqual(idsFrom('full', 50))
  })

  it('skips the details query when the page is empty', async () => {
    const { pool, of } = createPool({ ids: () => [], recent: 0, older: () => 0 })

    const result = await listConversations(pool, page(), 'alice@example.com', {
      olderCountCache: new OlderConversationCountCache(),
    })

    expect(of('ids')).toHaveLength(2)
    expect(of('details')).toHaveLength(0)
    expect(result.conversations).toEqual([])
    expect(result.pagination.total).toBe(0)
  })

  it('uses explicit date bounds without the window and counts exactly', async () => {
    const dateFrom = '2026-01-01T00:00:00Z'
    const dateTo = '2026-02-01T00:00:00Z'
    const { pool, calls, of } = createPool({
      ids: ({ limit }) => idsFrom('dated', Math.min(limit, 5)),
      exact: 5,
    })

    const result = await listConversations(pool, page({ dateFrom, dateTo }), 'alice@example.com', {
      olderCountCache: new OlderConversationCountCache(),
    })

    expect(calls.every(call => !call.sql.includes('INTERVAL'))).toBe(true)
    expect(of('ids')).toHaveLength(1)
    expect(of('recent')).toHaveLength(0)
    expect(of('older')).toHaveLength(0)
    expect(of('exact')).toHaveLength(1)
    for (const call of [...of('ids'), ...of('details'), ...of('exact')]) {
      expect(call.values).toEqual(expect.arrayContaining([dateFrom, dateTo]))
    }
    expect(result.conversations.map(c => c.conversationId)).toEqual(idsFrom('dated', 5))
    expect(result.pagination).toEqual({
      total: 5,
      limit: 50,
      offset: 0,
      hasMore: false,
      page: 1,
      totalPages: 1,
    })
  })

  it('treats a single date bound as explicit too', async () => {
    const { pool, calls, of } = createPool({ exact: 7 })

    const result = await listConversations(pool, page({ dateFrom: '2026-01-01' }), undefined, {
      olderCountCache: new OlderConversationCountCache(),
    })

    expect(calls.every(call => !call.sql.includes('INTERVAL'))).toBe(true)
    expect(of('exact')).toHaveLength(1)
    expect(result.pagination.total).toBe(7)
  })

  it('totals the live recent count plus the cached older count', async () => {
    let now = 1_000_000
    const cache = new OlderConversationCountCache({ ttlMs: 60_000, now: () => now })
    const { pool, state, of } = createPool({ recent: 30, older: () => 45 })

    const first = await listConversations(pool, page(), 'alice@example.com', {
      olderCountCache: cache,
    })
    expect(first.pagination).toEqual({
      total: 75,
      limit: 50,
      offset: 0,
      hasMore: true,
      page: 1,
      totalPages: 2,
    })
    const older = of('older')
    expect(older).toHaveLength(1)
    expect(older[0].sql).not.toContain('LIMIT')
    expect(older[0].values).toEqual(['alice@example.com'])
    expect(of('recent')[0].sql).toContain(WINDOW)

    // Recent stays live, older comes from the cache
    state.recent = 32
    state.older = () => 1000
    now += 59_999
    const second = await listConversations(pool, page({ offset: 50 }), 'alice@example.com', {
      olderCountCache: cache,
    })
    expect(of('older')).toHaveLength(1)
    expect(of('recent')).toHaveLength(2)
    expect(second.pagination.total).toBe(77)
    expect(second.pagination.hasMore).toBe(false)
    expect(second.pagination.page).toBe(2)

    // The cache is keyed by principal, project and account
    await listConversations(pool, page(), 'bob@example.com', { olderCountCache: cache })
    await listConversations(pool, page({ projectId: 'project-a' }), 'alice@example.com', {
      olderCountCache: cache,
    })
    await listConversations(pool, page({ accountId: 'account-1' }), 'alice@example.com', {
      olderCountCache: cache,
    })
    await listConversations(pool, page(), undefined, { olderCountCache: cache })
    expect(of('older')).toHaveLength(5)

    // Recomputed once the TTL has passed
    now += 2
    const third = await listConversations(pool, page(), 'alice@example.com', {
      olderCountCache: cache,
    })
    expect(of('older')).toHaveLength(6)
    expect(third.pagination.total).toBe(1032)
  })

  it('shares one in-flight older count between concurrent requests', async () => {
    let release: (count: number) => void = () => {}
    const { pool, of } = createPool({
      older: () =>
        new Promise<number>(resolve => {
          release = resolve
        }),
    })
    const cache = new OlderConversationCountCache()

    const first = listConversations(pool, page(), 'alice@example.com', { olderCountCache: cache })
    const second = listConversations(pool, page({ offset: 50 }), 'alice@example.com', {
      olderCountCache: cache,
    })
    await waitFor(() => of('older').length > 0 && of('recent').length === 2)
    release(45)

    const results = await Promise.all([first, second])
    expect(of('older')).toHaveLength(1)
    expect(results.map(r => r.pagination.total)).toEqual([75, 75])
  })

  it('does not cache a failed older count', async () => {
    const { pool, state, of } = createPool({
      older: () => Promise.reject(new Error('count failed')),
    })
    const cache = new OlderConversationCountCache()

    await expect(
      listConversations(pool, page(), 'alice@example.com', { olderCountCache: cache })
    ).rejects.toThrow('count failed')

    state.older = () => 45
    const result = await listConversations(pool, page(), 'alice@example.com', {
      olderCountCache: cache,
    })
    expect(of('older')).toHaveLength(2)
    expect(result.pagination.total).toBe(75)
  })

  it('takes anonymous aggregates from the un-windowed details query', async () => {
    const { pool, of } = createPool()

    const result = await listConversations(pool, page(), undefined, {
      olderCountCache: new OlderConversationCountCache(),
    })

    expect(of('ids')[0].sql).toContain(WINDOW)
    expect(of('ids')[0].sql).not.toContain('accessible_projects')
    const details = of('details')
    expect(details).toHaveLength(1)
    expect(details[0].sql).not.toContain('INTERVAL')
    expect(details[0].sql).not.toContain('accessible_projects')

    expect(result.conversations[0]).toEqual({
      conversationId: 'conv-0',
      trainIds: ['project-a'],
      accountIds: ['account-1'],
      projectId: 'project-a',
      accountId: 'account-1',
      firstMessageTime: new Date('2026-01-01T00:00:00Z'),
      lastMessageTime: new Date('2026-09-20T00:00:00Z'),
      messageCount: 12,
      totalTokens: 345,
      branchCount: 3,
      subtaskBranchCount: 1,
      compactBranchCount: 1,
      userBranchCount: 0,
      modelsUsed: ['claude-test'],
      latestRequestId: 'req-conv-0',
      latestModel: 'claude-test',
      latestContextTokens: 16,
      isSubtask: false,
      parentTaskRequestId: null,
      parentConversationId: null,
      subtaskMessageCount: 2,
    })
    expect(result.pagination.total).toBe(75)
  })
})
