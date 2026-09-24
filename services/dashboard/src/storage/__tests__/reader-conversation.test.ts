import { describe, it, expect, mock, beforeAll, afterAll } from 'bun:test'
import { userTextMessageCountSql } from '@agent-prompttrain/shared'
import { StorageReader } from '../reader'

const originalTtl = process.env.DASHBOARD_CACHE_TTL
beforeAll(() => {
  process.env.DASHBOARD_CACHE_TTL = '0'
})
afterAll(() => {
  if (originalTtl === undefined) {
    delete process.env.DASHBOARD_CACHE_TTL
  } else {
    process.env.DASHBOARD_CACHE_TTL = originalTtl
  }
})

function createPool(responses: unknown[][]) {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  const pool = {
    query: mock(async (sql: string, values: unknown[]) => {
      calls.push({ sql, values })
      return { rows: responses.shift() ?? [], rowCount: 0 }
    }),
  }
  return { pool: pool as any, calls }
}

describe('StorageReader.getConversationById', () => {
  it('reads precomputed summaries and never returns full bodies', async () => {
    const { pool, calls } = createPool([
      [
        {
          conversation_id: 'c1',
          request_count: '1',
          message_count: '3',
          first_message: '2026-09-24T00:00:00Z',
          last_message: '2026-09-24T00:00:00Z',
          total_tokens: '10',
          branches: ['main'],
        },
      ],
      [
        {
          request_id: 'r1',
          project_id: 'p',
          timestamp: '2026-09-24T00:00:00Z',
          model: 'm',
          input_tokens: 1,
          output_tokens: 2,
          total_tokens: 3,
          duration_ms: 4,
          branch_id: 'main',
          message_count: 3,
          response_body: { usage: {} },
          account_id: 'a',
          last_message: { role: 'user', content: 'hi' },
          user_text_message_count: 2,
        },
      ],
    ])

    const conversation = await new StorageReader(pool).getConversationById('c1')
    const sql = calls[1].sql

    expect(sql).toContain('last_message_summary')
    expect(sql).toContain(userTextMessageCountSql('body'))
    expect(sql).not.toMatch(/THEN\s+body\s+ELSE/)
    expect(sql).not.toMatch(/SELECT\s+\*/)
    expect(conversation!.requests[0].user_text_message_count).toBe(2)
    expect(conversation!.requests[0].last_message).toEqual({ role: 'user', content: 'hi' })
    expect(conversation!.requests[0].body).toBeUndefined()
  })
})

describe('StorageReader.getSubtasksForRequests', () => {
  it('returns an empty map without querying when there are no ids', async () => {
    const { pool, calls } = createPool([])
    const map = await new StorageReader(pool).getSubtasksForRequests([])
    expect(map.size).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('groups sub-tasks by parent request in a single narrow query', async () => {
    const { pool, calls } = createPool([
      [
        {
          request_id: 's1',
          conversation_id: 'cs',
          is_subtask: true,
          parent_task_request_id: 'p1',
          timestamp: 't1',
        },
        {
          request_id: 's2',
          conversation_id: 'cs',
          is_subtask: true,
          parent_task_request_id: 'p1',
          timestamp: 't2',
        },
        {
          request_id: 's3',
          conversation_id: 'ct',
          is_subtask: true,
          parent_task_request_id: 'p2',
          timestamp: 't3',
        },
      ],
    ])

    const map = await new StorageReader(pool).getSubtasksForRequests(['p1', 'p2', 'p3'])

    expect(calls).toHaveLength(1)
    expect(calls[0].values).toEqual([['p1', 'p2', 'p3']])
    expect(calls[0].sql).not.toMatch(/SELECT\s+\*/)
    expect(map.get('p1')!.map(s => s.request_id)).toEqual(['s1', 's2'])
    expect(map.get('p2')!.map(s => s.request_id)).toEqual(['s3'])
    expect(map.has('p3')).toBe(false)
  })
})
