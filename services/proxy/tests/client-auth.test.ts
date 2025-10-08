import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Hono } from 'hono'
import { clientAuthMiddleware } from '../src/middleware/client-auth'
import { container } from '../src/container'
import type { Pool } from 'pg'
import * as queries from '@agent-prompttrain/shared/database/queries'

describe('Client Authentication Middleware', () => {
  let app: Hono
  let originalGetDbPool: typeof container.getDbPool
  let mockPool: Pool
  let mockVerifyApiKeyAndGetTrain: any

  beforeEach(async () => {
    // Create mock pool
    mockPool = {} as Pool

    // Save original method
    originalGetDbPool = container.getDbPool

    // Mock container.getDbPool to return our mock pool
    container.getDbPool = () => mockPool

    // Mock the database query function
    mockVerifyApiKeyAndGetTrain = spyOn(queries, 'verifyApiKeyAndGetTrain').mockImplementation(
      () => null as any
    )

    app = new Hono()
    app.use('*', clientAuthMiddleware())
    app.get('/test', c => c.json({ ok: true }))
  })

  afterEach(() => {
    container.getDbPool = originalGetDbPool
    mockVerifyApiKeyAndGetTrain.mockRestore()
  })

  it('allows requests when token matches configured key', async () => {
    const token = 'cnp_live_valid'
    mockVerifyApiKeyAndGetTrain.mockImplementation(() => ({
      projectId: 'team-alpha',
      apiKeyId: 1,
    }))

    const res = await app.request('/test', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(mockVerifyApiKeyAndGetTrain).toHaveBeenCalledWith(mockPool, token)
  })

  it('rejects requests with invalid token', async () => {
    mockVerifyApiKeyAndGetTrain.mockImplementation(() => null)

    const res = await app.request('/test', {
      headers: {
        Authorization: 'Bearer cnp_live_invalid',
      },
    })

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.type).toBe('authentication_error')
  })

  it('rejects when no keys are configured for train', async () => {
    mockVerifyApiKeyAndGetTrain.mockImplementation(() => null)

    const res = await app.request('/test', {
      headers: {
        Authorization: 'Bearer any',
      },
    })

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.type).toBe('authentication_error')
  })

  it('falls back to default train when header missing but still enforces keys', async () => {
    mockVerifyApiKeyAndGetTrain.mockImplementation(() => ({
      projectId: 'default',
      apiKeyId: 1,
    }))

    const res = await app.request('/test', {
      headers: {
        Authorization: 'Bearer cnp_live_default',
      },
    })

    expect(res.status).toBe(200)
  })
})
