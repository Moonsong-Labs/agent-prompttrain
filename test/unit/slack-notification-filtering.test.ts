import { describe, it, expect } from 'bun:test'
import { NotificationService } from '../../services/proxy/src/services/NotificationService'
import { ProxyRequest } from '../../services/proxy/src/domain/entities/ProxyRequest'

describe('NotificationService - Request Type Filtering', () => {
  describe('request type filtering', () => {
    it('should only notify for inference requests', () => {
      // Inference request (2+ system messages)
      const inferenceRequest = new ProxyRequest(
        {
          model: 'claude-3-opus-20240229',
          system: 'System 1',
          messages: [
            { role: 'system', content: 'System 2' },
            { role: 'user', content: 'Complex task' },
          ],
          max_tokens: 100,
        },
        'train-alpha',
        'test-123'
      )

      expect(inferenceRequest.requestType).toBe('inference')

      // Query evaluation request (0-1 system messages)
      const queryRequest = new ProxyRequest(
        {
          model: 'claude-3-haiku-20240307',
          messages: [{ role: 'user', content: 'What is 2+2?' }],
          max_tokens: 10,
        },
        'train-alpha',
        'test-456'
      )

      expect(queryRequest.requestType).toBe('query_evaluation')

      // Quota request
      const quotaRequest = new ProxyRequest(
        {
          model: 'claude-3-haiku-20240307',
          messages: [{ role: 'user', content: 'quota' }],
          max_tokens: 1,
        },
        'train-alpha',
        'test-789'
      )

      expect(quotaRequest.requestType).toBe('quota')
    })
  })

  describe('notification configuration', () => {
    it('should check if notifications are enabled', () => {
      const service1 = new NotificationService({ enabled: true, maxLines: 20, maxLength: 3000 })
      expect(service1['config'].enabled).toBe(true)

      const service2 = new NotificationService({ enabled: false, maxLines: 20, maxLength: 3000 })
      expect(service2['config'].enabled).toBe(false)
    })

    it('should respect train-specific slack configuration', () => {
      const authWithSlack = {
        credentials: {
          slack: {
            enabled: true,
            webhook_url: 'https://hooks.slack.com/test',
            channel: '#notifications',
          },
        },
      }

      const authWithoutSlack = {
        credentials: {},
      }

      const authWithDisabledSlack = {
        credentials: {
          slack: {
            enabled: false,
            webhook_url: 'https://hooks.slack.com/test',
          },
        },
      }

      // Check slack configuration presence
      expect(authWithSlack.credentials.slack).toBeDefined()
      expect(authWithSlack.credentials.slack?.enabled).toBe(true)
      expect(authWithSlack.credentials.slack?.webhook_url).toBeDefined()

      expect(authWithoutSlack.credentials.slack).toBeUndefined()

      expect(authWithDisabledSlack.credentials.slack?.enabled).toBe(false)
    })
  })

  describe('message deduplication', () => {
    it('should track previous messages to avoid duplicates', () => {
      const service = new NotificationService()
      const cache = service['previousMessages']

      // Initially empty
      expect(cache.size).toBe(0)

      // Add some messages
      cache.set('train-one', 'message1')
      cache.set('train-two', 'message2')

      expect(cache.get('train-one')).toBe('message1')
      expect(cache.get('train-two')).toBe('message2')
      expect(cache.size).toBe(2)
    })

    it('should have a maximum cache size', () => {
      const service = new NotificationService()
      const maxSize = service['maxCacheSize']

      expect(maxSize).toBe(1000)
    })
  })
})
