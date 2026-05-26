import { describe, test, expect, mock } from 'bun:test'

// The middleware logger reads from request context; stub it out so the
// entity can be constructed without a real Hono request.
mock.module('../../../middleware/logger', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  },
}))

import { ProxyResponse } from '../ProxyResponse'
import type { ClaudeMessagesResponse, ClaudeStreamEvent } from '@agent-prompttrain/shared'

const baseResponse = (overrides: Partial<ClaudeMessagesResponse> = {}): ClaudeMessagesResponse => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-4-7',
  stop_reason: 'end_turn',
  stop_sequence: null,
  content: [],
  usage: { input_tokens: 10, output_tokens: 5 },
  ...overrides,
})

describe('ProxyResponse — modern Claude content blocks', () => {
  describe('B2: server_tool_use counted as a tool call', () => {
    test('non-streaming response includes server_tool_use in tool list', () => {
      const r = new ProxyResponse('req_1', false)
      r.processResponse(
        baseResponse({
          content: [
            { type: 'text', text: 'Let me search.' },
            {
              type: 'server_tool_use',
              id: 'srv_1',
              name: 'web_search',
              input: { query: 'cats' },
            } as any,
            {
              type: 'web_search_tool_result',
              tool_use_id: 'srv_1',
              content: [{ url: 'https://example.com', title: 'cats' }],
            } as any,
            { type: 'tool_use', id: 'cli_1', name: 'calculator', input: { a: 1 } } as any,
          ],
        })
      )

      // server_tool_use + tool_use = 2; results are not calls
      expect(r.toolCallCount).toBe(2)
      const names = r.toolCalls.map(t => t.name)
      expect(names).toContain('web_search')
      expect(names).toContain('calculator')
    })

    test('streaming response counts server_tool_use blocks', () => {
      const r = new ProxyResponse('req_2', true)

      const events: ClaudeStreamEvent[] = [
        {
          type: 'message_start',
          message: baseResponse({ usage: { input_tokens: 7, output_tokens: 0 } }),
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'server_tool_use',
            id: 'srv_1',
            name: 'web_search',
            input: {},
          } as any,
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"query":"cats"}' } as any,
        },
        { type: 'content_block_stop', index: 0 } as any,
        { type: 'message_stop' },
      ]

      events.forEach(e => r.processStreamEvent(e))

      expect(r.toolCallCount).toBe(1)
      expect(r.toolCalls[0].name).toBe('web_search')
      // input_json_delta payload should be parsed into the tool call
      expect(r.toolCalls[0].input).toEqual({ query: 'cats' })
    })

    test('streaming response does NOT count *_tool_result blocks as calls', () => {
      const r = new ProxyResponse('req_3', true)

      const events: ClaudeStreamEvent[] = [
        {
          type: 'message_start',
          message: baseResponse({ usage: { input_tokens: 1, output_tokens: 0 } }),
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'web_search_tool_result',
            tool_use_id: 'srv_1',
            content: [],
          } as any,
        },
        { type: 'content_block_stop', index: 0 } as any,
        { type: 'message_stop' },
      ]
      events.forEach(e => r.processStreamEvent(e))

      expect(r.toolCallCount).toBe(0)
    })
  })

  describe('B3: thinking deltas captured', () => {
    test('thinking_delta and signature_delta accumulate without polluting _content', () => {
      const r = new ProxyResponse('req_4', true)

      const events: ClaudeStreamEvent[] = [
        {
          type: 'message_start',
          message: baseResponse({ usage: { input_tokens: 1, output_tokens: 0 } }),
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '', signature: '' } as any,
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Let me ' } as any,
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'reason...' } as any,
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'sig-aaa' } as any,
        },
        { type: 'content_block_stop', index: 0 } as any,
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' } as any,
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'The answer is 42.' } as any,
        },
        { type: 'content_block_stop', index: 1 } as any,
        { type: 'message_stop' },
      ]

      events.forEach(e => r.processStreamEvent(e))

      // Visible content must NOT include the thinking text
      expect(r.content).toBe('The answer is 42.')
      // Thinking text is captured separately
      expect(r.thinkingContent).toBe('Let me reason...')
      // Signature(s) are captured for downstream verification
      expect(r.thinkingSignatures).toEqual(['sig-aaa'])
    })

    test('non-streaming thinking blocks are captured', () => {
      const r = new ProxyResponse('req_5', false)
      r.processResponse(
        baseResponse({
          content: [
            {
              type: 'thinking',
              thinking: 'Deep thoughts',
              signature: 'sig-1',
            } as any,
            { type: 'text', text: 'Hello.' },
          ],
        })
      )

      expect(r.content).toBe('Hello.')
      expect(r.thinkingContent).toBe('Deep thoughts')
      expect(r.thinkingSignatures).toEqual(['sig-1'])
    })

    test('unknown content_block_delta types do not throw', () => {
      const r = new ProxyResponse('req_6', true)

      const events: ClaudeStreamEvent[] = [
        {
          type: 'message_start',
          message: baseResponse({ usage: { input_tokens: 1, output_tokens: 0 } }),
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'citations_delta', citation: { url: 'https://x' } } as any,
        },
        { type: 'message_stop' },
      ]

      expect(() => events.forEach(e => r.processStreamEvent(e))).not.toThrow()
    })
  })
})
