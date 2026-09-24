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

describe('summarizeLastMessage surrogate-safe clipping', () => {
  // Two UTF-16 code units; a plain slice(0, 200) would keep only its high surrogate
  const EMOJI = '\u{1F916}'
  const LONE_HIGH_SURROGATE_AT_END = /[\uD800-\uDBFF]$/
  // Bun's JSON.stringify escapes lone surrogates, which PostgreSQL JSONB rejects
  const LONE_SURROGATE_ESCAPE = /\\ud[89a-f][0-9a-f]{2}/i
  const straddling = (prefixLength = SUMMARY_TEXT_LIMIT - 1) =>
    'a'.repeat(prefixLength) + EMOJI + ' Generated with Claude Code'

  const expectSafe = (value: unknown) => {
    expect(typeof value).toBe('string')
    const text = value as string
    expect(text.length).toBeLessThanOrEqual(SUMMARY_TEXT_LIMIT)
    expect(text.length).toBeGreaterThanOrEqual(SUMMARY_TEXT_LIMIT - 1)
    expect(text).not.toMatch(LONE_HIGH_SURROGATE_AT_END)
  }

  it('does not split an emoji straddling the limit in string content', () => {
    const summary = summarizeLastMessage({ role: 'user', content: straddling() })!
    expectSafe(summary.content)
    expect(summary.content).toBe('a'.repeat(SUMMARY_TEXT_LIMIT - 1))
    expect(JSON.stringify(summary)).not.toMatch(LONE_SURROGATE_ESCAPE)
  })

  it('does not split an emoji straddling the limit in a text block', () => {
    const summary = summarizeLastMessage({
      role: 'assistant',
      content: [{ type: 'text', text: '  ' + straddling() }],
    })!
    const [block] = summary.content as Array<{ text?: string }>
    expectSafe(block.text)
    expect(JSON.stringify(summary)).not.toMatch(LONE_SURROGATE_ESCAPE)
  })

  it('does not split an emoji straddling the limit in tool_result string content', () => {
    const summary = summarizeLastMessage({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: straddling() }],
    })!
    const [block] = summary.content as Array<{ content?: string }>
    expectSafe(block.content)
    expect(JSON.stringify(summary)).not.toMatch(LONE_SURROGATE_ESCAPE)
  })

  it('does not split an emoji straddling the limit in tool_result array content', () => {
    const prefix = JSON.stringify([{ type: 'text', text: '' }]).indexOf('""') + 1
    const arrayContent = [{ type: 'text', text: straddling(SUMMARY_TEXT_LIMIT - 1 - prefix) }]
    // Precondition: the serialized content has the emoji's high surrogate at index 199
    expect(JSON.stringify(arrayContent).charCodeAt(SUMMARY_TEXT_LIMIT - 1)).toBe(0xd83e)

    const summary = summarizeLastMessage({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: arrayContent }],
    })!
    const [block] = summary.content as Array<{ content?: string }>
    expectSafe(block.content)
    expect(JSON.stringify(summary)).not.toMatch(LONE_SURROGATE_ESCAPE)
  })

  it('does not split an emoji straddling the limit in a tool_use prompt', () => {
    const summary = summarizeLastMessage({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_3', name: 'Task', input: { prompt: straddling() } }],
    })!
    const [block] = summary.content as Array<{ input?: { prompt: string } }>
    expectSafe(block.input?.prompt)
    expect(JSON.stringify(summary)).not.toMatch(LONE_SURROGATE_ESCAPE)
  })

  it('keeps a complete surrogate pair that ends exactly at the limit', () => {
    const content = 'a'.repeat(SUMMARY_TEXT_LIMIT - 2) + EMOJI
    expect(summarizeLastMessage({ role: 'user', content: content + 'tail' })).toEqual({
      role: 'user',
      content,
    })
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
