import { describe, it, expect } from 'bun:test'
import {
  backfillConversationSummaries,
  parseSummariesBackfillArgs,
  planBackfillChunks,
} from '../backfill-conversation-summaries'

const at = (iso: string) => new Date(iso)

describe('parseSummariesBackfillArgs', () => {
  it('defaults to a dry run over the whole history in 7-day chunks', () => {
    expect(parseSummariesBackfillArgs([])).toEqual({
      since: undefined,
      chunkDays: 7,
      execute: false,
    })
  })

  it('parses every flag', () => {
    expect(
      parseSummariesBackfillArgs([
        '--since',
        '2026-09-01T00:00:00Z',
        '--chunk-days',
        '1',
        '--execute',
      ])
    ).toEqual({ since: '2026-09-01T00:00:00.000Z', chunkDays: 1, execute: true })
  })

  it('rejects invalid values', () => {
    expect(() => parseSummariesBackfillArgs(['--since', 'yesterday'])).toThrow('--since')
    expect(() => parseSummariesBackfillArgs(['--since'])).toThrow('--since')
    expect(() => parseSummariesBackfillArgs(['--chunk-days', '0'])).toThrow('--chunk-days')
    expect(() => parseSummariesBackfillArgs(['--chunk-days', '400'])).toThrow('--chunk-days')
    expect(() => parseSummariesBackfillArgs(['--chunk-days', '1.5'])).toThrow('--chunk-days')
    expect(() => parseSummariesBackfillArgs(['--bogus'])).toThrow('Unknown option')
  })
})

describe('planBackfillChunks', () => {
  it('walks newest first in contiguous chunks of at most chunkDays', () => {
    expect(planBackfillChunks(at('2026-09-01T00:00:00Z'), at('2026-09-20T00:00:00Z'), 7)).toEqual([
      { from: at('2026-09-13T00:00:00Z'), to: at('2026-09-20T00:00:00Z') },
      { from: at('2026-09-06T00:00:00Z'), to: at('2026-09-13T00:00:00Z') },
      { from: at('2026-09-01T00:00:00Z'), to: at('2026-09-06T00:00:00Z') },
    ])
  })

  it('covers an exact multiple without an empty chunk', () => {
    const chunks = planBackfillChunks(at('2026-09-06T00:00:00Z'), at('2026-09-20T00:00:00Z'), 7)
    expect(chunks.map(chunk => chunk.from.toISOString())).toEqual([
      '2026-09-13T00:00:00.000Z',
      '2026-09-06T00:00:00.000Z',
    ])
  })

  it('returns one short chunk for a short range', () => {
    expect(
      planBackfillChunks(at('2026-09-01T00:00:00Z'), at('2026-09-01T00:00:00.001Z'), 7)
    ).toEqual([{ from: at('2026-09-01T00:00:00Z'), to: at('2026-09-01T00:00:00.001Z') }])
  })

  it('returns nothing for an empty or inverted range', () => {
    expect(planBackfillChunks(at('2026-09-01T00:00:00Z'), at('2026-09-01T00:00:00Z'), 7)).toEqual(
      []
    )
    expect(planBackfillChunks(at('2026-09-20T00:00:00Z'), at('2026-09-01T00:00:00Z'), 7)).toEqual(
      []
    )
  })
})

function createPool(options: { start?: Date | null; end?: Date | null; readOnly?: boolean } = {}) {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  let released = false
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values })
      if (sql.startsWith('SHOW transaction_read_only')) {
        return { rows: [{ transaction_read_only: options.readOnly ? 'on' : 'off' }] }
      }
      if (sql.includes('AS history_start')) {
        return {
          rows: [
            {
              history_start:
                options.start === undefined ? at('2026-09-01T00:00:00Z') : options.start,
              history_end: options.end === undefined ? at('2026-09-14T12:00:00Z') : options.end,
            },
          ],
        }
      }
      if (sql.includes('RETURNING 1')) {
        return { rows: [{ groups: 3, changed: 2 }] }
      }
      if (sql.includes('AS groups')) {
        return { rows: [{ groups: 3 }] }
      }
      return { rows: [] }
    },
    release: () => {
      released = true
    },
  }
  return {
    pool: { connect: async () => client } as any,
    calls,
    released: () => released,
    of: (fragment: string) => calls.filter(call => call.sql.includes(fragment)),
  }
}

describe('backfillConversationSummaries', () => {
  const quiet = () => {}

  it('dry run counts each chunk and writes nothing', async () => {
    const { pool, calls, of, released } = createPool()

    const result = await backfillConversationSummaries(
      pool,
      { chunkDays: 7, execute: false },
      quiet
    )

    expect(result).toEqual({ chunks: 2, groups: 6, changed: 0 })
    expect(calls.some(call => /INSERT|UPDATE|DELETE/.test(call.sql))).toBe(false)
    const statements = calls.map(call => call.sql)
    expect(statements).toContain("SET statement_timeout = '120s'")
    expect(statements).toContain("SET lock_timeout = '5s'")
    expect(statements).toContain("SET application_name = 'backfill-conversation-summaries'")
    // The newest request is included: the range ends 1 ms after it
    expect(of('AS groups').map(call => call.values)).toEqual([
      [at('2026-09-07T12:00:00.001Z'), at('2026-09-14T12:00:00.001Z')],
      [at('2026-09-01T00:00:00Z'), at('2026-09-07T12:00:00.001Z')],
    ])
    expect(released()).toBe(true)
  })

  it('executes one merge upsert per chunk', async () => {
    const { pool, of } = createPool()

    const result = await backfillConversationSummaries(pool, { chunkDays: 7, execute: true }, quiet)

    expect(result).toEqual({ chunks: 2, groups: 6, changed: 4 })
    const upserts = of('INSERT INTO conversation_summaries')
    expect(upserts).toHaveLength(2)
    expect(upserts[0].sql).toContain('GROUP BY conversation_id, project_id')
    expect(upserts[0].sql).toContain('ON CONFLICT (conversation_id, project_id) DO UPDATE')
    expect(of('SHOW transaction_read_only')).toHaveLength(1)
  })

  it('refuses --execute on a read-only session', async () => {
    const { pool, of, released } = createPool({ readOnly: true })

    await expect(
      backfillConversationSummaries(pool, { chunkDays: 7, execute: true }, quiet)
    ).rejects.toThrow('read-only')

    expect(of('INSERT')).toHaveLength(0)
    expect(released()).toBe(true)
  })

  it('starts at --since', async () => {
    const { pool, of } = createPool()

    const result = await backfillConversationSummaries(
      pool,
      { since: '2026-09-10T00:00:00.000Z', chunkDays: 7, execute: false },
      quiet
    )

    expect(result.chunks).toBe(1)
    expect(of('AS groups')[0].values).toEqual([
      at('2026-09-10T00:00:00Z'),
      at('2026-09-14T12:00:00.001Z'),
    ])
  })

  it('does nothing without requests in a conversation', async () => {
    const { pool, of } = createPool({ start: null, end: null })

    const result = await backfillConversationSummaries(pool, { chunkDays: 7, execute: true }, quiet)

    expect(result).toEqual({ chunks: 0, groups: 0, changed: 0 })
    expect(of('INSERT')).toHaveLength(0)
  })
})
