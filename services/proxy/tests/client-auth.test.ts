import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { clientAuthMiddleware } from '../src/middleware/client-auth'
import { trainIdExtractorMiddleware } from '../src/middleware/train-id-extractor'
import { container } from '../src/container'
import { AuthenticationService } from '../src/services/AuthenticationService'
import { RequestContext } from '../src/domain/value-objects/RequestContext'

class MockAuthenticationService extends AuthenticationService {
  private keyMap = new Map<string, string[]>()

  constructor(rootDir: string) {
    super({
      accountsDir: join(rootDir, 'accounts'),
      clientKeysDir: join(rootDir, 'client-keys'),
    })
  }

  setKeys(trainId: string, keys: string[]) {
    this.keyMap.set(trainId, keys)
  }

  async getClientApiKeys(trainId: string): Promise<string[]> {
    return this.keyMap.get(trainId) ?? []
  }

  async hasClientKeys(trainId: string): Promise<boolean> {
    return (this.keyMap.get(trainId) ?? []).length > 0
  }

  async validateClientKey(trainId: string, clientKey: string): Promise<boolean> {
    return (this.keyMap.get(trainId) ?? []).includes(clientKey)
  }

  // authenticate is not used in these tests but must be implemented
  async authenticate(_context: RequestContext) {
    throw new Error('Not implemented in mock')
  }
}

describe('Client Authentication Middleware', () => {
  let app: Hono
  let originalGetAuthService: typeof container.getAuthenticationService
  let mockAuthService: MockAuthenticationService
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'client-auth-'))
    mockAuthService = new MockAuthenticationService(tempDir)
    originalGetAuthService = container.getAuthenticationService
    container.getAuthenticationService = () => mockAuthService

    app = new Hono()
    app.use('*', trainIdExtractorMiddleware())
    app.use('*', clientAuthMiddleware())
    app.get('/test', c => c.json({ ok: true }))
  })

  afterEach(() => {
    container.getAuthenticationService = originalGetAuthService
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('allows requests when token matches configured key', async () => {
    const token = 'cnp_live_valid'
    mockAuthService.setKeys('team-alpha', [token])

    const res = await app.request('/test', {
      headers: {
        'MSL-Train-Id': 'team-alpha',
        Authorization: `Bearer ${token}`,
      },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('rejects requests with invalid token', async () => {
    mockAuthService.setKeys('team-alpha', ['cnp_live_valid'])

    const res = await app.request('/test', {
      headers: {
        'MSL-Train-Id': 'team-alpha',
        Authorization: 'Bearer cnp_live_invalid',
      },
    })

    expect(res.status).toBe(401)
  })

  it('rejects when no keys are configured for train', async () => {
    const res = await app.request('/test', {
      headers: {
        'MSL-Train-Id': 'team-alpha',
        Authorization: 'Bearer any',
      },
    })

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.type).toBe('authentication_error')
  })

  it('falls back to default train when header missing but still enforces keys', async () => {
    mockAuthService.setKeys('default', ['cnp_live_default'])
    const res = await app.request('/test', {
      headers: {
        Authorization: 'Bearer cnp_live_default',
      },
    })

    expect(res.status).toBe(200)
  })
})
