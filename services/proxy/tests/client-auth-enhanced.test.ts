import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
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
      this.mockKeys.set(domain.toLowerCase(), key)
    } else {
      this.mockKeys.delete(domain.toLowerCase())
    }
  }

  async getClientApiKey(domain: string): Promise<string | null> {
    // Normalize domain to lowercase for lookup, simulating real-world behavior
    return this.mockKeys.get(domain.toLowerCase()) || null
  }
}

describe('Enhanced Client Authentication Tests', () => {
  let app: Hono
  let mockAuthService: MockAuthenticationService
  let originalGetAuthService: any

  beforeEach(() => {
    app = new Hono()
    mockAuthService = new MockAuthenticationService()

    // Override the container to use our mock
    originalGetAuthService = container.getAuthenticationService
    container.getAuthenticationService = () => mockAuthService

    // Apply middlewares
    app.use('*', domainExtractorMiddleware())
    app.use('*', clientAuthMiddleware())

    // Test endpoint
    app.get('/test', c => c.json({ success: true }))
  })

  afterEach(() => {
    container.getAuthenticationService = originalGetAuthService
  })

  describe('Domain Case Sensitivity', () => {
    it('should treat domain names as case-insensitive', async () => {
      const testKey = 'cnp_live_casekey'
      // Store the key with a lowercase domain
      mockAuthService.setMockKey('example.com', testKey)

      // Request with an uppercase domain
      const res = await app.request('/test', {
        headers: {
          Host: 'Example.COM',
          Authorization: `Bearer ${testKey}`,
        },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ success: true })
    })

    it('should handle mixed case domains consistently', async () => {
      const testKey = 'cnp_live_mixedcase'
      mockAuthService.setMockKey('MiXeD.CaSe.CoM', testKey)

      const domains = ['mixed.case.com', 'MIXED.CASE.COM', 'MiXeD.cAsE.cOm']

      for (const domain of domains) {
        const res = await app.request('/test', {
          headers: {
            Host: domain,
            Authorization: `Bearer ${testKey}`,
          },
        })
        expect(res.status).toBe(200)
      }
    })
  })

  describe('Malformed Authorization Headers', () => {
    const testCases = [
      ['Bearer', 'Missing token'],
      ['Bearer ', 'Missing token with space'],
      ['cnp_live_somekey', 'Missing Bearer scheme'],
      ['Basic cnp_live_somekey', 'Incorrect scheme (Basic)'],
      ['bearer cnp_live_somekey', 'Lowercase scheme'],
      ['Bearer  cnp_live_somekey', 'Extra space after scheme'],
      ['Bearer\tcnp_live_somekey', 'Tab instead of space'],
    ]

    it.each(testCases)(
      'should reject malformed Authorization header: %s (%s)',
      async (authHeader, _description) => {
        mockAuthService.setMockKey('example.com', 'cnp_live_validkey')

        const res = await app.request('/test', {
          headers: {
            Host: 'example.com',
            Authorization: authHeader,
          },
        })

        expect(res.status).toBe(401)
        expect(res.headers.get('WWW-Authenticate')).toBe('Bearer realm="Agent PromptTrain"')
      }
    )
  })

  describe('Edge Cases', () => {
    it('should reject requests if the configured API key is an empty string', async () => {
      mockAuthService.setMockKey('example.com', '')

      const res = await app.request('/test', {
        headers: {
          Host: 'example.com',
          Authorization: 'Bearer ',
        },
      })

      expect(res.status).toBe(401)
    })

    it('should handle very long API keys', async () => {
      const longKey = 'cnp_live_' + 'a'.repeat(1000)
      mockAuthService.setMockKey('example.com', longKey)

      const res = await app.request('/test', {
        headers: {
          Host: 'example.com',
          Authorization: `Bearer ${longKey}`,
        },
      })

      expect(res.status).toBe(200)
    })

    it('should handle API keys with special characters', async () => {
      const specialKey = 'cnp_live_!@#$%^&*()_+-=[]{}|;:,.<>?'
      mockAuthService.setMockKey('example.com', specialKey)

      const res = await app.request('/test', {
        headers: {
          Host: 'example.com',
          Authorization: `Bearer ${specialKey}`,
        },
      })

      expect(res.status).toBe(200)
    })
  })

  describe('Security Headers', () => {
    it('should ignore X-Forwarded-Host and rely only on the Host header', async () => {
      const realDomain = 'example.com'
      const fakeDomain = 'malicious-actor.com'
      const testKey = 'cnp_live_host_header_key'

      mockAuthService.setMockKey(realDomain, testKey)
      // No key is set for the malicious domain

      const res = await app.request('/test', {
        headers: {
          Host: realDomain,
          'X-Forwarded-Host': fakeDomain,
          Authorization: `Bearer ${testKey}`,
        },
      })

      // If X-Forwarded-Host were used, auth would fail. A 200 proves it was ignored
      expect(res.status).toBe(200)
    })

    it('should ignore X-Original-Host header', async () => {
      const realDomain = 'example.com'
      const fakeDomain = 'attacker.com'
      const testKey = 'cnp_live_original_host_test'

      mockAuthService.setMockKey(realDomain, testKey)

      const res = await app.request('/test', {
        headers: {
          Host: realDomain,
          'X-Original-Host': fakeDomain,
          Authorization: `Bearer ${testKey}`,
        },
      })

      expect(res.status).toBe(200)
    })
  })

  describe('Internationalized Domain Names', () => {
    it('should handle internationalized domain names (Punycode)', async () => {
      const punycodeDomain = 'xn--6qq79v.com' // Punycode for "你好.com"
      const testKey = 'cnp_live_idntest'

      mockAuthService.setMockKey(punycodeDomain, testKey)

      const res = await app.request('/test', {
        headers: {
          Host: punycodeDomain,
          Authorization: `Bearer ${testKey}`,
        },
      })

      expect(res.status).toBe(200)
    })

    it('should handle emoji domains in Punycode', async () => {
      const punycodeDomain = 'xn--i-7iq.ws' // Punycode for "❤️.ws"
      const testKey = 'cnp_live_emojitest'

      mockAuthService.setMockKey(punycodeDomain, testKey)

      const res = await app.request('/test', {
        headers: {
          Host: punycodeDomain,
          Authorization: `Bearer ${testKey}`,
        },
      })

      expect(res.status).toBe(200)
    })
  })
})

describe('Path Traversal Edge Cases', () => {
  it('should allow valid domain names that contain dot sequences', async () => {
    const authService = new AuthenticationService()
    // This domain contains '..' but is a valid subdomain structure
    const validDomainsWithDots = ['sub..domain.com', 'a..b.com', 'example..com', 'test...com']

    for (const domain of validDomainsWithDots) {
      // We expect it not to find a key, but it shouldn't be rejected as a traversal attempt
      const result = await authService.getClientApiKey(domain)
      expect(result).toBeNull()
    }
  })

  it('should reject domains with null bytes', async () => {
    const authService = new AuthenticationService()
    const maliciousDomains = ['example.com\x00.malicious', 'example.com\0', '\x00example.com']

    for (const domain of maliciousDomains) {
      const result = await authService.getClientApiKey(domain)
      expect(result).toBeNull()
    }
  })

  it('should handle domains with URL encoding attempts', async () => {
    const authService = new AuthenticationService()
    const encodedDomains = ['example%2Ecom', 'example%2e%2e%2fcom', '%2e%2e%2fetc%2fpasswd']

    for (const domain of encodedDomains) {
      const result = await authService.getClientApiKey(domain)
      expect(result).toBeNull()
    }
  })
})
