import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { BedrockEmulationService } from '../BedrockEmulationService'
import { Context } from 'hono'

// Response types for type-safe assertions
interface TokenCountResponse {
  input_tokens: number
}

interface ErrorResponse {
  error: {
    type: string
    message: string
  }
}

/**
 * Creates a mock Hono Context with the specified request body.
 */
function createMockContext(body: unknown): Context {
  const mockRequest = {
    json: mock(async () => body),
  }

  const jsonResponses: { body: unknown; status: number }[] = []

  return {
    req: mockRequest,
    json: mock((responseBody: unknown, status: number) => {
      jsonResponses.push({ body: responseBody, status })
      return new Response(JSON.stringify(responseBody), { status })
    }),
    get: mock(() => 'test-request-id'),
    // Expose captured responses for assertions
    _jsonResponses: jsonResponses,
  } as unknown as Context
}

describe('BedrockEmulationService', () => {
  let service: BedrockEmulationService

  beforeEach(() => {
    service = new BedrockEmulationService()
  })

  describe('handleCountTokens', () => {
    it('should return token count for valid messages', async () => {
      const ctx = createMockContext({
        messages: [{ role: 'user', content: 'Hello, world!' }],
      })

      const response = await service.handleCountTokens(ctx)
      const data = (await response.json()) as TokenCountResponse

      expect(response.status).toBe(200)
      expect(data.input_tokens).toBeGreaterThan(0)
    })

    it('should return error for missing messages array', async () => {
      const ctx = createMockContext({})

      const response = await service.handleCountTokens(ctx)
      const data = (await response.json()) as ErrorResponse

      expect(response.status).toBe(400)
      expect(data.error.type).toBe('invalid_request_error')
      expect(data.error.message).toContain('messages array')
    })

    it('should handle system prompts in token counting', async () => {
      const ctx = createMockContext({
        system: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'Hi' }],
      })

      const response = await service.handleCountTokens(ctx)
      const data = (await response.json()) as TokenCountResponse

      expect(response.status).toBe(200)
      expect(data.input_tokens).toBeGreaterThan(0)
    })

    it('should handle array content in messages', async () => {
      const ctx = createMockContext({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      })

      const response = await service.handleCountTokens(ctx)
      const data = (await response.json()) as TokenCountResponse

      expect(response.status).toBe(200)
      expect(data.input_tokens).toBeGreaterThan(0)
    })

    it('should cache results for identical requests', async () => {
      const body = {
        messages: [{ role: 'user', content: 'Cache test message' }],
      }

      // First request
      const ctx1 = createMockContext(body)
      await service.handleCountTokens(ctx1)

      // Second request with same content
      const ctx2 = createMockContext(body)
      await service.handleCountTokens(ctx2)

      const stats = service.getCacheStats()
      expect(stats.hits).toBe(1)
      expect(stats.misses).toBe(1)
    })
  })

  describe('request coalescing', () => {
    it('should coalesce parallel identical requests', async () => {
      const body = {
        messages: [{ role: 'user', content: 'Coalesce test message unique' }],
      }

      // Clear any existing cache
      service.clearCache()

      // Fire multiple parallel requests with identical content
      const ctx1 = createMockContext(body)
      const ctx2 = createMockContext(body)
      const ctx3 = createMockContext(body)

      const [response1, response2, response3] = await Promise.all([
        service.handleCountTokens(ctx1),
        service.handleCountTokens(ctx2),
        service.handleCountTokens(ctx3),
      ])

      const [data1, data2, data3] = (await Promise.all([
        response1.json(),
        response2.json(),
        response3.json(),
      ])) as TokenCountResponse[]

      // All responses should have the same token count
      expect(data1.input_tokens).toBe(data2.input_tokens)
      expect(data2.input_tokens).toBe(data3.input_tokens)

      // Check stats - should have coalesced requests
      const stats = service.getCacheStats()
      // With coalescing, we should have 1 miss (first computation)
      // and either cache hits or coalesced requests for the others
      expect(stats.misses).toBe(1)
      // The remaining 2 requests should be either coalesced or cache hits
      expect(stats.hits + stats.coalesced).toBe(2)
    })

    it('should handle different content without coalescing', async () => {
      service.clearCache()

      const ctx1 = createMockContext({
        messages: [{ role: 'user', content: 'First unique message' }],
      })
      const ctx2 = createMockContext({
        messages: [{ role: 'user', content: 'Second unique message' }],
      })

      await Promise.all([service.handleCountTokens(ctx1), service.handleCountTokens(ctx2)])

      const stats = service.getCacheStats()
      // Both should be cache misses since content is different
      expect(stats.misses).toBe(2)
      expect(stats.coalesced).toBe(0)
    })
  })

  describe('getCacheStats', () => {
    it('should return correct statistics', async () => {
      service.clearCache()

      const initialStats = service.getCacheStats()
      expect(initialStats.hits).toBe(0)
      expect(initialStats.misses).toBe(0)
      expect(initialStats.size).toBe(0)
      expect(initialStats.hitRate).toBe(0)
      expect(initialStats.coalesced).toBe(0)
      expect(initialStats.inFlight).toBe(0)
    })

    it('should track hit rate correctly', async () => {
      service.clearCache()

      const body = { messages: [{ role: 'user', content: 'Hit rate test' }] }

      // First request = miss
      await service.handleCountTokens(createMockContext(body))
      // Second request = hit
      await service.handleCountTokens(createMockContext(body))
      // Third request = hit
      await service.handleCountTokens(createMockContext(body))

      const stats = service.getCacheStats()
      expect(stats.misses).toBe(1)
      expect(stats.hits).toBe(2)
      expect(stats.hitRate).toBeCloseTo(2 / 3, 2)
    })
  })

  describe('clearCache', () => {
    it('should reset all statistics', async () => {
      const body = { messages: [{ role: 'user', content: 'Clear test' }] }
      await service.handleCountTokens(createMockContext(body))

      service.clearCache()

      const stats = service.getCacheStats()
      expect(stats.hits).toBe(0)
      expect(stats.misses).toBe(0)
      expect(stats.size).toBe(0)
      expect(stats.coalesced).toBe(0)
      expect(stats.inFlight).toBe(0)
    })
  })
})
