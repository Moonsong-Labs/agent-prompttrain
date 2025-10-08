import { describe, it, expect } from 'bun:test'
import { ProxyRequest } from '../../services/proxy/src/domain/entities/ProxyRequest'
import { ProxyResponse } from '../../services/proxy/src/domain/entities/ProxyResponse'
import { responseFactory } from '../helpers/test-factories'

describe('ProxyRequest - Parsing', () => {
  describe('model parsing', () => {
    it('should extract model name correctly', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-3-opus-20240229',
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 100,
        },
        'project-alpha',
        'test-123'
      )

      expect(request.model).toBe('claude-3-opus-20240229')
    })
  })

  describe('streaming detection', () => {
    it('should detect streaming requests', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-3-haiku-20240307',
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 100,
          stream: true,
        },
        'project-alpha',
        'test-123'
      )

      expect(request.isStreaming).toBe(true)
    })

    it('should default to non-streaming when stream is not specified', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-3-haiku-20240307',
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 100,
        },
        'project-alpha',
        'test-123'
      )

      expect(request.isStreaming).toBe(false)
    })
  })

  describe('tools detection', () => {
    it('should detect when tools are present', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-3-opus-20240229',
          messages: [{ role: 'user', content: 'Get the weather' }],
          max_tokens: 100,
          tools: [
            {
              name: 'get_weather',
              description: 'Get weather for a location',
              input_schema: {
                type: 'object',
                properties: {
                  location: { type: 'string' },
                },
                required: ['location'],
              },
            },
          ],
        },
        'project-alpha',
        'test-123'
      )

      expect(request.raw.tools).toBeDefined()
      expect(request.raw.tools?.length).toBe(1)
    })

    it('should detect when no tools are present', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-3-opus-20240229',
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 100,
        },
        'project-alpha',
        'test-123'
      )

      expect(request.raw.tools).toBeUndefined()
    })

    it('should handle empty tools array', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-3-opus-20240229',
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 100,
          tools: [],
        },
        'project-alpha',
        'test-123'
      )

      expect(request.raw.tools).toBeDefined()
      expect(request.raw.tools?.length).toBe(0)
    })
  })

  describe('content extraction', () => {
    it('should extract user content from string message', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-3-haiku-20240307',
          messages: [{ role: 'user', content: 'What is the weather?' }],
          max_tokens: 100,
        },
        'project-alpha',
        'test-123'
      )

      expect(request.getUserContent()).toBe('What is the weather?')
    })

    it('should extract user content from content blocks', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-3-opus-20240229',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'First part. ' },
                { type: 'text', text: 'Second part.' },
              ],
            },
          ],
          max_tokens: 100,
        },
        'project-alpha',
        'test-123'
      )

      expect(request.getUserContent()).toBe('First part. \nSecond part.')
    })

    it('should handle non-text content blocks', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-3-opus-20240229',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Look at this:' },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'data' },
                },
                { type: 'text', text: 'What do you see?' },
              ],
            },
          ],
          max_tokens: 100,
        },
        'project-alpha',
        'test-123'
      )

      expect(request.getUserContent()).toBe('Look at this:\nWhat do you see?')
    })
  })
})

describe('ProxyResponse - Parsing', () => {
  describe('non-streaming responses', () => {
    it('should parse simple text response', () => {
      const response = new ProxyResponse('test-123', false)
      const claudeResponse = responseFactory.simple()

      response.processResponse(claudeResponse)

      expect(response.content).toBe(claudeResponse.content[0].text)
      expect(response.inputTokens).toBe(claudeResponse.usage.input_tokens)
      expect(response.outputTokens).toBe(claudeResponse.usage.output_tokens)
    })

    it('should parse response with tool use', () => {
      const response = new ProxyResponse('test-123', false)
      const claudeResponse = responseFactory.withToolUse()

      response.processResponse(claudeResponse)

      expect(response.content).toContain("I'll help you with that.")
      expect(response.toolCallCount).toBe(1)
    })

    it('should handle multiple content blocks', () => {
      const response = new ProxyResponse('test-123', false)
      const claudeResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'First part. ' },
          { type: 'text', text: 'Second part.' },
        ],
        model: 'claude-3-opus-20240229',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 20,
        },
      }

      response.processResponse(claudeResponse)

      expect(response.content).toBe('First part. \nSecond part.')
    })
  })

  describe('streaming responses', () => {
    it('should accumulate content from stream chunks', () => {
      const response = new ProxyResponse('test-123', true)

      // Message start
      response.processStreamEvent({
        type: 'message_start',
        message: {
          id: 'msg_123',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-3-opus-20240229',
          usage: { input_tokens: 15, output_tokens: 0 },
        },
      })

      // Content chunks
      response.processStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello ' },
      })

      response.processStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'world!' },
      })

      // Message delta with final token count
      response.processStreamEvent({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 5 },
      })

      expect(response.content).toBe('Hello world!')
      expect(response.inputTokens).toBe(15)
      expect(response.outputTokens).toBe(5)
      // ProxyResponse doesn't expose stopReason directly
    })

    it('should handle tool use in streaming', () => {
      const response = new ProxyResponse('test-123', true)

      // Tool use block
      response.processStreamEvent({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'tool_123',
          name: 'get_weather',
          input: {},
        },
      })

      response.processStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"location": "San Francisco"}',
        },
      })

      expect(response.toolCallCount).toBe(1)
    })
  })

  describe('error handling', () => {
    it('should handle missing content gracefully', () => {
      const response = new ProxyResponse('test-123', false)
      const claudeResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-3-opus-20240229',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 0,
        },
      }

      response.processResponse(claudeResponse)

      expect(response.content).toBe('')
      expect(response.outputTokens).toBe(0)
    })

    it('should handle null/undefined in content blocks', () => {
      const response = new ProxyResponse('test-123', false)
      const claudeResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: null },
          { type: 'text', text: 'Valid text' },
          { type: 'text', text: undefined },
        ],
        model: 'claude-3-opus-20240229',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
        },
      }

      response.processResponse(claudeResponse as any)

      expect(response.content).toBe('\nValid text\n')
    })
  })
})
