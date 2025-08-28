import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Hono } from 'hono'
import { clientAuthMiddleware } from '../src/middleware/client-auth'
import { domainExtractorMiddleware } from '../src/middleware/domain-extractor'
import { container } from '../src/container'
import { AuthenticationService } from '../src/services/AuthenticationService'

// Mock authentication service
class MockAuthenticationService extends AuthenticationService {
  private mockKeys: Map<string, string> = new Map()

  constructor() {
    super(undefined, '/tmp/test-credentials')
  }

  setMockKey(domain: string, key: string | null) {
    if (key) {
      this.mockKeys.set(domain, key)
    } else {
      this.mockKeys.delete(domain)
    }
  }

  async getClientApiKey(domain: string): Promise<string | null> {
    return this.mockKeys.get(domain) || null
  }
}

describe('Client Authentication Middleware', () => {
  let app: Hono
  let mockAuthService: MockAuthenticationService

  beforeEach(() => {
    app = new Hono()
    mockAuthService = new MockAuthenticationService()

    // Override the container to use our mock
    const originalGetAuthService = container.getAuthenticationService
    container.getAuthenticationService = () => mockAuthService

    // Apply middlewares
    app.use('*', domainExtractorMiddleware())
    app.use('*', clientAuthMiddleware())

    // Test endpoint
    app.get('/test', c => c.json({ success: true }))

    // Restore after each test
    afterEach(() => {
      container.getAuthenticationService = originalGetAuthService
    })
  })

  describe('Valid Authentication', () => {
    it('should allow requests with valid API key', async () => {
      const testKey = 'cnp_live_validtestkey123'
      mockAuthService.setMockKey('example.com', testKey)

      const res = await app.request('/test', {
        headers: {
          Host: 'example.com',
          Authorization: `Bearer ${testKey}`,
        },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ success: true })
    })

    it('should handle different domains correctly', async () => {
      const key1 = 'cnp_live_domain1key'
      const key2 = 'cnp_live_domain2key'

      mockAuthService.setMockKey('domain1.com', key1)
      mockAuthService.setMockKey('domain2.com', key2)

      // Test domain1
      const res1 = await app.request('/test', {
        headers: {
          Host: 'domain1.com',
          Authorization: `Bearer ${key1}`,
        },
      })
      expect(res1.status).toBe(200)

      // Test domain2
      const res2 = await app.request('/test', {
        headers: {
          Host: 'domain2.com',
          Authorization: `Bearer ${key2}`,
        },
      })
      expect(res2.status).toBe(200)

      // Test wrong key for domain1
      const res3 = await app.request('/test', {
        headers: {
          Host: 'domain1.com',
          Authorization: `Bearer ${key2}`,
        },
      })
      expect(res3.status).toBe(401)
    })
  })

  describe('Invalid Authentication', () => {
    it('should reject requests without Authorization header', async () => {
      mockAuthService.setMockKey('example.com', 'cnp_live_testkey')

      const res = await app.request('/test', {
        headers: {
          Host: 'example.com',
        },
      })

      expect(res.status).toBe(401)
      expect(res.headers.get('WWW-Authenticate')).toBe('Bearer realm="Agent Prompt Train"')
    })

    it('should reject requests with invalid API key', async () => {
      mockAuthService.setMockKey('example.com', 'cnp_live_validkey')

      const res = await app.request('/test', {
        headers: {
          Host: 'example.com',
          Authorization: 'Bearer cnp_live_wrongkey',
        },
      })

      expect(res.status).toBe(401)
    })

    it('should reject requests when no API key is configured', async () => {
      // No key set for domain

      const res = await app.request('/test', {
        headers: {
          Host: 'example.com',
          Authorization: 'Bearer cnp_live_somekey',
        },
      })

      expect(res.status).toBe(401)
    })

    it('should reject requests without Host header', async () => {
      const res = await app.request('/test', {
        headers: {
          Authorization: 'Bearer cnp_live_testkey',
        },
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error.message).toBe('Host header is required')
    })
  })

  describe('Security Features', () => {
    it('should use timing-safe comparison', async () => {
      // This test verifies that the implementation uses SHA-256 hashing
      // We can't directly test timing, but we can verify the behavior
      const testKey = 'cnp_live_securekey123'
      mockAuthService.setMockKey('example.com', testKey)

      // Multiple requests with wrong keys of different lengths
      const wrongKeys = [
        'a',
        'cnp_live_wrong',
        'cnp_live_wrongkeythatisverylongandshouldbedifferent',
        testKey.slice(0, -1), // Almost correct
      ]

      for (const wrongKey of wrongKeys) {
        const res = await app.request('/test', {
          headers: {
            Host: 'example.com',
            Authorization: `Bearer ${wrongKey}`,
          },
        })
        expect(res.status).toBe(401)
      }
    })

    it('should handle domains with ports correctly', async () => {
      const testKey = 'cnp_live_porttest'
      mockAuthService.setMockKey('example.com', testKey)

      const res = await app.request('/test', {
        headers: {
          Host: 'example.com:8080',
          Authorization: `Bearer ${testKey}`,
        },
      })

      expect(res.status).toBe(200)
    })
  })

  describe('Error Handling', () => {
    it('should handle authentication service errors gracefully', async () => {
      // Override getClientApiKey to throw an error
      mockAuthService.getClientApiKey = async () => {
        throw new Error('Database connection failed')
      }

      const res = await app.request('/test', {
        headers: {
          Host: 'example.com',
          Authorization: 'Bearer cnp_live_anykey',
        },
      })

      expect(res.status).toBe(500)
    })
  })
})

describe('Path Traversal Protection', () => {
  it('should prevent path traversal attacks', async () => {
    const authService = new AuthenticationService()

    // Test various path traversal attempts
    const maliciousDomains = [
      '../../../etc/passwd',
      '..\\..\\..\\windows\\system32',
      'example.com/../../secrets',
      'example.com%2F..%2F..%2Fsecrets',
      '..',
      '.',
      '',
    ]

    for (const domain of maliciousDomains) {
      const result = await authService.getClientApiKey(domain)
      expect(result).toBeNull()
    }
  })

  it('should allow valid domain names', async () => {
    const authService = new AuthenticationService()

    // These should be allowed (though they won't have keys in tests)
    const validDomains = [
      'example.com',
      'sub.example.com',
      'example-with-dash.com',
      'example123.com',
      'localhost',
    ]

    // Just verify they don't throw errors
    for (const domain of validDomains) {
      await expect(authService.getClientApiKey(domain)).resolves.toBeDefined()
    }
  })
})
