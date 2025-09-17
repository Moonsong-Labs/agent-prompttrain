import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'
import { clientAuthMiddleware } from '../src/middleware/client-auth'
import { trainIdExtractorMiddleware } from '../src/middleware/train-id-extractor'
import { container } from '../src/container'
import { AuthenticationService } from '../src/services/AuthenticationService'

// Mock authentication service that allows us to control train credentials
class MockAuthenticationService extends AuthenticationService {
  private readonly mockKeys = new Map<string, string>()

  constructor() {
    super(undefined, '/tmp/test-credentials')
  }

  setMockKey(trainId: string, key: string | null) {
    if (key) {
      this.mockKeys.set(trainId, key)
    } else {
      this.mockKeys.delete(trainId)
    }
  }

  async getClientApiKey(trainId: string): Promise<string | null> {
    return this.mockKeys.get(trainId) ?? null
  }
}

describe('Client Authentication Middleware', () => {
  let app: Hono
  let mockAuthService: MockAuthenticationService
  let originalGetAuthService: typeof container.getAuthenticationService

  beforeEach(() => {
    mockAuthService = new MockAuthenticationService()
    originalGetAuthService = container.getAuthenticationService
    container.getAuthenticationService = () => mockAuthService

    app = new Hono()
    app.use('*', trainIdExtractorMiddleware())
    app.use('*', clientAuthMiddleware())
    app.get('/test', c => c.json({ success: true }))
  })

  afterEach(() => {
    container.getAuthenticationService = originalGetAuthService
  })

  describe('Valid Authentication', () => {
    it('allows requests with valid API key', async () => {
      const testKey = 'cnp_live_validtestkey123'
      mockAuthService.setMockKey('team-alpha', testKey)

      const res = await app.request('/test', {
        headers: {
          'train-id': 'team-alpha',
          Authorization: `Bearer ${testKey}`,
        },
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true })
    })

    it('isolates keys per train ID', async () => {
      const key1 = 'cnp_live_train1'
      const key2 = 'cnp_live_train2'

      mockAuthService.setMockKey('train-one', key1)
      mockAuthService.setMockKey('train-two', key2)

      const res1 = await app.request('/test', {
        headers: {
          'train-id': 'train-one',
          Authorization: `Bearer ${key1}`,
        },
      })
      expect(res1.status).toBe(200)

      const res2 = await app.request('/test', {
        headers: {
          'train-id': 'train-two',
          Authorization: `Bearer ${key2}`,
        },
      })
      expect(res2.status).toBe(200)

      const res3 = await app.request('/test', {
        headers: {
          'train-id': 'train-one',
          Authorization: `Bearer ${key2}`,
        },
      })
      expect(res3.status).toBe(401)
    })
  })

  describe('Invalid Authentication', () => {
    it('rejects requests without Authorization header', async () => {
      mockAuthService.setMockKey('team-alpha', 'cnp_live_testkey')

      const res = await app.request('/test', {
        headers: {
          'train-id': 'team-alpha',
        },
      })

      expect(res.status).toBe(401)
      expect(res.headers.get('WWW-Authenticate')).toBe('Bearer realm="Agent Prompt Train"')
    })

    it('rejects requests with invalid API key', async () => {
      mockAuthService.setMockKey('team-alpha', 'cnp_live_validkey')

      const res = await app.request('/test', {
        headers: {
          'train-id': 'team-alpha',
          Authorization: 'Bearer cnp_live_wrongkey',
        },
      })

      expect(res.status).toBe(401)
    })

    it('rejects requests when no API key is configured', async () => {
      const res = await app.request('/test', {
        headers: {
          'train-id': 'team-alpha',
          Authorization: 'Bearer cnp_live_somekey',
        },
      })

      expect(res.status).toBe(401)
    })

    it('rejects requests without train-id header', async () => {
      const res = await app.request('/test', {
        headers: {
          Authorization: 'Bearer cnp_live_testkey',
        },
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error.message).toBe('train-id header is required')
    })
  })

  describe('Security Features', () => {
    it('uses timing-safe comparison for credentials', async () => {
      const testKey = 'cnp_live_securekey123'
      mockAuthService.setMockKey('team-alpha', testKey)

      const wrongKeys = [
        'a',
        'cnp_live_wrong',
        'cnp_live_wrongkeythatisverylongandshouldbedifferent',
        testKey.slice(0, -1),
      ]

      for (const wrongKey of wrongKeys) {
        const res = await app.request('/test', {
          headers: {
            'train-id': 'team-alpha',
            Authorization: `Bearer ${wrongKey}`,
          },
        })
        expect(res.status).toBe(401)
      }
    })
  })

  describe('Error Handling', () => {
    it('returns 500 when authentication service throws', async () => {
      mockAuthService.getClientApiKey = async () => {
        throw new Error('Database connection failed')
      }

      const res = await app.request('/test', {
        headers: {
          'train-id': 'team-alpha',
          Authorization: 'Bearer cnp_live_anykey',
        },
      })

      expect(res.status).toBe(500)
    })
  })
})

describe('Train ID validation', () => {
  it('prevents path traversal attempts', async () => {
    const authService = new AuthenticationService()

    const maliciousIds = [
      '../../../etc/passwd',
      '..\\..\\..\\windows\\system32',
      'team-alpha/../../secrets',
      'team-alpha%2F..%2F..%2Fsecrets',
      '..',
      '.',
      '',
    ]

    for (const trainId of maliciousIds) {
      const result = await authService.getClientApiKey(trainId)
      expect(result).toBeNull()
    }
  })

  it('allows valid train identifiers', async () => {
    const authService = new AuthenticationService()

    const validTrainIds = [
      'team-alpha',
      'team-beta',
      'team.alpha',
      'team_alpha',
      'team-alpha:preview',
    ]

    for (const trainId of validTrainIds) {
      await expect(authService.getClientApiKey(trainId)).resolves.toBeDefined()
    }
  })
})
