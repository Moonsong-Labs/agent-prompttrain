import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { MetricsService } from '../src/services/MetricsService'
import { ProxyRequest } from '../src/domain/entities/ProxyRequest'
import { ProxyResponse } from '../src/domain/entities/ProxyResponse'
import { RequestContextFactory } from '../src/domain/factories/RequestContextFactory'
import { StorageAdapter } from '../src/storage/StorageAdapter'

describe('MetricsService', () => {
  let metricsService: MetricsService
  let mockStorageAdapter: StorageAdapter
  let mockStoreRequest: any
  let mockStoreResponse: any

  beforeEach(() => {
    // Create mock storage adapter
    mockStoreRequest = mock(() => Promise.resolve())
    mockStoreResponse = mock(() => Promise.resolve())

    mockStorageAdapter = {
      storeRequest: mockStoreRequest,
      storeResponse: mockStoreResponse,
      storeStreamingChunk: mock(() => Promise.resolve()),
      close: mock(() => Promise.resolve()),
    } as any

    // Create metrics service with storage enabled
    metricsService = new MetricsService(
      {
        enableTokenTracking: true,
        enableStorage: true,
        enableTelemetry: false,
      },
      mockStorageAdapter
    )
  })

  describe('request storage filtering', () => {
    it('should store inference requests', async () => {
      const request = new ProxyRequest(
        {
          model: 'claude-3-opus-20240229',
          messages: [
            { role: 'system', content: 'System prompt 1' },
            { role: 'system', content: 'System prompt 2' },
            { role: 'user', content: 'Hello' },
          ],
        },
        'example.com',
        'test-request-id',
        'test-api-key'
      )

      const response = new ProxyResponse('test-request-id', false)
      response.processResponse({
        id: 'test-id',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        model: 'claude-3-opus-20240229',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 20,
        },
      })

      const context = RequestContextFactory.forTesting({
        method: 'POST',
        path: '/v1/messages',
        headers: {},
        host: 'example.com',
        requestId: 'test-request-id',
      })

      await metricsService.trackRequest(request, response, context)

      // Verify storage was called for inference request
      expect(mockStoreRequest).toHaveBeenCalled()
      expect(mockStoreResponse).toHaveBeenCalled()
    })

    it('should NOT store quota requests', async () => {
      const request = new ProxyRequest(
        {
          model: 'claude-3-5-haiku-20241022',
          messages: [
            {
              role: 'user',
              content: 'quota',
            },
          ],
          metadata: {
            user_id: 'claude-1',
          },
          max_tokens: 1,
        },
        'example.com',
        'test-request-id',
        'test-api-key'
      )

      const response = new ProxyResponse('test-request-id', false)
      response.processResponse({
        id: 'test-id',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Quota response' }],
        model: 'claude-3-5-haiku-20241022',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 5,
          output_tokens: 1,
        },
      })

      const context = RequestContextFactory.forTesting({
        method: 'POST',
        path: '/v1/messages',
        headers: {},
        host: 'example.com',
        requestId: 'test-request-id',
      })

      await metricsService.trackRequest(request, response, context)

      // Verify storage was NOT called for quota request
      expect(mockStoreRequest).not.toHaveBeenCalled()
      expect(mockStoreResponse).not.toHaveBeenCalled()
    })

    it('should NOT store query_evaluation requests', async () => {
      const request = new ProxyRequest(
        {
          model: 'claude-3-opus-20240229',
          messages: [
            { role: 'system', content: 'Single system message' },
            { role: 'user', content: 'Hello' },
          ],
        },
        'example.com',
        'test-request-id',
        'test-api-key'
      )

      const response = new ProxyResponse('test-request-id', false)
      response.processResponse({
        id: 'test-id',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        model: 'claude-3-opus-20240229',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 20,
        },
      })

      const context = RequestContextFactory.forTesting({
        method: 'POST',
        path: '/v1/messages',
        headers: {},
        host: 'example.com',
        requestId: 'test-request-id',
      })

      await metricsService.trackRequest(request, response, context)

      // Verify storage was NOT called for query_evaluation request
      expect(mockStoreRequest).not.toHaveBeenCalled()
      expect(mockStoreResponse).not.toHaveBeenCalled()
    })
  })
})
