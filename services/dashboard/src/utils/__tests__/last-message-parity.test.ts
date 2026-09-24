import { describe, it, expect } from 'bun:test'
import { countUserTextMessages, summarizeLastMessage } from '@agent-prompttrain/shared'
import { classifyLastMessage, getLastMessageContent } from '../last-message'
import { calculateConversationMetrics } from '../conversation-metrics'
import type { ConversationRequest } from '../../types/conversation'

// Summaries round-trip through JSONB in production
const stored = (message: unknown) => JSON.parse(JSON.stringify(summarizeLastMessage(message)))

const LAST_MESSAGES: Record<string, unknown> = {
  userString: { role: 'user', content: 'Please fix the failing test in src/app.ts' },
  userWhitespace: { role: 'user', content: '   \n  ' },
  userEmptyString: { role: 'user', content: '' },
  userLongText: {
    role: 'user',
    content: [{ type: 'text', text: ' '.repeat(3) + 'w'.repeat(500) }],
  },
  exactly80: { role: 'user', content: 'e'.repeat(80) },
  exactly81: { role: 'user', content: 'f'.repeat(81) },
  toolResults: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_a', content: 'r'.repeat(1000) },
      {
        type: 'tool_result',
        tool_use_id: 'toolu_b',
        is_error: true,
        content: [
          { type: 'text', text: 'Error: ENOENT' },
          { type: 'image', source: { data: 'AAAA' } },
        ],
      },
    ],
  },
  toolResultThenText: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_c', content: 'ok' },
      { type: 'text', text: 'continue please' },
    ],
  },
  blankTextThenError: {
    role: 'user',
    content: [
      { type: 'text', text: '   ' },
      { type: 'tool_result', tool_use_id: 'toolu_d', is_error: true, content: 'failed' },
    ],
  },
  imageQuestion: {
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', data: 'B'.repeat(50_000) } },
      { type: 'text', text: 'What is this?' },
    ],
  },
  assistantToolUse: {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Delegating.' },
      { type: 'tool_use', id: 'toolu_e', name: 'Task', input: { prompt: 'q'.repeat(300) } },
    ],
  },
  unicodeWhitespace: { role: 'user', content: [{ type: 'text', text: '\u00a0\u3000\ufeff' }] },
  emptyArray: { role: 'user', content: [] },
  document: { role: 'user', content: [{ type: 'document', source: { data: 'D' } }] },
  systemRole: { role: 'system', content: [] },
}

describe('last-message summary parity', () => {
  for (const [name, message] of Object.entries(LAST_MESSAGES)) {
    it(`derives identical node classification for ${name}`, () => {
      expect(classifyLastMessage(stored(message))).toEqual(classifyLastMessage(message))
    })

    it(`derives an identical timeline preview for ${name}`, () => {
      const full = { request_id: 'r', last_message: message } as ConversationRequest
      const summary = { request_id: 'r', last_message: stored(message) } as ConversationRequest
      expect(getLastMessageContent(summary)).toBe(getLastMessageContent(full))
    })
  }
})

describe('conversation metrics parity', () => {
  const t = (seconds: number) => new Date(Date.UTC(2026, 8, 24, 10, 0, seconds)).toISOString()
  const history = [
    { role: 'user', content: 'Fix the bug' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: {} }] },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: 'boom' }],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
    { role: 'user', content: 'thanks, now add tests' },
  ]
  const branchHistory = [...history.slice(0, 6), { role: 'user', content: 'alternative approach' }]

  const base = [
    {
      id: 'r1',
      at: 0,
      branch: 'main',
      last: history[0],
      response: [
        { type: 'text', text: 'Looking' },
        { type: 'tool_use', id: 'tu1', name: 'Read' },
      ],
    },
    {
      id: 'r2',
      at: 5,
      branch: 'main',
      last: history[2],
      response: [{ type: 'tool_use', id: 'tu2', name: 'Bash' }],
    },
    {
      id: 'r3',
      at: 9,
      branch: 'main',
      last: history[4],
      response: [{ type: 'text', text: 'Done' }],
    },
    {
      id: 'r4',
      at: 60,
      branch: 'main',
      last: history[6],
      response: [{ type: 'text', text: 'Sure' }],
      full: history,
    },
    {
      id: 'r5',
      at: 70,
      branch: 'branch_2',
      last: branchHistory[6],
      response: [{ type: 'text', text: 'ok' }],
      full: branchHistory,
    },
  ]

  // Old reader shape: full body only on the latest request per branch
  const legacyRequests = base.map(r => ({
    request_id: r.id,
    timestamp: t(r.at),
    branch_id: r.branch,
    model: 'claude-test',
    total_tokens: 10,
    last_message: r.last,
    response_body: { content: r.response },
    body: r.full ? { messages: r.full } : undefined,
  })) as ConversationRequest[]

  // New reader shape: summaries everywhere, count only on the latest request per branch, no bodies
  const summarizedRequests = base.map(r => ({
    request_id: r.id,
    timestamp: t(r.at),
    branch_id: r.branch,
    model: 'claude-test',
    total_tokens: 10,
    last_message: stored(r.last),
    response_body: { content: r.response },
    user_text_message_count: r.full ? countUserTextMessages(r.full) : null,
  })) as ConversationRequest[]

  it('produces identical metrics from summaries and counts', () => {
    expect(calculateConversationMetrics(summarizedRequests)).toEqual(
      calculateConversationMetrics(legacyRequests)
    )
  })
})
