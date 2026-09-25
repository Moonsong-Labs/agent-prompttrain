import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Pool } from 'pg'
import { StorageWriter } from '../../services/proxy/src/storage/writer'
import { backfillConversationSummaries } from '../../scripts/db/backfill-conversation-summaries'
import { verifyConversationSummaries } from '../../scripts/db/verify-conversation-summaries'

// Only ever runs against an explicitly named local *_test database
const databaseUrl = process.env.CONVERSATION_SUMMARIES_TEST_DATABASE_URL
const enabled = !!databaseUrl && new URL(databaseUrl).pathname.endsWith('_test')

const PROJECT = 'convsum-verify-public'
const PRIVATE_PROJECT = 'convsum-verify-private'
const MEMBER = 'member@convsum-verify.test'
const conv = (n: number) => `c5ab0010-0000-4000-8000-${String(n).padStart(12, '0')}`
const req = (n: number) => `c5ab0011-0000-4000-8000-${String(n).padStart(12, '0')}`
const PHANTOM = conv(999)

describe.skipIf(!enabled)('verify-conversation-summaries against PostgreSQL', () => {
  let pool: Pool
  const quiet = () => {}
  const options = { principals: 5, pageSize: 5, settleSeconds: 0 }
  const refill = () => backfillConversationSummaries(pool, { chunkDays: 7, execute: true }, quiet)

  const cleanUp = async () => {
    await pool.query(`DELETE FROM api_requests WHERE request_id::text LIKE 'c5ab0011-%'`)
    await pool.query(
      `DELETE FROM conversation_summaries WHERE conversation_id::text LIKE 'c5ab0010-%'`
    )
    await pool.query(`DELETE FROM projects WHERE project_id LIKE 'convsum-verify-%'`)
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl })
    await cleanUp()
    for (const [projectId, isPrivate] of [
      [PROJECT, false],
      [PRIVATE_PROJECT, true],
    ] as const) {
      await pool.query(
        `INSERT INTO projects (project_id, name, is_private, api_key) VALUES ($1, $1, $2, $3)`,
        [projectId, isPrivate, `${projectId}-key`]
      )
    }
    await pool.query(
      `INSERT INTO project_members (project_id, user_email, role, added_by)
       SELECT id, $2, 'member', 'verify-conversation-summaries-test' FROM projects WHERE project_id = $1`,
      [PRIVATE_PROJECT, MEMBER]
    )

    const writer = new StorageWriter(pool)
    const now = Date.now()
    // 8 conversations over 12 requests; 0, 1 and 3 span both projects
    for (let n = 0; n < 12; n++) {
      await writer.storeRequest({
        requestId: req(n),
        projectId: n % 3 === 0 ? PRIVATE_PROJECT : PROJECT,
        accountId: n % 2 === 0 ? 'convsum-verify-acc-a' : 'convsum-verify-acc-b',
        timestamp: new Date(now - n * 3_600_000),
        method: 'POST',
        path: '/v1/messages',
        headers: {},
        body: { messages: [{ role: 'user', content: 'verify request' }] },
        apiKey: '',
        model: 'claude-test',
        requestType: 'inference',
        conversationId: conv(n % 8),
        parentMessageHash: 'verify-parent',
      })
    }

    // Other suites store requests without StorageWriter or delete them afterwards
    await pool.query('DELETE FROM conversation_summaries')
    await refill()
  })

  afterAll(async () => {
    await cleanUp()
    await pool.end()
  })

  it('finds no mismatch on a consistent table', async () => {
    const lines: string[] = []

    const mismatches = await verifyConversationSummaries(pool, options, line => lines.push(line))

    expect(mismatches).toEqual([])
    expect(lines.some(line => line.startsWith('principal-1:'))).toBe(true)
    expect(lines.some(line => line.startsWith('busiest-project:'))).toBe(true)
    expect(lines.some(line => line.startsWith('busiest-account:'))).toBe(true)
  })

  it('reports a stale row, a missing row and the page they disturb', async () => {
    await pool.query(
      `INSERT INTO conversation_summaries (conversation_id, project_id, first_activity_at, last_activity_at)
       VALUES ($1, $2, now(), now())`,
      [PHANTOM, PROJECT]
    )
    await pool.query('DELETE FROM conversation_summaries WHERE conversation_id = $1', [conv(1)])
    try {
      const mismatches = await verifyConversationSummaries(pool, options, quiet)

      expect(mismatches).toContain(`stale:${PHANTOM}`)
      expect(mismatches).toContain(`missing:${conv(1)}`)
      expect(mismatches.some(mismatch => mismatch.startsWith('pages:anonymous:'))).toBe(true)
    } finally {
      await pool.query('DELETE FROM conversation_summaries WHERE conversation_id = $1', [PHANTOM])
      await refill()
    }
    expect(await verifyConversationSummaries(pool, options, quiet)).toEqual([])
  })

  it('reports a row whose activity differs', async () => {
    await pool.query(
      `UPDATE conversation_summaries SET last_activity_at = last_activity_at - interval '1 day'
       WHERE conversation_id = $1`,
      [conv(2)]
    )
    try {
      expect(await verifyConversationSummaries(pool, options, quiet)).toContain(
        `different:${conv(2)}`
      )
    } finally {
      await refill()
    }
    expect(await verifyConversationSummaries(pool, options, quiet)).toEqual([])
  })

  it('never hands its read-only session back to the pool', async () => {
    const single = new Pool({ connectionString: databaseUrl, max: 1 })
    try {
      expect(await verifyConversationSummaries(single, options, quiet)).toEqual([])
      const { rows } = await single.query('SHOW transaction_read_only')
      expect(rows[0].transaction_read_only).toBe('off')
    } finally {
      await single.end()
    }
  })
})
