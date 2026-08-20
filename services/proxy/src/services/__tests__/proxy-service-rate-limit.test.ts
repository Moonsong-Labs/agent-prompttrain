import { describe, expect, mock, test } from 'bun:test'
import { UpstreamError, type ClaudeMessagesRequest } from '@agent-prompttrain/shared'
import { RequestContext } from '../../domain/value-objects/RequestContext'
import { ProxyService } from '../ProxyService'
import type { AuthResult } from '../AuthenticationService'

function requestBody(): ClaudeMessagesRequest {
  return {
    model: 'claude-sonnet-5',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hello' }],
  }
}

function auth(credentialId: string, accountId: string): AuthResult {
  return {
    provider: 'anthropic',
    type: 'oauth',
    headers: { Authorization: `Bearer token-${credentialId}` },
    key: `token-${credentialId}`,
    accountId,
    accountName: accountId,
    credentialId,
    fromPool: true,
    reserved: true,
    explicitlySelected: false,
  }
}

function rateLimitError(): UpstreamError {
  return new UpstreamError(
    'rate_limit_error: account exhausted',
    429,
    { requestId: 'req-1' },
    { type: 'error', error: { type: 'rate_limit_error', message: 'account exhausted' } },
    { 'retry-after': '120' }
  )
}

function successfulClaudeResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'msg-1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}

function makeDependencies(forward: (authResult: AuthResult) => Promise<Response>) {
  const accounts = [auth('credential-1', 'account-1'), auth('credential-2', 'account-2')]
  const authenticate = mock<
    (
      context: RequestContext,
      model?: string,
      options?: { excludeCredentialIds?: string[] }
    ) => Promise<AuthResult>
  >(async () => accounts.shift()!)
  const markRateLimited = mock(async () => '2026-08-13T22:00:00.000Z')
  const release = mock(async () => undefined)
  const authService = { authenticate, markRateLimited, release }

  const apiClient = {
    forward: mock(async (_request: unknown, authResult: AuthResult) => forward(authResult)),
    processResponse: mock(async (response: Response) => response.json()),
  }
  const metricsService = {
    trackRequest: mock(async () => undefined),
    trackError: mock(async () => undefined),
  }
  const notificationService = {
    notify: mock(async () => undefined),
    notifyError: mock(async () => undefined),
  }

  return { authService, apiClient, metricsService, notificationService }
}

describe('ProxyService account rate-limit failover', () => {
  test('marks the failed credential and immediately tries one different pooled account', async () => {
    let forwardAttempt = 0
    const dependencies = makeDependencies(async () => {
      forwardAttempt += 1
      if (forwardAttempt === 1) {
        throw rateLimitError()
      }
      return successfulClaudeResponse()
    })
    const service = new ProxyService(
      dependencies.authService as any,
      dependencies.apiClient as any,
      dependencies.notificationService as any,
      dependencies.metricsService as any
    )

    const response = await service.handleRequest(
      requestBody(),
      new RequestContext('req-1', 'project-1', 'POST', '/v1/messages', Date.now(), {})
    )

    expect(response.status).toBe(200)
    expect(dependencies.apiClient.forward).toHaveBeenCalledTimes(2)
    expect(dependencies.authService.markRateLimited).toHaveBeenCalledTimes(1)
    expect(dependencies.authService.release).toHaveBeenCalledTimes(2)
    expect(dependencies.authService.authenticate.mock.calls[1]?.[2]).toEqual({
      excludeCredentialIds: ['credential-1'],
    })
  })

  test('stops after the single alternate attempt when both accounts return 429', async () => {
    const dependencies = makeDependencies(async () => {
      throw rateLimitError()
    })
    const service = new ProxyService(
      dependencies.authService as any,
      dependencies.apiClient as any,
      dependencies.notificationService as any,
      dependencies.metricsService as any
    )

    await expect(
      service.handleRequest(
        requestBody(),
        new RequestContext('req-1', 'project-1', 'POST', '/v1/messages', Date.now(), {})
      )
    ).rejects.toBeInstanceOf(UpstreamError)

    expect(dependencies.apiClient.forward).toHaveBeenCalledTimes(2)
    expect(dependencies.authService.authenticate).toHaveBeenCalledTimes(2)
    expect(dependencies.authService.markRateLimited).toHaveBeenCalledTimes(2)
    expect(dependencies.authService.release).toHaveBeenCalledTimes(2)
  })
})
