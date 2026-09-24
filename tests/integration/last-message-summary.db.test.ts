import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Pool } from 'pg'
import { join } from 'node:path'
import {
  countUserTextMessages,
  summarizeLastMessage,
  userTextMessageCountSql,
} from '../../packages/shared/src/utils/message-summary'
import { StorageReader } from '../../services/dashboard/src/storage/reader'
import {
  classifyLastMessage,
  getLastMessageContent,
} from '../../services/dashboard/src/utils/last-message'
import { calculateConversationMetrics } from '../../services/dashboard/src/utils/conversation-metrics'
import { runBackfill } from '../../scripts/db/backfill-last-message-summary'
import { StorageWriter } from '../../services/proxy/src/storage/writer'

// Only ever runs against an explicitly named local *_test database
const databaseUrl = process.env.SUMMARY_TEST_DATABASE_URL
const enabled = !!databaseUrl && new URL(databaseUrl).pathname.endsWith('_test')
const root = join(import.meta.dir, '../..')

const CONVERSATION = '55555555-5555-4555-8555-555555555555'
const BACKFILL_CONVERSATION = '66666666-6666-4666-8666-666666666666'
const WRITER_CONVERSATION = '77777777-7777-4777-8777-777777777777'
const EMOJI_BACKFILL_CONVERSATION = '88888888-8888-4888-8888-888888888888'
const TEST_CONVERSATIONS = [
  CONVERSATION,
  BACKFILL_CONVERSATION,
  WRITER_CONVERSATION,
  EMOJI_BACKFILL_CONVERSATION,
]
// An emoji whose high surrogate sits at index 199, right at the 200-unit clip
const STRADDLING = 'a'.repeat(199) + '\u{1F916} Generated with Claude Code'
const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`

describe.skipIf(!enabled)('last-message summary against PostgreSQL', () => {
  let pool: Pool

  const insert = async (row: {
    requestId: string
    conversationId: string
    timestamp: string
    branchId?: string
    messages: unknown[]
    summarized: boolean
    parentTaskRequestId?: string
  }) => {
    const last = row.messages[row.messages.length - 1]
    await pool.query(
      `INSERT INTO api_requests (
         request_id, project_id, timestamp, method, path, headers, body, model, request_type,
         response_status, response_body, input_tokens, output_tokens, total_tokens, duration_ms,
         conversation_id, branch_id, message_count, parent_task_request_id, is_subtask,
         last_message_summary, user_text_message_count
       ) VALUES ($1, 'project-e2e', $2, 'POST', '/v1/messages', '{}', $3, 'claude-test', 'inference',
         200, $4, 1, 1, 2, 100, $5, $6, $7, $8, $9, $10, $11)`,
      [
        row.requestId,
        row.timestamp,
        JSON.stringify({ messages: row.messages }),
        JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1 } }),
        row.conversationId,
        row.branchId ?? 'main',
        row.messages.length,
        row.parentTaskRequestId ?? null,
        !!row.parentTaskRequestId,
        row.summarized ? JSON.stringify(summarizeLastMessage(last)) : null,
        row.summarized ? countUserTextMessages(row.messages) : null,
      ]
    )
  }

  const history = [
    { role: 'user', content: 'Fix the bug' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }] },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'x'.repeat(5000) },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'Fixed' }] },
    { role: 'user', content: [{ type: 'text', text: '\u00a0 thanks \u3000' }] },
  ]

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl })
    process.env.DASHBOARD_CACHE_TTL = '0'
    await pool.query('DELETE FROM api_requests WHERE conversation_id = ANY($1::uuid[])', [
      TEST_CONVERSATIONS,
    ])
  })

  afterAll(async () => {
    await pool.query('DELETE FROM api_requests WHERE conversation_id = ANY($1::uuid[])', [
      TEST_CONVERSATIONS,
    ])
    await pool.end()
  })

  it('migration 026 is idempotent', async () => {
    for (let run = 0; run < 2; run++) {
      const child = Bun.spawn(
        ['bun', join(root, 'scripts/db/migrations/026-add-last-message-summary.ts'), 'up'],
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

  it('SQL count equals JS count, including Unicode whitespace', async () => {
    const fixtures: unknown[][] = [
      history,
      [],
      [{ role: 'user', content: '   ' }],
      [
        {
          role: 'user',
          content: '\u00a0\u1680\u2000\u200a\u2028\u2029\u202f\u205f\u3000\ufeff\t\n\v\f\r',
        },
      ],
      [{ role: 'user', content: 'a\u00a0' }],
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: '\u3000' },
            { type: 'tool_result', tool_use_id: 't' },
          ],
        },
      ],
      [
        { role: 'user', content: [{ type: 'text', text: ' x ' }] },
        { role: 'assistant', content: 'y' },
      ],
    ]

    for (const messages of fixtures) {
      const { rows } = await pool.query(`SELECT ${userTextMessageCountSql('$1::jsonb')} AS count`, [
        JSON.stringify({ messages }),
      ])
      expect(rows[0].count).toBe(countUserTextMessages(messages))
    }

    const { rows } = await pool.query(`SELECT ${userTextMessageCountSql('$1::jsonb')} AS count`, [
      JSON.stringify({ other: true }),
    ])
    expect(rows[0].count).toBeNull()
  })

  it('renders a mixed conversation exactly like an all-legacy one', async () => {
    const t = (s: number) => new Date(Date.UTC(2026, 8, 24, 9, 0, s)).toISOString()
    await insert({
      requestId: id(1),
      conversationId: CONVERSATION,
      timestamp: t(0),
      messages: history.slice(0, 1),
      summarized: false,
    })
    await insert({
      requestId: id(2),
      conversationId: CONVERSATION,
      timestamp: t(5),
      messages: history.slice(0, 3),
      summarized: true,
    })
    await insert({
      requestId: id(3),
      conversationId: CONVERSATION,
      timestamp: t(9),
      messages: history,
      summarized: true,
    })
    await insert({
      requestId: id(4),
      conversationId: CONVERSATION,
      timestamp: t(12),
      branchId: 'branch_2',
      messages: history.slice(0, 3),
      summarized: false,
    })

    const reader = new StorageReader(pool)
    const mixed = (await reader.getConversationById(CONVERSATION))!

    await pool.query(
      'UPDATE api_requests SET last_message_summary = NULL, user_text_message_count = NULL WHERE conversation_id = $1',
      [CONVERSATION]
    )
    const legacy = (await reader.getConversationById(CONVERSATION))!

    expect(mixed.requests.map(r => r.request_id)).toEqual(legacy.requests.map(r => r.request_id))
    mixed.requests.forEach((request, i) => {
      expect(classifyLastMessage(request.last_message)).toEqual(
        classifyLastMessage(legacy.requests[i].last_message)
      )
      expect(getLastMessageContent(request as any)).toBe(
        getLastMessageContent(legacy.requests[i] as any)
      )
      expect((request as any).body).toBeUndefined()
    })
    expect(calculateConversationMetrics(mixed.requests as any)).toEqual(
      calculateConversationMetrics(legacy.requests as any)
    )
  })

  it('backfills idempotently and never overwrites stored summaries', async () => {
    const now = Date.now()
    const recent = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
    for (let n = 10; n < 15; n++) {
      await insert({
        requestId: id(n),
        conversationId: BACKFILL_CONVERSATION,
        timestamp: recent(n),
        messages: history,
        summarized: false,
      })
    }
    await insert({
      requestId: id(20),
      conversationId: BACKFILL_CONVERSATION,
      timestamp: recent(1),
      messages: history,
      summarized: false,
    })
    await pool.query(
      `UPDATE api_requests SET last_message_summary = '{"role":"user","content":"sentinel"}', user_text_message_count = 99 WHERE request_id = $1`,
      [id(20)]
    )
    await insert({
      requestId: id(30),
      conversationId: BACKFILL_CONVERSATION,
      timestamp: new Date(now - 200 * 86_400_000).toISOString(),
      messages: history,
      summarized: false,
    })

    const options = { days: 90, batchSize: 2, sleepMs: 0, execute: false }
    const quiet = () => {}
    const countNull = async () =>
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM api_requests WHERE conversation_id = $1 AND last_message_summary IS NULL',
          [BACKFILL_CONVERSATION]
        )
      ).rows[0].n

    await runBackfill(pool, options, quiet)
    expect(await countNull()).toBe(6)

    const executed = await runBackfill(pool, { ...options, execute: true }, quiet)
    expect(executed.updated).toBeGreaterThanOrEqual(5)
    expect(await countNull()).toBe(1) // only the 200-day-old row remains

    const { rows } = await pool.query(
      'SELECT request_id, last_message_summary, user_text_message_count FROM api_requests WHERE request_id = ANY($1::uuid[]) ORDER BY request_id',
      [[id(10), id(20)]]
    )
    expect(rows[0].last_message_summary).toEqual(
      JSON.parse(JSON.stringify(summarizeLastMessage(history[4])))
    )
    expect(rows[0].user_text_message_count).toBe(countUserTextMessages(history))
    expect(rows[1].last_message_summary).toEqual({ role: 'user', content: 'sentinel' })
    expect(rows[1].user_text_message_count).toBe(99)

    const rerun = await runBackfill(pool, { ...options, execute: true }, quiet)
    expect(rerun.updated).toBe(0)
  })

  it('batched sub-task lookup matches per-request lookups', async () => {
    const t = (s: number) => new Date(Date.UTC(2026, 8, 24, 8, 0, s)).toISOString()
    await insert({
      requestId: id(40),
      conversationId: CONVERSATION,
      timestamp: t(0),
      messages: history,
      summarized: true,
      parentTaskRequestId: id(1),
    })
    await insert({
      requestId: id(41),
      conversationId: CONVERSATION,
      timestamp: t(1),
      messages: history,
      summarized: true,
      parentTaskRequestId: id(1),
    })
    await insert({
      requestId: id(42),
      conversationId: CONVERSATION,
      timestamp: t(2),
      messages: history,
      summarized: true,
      parentTaskRequestId: id(2),
    })

    const reader = new StorageReader(pool)
    const batched = await reader.getSubtasksForRequests([id(1), id(2), id(3)])

    for (const parent of [id(1), id(2), id(3)]) {
      const single = await reader.getSubtasksForRequest(parent)
      expect((batched.get(parent) ?? []).map(s => s.request_id)).toEqual(
        single.map(s => s.request_id)
      )
    }
  })

  it('the proxy writer stores a request whose last message straddles the clip with an emoji', async () => {
    const messages = [
      { role: 'user', content: 'Summarize the release log' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu9', name: 'Bash', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu9', content: STRADDLING },
          { type: 'text', text: STRADDLING },
        ],
      },
    ]

    await new StorageWriter(pool).storeRequest({
      requestId: id(50),
      projectId: 'project-e2e',
      timestamp: new Date(),
      method: 'POST',
      path: '/v1/messages',
      headers: {},
      body: { messages },
      apiKey: '',
      model: 'claude-test',
      requestType: 'inference',
      conversationId: WRITER_CONVERSATION,
      messageCount: messages.length,
    })

    const { rows } = await pool.query(
      `SELECT jsonb_typeof(last_message_summary) AS summary_type, last_message_summary,
              user_text_message_count
       FROM api_requests WHERE request_id = $1`,
      [id(50)]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].summary_type).toBe('object')
    expect(rows[0].last_message_summary).toEqual(
      JSON.parse(JSON.stringify(summarizeLastMessage(messages[2])))
    )
    expect(rows[0].user_text_message_count).toBe(countUserTextMessages(messages))
  })

  it('backfills a legacy row whose last message straddles the clip with an emoji', async () => {
    const messages = [
      { role: 'user', content: 'Write the changelog' },
      { role: 'assistant', content: [{ type: 'text', text: STRADDLING }] },
    ]
    await insert({
      requestId: id(60),
      conversationId: EMOJI_BACKFILL_CONVERSATION,
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      messages,
      summarized: false,
    })

    await runBackfill(pool, { days: 90, batchSize: 200, sleepMs: 0, execute: true }, () => {})

    const { rows } = await pool.query(
      `SELECT jsonb_typeof(last_message_summary) AS summary_type, last_message_summary,
              user_text_message_count
       FROM api_requests WHERE request_id = $1`,
      [id(60)]
    )
    expect(rows[0].summary_type).toBe('object')
    expect(rows[0].last_message_summary).toEqual(
      JSON.parse(JSON.stringify(summarizeLastMessage(messages[1])))
    )
    expect(rows[0].user_text_message_count).toBe(countUserTextMessages(messages))
  })
})
