import { describe, expect, mock, test } from 'bun:test'
import { getRetryAfter, UpstreamError } from '@agent-prompttrain/shared'
import { ProxyRequest } from '../../domain/entities/ProxyRequest'
import { ClaudeApiClient } from '../ClaudeApiClient'
import type { AuthResult } from '../AuthenticationService'

describe('ClaudeApiClient rate-limit handling', () => {
  test('preserves upstream headers and does not retry a 429 on the same credential', async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'rate_limit_error', message: 'account exhausted' },
          }),
          {
            status: 429,
            headers: {
              'retry-after': '180',
              'anthropic-ratelimit-requests-reset': '2026-08-13T22:00:00Z',
            },
          }
        )
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    try {
      const client = new ClaudeApiClient({ baseUrl: 'https://api.anthropic.test', timeout: 1_000 })
      const request = new ProxyRequest(
        {
          model: 'claude-sonnet-5',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hello' }],
        },
        'project-1',
        'req-1'
      )
      const auth: AuthResult = {
        provider: 'anthropic',
        type: 'oauth',
        headers: { Authorization: 'Bearer token' },
        key: 'token',
        accountId: 'account-1',
        accountName: 'account-1',
      }

      try {
        await client.forward(request, auth)
        expect.unreachable('forward should throw')
      } catch (error) {
        expect(error).toBeInstanceOf(UpstreamError)
        const upstreamError = error as UpstreamError
        expect(upstreamError.upstreamHeaders?.['retry-after']).toBe('180')
        expect(getRetryAfter(upstreamError)).toBe(180_000)
      }

      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
