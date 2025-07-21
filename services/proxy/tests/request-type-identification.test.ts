import { describe, it, expect } from 'bun:test'
import { ProxyRequest } from '../src/domain/entities/ProxyRequest'
import { ClaudeMessagesRequest } from '@claude-nexus/shared'

// Load real test samples
import quotaSample from './fixtures/requests/quota_haiku.json'
import queryEvaluationSample from './fixtures/requests/query_evaluation_streaming_with_system_haiku.json'
import inferenceSample from './fixtures/requests/inference_streaming_with_tools_with_system_opus.json'

describe('ProxyRequest - Request Type Identification', () => {
  const TEST_DOMAIN = 'test.domain.com'
  const TEST_REQUEST_ID = 'test-123'

  describe('quota requests', () => {
    it('should identify quota request when user content is exactly "quota"', () => {
      const request = new ProxyRequest(
        quotaSample.body as ClaudeMessagesRequest,
        TEST_DOMAIN,
        TEST_REQUEST_ID
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
        TEST_DOMAIN,
        TEST_REQUEST_ID
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
        TEST_DOMAIN,
        TEST_REQUEST_ID
      )

      expect(request.requestType).toBe('quota')
    })
  })

  describe('query_evaluation requests', () => {
    it('should identify query_evaluation with 1 system message in field', () => {
      const request = new ProxyRequest(
        queryEvaluationSample.body as ClaudeMessagesRequest,
        TEST_DOMAIN,
        TEST_REQUEST_ID
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
        TEST_DOMAIN,
        TEST_REQUEST_ID
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
        TEST_DOMAIN,
        TEST_REQUEST_ID
      )

      expect(request.requestType).toBe('query_evaluation')
    })
  })

  describe('inference requests', () => {
    it('should identify inference with multiple system messages', () => {
      const request = new ProxyRequest(
        inferenceSample.body as ClaudeMessagesRequest,
        TEST_DOMAIN,
        TEST_REQUEST_ID
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
        TEST_DOMAIN,
        TEST_REQUEST_ID
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
        TEST_DOMAIN,
        TEST_REQUEST_ID
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
        TEST_DOMAIN,
        TEST_REQUEST_ID
      )

      expect(request.systemMessageCount).toBe(1)
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
        TEST_DOMAIN,
        TEST_REQUEST_ID
      )

      expect(request.systemMessageCount).toBe(3)
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
        TEST_DOMAIN,
        TEST_REQUEST_ID
      )

      expect(request.systemMessageCount).toBe(3) // 1 from field + 2 from array
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
        TEST_DOMAIN,
        TEST_REQUEST_ID
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
        TEST_DOMAIN,
        TEST_REQUEST_ID
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
        TEST_DOMAIN,
        TEST_REQUEST_ID
      )

      expect(request.requestType).toBe('query_evaluation')
    })
  })
})
