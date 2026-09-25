import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Hono } from 'hono'
import { logger, loggingMiddleware } from '../src/middleware/logger'

describe('loggingMiddleware', () => {
  let app: Hono
  let info: ReturnType<typeof spyOn>
  let debug: ReturnType<typeof spyOn>

  beforeEach(() => {
    info = spyOn(logger, 'info').mockImplementation(() => {})
    debug = spyOn(logger, 'debug').mockImplementation(() => {})

    app = new Hono()
    app.use('*', loggingMiddleware())
    // Stands in for the client auth middleware, which resolves the project after logging starts
    app.use('*', async (c, next) => {
      c.set('projectId', 'team-alpha')
      await next()
    })
    app.post('/v1/messages', c => c.json({ ok: true }))
  })

  afterEach(() => {
    info.mockRestore()
    debug.mockRestore()
  })

  const infoMessages = () => info.mock.calls.map(call => call[0])

  it('logs the arrival of a request at debug level only', async () => {
    await app.request('/v1/messages', { method: 'POST' })

    expect(infoMessages()).not.toContain('Incoming request')
    expect(debug.mock.calls.map(call => call[0])).toContain('Incoming request')
  })

  it('logs one completion line carrying the project resolved during the request', async () => {
    await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'user-agent': 'claude-cli/9.9.9', 'x-forwarded-for': '203.0.113.7' },
    })

    expect(infoMessages()).toEqual(['Request completed'])
    expect(info.mock.calls[0][1]).toMatchObject({
      projectId: 'team-alpha',
      method: 'POST',
      path: '/v1/messages',
      statusCode: 200,
      metadata: { userAgent: 'claude-cli/9.9.9', ip: '203.0.113.7' },
    })
  })
})
