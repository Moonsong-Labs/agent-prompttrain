import { describe, it, expect, mock } from 'bun:test'
import { StorageWriter } from '../src/storage/writer'

describe('StorageWriter.storeRequest summary columns', () => {
  it('stores the precomputed summary in the request INSERT', async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = []
    const pool = {
      query: mock(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values })
        return { rows: [], rowCount: 0 }
      }),
    }
    const writer = new StorageWriter(pool as any)

    await writer.storeRequest({
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
    })

    const insert = calls.find(call => call.sql.includes('INSERT INTO api_requests'))
    expect(insert).toBeDefined()
    expect(insert!.sql).toContain('last_message_summary, user_text_message_count')
    expect(insert!.values).toHaveLength(23)
    expect(JSON.parse(insert!.values![21] as string)).toEqual({ role: 'user', content: 'continue' })
    expect(insert!.values![22]).toBe(2)
  })
})
