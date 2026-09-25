import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Pool } from 'pg'
import { join } from 'node:path'
import {
  listConversations,
  type ConversationListParams,
  type ConversationListPool,
} from '../../services/proxy/src/services/conversation-list'
import { StorageWriter } from '../../services/proxy/src/storage/writer'
import {
  backfillConversationSummaries,
  refreshConversationSummaries,
} from '../../scripts/db/backfill-conversation-summaries'

// Only ever runs against an explicitly named local *_test database
const databaseUrl = process.env.CONVERSATION_SUMMARIES_TEST_DATABASE_URL
const enabled = !!databaseUrl && new URL(databaseUrl).pathname.endsWith('_test')
const root = join(import.meta.dir, '../..')

const PUBLIC_A = 'convsum-test-public-a'
const PUBLIC_B = 'convsum-test-public-b'
const PRIVATE = 'convsum-test-private' // the viewer is not a member
const MEMBER = 'convsum-test-member' // private, the viewer is a member
const VIEWER = 'Viewer@ConvSum.test'
const OTHER_MEMBER = 'other@convsum.test' // member of PRIVATE only
const NON_MEMBER = 'nobody@convsum.test'
const ACC_A = 'convsum-acc-a'
const ACC_B = 'convsum-acc-b'
const ACC_C = 'convsum-acc-c'
const FLAG = 'CONVERSATION_SUMMARIES_ENABLED'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const conv = (n: number) => `c5ab0000-0000-4000-8000-${String(n).padStart(12, '0')}`
const req = (n: number) => `c5ab0001-0000-4000-8000-${String(n).padStart(12, '0')}`
const isSeeded = (conversationId: string) => conversationId.startsWith('c5ab0000-')

type Filters = Omit<ConversationListParams, 'limit' | 'offset'>

interface Seed {
  conversation?: number
  project: string
  account?: string
  at: number
}

describe.skipIf(!enabled)('conversation summaries against PostgreSQL', () => {
  let pool: Pool
  let writer: StorageWriter
  let savedFlag: string | undefined
  let nextRequest = 0
  const now = Date.now()
  const quiet = () => {}
  const base = (c: number) => now - c * 7 * HOUR - 30 * MINUTE

  const seeds = (): Seed[] => {
    const list: Seed[] = []
    // 70 public conversations over ~20 days; every third one used ACC_C last
    for (let c = 0; c < 70; c++) {
      const last = c === 19 ? base(20) : base(c) // 19 and 20 tie on last activity
      const account = c % 2 === 0 ? ACC_A : ACC_B
      list.push({ conversation: c, project: PUBLIC_A, account, at: last - 2 * DAY })
      if (c % 3 === 0) {
        list.push({ conversation: c, project: PUBLIC_A, account, at: last - DAY })
        list.push({ conversation: c, project: PUBLIC_A, account: ACC_C, at: last })
      } else {
        list.push({ conversation: c, project: PUBLIC_A, account, at: last })
      }
    }
    // Conversations in two public projects, newest in either one
    for (let c = 70; c < 75; c++) {
      const offset = (c - 70) * 5 * HOUR
      list.push({
        conversation: c,
        project: PUBLIC_A,
        account: ACC_A,
        at: now - offset - (c % 2 ? HOUR : 3 * HOUR),
      })
      list.push({
        conversation: c,
        project: PUBLIC_B,
        account: ACC_B,
        at: now - offset - (c % 2 ? 3 * HOUR : HOUR),
      })
    }
    // Public conversations whose newest request is in the private project
    for (let c = 75; c < 80; c++) {
      list.push({
        conversation: c,
        project: PUBLIC_A,
        account: ACC_A,
        at: now - 2 * DAY - (c - 75) * HOUR,
      })
      list.push({ conversation: c, project: PRIVATE, account: ACC_A, at: now - 10 * MINUTE })
    }
    for (let c = 80; c < 85; c++) {
      list.push({
        conversation: c,
        project: PRIVATE,
        account: ACC_B,
        at: now - (c - 80) * 3 * HOUR - 20 * MINUTE,
      })
    }
    for (let c = 85; c < 90; c++) {
      list.push({
        conversation: c,
        project: MEMBER,
        account: ACC_B,
        at: now - (c - 85) * 4 * HOUR - 40 * MINUTE,
      })
    }
    // Long-idle conversations spanning several chunks; 90 starts without an account
    for (let c = 90; c < 100; c++) {
      list.push({
        conversation: c,
        project: PUBLIC_A,
        account: c === 90 ? undefined : ACC_A,
        at: now - 40 * DAY - c * HOUR,
      })
      list.push({
        conversation: c,
        project: PUBLIC_A,
        account: ACC_B,
        at: now - 30 * DAY - c * HOUR,
      })
    }
    // A conversation without any account, and requests outside any conversation
    list.push({ conversation: 100, project: PUBLIC_A, at: now - 35 * DAY })
    list.push({ conversation: 100, project: PUBLIC_A, at: now - 34 * DAY })
    for (let i = 0; i < 3; i++) {
      list.push({ project: PUBLIC_A, account: ACC_A, at: now - i * HOUR })
    }
    return list
  }
  const SEED_GROUPS = 111

  const store = (seed: Seed) =>
    writer.storeRequest({
      requestId: req(nextRequest++),
      projectId: seed.project,
      accountId: seed.account,
      timestamp: new Date(seed.at),
      method: 'POST',
      path: '/v1/messages',
      headers: {},
      body: { messages: [{ role: 'user', content: 'seeded request' }] },
      apiKey: '',
      model: 'claude-test',
      requestType: 'inference',
      conversationId: seed.conversation === undefined ? undefined : conv(seed.conversation),
      parentMessageHash: 'convsum-parent',
    })

  const cleanUp = async () => {
    await pool.query(`DELETE FROM api_requests WHERE request_id::text LIKE 'c5ab0001-%'`)
    await pool.query(
      `DELETE FROM conversation_summaries WHERE conversation_id::text LIKE 'c5ab0000-%'`
    )
    await pool.query(`DELETE FROM projects WHERE project_id LIKE 'convsum-test-%'`)
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl })
    savedFlag = process.env[FLAG]
    process.env[FLAG] = 'true'
    await cleanUp()
    // Other suites store requests without StorageWriter or delete them afterwards:
    // start from a table derived from api_requests
    await pool.query('DELETE FROM conversation_summaries')
    await backfillConversationSummaries(pool, { chunkDays: 7, execute: true }, quiet)

    for (const [projectId, isPrivate] of [
      [PUBLIC_A, false],
      [PUBLIC_B, false],
      [PRIVATE, true],
      [MEMBER, true],
    ] as const) {
      await pool.query(
        `INSERT INTO projects (project_id, name, is_private, api_key) VALUES ($1, $1, $2, $3)`,
        [projectId, isPrivate, `${projectId}-key`]
      )
    }
    for (const [projectId, email] of [
      [PRIVATE, OTHER_MEMBER],
      [MEMBER, VIEWER],
    ]) {
      await pool.query(
        `INSERT INTO project_members (project_id, user_email, role, added_by)
         SELECT id, $2, 'member', 'conversation-summaries-test' FROM projects WHERE project_id = $1`,
        [projectId, email]
      )
    }

    writer = new StorageWriter(pool)
    // Out of chronological order, so first/last activity rely on LEAST/GREATEST
    const ordered = seeds()
      .map((seed, index) => ({ seed, key: (index * 7919) % 1009 }))
      .sort((a, b) => a.key - b.key)
      .map(entry => entry.seed)
    for (const seed of ordered) {
      await store(seed)
    }
  })

  afterAll(async () => {
    await cleanUp()
    await pool.end()
    if (savedFlag === undefined) {
      delete process.env[FLAG]
    } else {
      process.env[FLAG] = savedFlag
    }
  })

  const tableRows = async () =>
    (
      await pool.query(
        `SELECT conversation_id, project_id, first_activity_at, last_activity_at,
                ARRAY(SELECT unnest(account_ids) ORDER BY 1) AS account_ids
         FROM conversation_summaries
         WHERE conversation_id::text LIKE 'c5ab0000-%'
         ORDER BY conversation_id, project_id`
      )
    ).rows

  /** Grouped from api_requests, independently of the code under test */
  const groupedReference = async () =>
    (
      await pool.query(
        `SELECT conversation_id, project_id,
                MIN(timestamp) AS first_activity_at,
                MAX(timestamp) AS last_activity_at,
                COALESCE(ARRAY_AGG(DISTINCT account_id::text ORDER BY account_id::text)
                  FILTER (WHERE account_id IS NOT NULL), '{}') AS account_ids
         FROM api_requests
         WHERE conversation_id::text LIKE 'c5ab0000-%'
         GROUP BY conversation_id, project_id
         ORDER BY conversation_id, project_id`
      )
    ).rows

  const visibility = `
         ar.conversation_id IS NOT NULL
         AND ($1::text IS NULL OR ar.project_id IN (
           SELECT p.project_id FROM projects p
           WHERE NOT p.is_private
              OR EXISTS (
                SELECT 1 FROM project_members pm
                WHERE pm.project_id = p.id AND LOWER(pm.user_email) = LOWER($1)
              )
         ))
         AND ($2::text IS NULL OR ar.project_id = $2)
         AND ($3::text IS NULL OR ar.account_id = $3)`

  /** Request-level reference over the whole database, written independently of the code under test */
  const reference = async (
    principal: string | undefined,
    filters: Filters,
    limit: number,
    offset: number
  ) => {
    const values = [principal?.trim() || null, filters.projectId ?? null, filters.accountId ?? null]
    const ids = await pool.query(
      `SELECT ar.conversation_id
       FROM api_requests ar
       WHERE ${visibility}
       GROUP BY ar.conversation_id
       ORDER BY MAX(ar.timestamp) DESC, ar.conversation_id DESC
       LIMIT $4 OFFSET $5`,
      [...values, limit, offset]
    )
    const total = await pool.query(
      `SELECT COUNT(DISTINCT ar.conversation_id)::int AS total
       FROM api_requests ar
       WHERE ${visibility}`,
      values
    )
    return {
      ids: ids.rows.map((row: { conversation_id: string }) => row.conversation_id),
      total: total.rows[0].total as number,
    }
  }

  const listed = async (principal: string | undefined, params: ConversationListParams) => {
    const statements: string[] = []
    const spy = {
      query: (sql: string, values?: unknown[]) => {
        statements.push(sql)
        return pool.query(sql, values)
      },
    } as unknown as ConversationListPool
    const result = await listConversations(spy, params, principal)
    return {
      ids: result.conversations.map(item => item.conversationId),
      conversations: result.conversations,
      total: result.pagination.total,
      statements,
    }
  }

  it('migration 027 is idempotent', async () => {
    for (let run = 0; run < 2; run++) {
      const child = Bun.spawn(
        [
          'bun',
          '--no-env-file',
          join(root, 'scripts/db/migrations/027-add-conversation-summaries.ts'),
          'up',
        ],
        {
          cwd: root,
          env: { ...process.env, DATABASE_URL: databaseUrl },
          stdout: 'ignore',
          stderr: 'inherit',
        }
      )
      expect(await child.exited).toBe(0)
    }
  })

  it('the writer keeps one row per conversation and project', async () => {
    const stored = await pool.query(
      `SELECT COUNT(*)::int AS requests,
              COUNT(*) FILTER (WHERE conversation_id IS NULL)::int AS without_conversation
       FROM api_requests WHERE request_id::text LIKE 'c5ab0001-%'`
    )
    expect(stored.rows[0]).toEqual({ requests: seeds().length, without_conversation: 3 })

    const expected = await groupedReference()
    expect(expected).toHaveLength(SEED_GROUPS)
    expect(await tableRows()).toEqual(expected)
  })

  const cases: Array<{ name: string; principal?: string; filters: Filters }> = [
    { name: 'anonymous', filters: {} },
    { name: 'anonymous with projectId', filters: { projectId: PUBLIC_A } },
    { name: 'member', principal: VIEWER, filters: {} },
    {
      name: 'member with their private project',
      principal: VIEWER,
      filters: { projectId: MEMBER },
    },
    { name: 'member of the private project', principal: OTHER_MEMBER, filters: {} },
    { name: 'non-member', principal: NON_MEMBER, filters: {} },
    {
      name: 'non-member with a private projectId',
      principal: NON_MEMBER,
      filters: { projectId: PRIVATE },
    },
    { name: 'anonymous with accountId', filters: { accountId: ACC_A } },
    {
      name: 'member with projectId and accountId',
      principal: VIEWER,
      filters: { projectId: PUBLIC_A, accountId: ACC_C },
    },
  ]

  for (const testCase of cases) {
    it(`pages 1-3 and the total match the request-level reference: ${testCase.name}`, async () => {
      for (const offset of [0, 20, 40]) {
        const expected = await reference(testCase.principal, testCase.filters, 20, offset)
        const result = await listed(testCase.principal, { ...testCase.filters, limit: 20, offset })

        expect(result.ids).toEqual(expected.ids)
        expect(result.total).toBe(expected.total)
        if (!testCase.filters.accountId) {
          // Page IDs and totals never scan api_requests; only the details query does
          expect(
            result.statements.filter(
              sql => sql.includes('FROM api_requests') && !sql.includes('conversation_rollups')
            )
          ).toEqual([])
        }
      }
    })
  }

  it('orders a cross-project conversation by its accessible activity only', async () => {
    // Their newest requests are in the private project, tied, so by id descending
    const anonymous = await listed(undefined, { limit: 20, offset: 0 })
    expect(anonymous.ids.filter(isSeeded).slice(0, 5)).toEqual([79, 78, 77, 76, 75].map(conv))

    const expected = await reference(VIEWER, {}, 60, 0)
    const viewer = await listed(VIEWER, { limit: 60, offset: 0 })
    expect(viewer.ids).toEqual(expected.ids)
    expect(viewer.ids.filter(isSeeded).slice(0, 5)).not.toContain(conv(75))
    const item = viewer.conversations.find(c => c.conversationId === conv(75))
    expect(item?.trainIds).toEqual([PUBLIC_A])
  })

  it("orders accountId pages by that account's own activity", async () => {
    const filters = { projectId: PUBLIC_A, accountId: ACC_A }
    const byRowActivity = await pool.query(
      `SELECT conversation_id FROM conversation_summaries
       WHERE project_id = $1 AND account_ids @> ARRAY[$2::text]
       ORDER BY last_activity_at DESC, conversation_id DESC
       LIMIT 20`,
      [PUBLIC_A, ACC_A]
    )
    const expected = await reference(undefined, filters, 20, 0)
    // Only meaningful while the account's own order differs from the rows' order
    expect(byRowActivity.rows.map(row => row.conversation_id)).not.toEqual(expected.ids)

    const result = await listed(undefined, { ...filters, limit: 20, offset: 0 })
    expect(result.ids).toEqual(expected.ids)
    expect(result.total).toBe(expected.total)
  })

  it('explicit dates keep the request-level path', async () => {
    const result = await listed(VIEWER, {
      dateFrom: new Date(now - 10 * DAY).toISOString(),
      dateTo: new Date(now).toISOString(),
      limit: 20,
      offset: 0,
    })

    expect(result.statements.some(sql => sql.includes('conversation_summaries'))).toBe(false)
    expect(
      result.statements.some(sql => sql.includes('COUNT(DISTINCT ar.conversation_id) AS total'))
    ).toBe(true)
  })

  it('a backfill after live writes changes nothing', async () => {
    const result = await backfillConversationSummaries(pool, { chunkDays: 7, execute: true }, quiet)

    expect(result.changed).toBe(0)
    expect(result.groups).toBeGreaterThanOrEqual(SEED_GROUPS)
    expect(await tableRows()).toEqual(await groupedReference())
  })

  it('a backfill alone rebuilds the rows across chunk boundaries and is idempotent', async () => {
    await pool.query(
      `DELETE FROM conversation_summaries WHERE conversation_id::text LIKE 'c5ab0000-%'`
    )

    const first = await backfillConversationSummaries(pool, { chunkDays: 1, execute: true }, quiet)
    expect(first.changed).toBeGreaterThanOrEqual(SEED_GROUPS)
    expect(await tableRows()).toEqual(await groupedReference())

    const again = await backfillConversationSummaries(pool, { chunkDays: 1, execute: true }, quiet)
    expect(again.changed).toBe(0)
  })

  it('live writes after a backfill converge', async () => {
    await pool.query(
      `DELETE FROM conversation_summaries WHERE conversation_id::text LIKE 'c5ab0000-%'`
    )
    await backfillConversationSummaries(pool, { chunkDays: 7, execute: true }, quiet)

    await store({ conversation: 5, project: PUBLIC_A, account: ACC_B, at: now - 60 * DAY }) // before its first activity
    await store({ conversation: 6, project: PUBLIC_A, account: ACC_A, at: base(6) + 5 * MINUTE }) // after its last
    await store({ conversation: 7, project: PUBLIC_A, account: ACC_C, at: base(7) - HOUR }) // a new account
    await store({ conversation: 8, project: PUBLIC_B, account: ACC_A, at: base(8) - HOUR }) // a new project

    expect(await tableRows()).toEqual(await groupedReference())
  })

  it('converges when the backfill runs concurrently with live writes', async () => {
    await pool.query(
      `DELETE FROM conversation_summaries WHERE conversation_id::text LIKE 'c5ab0000-%'`
    )

    await Promise.all([
      backfillConversationSummaries(pool, { chunkDays: 1, execute: true }, quiet),
      ...[10, 11, 12, 13, 14, 15].map((c, i) =>
        store({
          conversation: c,
          project: i % 2 ? PUBLIC_B : PUBLIC_A,
          account: ACC_C,
          at: base(c) - i * DAY,
        })
      ),
    ])

    expect(await tableRows()).toEqual(await groupedReference())
  })

  it('refreshConversationSummaries repairs rows a re-key outside the proxy left stale', async () => {
    const oldId = conv(200)
    const newId = conv(201)
    const rowsFor = (rows: Array<{ conversation_id: string }>, id: string) =>
      rows.filter(row => row.conversation_id === id)

    const firstRequest = nextRequest
    await store({ conversation: 200, project: PUBLIC_A, account: ACC_A, at: now - 5 * DAY })
    await store({ conversation: 200, project: PUBLIC_A, account: ACC_B, at: now - 4 * DAY })
    await store({ conversation: 200, project: PUBLIC_A, account: ACC_A, at: now - 3 * DAY })
    // Re-key two of the three requests the way rebuild-conversations.ts does: plain SQL against
    // api_requests, which never touches conversation_summaries
    const movedRequestIds = [req(firstRequest + 1), req(firstRequest + 2)]
    await pool.query(
      `UPDATE api_requests SET conversation_id = $2 WHERE request_id = ANY($1::uuid[])`,
      [movedRequestIds, newId]
    )

    // Before refresh: the old row is stale (still reflects all 3 original requests) and the new
    // id has no row at all, even though api_requests now has two of its own
    const staleOldRow = rowsFor(await tableRows(), oldId)
    const correctOldRow = rowsFor(await groupedReference(), oldId)
    expect(staleOldRow).not.toEqual(correctOldRow)
    expect(rowsFor(await tableRows(), newId)).toEqual([])
    expect(rowsFor(await groupedReference(), newId)).not.toEqual([])

    const result = await refreshConversationSummaries(pool, [oldId, newId], quiet)
    expect(result.conversations).toBe(2)

    expect(rowsFor(await tableRows(), oldId)).toEqual(rowsFor(await groupedReference(), oldId))
    expect(rowsFor(await tableRows(), newId)).toEqual(rowsFor(await groupedReference(), newId))

    // Idempotent: refreshing an already-correct pair changes nothing
    const again = await refreshConversationSummaries(pool, [oldId, newId], quiet)
    expect(again.conversations).toBe(2)
    expect(rowsFor(await tableRows(), oldId)).toEqual(rowsFor(await groupedReference(), oldId))
    expect(rowsFor(await tableRows(), newId)).toEqual(rowsFor(await groupedReference(), newId))
  })

  it('backfillConversationSummaries releases its connection without leaking session settings (M3)', async () => {
    // max: 1 forces the very next query on this pool to reuse the connection the backfill used,
    // unless it was actually destroyed rather than returned to the pool
    const leakPool = new Pool({ connectionString: databaseUrl, max: 1 })
    try {
      await backfillConversationSummaries(leakPool, { chunkDays: 7, execute: false }, quiet)

      const lockTimeout = await leakPool.query('SHOW lock_timeout')
      const applicationName = await leakPool.query('SHOW application_name')

      const freshPool = new Pool({ connectionString: databaseUrl, max: 1 })
      try {
        const freshLockTimeout = await freshPool.query('SHOW lock_timeout')
        const freshApplicationName = await freshPool.query('SHOW application_name')

        expect(lockTimeout.rows[0].lock_timeout).toBe(freshLockTimeout.rows[0].lock_timeout)
        expect(applicationName.rows[0].application_name).toBe(
          freshApplicationName.rows[0].application_name
        )
      } finally {
        await freshPool.end()
      }
    } finally {
      await leakPool.end()
    }
  })
})
