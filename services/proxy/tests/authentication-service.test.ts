import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { AuthenticationService } from '../src/services/AuthenticationService'
import * as fs from 'fs'
import * as path from 'path'
import { RequestContext } from '../src/domain/value-objects/RequestContext'
import { AuthenticationError } from '@agent-prompttrain/shared'

// Mock logger module first
mock.module('../src/middleware/logger', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  },
}))

// Mock the credentials module
const mockLoadCredentials = spyOn(await import('../src/credentials'), 'loadCredentials')
const mockGetApiKey = spyOn(await import('../src/credentials'), 'getApiKey')

// Mock fs.promises.access
const mockFsAccess = spyOn(fs.promises, 'access')

// Mock psl
const mockPsl = {
  parse: (domain: string) => {
    // Simple mock PSL implementation
    const parts = domain.split('.')
    if (parts.length >= 2) {
      const tld = parts[parts.length - 1]
      const sld = parts[parts.length - 2]

      // Handle common public suffixes
      if (['co', 'com', 'org', 'net', 'gov', 'edu'].includes(tld)) {
        if (sld === 'co' && parts.length >= 3) {
          // Handle co.uk, co.jp etc
          return { domain: `${parts[parts.length - 3]}.${sld}.${tld}` }
        }
        return { domain: `${sld}.${tld}` }
      }
    }
    return { domain: null }
  },
}

// Replace psl module
mock.module('psl', () => mockPsl)

describe('AuthenticationService - Wildcard Support', () => {
  let authService: AuthenticationService
  const credentialsDir = '/tmp/test-credentials'

  beforeEach(() => {
    // Reset all mocks
    mockLoadCredentials.mockReset()
    mockGetApiKey.mockReset()
    mockFsAccess.mockReset()

    // Clear environment variables
    delete process.env.CNP_WILDCARD_CREDENTIALS
    delete process.env.CNP_RESOLUTION_CACHE_TTL
    delete process.env.CNP_DEBUG_RESOLUTION

    authService = new AuthenticationService(undefined, credentialsDir)
  })

  afterEach(() => {
    authService.destroy()
  })

  describe('Domain Normalization', () => {
    it('should normalize domain to lowercase', () => {
      const normalized = authService['normalizeDomain']('API.Example.COM')
      expect(normalized).toBe('api.example.com')
    })

    it('should remove port numbers', () => {
      const normalized = authService['normalizeDomain']('api.example.com:8080')
      expect(normalized).toBe('api.example.com')
    })

    it('should remove trailing dots', () => {
      const normalized = authService['normalizeDomain']('api.example.com.')
      expect(normalized).toBe('api.example.com')
    })

    it('should collapse consecutive dots', () => {
      const normalized = authService['normalizeDomain']('api..example...com')
      expect(normalized).toBe('api.example.com')
    })

    it('should throw on empty labels', () => {
      expect(() => authService['normalizeDomain']('.example.com')).toThrow('Invalid domain')
      expect(() => authService['normalizeDomain']('example.com.')).not.toThrow()
    })

    it('should handle IDN (internationalized domain names)', () => {
      // Test various international domains
      const testCases = [
        { input: 'café.example.com', expected: 'xn--caf-dma.example.com' },
        { input: 'münchen.example.com', expected: 'xn--mnchen-3ya.example.com' },
        { input: '日本.example.com', expected: 'xn--wgv71a.example.com' },
        { input: 'россия.example.com', expected: 'xn--h1alffa9f.example.com' },
      ]

      for (const { input, expected } of testCases) {
        const normalized = authService['normalizeDomain'](input)
        expect(normalized).toBe(expected)
      }
    })

    it('should handle mixed IDN and ASCII', () => {
      const normalized = authService['normalizeDomain']('api.café.example.com:8080')
      expect(normalized).toBe('api.xn--caf-dma.example.com')
    })

    it('should handle already punycoded domains', () => {
      const normalized = authService['normalizeDomain']('xn--caf-dma.example.com')
      expect(normalized).toBe('xn--caf-dma.example.com')
    })
  })

  describe('Credential File Existence Check', () => {
    it('should return true when file exists', async () => {
      mockFsAccess.mockResolvedValueOnce(undefined)

      const exists = await authService['credentialFileExists']('/path/to/file')
      expect(exists).toBe(true)
      expect(mockFsAccess).toHaveBeenCalledWith('/path/to/file', fs.constants.F_OK)
    })

    it('should return false when file does not exist', async () => {
      mockFsAccess.mockRejectedValueOnce(new Error('ENOENT'))

      const exists = await authService['credentialFileExists']('/path/to/file')
      expect(exists).toBe(false)
    })
  })

  describe('Wildcard Pattern Matching with PSL', () => {
    it('should find most specific wildcard match', async () => {
      mockFsAccess.mockImplementation(async (path: string) => {
        if (path.includes('_wildcard.staging.example.com')) {
          return undefined // File exists
        }
        throw new Error('ENOENT')
      })

      const match = await authService['findWildcardMatch']('api.staging.example.com')
      expect(match).toContain('_wildcard.staging.example.com.credentials.json')
    })

    it('should stop at registrable domain boundary', async () => {
      mockFsAccess.mockRejectedValue(new Error('ENOENT'))

      const match = await authService['findWildcardMatch']('api.example.co.uk')
      expect(match).toBeNull()

      // Should not have checked _wildcard.co.uk
      expect(mockFsAccess).not.toHaveBeenCalledWith(
        expect.stringContaining('_wildcard.co.uk.credentials.json'),
        expect.anything()
      )
    })

    it('should return null when no wildcard matches', async () => {
      mockFsAccess.mockRejectedValue(new Error('ENOENT'))

      const match = await authService['findWildcardMatch']('api.example.com')
      expect(match).toBeNull()
    })
  })

  describe('Credential Resolution with Feature Flag', () => {
    it('should use original behavior when feature flag is disabled', async () => {
      process.env.CNP_WILDCARD_CREDENTIALS = 'false'

      const mockContext: RequestContext = {
        requestId: 'test-123',
        host: 'api.example.com',
        timestamp: new Date().toISOString(),
        path: '/test',
        method: 'POST',
        headers: {},
        body: null,
        stream: null,
        streamController: null,
        apiKey: null,
      }

      // Mock credential file exists
      const expectedPath = path.join(credentialsDir, 'api.example.com.credentials.json')
      mockLoadCredentials.mockReturnValue({
        type: 'api_key',
        api_key: 'sk-ant-test',
        accountId: 'acc_test',
      })
      mockGetApiKey.mockResolvedValue('sk-ant-test')

      const result = await authService.authenticateNonPersonalDomain(mockContext)

      expect(result.type).toBe('api_key')
      expect(result.key).toBe('sk-ant-test')
    })

    it('should try exact match first when wildcard is enabled', async () => {
      process.env.CNP_WILDCARD_CREDENTIALS = 'true'

      mockFsAccess.mockImplementation(async (path: string) => {
        if (path.includes('api.example.com.credentials.json') && !path.includes('_wildcard')) {
          return undefined // Exact match exists
        }
        throw new Error('ENOENT')
      })

      mockLoadCredentials.mockReturnValue({
        type: 'api_key',
        api_key: 'sk-ant-exact',
        accountId: 'acc_exact',
      })
      mockGetApiKey.mockResolvedValue('sk-ant-exact')

      const mockContext: RequestContext = {
        requestId: 'test-123',
        host: 'api.example.com',
        timestamp: new Date().toISOString(),
        path: '/test',
        method: 'POST',
        headers: {},
        body: null,
        stream: null,
        streamController: null,
        apiKey: null,
      }

      const result = await authService.authenticateNonPersonalDomain(mockContext)

      expect(result.key).toBe('sk-ant-exact')
      expect(result.accountId).toBe('acc_exact')
    })

    it('should fall back to wildcard when exact match not found', async () => {
      process.env.CNP_WILDCARD_CREDENTIALS = 'true'

      mockFsAccess.mockImplementation(async (path: string) => {
        if (path.includes('_wildcard.example.com.credentials.json')) {
          return undefined // Wildcard exists
        }
        throw new Error('ENOENT')
      })

      mockLoadCredentials.mockReturnValue({
        type: 'api_key',
        api_key: 'sk-ant-wildcard',
        accountId: 'acc_wildcard',
      })
      mockGetApiKey.mockResolvedValue('sk-ant-wildcard')

      const mockContext: RequestContext = {
        requestId: 'test-123',
        host: 'api.subdomain.example.com',
        timestamp: new Date().toISOString(),
        path: '/test',
        method: 'POST',
        headers: {},
        body: null,
        stream: null,
        streamController: null,
        apiKey: null,
      }

      const result = await authService.authenticateNonPersonalDomain(mockContext)

      expect(result.key).toBe('sk-ant-wildcard')
      expect(result.accountId).toBe('acc_wildcard')
    })
  })

  describe('Caching Behavior', () => {
    it('should cache resolution results', async () => {
      process.env.CNP_WILDCARD_CREDENTIALS = 'true'
      process.env.CNP_RESOLUTION_CACHE_TTL = '60000' // 1 minute

      mockFsAccess.mockImplementation(async (path: string) => {
        if (path.includes('test.example.com.credentials.json')) {
          return undefined
        }
        throw new Error('ENOENT')
      })

      // First call
      await authService['resolveCredentialPath']('test.example.com')
      expect(mockFsAccess).toHaveBeenCalledTimes(1)

      // Second call should use cache
      await authService['resolveCredentialPath']('test.example.com')
      expect(mockFsAccess).toHaveBeenCalledTimes(1) // No additional calls
    })

    it('should cache negative results', async () => {
      process.env.CNP_WILDCARD_CREDENTIALS = 'true'

      mockFsAccess.mockRejectedValue(new Error('ENOENT'))

      // First call
      const result1 = await authService['resolveCredentialPath']('nonexistent.example.com')
      expect(result1).toBeNull()

      // Reset mock to ensure cache is used
      mockFsAccess.mockReset()

      // Second call should use cache
      const result2 = await authService['resolveCredentialPath']('nonexistent.example.com')
      expect(result2).toBeNull()
      expect(mockFsAccess).not.toHaveBeenCalled()
    })

    it('should enforce cache size limits', async () => {
      process.env.CNP_WILDCARD_CREDENTIALS = 'true'
      process.env.CNP_RESOLUTION_CACHE_TTL = '60000' // 1 minute

      mockFsAccess.mockRejectedValue(new Error('ENOENT'))

      // Fill cache beyond limit
      const maxSize = authService['maxCacheSize']
      for (let i = 0; i < maxSize + 100; i++) {
        await authService['resolveCredentialPath'](`test${i}.example.com`)
      }

      // Cache should not exceed max size
      expect(authService['resolutionCache'].size).toBeLessThanOrEqual(maxSize)
    })

    it('should handle invalid TTL values gracefully', async () => {
      process.env.CNP_WILDCARD_CREDENTIALS = 'true'

      // Test various invalid TTL values
      const invalidTtls = ['invalid', '-1000', '0', '999', '86400001'] // too small, too large

      for (const ttl of invalidTtls) {
        process.env.CNP_RESOLUTION_CACHE_TTL = ttl
        authService = new AuthenticationService(undefined, credentialsDir)

        mockFsAccess.mockRejectedValue(new Error('ENOENT'))

        // Should not throw, should use default TTL
        await authService['resolveCredentialPath']('test.example.com')

        // Check that cache entry exists with valid expiration
        const cached = authService['resolutionCache'].get('test.example.com')
        expect(cached).toBeDefined()
        expect(cached!.expiresAt).toBeGreaterThan(Date.now())
        expect(cached!.expiresAt).toBeLessThanOrEqual(Date.now() + 300000 + 1000) // default + buffer

        authService.destroy()
      }
    })
  })

  describe('Shadow Mode', () => {
    it('should log but not change behavior in shadow mode', async () => {
      process.env.CNP_WILDCARD_CREDENTIALS = 'shadow'

      const logSpy = spyOn(console, 'log')

      mockFsAccess.mockImplementation(async (path: string) => {
        if (path.includes('shadow.example.com.credentials.json')) {
          return undefined
        }
        throw new Error('ENOENT')
      })

      await authService['resolveCredentialPath']('shadow.example.com')

      // Should still perform resolution
      expect(mockFsAccess).toHaveBeenCalled()
    })
  })

  describe('Security Tests', () => {
    it('should not allow wildcard patterns in user input', async () => {
      process.env.CNP_WILDCARD_CREDENTIALS = 'true'

      // These domains should either be rejected or normalized
      const result1 = await authService['resolveCredentialPath']('*.example.com')
      if (result1) {
        // The * should be treated as a regular character, not a wildcard
        expect(result1).not.toContain('_wildcard')
      }

      const result2 = await authService['resolveCredentialPath']('../../../etc/passwd')
      expect(result2).toBeNull() // Should be rejected by getSafeCredentialPath

      const result3 = await authService['resolveCredentialPath']('example.com/../../secrets')
      expect(result3).toBeNull() // Should be rejected by getSafeCredentialPath
    })

    it('should never check public suffix wildcards', async () => {
      process.env.CNP_WILDCARD_CREDENTIALS = 'true'

      mockFsAccess.mockRejectedValue(new Error('ENOENT'))

      await authService['findWildcardMatch']('subdomain.example.com')

      // Should never check _wildcard.com
      expect(mockFsAccess).not.toHaveBeenCalledWith(
        expect.stringContaining('_wildcard.com.credentials.json'),
        expect.anything()
      )
    })
  })
})
