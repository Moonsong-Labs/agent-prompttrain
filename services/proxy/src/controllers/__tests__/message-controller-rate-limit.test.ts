import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { UpstreamError } from '@agent-prompttrain/shared'
import { MessageController } from '../MessageController'
import { AccountPoolExhaustedError } from '../../services/account-pool-service'

const body = {
  model: 'claude-sonnet-5',
  max_tokens: 64,
  messages: [{ role: 'user', content: 'hello' }],
}

type TestEnv = { Variables: { requestId: string; projectId: string } }

function appThatThrows(error: Error): Hono<TestEnv> {
  const proxyService = {
    handleRequest: async () => {
      throw error
    },
  }
  const controller = new MessageController(proxyService as any)
  const app = new Hono<TestEnv>()
  app.use('*', async (context, next) => {
    context.set('requestId', 'req-1')
    context.set('projectId', 'project-1')
    await next()
  })
  app.post('/v1/messages', context => controller.handle(context))
  return app
}

describe('MessageController rate-limit headers', () => {
  test('forwards safe Anthropic rate-limit headers to the client', async () => {
    const app = appThatThrows(
      new UpstreamError(
        'rate limited',
        429,
        undefined,
        { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } },
        {
          'retry-after': '120',
          'anthropic-ratelimit-requests-reset': '2027-01-01T00:00:00Z',
          'set-cookie': 'must-not-be-forwarded',
        }
      )
    )

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('120')
    expect(response.headers.get('anthropic-ratelimit-requests-reset')).toBe('2027-01-01T00:00:00Z')
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  test('returns Retry-After when the shared account pool is exhausted', async () => {
    const reset = new Date(Date.now() + 120_000).toISOString()
    const app = appThatThrows(new AccountPoolExhaustedError('pool exhausted', reset))

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const responseBody = (await response.json()) as any

    expect(response.status).toBe(429)
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(119)
    expect(responseBody.error.estimated_reset).toBe(reset)
  })
})
