import { describe, it, expect } from 'bun:test'
import { buildSummaryColumns } from '../src/storage/summary-columns'

describe('buildSummaryColumns', () => {
  it('summarizes the last message and counts user text messages', () => {
    const columns = buildSummaryColumns({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }],
        },
      ],
    })

    expect(JSON.parse(columns.lastMessageSummary!)).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }],
    })
    expect(columns.userTextMessageCount).toBe(1)
  })

  it('returns nulls when there is nothing to summarize', () => {
    expect(buildSummaryColumns({})).toEqual({
      lastMessageSummary: null,
      userTextMessageCount: null,
    })
    expect(buildSummaryColumns(undefined)).toEqual({
      lastMessageSummary: null,
      userTextMessageCount: null,
    })
    expect(buildSummaryColumns({ messages: [] })).toEqual({
      lastMessageSummary: null,
      userTextMessageCount: 0,
    })
  })

  it('never throws on hostile input', () => {
    const hostile = {
      role: 'user',
      get content(): never {
        throw new Error('boom')
      },
    }

    expect(buildSummaryColumns({ messages: [hostile] })).toEqual({
      lastMessageSummary: null,
      userTextMessageCount: null,
    })
  })
})
