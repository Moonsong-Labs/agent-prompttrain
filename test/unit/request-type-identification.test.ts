import { describe, it, expect } from 'bun:test'
import { ProxyRequest } from '../../services/proxy/src/domain/entities/ProxyRequest'
import { ClaudeMessagesRequest } from '../../services/proxy/src/types/claude'

// Load real test samples
import quotaSample from '../fixtures/requests/quota_haiku.json'
import queryEvaluationSample from '../fixtures/requests/query_evaluation_streaming_with_system_haiku.json'
import inferenceSample from '../fixtures/requests/inference_streaming_with_tools_with_system_opus.json'

describe('ProxyRequest - Request Type Identification', () => {
  describe('quota requests', () => {
    it('should identify quota request when user content is exactly "quota"', () => {
      const request = new ProxyRequest(
        quotaSample.body as ClaudeMessagesRequest,
        'project-alpha',
        'test-123'
      )

      expect(request.requestType).toBe('quota')
    })

    it('should identify quota request case-insensitively', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-3-haiku-20240307',
          messages: [{ role: 'user', content: 'QUOTA' }],
          max_tokens: 10,
        },
        'project-alpha',
        'test-123'
      )

      expect(request.requestType).toBe('quota')
    })

    it('should identify quota request with trimmed whitespace', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-3-haiku-20240307',
          messages: [{ role: 'user', content: '  quota  ' }],
          max_tokens: 10,
        },
        'project-alpha',
        'test-123'
      )

      expect(request.requestType).toBe('quota')
    })
  })

  describe('query_evaluation requests', () => {
    it('should identify query_evaluation with 1 system message in field', () => {
      const request = new ProxyRequest(
        queryEvaluationSample.body as ClaudeMessagesRequest,
        'project-alpha',
        'test-123'
      )

      expect(request.requestType).toBe('query_evaluation')
    })

    it('should identify query_evaluation with 0 system messages', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-3-haiku-20240307',
          messages: [{ role: 'user', content: 'What is 2+2?' }],
          max_tokens: 10,
        },
        'project-alpha',
        'test-123'
      )

      expect(request.requestType).toBe('query_evaluation')
    })

    it('should identify query_evaluation with 1 system message in messages array', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-3-haiku-20240307',
          messages: [
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'Hello' },
          ],
          max_tokens: 10,
        },
        'project-alpha',
        'test-123'
      )

      expect(request.requestType).toBe('query_evaluation')
    })
  })

  describe('inference requests', () => {
    it('should identify inference with multiple system messages', () => {
      const request = new ProxyRequest(
        inferenceSample.body as ClaudeMessagesRequest,
        'project-alpha',
        'test-123'
      )

      expect(request.requestType).toBe('inference')
    })

    it('should identify inference with 2 system messages (1 field + 1 array)', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-3-opus-20240229',
          system: 'You are an AI assistant.',
          messages: [
            { role: 'system', content: 'Follow these rules.' },
            { role: 'user', content: 'Hello' },
          ],
          max_tokens: 100,
        },
        'project-alpha',
        'test-123'
      )

      expect(request.requestType).toBe('inference')
    })

    it('should identify inference with array system field', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-3-opus-20240229',
          system: [
            { type: 'text', text: 'System instruction 1' },
            { type: 'text', text: 'System instruction 2' },
          ],
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 100,
        },
        'project-alpha',
        'test-123'
      )

      expect(request.requestType).toBe('inference')
    })
  })

  describe('system message counting', () => {
    it('should count system messages correctly with string system field', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-3-opus-20240229',
          system: 'Single system message',
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 100,
        },
        'project-alpha',
        'test-123'
      )

      expect(request.countSystemMessages()).toBe(1)
    })

    it('should count system messages correctly with array system field', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-3-opus-20240229',
          system: [
            { type: 'text', text: 'First' },
            { type: 'text', text: 'Second' },
            { type: 'text', text: 'Third' },
          ],
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 100,
        },
        'project-alpha',
        'test-123'
      )

      expect(request.countSystemMessages()).toBe(3)
    })

    it('should count combined system messages from field and array', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-3-opus-20240229',
          system: 'System field message',
          messages: [
            { role: 'system', content: 'Array system 1' },
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi' },
            { role: 'system', content: 'Array system 2' },
            { role: 'user', content: 'Bye' },
          ],
          max_tokens: 100,
        },
        'project-alpha',
        'test-123'
      )

      expect(request.countSystemMessages()).toBe(3) // 1 from field + 2 from array
    })
  })

  describe('internal_operation requests', () => {
    it('should identify Claude Code internal file path extraction request', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-haiku-4-5-20251001',
          tools: [],
          stream: true,
          system: [
            {
              text: "You are Claude Code, Anthropic's official CLI for Claude.",
              type: 'text',
            },
            {
              text: 'Extract any file paths that this command reads or modifies. For commands like "git diff" and "cat", include the paths of files being shown.',
              type: 'text',
            },
          ],
          messages: [
            {
              role: 'user',
              content: [
                {
                  text: 'Command: ls apps/proxy/src/\nOutput: test\n\n',
                  type: 'text',
                },
              ],
            },
          ],
          max_tokens: 32000,
        },
        'project-alpha',
        'test-123'
      )

      expect(request.requestType).toBe('internal_operation')
    })

    it('should identify internal operation with string system field', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-haiku-4-5-20251001',
          system: 'Extract any file paths that this command reads or modifies',
          messages: [{ role: 'user', content: 'Command: ls' }],
          max_tokens: 100,
        },
        'project-alpha',
        'test-123'
      )

      expect(request.requestType).toBe('internal_operation')
    })

    it('should identify internal operation regardless of model', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-3-opus-20240229',
          system: [
            {
              text: 'Extract any file paths that this command reads or modifies',
              type: 'text',
            },
          ],
          messages: [{ role: 'user', content: 'Command: ls' }],
          max_tokens: 100,
        },
        'project-alpha',
        'test-123'
      )

      expect(request.requestType).toBe('internal_operation')
    })

    it('should NOT identify internal operation if tools are present', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-haiku-4-5-20251001',
          tools: [{ name: 'test_tool', description: 'test', input_schema: { type: 'object' } }],
          system: [
            {
              text: 'Extract any file paths that this command reads or modifies',
              type: 'text',
            },
          ],
          messages: [{ role: 'user', content: 'Command: ls' }],
          max_tokens: 100,
        },
        'project-alpha',
        'test-123'
      )

      expect(request.requestType).not.toBe('internal_operation')
    })

    it('should NOT identify internal operation if system prompt is different', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-haiku-4-5-20251001',
          system: 'You are a helpful assistant',
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 100,
        },
        'project-alpha',
        'test-123'
      )

      expect(request.requestType).not.toBe('internal_operation')
    })
  })

  describe('edge cases', () => {
    it('should handle empty messages array', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-3-haiku-20240307',
          messages: [],
          max_tokens: 10,
        },
        'project-alpha',
        'test-123'
      )

      expect(request.requestType).toBe('query_evaluation')
    })

    it('should handle content blocks in user messages', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-3-opus-20240229',
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: 'quota' }],
            },
          ],
          max_tokens: 10,
        },
        'project-alpha',
        'test-123'
      )

      expect(request.requestType).toBe('quota')
    })

    it('should handle mixed content types', () => {
      const request = new ProxyRequest(
        {
          model: 'claude-3-opus-20240229',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Look at this image' },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'base64data' },
                },
              ],
            },
          ],
          max_tokens: 100,
        },
        'project-alpha',
        'test-123'
      )

      expect(request.requestType).toBe('query_evaluation')
    })
  })
})
