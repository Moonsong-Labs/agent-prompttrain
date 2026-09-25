import { describe, it, expect, mock, spyOn, afterEach } from 'bun:test'
import { StorageWriter } from '../src/storage/writer'
import { logger } from '../src/middleware/logger'

const SUMMARY_COLUMNS = ['last_message_summary', 'user_text_message_count']

interface PoolOptions {
  columns?: string[]
  insertFailures?: unknown[]
  /** rowCount of a successful request INSERT (0 when the request id is already stored) */
  insertRowCount?: number
  tableExists?: boolean
  /** Answers for successive information_schema.tables checks; falls back to `tableExists` once exhausted */
  tableExistsSequence?: boolean[]
  tableCheckFailures?: number
  upsertFailures?: unknown[]
}

function createPool(options: PoolOptions = {}) {
  const columns = options.columns ?? SUMMARY_COLUMNS
  const insertFailures = [...(options.insertFailures ?? [])]
  const upsertFailures = [...(options.upsertFailures ?? [])]
  const tableExistsSequence = [...(options.tableExistsSequence ?? [])]
  let tableCheckFailures = options.tableCheckFailures ?? 0
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const pool = {
    query: mock(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values })
      if (sql.includes('information_schema.columns')) {
        return { rows: columns.map(column_name => ({ column_name })), rowCount: columns.length }
      }
      if (sql.includes('information_schema.tables')) {
        if (tableCheckFailures > 0) {
          tableCheckFailures--
          throw new Error('connection reset')
        }
        const exists =
          tableExistsSequence.length > 0
            ? tableExistsSequence.shift()!
            : (options.tableExists ?? true)
        return {
          rows: exists ? [{ table_name: 'conversation_summaries' }] : [],
          rowCount: exists ? 1 : 0,
        }
      }
      if (sql.includes('INSERT INTO api_requests')) {
        if (insertFailures.length > 0) {
          throw insertFailures.shift()
        }
        return { rows: [], rowCount: options.insertRowCount ?? 1 }
      }
      if (sql.includes('INSERT INTO conversation_summaries')) {
        if (upsertFailures.length > 0) {
          throw upsertFailures.shift()
        }
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }),
  }
  const matching = (fragment: string) => calls.filter(call => call.sql.includes(fragment))
  return {
    writer: new StorageWriter(pool as any),
    calls,
    inserts: () => matching('INSERT INTO api_requests'),
    upserts: () => matching('INSERT INTO conversation_summaries'),
    tableChecks: () => matching('information_schema.tables'),
  }
}

const baseRequest = {
  requestId: '11111111-1111-4111-8111-111111111111',
  projectId: 'project-test',
  accountId: 'account-1',
  timestamp: new Date('2026-09-25T00:00:00Z'),
  method: 'POST',
  path: '/v1/messages',
  headers: {},
  apiKey: '',
  model: 'claude-test',
  conversationId: '22222222-2222-4222-8222-222222222222',
  parentMessageHash: 'parent-hash',
  body: { messages: [{ role: 'user', content: 'hello' }] },
}
const secondRequest = { ...baseRequest, requestId: '33333333-3333-4333-8333-333333333333' }
const thirdRequest = { ...baseRequest, requestId: '44444444-4444-4444-8444-444444444444' }

afterEach(() => {
  mock.restore()
})

/**
 * Silence a logger method and count its calls from now on. Other test files replace logger
 * methods with long-lived mocks, so clear any calls recorded before this test.
 */
function silence(method: 'warn' | 'error') {
  const spy = spyOn(logger, method).mockImplementation(() => {})
  spy.mockClear()
  return spy
}

describe('StorageWriter conversation summaries (migration 027)', () => {
  it('upserts the summary after the request INSERT with the merge rules', async () => {
    const { writer, calls, upserts } = createPool()

    await writer.storeRequest(baseRequest)

    const insertAt = calls.findIndex(call => call.sql.includes('INSERT INTO api_requests'))
    const upsertAt = calls.findIndex(call =>
      call.sql.includes('INSERT INTO conversation_summaries')
    )
    expect(insertAt).toBeGreaterThanOrEqual(0)
    expect(upsertAt).toBeGreaterThan(insertAt)
    expect(upserts()).toHaveLength(1)
    const [upsert] = upserts()
    expect(upsert.sql).toContain('VALUES ($1, $2, $3, $3, $4)')
    expect(upsert.sql).toContain('ON CONFLICT (conversation_id, project_id) DO UPDATE')
    expect(upsert.sql).toContain('LEAST(cs.first_activity_at, EXCLUDED.first_activity_at)')
    expect(upsert.sql).toContain('GREATEST(cs.last_activity_at, EXCLUDED.last_activity_at)')
    expect(upsert.values).toEqual([
      baseRequest.conversationId,
      baseRequest.projectId,
      baseRequest.timestamp,
      ['account-1'],
    ])
  })

  it('records an empty account list when the request has no account', async () => {
    const { writer, upserts } = createPool()

    await writer.storeRequest({ ...baseRequest, accountId: undefined })

    expect(upserts()[0].values![3]).toEqual([])
  })

  it('skips the summary for a request without a conversation', async () => {
    const { writer, inserts, upserts, tableChecks } = createPool()

    await writer.storeRequest({ ...baseRequest, conversationId: undefined })

    expect(inserts()).toHaveLength(1)
    expect(upserts()).toHaveLength(0)
    expect(tableChecks()).toHaveLength(0)
  })

  it('does not upsert when the request INSERT fails', async () => {
    const error = silence('error')
    const { writer, upserts } = createPool({ insertFailures: [{ code: '23503' }] })

    await writer.storeRequest(baseRequest)

    expect(upserts()).toHaveLength(0)
    expect(error).toHaveBeenCalledWith('Failed to store request', expect.anything())
  })

  it('upserts once after the INSERT is retried without a summary', async () => {
    silence('warn')
    const { writer, inserts, upserts } = createPool({ insertFailures: [{ code: '22P02' }] })

    await writer.storeRequest(baseRequest)

    expect(inserts()).toHaveLength(2)
    expect(upserts()).toHaveLength(1)
  })

  it('upserts after the pre-026 INSERT', async () => {
    silence('error')
    const { writer, inserts, upserts } = createPool({ columns: [] })

    await writer.storeRequest(baseRequest)

    expect(inserts()[0].values).toHaveLength(21)
    expect(upserts()).toHaveLength(1)
  })

  it('does not upsert when the INSERT stored nothing (request id already stored)', async () => {
    const { writer, upserts, tableChecks } = createPool({ insertRowCount: 0 })

    await writer.storeRequest(baseRequest)

    expect(upserts()).toHaveLength(0)
    expect(tableChecks()).toHaveLength(0)
  })

  it('logs a failed upsert without failing the stored request', async () => {
    const error = silence('error')
    const { writer, inserts, upserts } = createPool({
      upsertFailures: [new Error('deadlock detected')],
    })

    await expect(writer.storeRequest(baseRequest)).resolves.toBeUndefined()
    await writer.storeRequest(secondRequest)

    expect(inserts()).toHaveLength(2)
    // A failed upsert does not disable the next one
    expect(upserts()).toHaveLength(2)
    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(
      'Failed to update the conversation summary',
      expect.anything()
    )
    expect(error).not.toHaveBeenCalledWith('Failed to store request', expect.anything())
  })

  it('skips the upsert and logs one error while the table is missing', async () => {
    const error = silence('error')
    const { writer, inserts, upserts, tableChecks } = createPool({ tableExists: false })

    await writer.storeRequest(baseRequest)
    await writer.storeRequest(secondRequest)

    expect(inserts()).toHaveLength(2)
    expect(tableChecks()).toHaveLength(1)
    expect(upserts()).toHaveLength(0)
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0][0]).toContain('027')
  })

  it('checks for the table again after a failed check', async () => {
    const warn = silence('warn')
    const error = silence('error')
    const { writer, upserts, tableChecks } = createPool({ tableCheckFailures: 1 })

    await writer.storeRequest(baseRequest)
    await writer.storeRequest(secondRequest)

    expect(tableChecks()).toHaveLength(2)
    expect(upserts()).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(error).not.toHaveBeenCalled()
  })

  it('re-checks the table after an undefined-table error (SQLSTATE 42P01) and stops upserting', async () => {
    const error = silence('error')
    const { writer, inserts, upserts, tableChecks } = createPool({
      tableExistsSequence: [true, false],
      upsertFailures: [{ code: '42P01' }],
    })

    await writer.storeRequest(baseRequest)
    await writer.storeRequest(secondRequest)
    await writer.storeRequest(thirdRequest)

    expect(inserts()).toHaveLength(3)
    // First request: table check passes, then the upsert fails with 42P01
    // Second request: the table check re-runs and now finds no rows, so no upsert is attempted
    // Third request: the missing result is cached, so neither the check nor the upsert re-runs
    expect(tableChecks()).toHaveLength(2)
    expect(upserts()).toHaveLength(1)
    expect(error).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenNthCalledWith(
      1,
      'Failed to update the conversation summary',
      expect.anything()
    )
    expect(error.mock.calls[1][0]).toContain('027')
  })
})
