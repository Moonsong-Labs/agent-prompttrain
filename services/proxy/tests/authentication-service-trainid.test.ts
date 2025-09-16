import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { AuthenticationService } from '../src/services/AuthenticationService'
import * as fs from 'fs'
import { RequestContext } from '../src/domain/value-objects/RequestContext'
import { AuthenticationError } from '@agent-prompttrain/shared'

// Mock logger module
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

describe('AuthenticationService - Train-ID Based Authentication', () => {
  let authService: AuthenticationService
  const credentialsDir = '/tmp/test-credentials'

  beforeEach(async () => {
    // Reset all mocks
    mockLoadCredentials.mockReset()
    mockGetApiKey.mockReset()

    // Mock fs.existsSync to return false for most files
    spyOn(fs, 'existsSync').mockReturnValue(false)

    // Mock fs promises readdir to return empty array initially
    const fsPromises = await import('node:fs/promises')
    spyOn(fsPromises, 'readdir').mockResolvedValue([])

    authService = new AuthenticationService(undefined, credentialsDir)
    await authService.initialize()
  })

  afterEach(() => {
    authService.cleanup()
  })

  describe('Train-ID to Account Mapping', () => {
    beforeEach(async () => {
      // Mock available accounts for consistent testing
      const fsPromises = await import('node:fs/promises')
      const mockReaddir = fsPromises.readdir as any
      mockReaddir.mockResolvedValue([
        'account1.credentials.json',
        'account2.credentials.json',
        'account3.credentials.json',
      ])

      // Mock credentials directory exists
      const mockExistsSync = fs.existsSync as any
      mockExistsSync.mockImplementation((path: string) => {
        return path === credentialsDir || path.endsWith('.credentials.json')
      })

      // Reinitialize service with mocked accounts
      authService = new AuthenticationService(undefined, credentialsDir)
      await authService.initialize()
    })

    it('should consistently map the same train-id to the same account', () => {
      const trainId = 'test-train-123'

      // Call multiple times
      const result1 = (authService as any).mapTrainIdToAccount(trainId)
      const result2 = (authService as any).mapTrainIdToAccount(trainId)
      const result3 = (authService as any).mapTrainIdToAccount(trainId)

      // Should always return the same account
      expect(result1).toBe(result2)
      expect(result2).toBe(result3)
      expect(result1).not.toBeNull()
    })

    it('should distribute different train-ids across available accounts', () => {
      const trainIds = [
        'train-1',
        'train-2',
        'train-3',
        'train-4',
        'train-5',
        'train-6',
        'train-7',
        'train-8',
        'train-9',
        'train-10',
        'alpha',
        'beta',
        'gamma',
        'delta',
        'epsilon',
        'user-001',
        'user-002',
        'user-003',
        'project-a',
        'project-b',
      ]

      const accountMappings = new Map<string, string[]>()

      // Map all train-ids to accounts
      for (const trainId of trainIds) {
        const account = (authService as any).mapTrainIdToAccount(trainId)
        expect(account).not.toBeNull()

        if (!accountMappings.has(account)) {
          accountMappings.set(account, [])
        }
        accountMappings.get(account)!.push(trainId)
      }

      // Should use all 3 accounts (with reasonable distribution)
      expect(accountMappings.size).toBe(3)

      // Each account should have some train-ids assigned
      for (const [account, trainIds] of accountMappings) {
        expect(trainIds.length).toBeGreaterThan(0)
        console.log(`Account ${account} has ${trainIds.length} train-ids: ${trainIds.join(', ')}`)
      }
    })

    it('should handle edge cases in train-id values', () => {
      const edgeCases = [
        '', // Empty string
        ' ', // Whitespace
        '123456789', // Numeric
        'UPPERCASE', // All caps
        'MiXeD-CaSe', // Mixed case
        'special-chars-!@#$%^&*()', // Special characters
        'unicode-café-日本-🚀', // Unicode characters
        'very-long-train-id-that-exceeds-normal-length-boundaries-to-test-hash-behavior',
      ]

      for (const trainId of edgeCases) {
        const result = (authService as any).mapTrainIdToAccount(trainId)
        expect(result).not.toBeNull()
        expect(typeof result).toBe('string')

        // Should be consistent across calls
        const result2 = (authService as any).mapTrainIdToAccount(trainId)
        expect(result).toBe(result2)
      }
    })

    it('should return null when no accounts are available', async () => {
      // Create service with no accounts
      const fsPromises = await import('node:fs/promises')
      const mockReaddir = fsPromises.readdir as any
      mockReaddir.mockResolvedValue([])

      const emptyService = new AuthenticationService(undefined, credentialsDir)
      await emptyService.initialize()

      const result = (emptyService as any).mapTrainIdToAccount('any-train-id')
      expect(result).toBeNull()

      emptyService.cleanup()
    })

    it('should use proper integer modulo for hash distribution', () => {
      // Test that modulo is applied correctly to the hash value
      const trainId = 'test-hash-distribution'
      const result = (authService as any).mapTrainIdToAccount(trainId)

      expect(result).not.toBeNull()
      expect(['account1', 'account2', 'account3']).toContain(result)
    })
  })

  describe('Authentication Flow with Train-ID', () => {
    it('should authenticate successfully with mapped account', async () => {
      // Mock file system for available accounts
      const fsPromises = await import('node:fs/promises')
      const mockReaddir = fsPromises.readdir as any
      mockReaddir.mockResolvedValue(['test-account.credentials.json'])

      const mockExistsSync = fs.existsSync as any
      mockExistsSync.mockImplementation((path: string) => {
        return path === credentialsDir || path.includes('test-account.credentials.json')
      })

      // Mock credential loading
      mockLoadCredentials.mockReturnValue({
        type: 'api_key',
        api_key: 'sk-ant-test-key',
        accountId: 'test-account',
      })
      mockGetApiKey.mockResolvedValue('sk-ant-test-key')

      // Reinitialize service with mocked account
      authService = new AuthenticationService(undefined, credentialsDir)
      await authService.initialize()

      const context: RequestContext = {
        requestId: 'test-123',
        trainId: 'my-train-id',
        timestamp: new Date().toISOString(),
        path: '/test',
        method: 'POST',
        headers: {},
        body: null,
        stream: null,
        streamController: null,
        apiKey: null,
      }

      const result = await authService.authenticate(context)

      expect(result.type).toBe('api_key')
      expect(result.key).toBe('sk-ant-test-key')
      expect(result.headers).toHaveProperty('x-api-key', 'sk-ant-test-key')
    })

    it('should throw error when no accounts are available', async () => {
      // Service with no accounts
      const context: RequestContext = {
        requestId: 'test-123',
        trainId: 'my-train-id',
        timestamp: new Date().toISOString(),
        path: '/test',
        method: 'POST',
        headers: {},
        body: null,
        stream: null,
        streamController: null,
        apiKey: null,
      }

      await expect(authService.authenticate(context)).rejects.toThrow(AuthenticationError)
    })

    it('should use default API key for default train-id', async () => {
      const serviceWithDefault = new AuthenticationService('sk-default-key', credentialsDir)
      await serviceWithDefault.initialize()

      const context: RequestContext = {
        requestId: 'test-123',
        trainId: 'default',
        timestamp: new Date().toISOString(),
        path: '/test',
        method: 'POST',
        headers: {},
        body: null,
        stream: null,
        streamController: null,
        apiKey: null,
      }

      const result = await serviceWithDefault.authenticate(context)

      expect(result.type).toBe('api_key')
      expect(result.key).toBe('sk-default-key')
      expect(result.headers).toHaveProperty('x-api-key', 'sk-default-key')

      serviceWithDefault.cleanup()
    })
  })

  describe('Hash Distribution Quality', () => {
    it('should demonstrate good distribution properties', async () => {
      // Setup with more accounts for better distribution testing
      const fsPromises = await import('node:fs/promises')
      const mockReaddir = fsPromises.readdir as any
      mockReaddir.mockResolvedValue([
        'account1.credentials.json',
        'account2.credentials.json',
        'account3.credentials.json',
        'account4.credentials.json',
        'account5.credentials.json',
      ])

      const mockExistsSync = fs.existsSync as any
      mockExistsSync.mockImplementation((path: string) => {
        return path === credentialsDir || path.endsWith('.credentials.json')
      })

      // Reinitialize with 5 accounts
      const testService = new AuthenticationService(undefined, credentialsDir)
      await testService.initialize()

      // Generate many train-ids and check distribution
      const sampleSize = 1000
      const accountCounts = new Map<string, number>()

      for (let i = 0; i < sampleSize; i++) {
        const trainId = `train-${i}-${Math.random().toString(36).substring(7)}`
        const account = (testService as any).mapTrainIdToAccount(trainId)

        accountCounts.set(account, (accountCounts.get(account) || 0) + 1)
      }

      // Check that we have reasonable distribution
      expect(accountCounts.size).toBe(5) // All accounts used

      const expectedPerAccount = sampleSize / 5 // 200
      const tolerance = expectedPerAccount * 0.2 // 20% tolerance

      for (const [account, count] of accountCounts) {
        expect(count).toBeGreaterThan(expectedPerAccount - tolerance)
        expect(count).toBeLessThan(expectedPerAccount + tolerance)
        console.log(
          `Account ${account}: ${count} assignments (${((count / sampleSize) * 100).toFixed(1)}%)`
        )
      }

      testService.cleanup()
    })
  })
})
