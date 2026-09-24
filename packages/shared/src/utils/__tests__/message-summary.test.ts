import { describe, it, expect } from 'bun:test'
import {
  SUMMARY_TEXT_LIMIT,
  summarizeLastMessage,
  hasVisibleText,
  countUserTextMessages,
  userTextMessageCountSql,
} from '../message-summary'

describe('summarizeLastMessage', () => {
  it('returns null for missing or non-object messages', () => {
    expect(summarizeLastMessage(undefined)).toBeNull()
    expect(summarizeLastMessage(null)).toBeNull()
    expect(summarizeLastMessage('hello')).toBeNull()
  })

  it('trims then clips string content', () => {
    const long = '  ' + 'a'.repeat(500) + '  '
    expect(summarizeLastMessage({ role: 'user', content: long })).toEqual({
      role: 'user',
      content: 'a'.repeat(SUMMARY_TEXT_LIMIT),
    })
  })

  it('keeps whitespace-only content truthy but blank', () => {
    expect(summarizeLastMessage({ role: 'user', content: ' \n\t ' })).toEqual({
      role: 'user',
      content: ' ',
    })
    expect(summarizeLastMessage({ role: 'user', content: '' })).toEqual({
      role: 'user',
      content: '',
    })
  })

  it('summarizes text blocks with the same trimming rule', () => {
    expect(
      summarizeLastMessage({
        role: 'user',
        content: [
          { type: 'text', text: '  hello  ' },
          { type: 'text', text: '   ' },
          { type: 'text', text: 'x'.repeat(300) },
          { type: 'text' },
        ],
      })
    ).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'text', text: ' ' },
        { type: 'text', text: 'x'.repeat(SUMMARY_TEXT_LIMIT) },
        { type: 'text' },
      ],
    })
  })

  it('keeps tool_result identity, error flag and a clipped content preview', () => {
    const arrayContent = [{ type: 'text', text: 'y'.repeat(400) }]
    expect(
      summarizeLastMessage({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'z'.repeat(1000) },
          { type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: arrayContent },
          { type: 'tool_result', tool_use_id: 'toolu_3', content: '' },
        ],
      })
    ).toStrictEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'z'.repeat(SUMMARY_TEXT_LIMIT) },
        {
          type: 'tool_result',
          tool_use_id: 'toolu_2',
          is_error: true,
          content: JSON.stringify(arrayContent).slice(0, SUMMARY_TEXT_LIMIT),
        },
        { type: 'tool_result', tool_use_id: 'toolu_3' },
      ],
    })
  })

  it('keeps tool_use name and a clipped prompt only', () => {
    expect(
      summarizeLastMessage({
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_9',
            name: 'Task',
            input: { prompt: 'p'.repeat(300), description: 'd' },
          },
          { type: 'tool_use', id: 'toolu_8', name: 'Bash', input: { command: 'ls' } },
        ],
      })
    ).toStrictEqual({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_9',
          name: 'Task',
          input: { prompt: 'p'.repeat(SUMMARY_TEXT_LIMIT) },
        },
        { type: 'tool_use', id: 'toolu_8', name: 'Bash' },
      ],
    })
  })

  it('drops payloads of images, documents and unknown blocks', () => {
    expect(
      summarizeLastMessage({
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', data: 'A'.repeat(2_000_000) } },
          { type: 'document', source: { data: 'B'.repeat(10) } },
          { type: 'thinking', thinking: 'internal' },
          null,
          42,
        ],
      })
    ).toStrictEqual({
      role: 'user',
      content: [{ type: 'image' }, { type: 'document' }, { type: 'thinking' }],
    })
  })

  it('stays small for huge messages', () => {
    const blocks = Array.from({ length: 20 }, (_, i) => ({
      type: 'tool_result',
      tool_use_id: `toolu_${i}`,
      content: 'q'.repeat(1_000_000),
    }))
    const json = JSON.stringify(summarizeLastMessage({ role: 'user', content: blocks }))
    expect(json.length).toBeLessThan(20 * 300)
  })

  it('maps non-string, non-array content to null and keeps missing content missing', () => {
    expect(summarizeLastMessage({ role: 'user', content: 12345 })).toEqual({
      role: 'user',
      content: null,
    })
    expect(summarizeLastMessage({ role: 'user' })).toStrictEqual({ role: 'user' })
  })
})

describe('hasVisibleText', () => {
  it('matches the dashboard visible-text rule', () => {
    expect(hasVisibleText({ role: 'user', content: 'hi' })).toBe(true)
    expect(hasVisibleText({ role: 'user', content: '   ' })).toBe(false)
    expect(hasVisibleText({ role: 'user', content: [{ type: 'tool_result', content: 'x' }] })).toBe(
      false
    )
    expect(hasVisibleText({ role: 'user', content: [{ type: 'text', text: ' ok ' }] })).toBe(true)
    expect(
      hasVisibleText({
        role: 'user',
        content: [{ type: 'text', text: '\u00a0\u3000\ufeff\u2028' }],
      })
    ).toBe(false)
    expect(hasVisibleText(null)).toBe(false)
  })
})

describe('countUserTextMessages', () => {
  it('counts user messages with visible text', () => {
    expect(
      countUserTextMessages([
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't' }] },
        { role: 'user', content: [{ type: 'text', text: 'c' }] },
        null,
      ])
    ).toBe(2)
    expect(countUserTextMessages([])).toBe(0)
  })

  it('returns null when messages is not an array', () => {
    expect(countUserTextMessages(undefined)).toBeNull()
    expect(countUserTextMessages({})).toBeNull()
  })
})

describe('userTextMessageCountSql', () => {
  it('uses the given body expression and guards non-array messages', () => {
    const sql = userTextMessageCountSql('ar.body')
    expect(sql).toContain("jsonb_typeof(ar.body -> 'messages') = 'array'")
    expect(sql).toContain("jsonb_array_elements(ar.body -> 'messages')")
    expect(userTextMessageCountSql()).toContain("jsonb_typeof(body -> 'messages') = 'array'")
  })
})
