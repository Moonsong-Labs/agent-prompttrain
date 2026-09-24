import { describe, it, expect, mock, spyOn, afterEach } from 'bun:test'
import { StorageWriter } from '../src/storage/writer'
import { logger } from '../src/middleware/logger'

const SUMMARY_COLUMNS = ['last_message_summary', 'user_text_message_count']

function createPool(options: { columns?: string[]; insertFailures?: unknown[] } = {}) {
  const columns = options.columns ?? SUMMARY_COLUMNS
  const insertFailures = [...(options.insertFailures ?? [])]
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const pool = {
    query: mock(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values })
      if (sql.includes('information_schema.columns')) {
        return { rows: columns.map(column_name => ({ column_name })), rowCount: columns.length }
      }
      if (sql.includes('INSERT INTO api_requests') && insertFailures.length > 0) {
        throw insertFailures.shift()
      }
      return { rows: [], rowCount: 0 }
    }),
  }
  const inserts = () => calls.filter(call => call.sql.includes('INSERT INTO api_requests'))
  return { writer: new StorageWriter(pool as any), calls, inserts }
}

const baseRequest = {
  requestId: '11111111-1111-4111-8111-111111111111',
  projectId: 'project-test',
  timestamp: new Date('2026-09-24T00:00:00Z'),
  method: 'POST',
  path: '/v1/messages',
  headers: {},
  apiKey: '',
  model: 'claude-test',
  conversationId: '22222222-2222-4222-8222-222222222222',
  parentMessageHash: 'parent-hash',
  body: {
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: '  continue  ' },
    ],
  },
}

afterEach(() => {
  mock.restore()
})

describe('StorageWriter.storeRequest summary columns', () => {
  it('stores the precomputed summary in the request INSERT', async () => {
    const { writer, inserts } = createPool()

    await writer.storeRequest(baseRequest)

    const [insert] = inserts()
    expect(inserts()).toHaveLength(1)
    expect(insert.sql).toContain('last_message_summary, user_text_message_count')
    expect(insert.values).toHaveLength(23)
    expect(JSON.parse(insert.values![21] as string)).toEqual({ role: 'user', content: 'continue' })
    expect(insert.values![22]).toBe(2)
  })

  for (const code of ['22P02', '22P05']) {
    it(`retries once without the summary when PostgreSQL rejects the INSERT with ${code}`, async () => {
      const warn = spyOn(logger, 'warn').mockImplementation(() => {})
      const { writer, inserts } = createPool({ insertFailures: [{ code }] })

      await writer.storeRequest(baseRequest)

      const [first, retry] = inserts()
      expect(inserts()).toHaveLength(2)
      expect(first.values![21]).not.toBeNull()
      expect(retry.sql).toBe(first.sql)
      expect(retry.values).toHaveLength(23)
      expect(retry.values!.slice(0, 21)).toEqual(first.values!.slice(0, 21))
      expect(retry.values![21]).toBeNull()
      expect(retry.values![22]).toBeNull()
      expect(warn).toHaveBeenCalledTimes(1)
    })
  }

  it('does not retry other INSERT errors', async () => {
    const error = spyOn(logger, 'error').mockImplementation(() => {})
    const { writer, inserts } = createPool({ insertFailures: [{ code: '23503' }] })

    await writer.storeRequest(baseRequest)

    expect(inserts()).toHaveLength(1)
    expect(error).toHaveBeenCalledWith('Failed to store request', expect.anything())
  })

  it('does not retry when there is no summary to drop', async () => {
    spyOn(logger, 'error').mockImplementation(() => {})
    const { writer, inserts } = createPool({ insertFailures: [{ code: '22P02' }] })

    await writer.storeRequest({ ...baseRequest, body: { prompt: 'no messages' } })

    expect(inserts()).toHaveLength(1)
    expect(inserts()[0].values![21]).toBeNull()
    expect(inserts()[0].values![22]).toBeNull()
  })

  it('reports a failed retry as a failed store', async () => {
    spyOn(logger, 'warn').mockImplementation(() => {})
    const error = spyOn(logger, 'error').mockImplementation(() => {})
    const { writer, inserts } = createPool({
      insertFailures: [{ code: '22P02' }, { code: '22P02' }],
    })

    await writer.storeRequest(baseRequest)

    expect(inserts()).toHaveLength(2)
    expect(error).toHaveBeenCalledWith('Failed to store request', expect.anything())
  })
})
