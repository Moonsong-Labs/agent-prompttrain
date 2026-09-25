import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  conversationSummariesEnabled,
  listConversations,
  OlderConversationCountCache,
  SUMMARY_SCAN_SLACK,
  type ConversationListParams,
  type ConversationListPool,
} from '../src/services/conversation-list'

const FLAG = 'CONVERSATION_SUMMARIES_ENABLED'

type QueryKind =
  | 'projects'
  | 'summary-ids'
  | 'summary-total'
  | 'details'
  | 'ids'
  | 'recent'
  | 'older'
  | 'exact'

interface RecordedQuery {
  kind: QueryKind
  sql: string
  values: unknown[]
}

interface SummaryRow {
  conversation_id: string
  project_id: string
  last_activity_at: Date
  account_ids: string[]
}

interface PoolState {
  /** Projects the principal may see */
  accessible: string[]
  /** conversation_summaries rows, newest first as the index returns them */
  summaries: SummaryRow[]
  /** IDs returned by the request-level page-ID query */
  requestIds: string[]
}

function classify(sql: string): QueryKind {
  if (sql.includes('FROM conversation_summaries')) {
    return sql.includes('COUNT(DISTINCT cs.conversation_id)') ? 'summary-total' : 'summary-ids'
  }
  if (sql.includes('conversation_rollups')) {
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
  if (sql.includes('FROM api_requests')) {
    return 'ids'
  }
  if (sql.includes('FROM projects p')) {
    return 'projects'
  }
  throw new Error(`Unexpected query: ${sql}`)
}

/** Applies the project and account conditions of a conversation_summaries query */
function matching(sql: string, values: unknown[], rows: SummaryRow[]): SummaryRow[] {
  const valueOf = (match: RegExpMatchArray | null) =>
    match ? values[Number(match[1]) - 1] : undefined
  const anyProject = valueOf(sql.match(/cs\.project_id = ANY\(\$(\d+)::text\[\]\)/)) as
    | string[]
    | undefined
  const oneProject = valueOf(sql.match(/cs\.project_id = \$(\d+)/)) as string | undefined
  const account = valueOf(sql.match(/cs\.account_ids @> ARRAY\[\$(\d+)::text\]/)) as
    | string
    | undefined
  return rows.filter(
    row =>
      (anyProject === undefined || anyProject.includes(row.project_id)) &&
      (oneProject === undefined || row.project_id === oneProject) &&
      (account === undefined || row.account_ids.includes(account))
  )
}

function detailRow(conversationId: string) {
  return {
    conversation_id: conversationId,
    train_ids: ['project-a'],
    account_ids: ['acc-1'],
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
    latest_response_body: { usage: { input_tokens: 10 } },
    parent_task_request_id: null,
    parent_conversation_id: null,
  }
}

const idsFrom = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}-${i}`)

const summary = (
  conversationId: string,
  projectId: string,
  minutesAgo: number,
  accountIds: string[] = ['acc-1']
): SummaryRow => ({
  conversation_id: conversationId,
  project_id: projectId,
  last_activity_at: new Date(Date.UTC(2026, 8, 20) - minutesAgo * 60_000),
  account_ids: accountIds,
})

const summariesFor = (count: number, projectId = 'project-a') =>
  Array.from({ length: count }, (_, i) => summary(`conv-${i}`, projectId, i))

function createPool(overrides: Partial<PoolState> = {}) {
  const state: PoolState = {
    accessible: ['project-a'],
    summaries: summariesFor(75),
    requestIds: idsFrom('conv', 50),
    ...overrides,
  }
  const calls: RecordedQuery[] = []

  const pool = {
    async query(sql: string, values: unknown[] = []) {
      const kind = classify(sql)
      calls.push({ kind, sql, values })

      switch (kind) {
        case 'projects':
          return { rows: state.accessible.map(project_id => ({ project_id })) }
        case 'summary-ids': {
          const limit = Number(values[values.length - 1])
          return {
            rows: matching(sql, values, state.summaries)
              .slice(0, limit)
              .map(({ conversation_id, last_activity_at }) => ({
                conversation_id,
                last_activity_at,
              })),
          }
        }
        case 'summary-total': {
          const ids = new Set(
            matching(sql, values, state.summaries).map(row => row.conversation_id)
          )
          return { rows: [{ total: String(ids.size) }] }
        }
        case 'details': {
          const ids = values.find(Array.isArray) as string[]
          return { rows: ids.map(detailRow) }
        }
        case 'ids': {
          const match = sql.match(/LIMIT \$(\d+)\s+OFFSET \$(\d+)/)
          if (!match) {
            throw new Error('page ID query without LIMIT/OFFSET placeholders')
          }
          const limit = Number(values[Number(match[1]) - 1])
          const offset = Number(values[Number(match[2]) - 1])
          return {
            rows: state.requestIds
              .slice(offset, offset + limit)
              .map(conversation_id => ({ conversation_id })),
          }
        }
        case 'recent':
          return { rows: [{ recent_total: '30' }] }
        case 'older':
          return { rows: [{ older_total: '45' }] }
        case 'exact':
          return { rows: [{ total: '99' }] }
      }
    },
  }

  return {
    pool: pool as unknown as ConversationListPool,
    calls,
    of: (kind: QueryKind) => calls.filter(call => call.kind === kind),
  }
}

const page = (overrides: Partial<ConversationListParams> = {}): ConversationListParams => ({
  limit: 50,
  offset: 0,
  ...overrides,
})

let savedFlag: string | undefined

beforeEach(() => {
  savedFlag = process.env[FLAG]
  process.env[FLAG] = 'true'
})

afterEach(() => {
  if (savedFlag === undefined) {
    delete process.env[FLAG]
  } else {
    process.env[FLAG] = savedFlag
  }
})

describe('listConversations with CONVERSATION_SUMMARIES_ENABLED=true', () => {
  it('selects page IDs and the exact total from conversation_summaries only', async () => {
    const { pool, calls, of } = createPool()

    const result = await listConversations(pool, page(), undefined)

    expect(SUMMARY_SCAN_SLACK).toBe(32)
    expect(of('summary-ids')).toHaveLength(1)
    const [ids] = of('summary-ids')
    expect(ids.sql).toContain('ORDER BY cs.last_activity_at DESC, cs.conversation_id DESC')
    expect(ids.sql).not.toContain('WHERE')
    expect(ids.values).toEqual([50 + SUMMARY_SCAN_SLACK])
    expect(of('summary-total')).toHaveLength(1)
    expect(of('summary-total')[0].values).toEqual([])
    expect(of('projects')).toHaveLength(0)
    // api_requests is only read for the details of the selected page
    expect(calls.filter(call => call.sql.includes('api_requests')).map(call => call.kind)).toEqual([
      'details',
    ])
    expect(of('details')[0].values).toContainEqual(idsFrom('conv', 50))
    expect(result.conversations.map(c => c.conversationId)).toEqual(idsFrom('conv', 50))
    expect(result.pagination).toEqual({
      total: 75,
      limit: 50,
      offset: 0,
      hasMore: true,
      page: 1,
      totalPages: 2,
    })
  })

  it('restricts a principal to the accessible projects in both queries', async () => {
    const { pool, of } = createPool({
      accessible: ['project-a', 'project-b'],
      summaries: [summary('conv-hidden', 'project-c', 0), ...summariesFor(3)],
    })

    const result = await listConversations(pool, page(), ' Alice@Example.com ')

    expect(of('projects')).toHaveLength(1)
    expect(of('projects')[0].values).toEqual(['alice@example.com'])
    expect(of('projects')[0].sql).toContain('LOWER(pm.user_email) = $1')
    for (const query of [...of('summary-ids'), ...of('summary-total')]) {
      expect(query.sql).toContain('cs.project_id = ANY($1::text[])')
      expect(query.values[0]).toEqual(['project-a', 'project-b'])
    }
    expect(of('details')[0].sql).toContain('accessible_projects')
    expect(of('details')[0].values).toContain('alice@example.com')
    expect(result.conversations.map(c => c.conversationId)).toEqual(idsFrom('conv', 3))
    expect(result.pagination.total).toBe(3)
  })

  it('intersects projectId with the accessible projects', async () => {
    const { pool, of } = createPool({
      accessible: ['project-a', 'project-b'],
      summaries: [summary('conv-a', 'project-a', 0), summary('conv-b', 'project-b', 1)],
    })

    const result = await listConversations(
      pool,
      page({ projectId: 'project-b' }),
      'alice@example.com'
    )

    for (const query of [...of('summary-ids'), ...of('summary-total')]) {
      expect(query.sql).toContain('cs.project_id = $1')
      expect(query.values[0]).toBe('project-b')
    }
    expect(of('details')[0].values).toEqual(
      expect.arrayContaining(['alice@example.com', 'project-b'])
    )
    expect(result.conversations.map(c => c.conversationId)).toEqual(['conv-b'])
    expect(result.pagination.total).toBe(1)
  })

  it('returns nothing when no project is accessible', async () => {
    const cases: Array<[string[], ConversationListParams]> = [
      [[], page()],
      [['project-a'], page({ projectId: 'project-private' })],
      [[], page({ accountId: 'acc-1' })],
    ]
    for (const [accessible, params] of cases) {
      const { pool, calls } = createPool({ accessible })

      const result = await listConversations(pool, params, 'alice@example.com')

      // An empty project list must never widen to every project
      expect(calls.map(call => call.kind)).toEqual(['projects'])
      expect(result.conversations).toEqual([])
      expect(result.pagination).toEqual({
        total: 0,
        limit: 50,
        offset: 0,
        hasMore: false,
        page: 1,
        totalPages: 0,
      })
    }
  })

  it('filters an anonymous projectId directly on the table', async () => {
    const { pool, of } = createPool({
      summaries: [summary('conv-a', 'project-a', 0), summary('conv-b', 'project-b', 1)],
    })

    const result = await listConversations(pool, page({ projectId: 'project-a' }), undefined)

    expect(of('projects')).toHaveLength(0)
    expect(of('summary-ids')[0].sql).toContain('cs.project_id = $1')
    expect(of('summary-ids')[0].values).toEqual(['project-a', 50 + SUMMARY_SCAN_SLACK])
    expect(result.conversations.map(c => c.conversationId)).toEqual(['conv-a'])
    expect(result.pagination.total).toBe(1)
  })

  it('de-duplicates conversations listed under several projects, keeping the newest row', async () => {
    const { pool, of } = createPool({
      summaries: [
        summary('conv-0', 'project-a', 0),
        summary('conv-1', 'project-b', 1),
        summary('conv-0', 'project-b', 2),
        summary('conv-2', 'project-a', 3),
        summary('conv-1', 'project-a', 4),
        summary('conv-3', 'project-a', 5),
      ],
    })

    const first = await listConversations(pool, page({ limit: 2 }), undefined)
    const second = await listConversations(pool, page({ limit: 2, offset: 2 }), undefined)

    expect(first.conversations.map(c => c.conversationId)).toEqual(['conv-0', 'conv-1'])
    expect(second.conversations.map(c => c.conversationId)).toEqual(['conv-2', 'conv-3'])
    expect(of('details')[1].values).toContainEqual(['conv-2', 'conv-3'])
    expect([first.pagination.total, second.pagination.total]).toEqual([4, 4])
    expect(of('summary-ids').map(query => query.values.at(-1))).toEqual([
      2 + SUMMARY_SCAN_SLACK,
      4 + SUMMARY_SCAN_SLACK,
    ])
  })

  it('scans again with a doubled limit when duplicates exceed the slack', async () => {
    const scanLimit = 2 + SUMMARY_SCAN_SLACK
    const { pool, of } = createPool({
      summaries: [
        ...Array.from({ length: scanLimit }, (_, i) => summary('conv-dup', `project-${i}`, i)),
        summary('conv-a', 'project-a', 100),
        summary('conv-b', 'project-a', 101),
      ],
    })

    const result = await listConversations(pool, page({ limit: 2 }), undefined)

    expect(of('summary-ids').map(query => query.values.at(-1))).toEqual([scanLimit, 2 * scanLimit])
    expect(result.conversations.map(c => c.conversationId)).toEqual(['conv-dup', 'conv-a'])
    expect(result.pagination.total).toBe(3)
  })

  it('stops scanning at the end of the table', async () => {
    const { pool, of } = createPool({ summaries: summariesFor(5) })

    const result = await listConversations(pool, page({ offset: 100 }), undefined)

    expect(of('summary-ids')).toHaveLength(1)
    expect(of('details')).toHaveLength(0)
    expect(result.conversations).toEqual([])
    expect(result.pagination).toEqual({
      total: 5,
      limit: 50,
      offset: 100,
      hasMore: false,
      page: 3,
      totalPages: 1,
    })
  })

  it('keeps the request-level page selection for accountId and counts from the table', async () => {
    // conv-1's row is newer, but its activity with acc-1 can be older than conv-0's
    const { pool, of } = createPool({
      summaries: [
        summary('conv-1', 'project-a', 0, ['acc-1', 'acc-2']),
        summary('conv-0', 'project-a', 1, ['acc-1']),
        summary('conv-2', 'project-a', 2, ['acc-2']),
      ],
      requestIds: ['conv-0', 'conv-1'],
    })

    const result = await listConversations(pool, page({ accountId: 'acc-1' }), 'alice@example.com')

    expect(of('summary-ids')).toHaveLength(0)
    const ids = of('ids')
    expect(ids[0].sql).toContain("INTERVAL '7 days'")
    expect(ids[0].values).toEqual(expect.arrayContaining(['alice@example.com', 'acc-1']))
    const [total] = of('summary-total')
    expect(total.sql).toContain('cs.account_ids @> ARRAY[$2::text]')
    expect(total.values).toEqual(['project-a', 'acc-1'])
    expect([...of('recent'), ...of('older'), ...of('exact')]).toHaveLength(0)
    expect(result.conversations.map(c => c.conversationId)).toEqual(['conv-0', 'conv-1'])
    expect(result.pagination.total).toBe(2)
  })

  it('keeps the #213 paths unless the flag is exactly "true", and for explicit dates', async () => {
    for (const value of [undefined, '', 'false', 'TRUE', '1', ' true']) {
      if (value === undefined) {
        delete process.env[FLAG]
      } else {
        process.env[FLAG] = value
      }
      const { pool, of } = createPool()

      await listConversations(pool, page(), 'alice@example.com', {
        olderCountCache: new OlderConversationCountCache(),
      })

      expect(conversationSummariesEnabled()).toBe(false)
      expect([...of('projects'), ...of('summary-ids'), ...of('summary-total')]).toHaveLength(0)
      expect(of('recent')).toHaveLength(1)
      expect(of('older')).toHaveLength(1)
    }

    process.env[FLAG] = 'true'
    const dated = createPool()
    await listConversations(dated.pool, page({ dateFrom: '2026-01-01' }), 'alice@example.com', {
      olderCountCache: new OlderConversationCountCache(),
    })
    expect(dated.of('exact')).toHaveLength(1)
    expect([
      ...dated.of('projects'),
      ...dated.of('summary-ids'),
      ...dated.of('summary-total'),
    ]).toHaveLength(0)
  })

  it('reads the flag on every call and honours the summaries option', async () => {
    const { pool, of } = createPool()
    const olderCountCache = new OlderConversationCountCache()

    await listConversations(pool, page(), undefined)
    delete process.env[FLAG]
    await listConversations(pool, page(), undefined, { olderCountCache })
    expect(of('summary-ids')).toHaveLength(1)
    expect(of('recent')).toHaveLength(1)

    await listConversations(pool, page(), undefined, { summaries: true })
    expect(of('summary-ids')).toHaveLength(2)

    process.env[FLAG] = 'true'
    await listConversations(pool, page(), undefined, { summaries: false, olderCountCache })
    expect(of('recent')).toHaveLength(2)
    expect(of('summary-ids')).toHaveLength(2)
  })
})
