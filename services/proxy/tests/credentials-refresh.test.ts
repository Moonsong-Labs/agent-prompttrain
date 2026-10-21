import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import type { Pool, PoolClient } from 'pg'
import type { AnthropicCredential } from '@agent-prompttrain/shared'
import * as queries from '@agent-prompttrain/shared/database/queries'
import * as alerts from '../src/services/refresh-token-alert'
import { getApiKey, OAuthRefreshError, refreshAccessToken } from '../src/credentials'

const pool = {} as Pool
const lockClient = {} as PoolClient

// Each test uses its own credential ID: getApiKey keeps a per-credential failure cooldown
const makeExpiredCredential = (id: string): AnthropicCredential => ({
  id,
  account_id: `acct-${id}`,
  account_name: `Account ${id}`,
  provider: 'anthropic',
  token_limit_threshold: 0.95,
  oauth_access_token: 'old-access-token',
  oauth_refresh_token: `refresh-${id}`,
  oauth_expires_at: new Date(Date.now() - 60_000),
  oauth_scopes: ['user:inference'],
  oauth_is_max: true,
  last_refresh_at: null,
  created_at: new Date(),
  updated_at: new Date(),
})

describe('getApiKey refresh failures', () => {
  const originalFetch = globalThis.fetch
  let getCredentialSpy: any
  let updateTokensSpy: any
  let markRejectedSpy: any
  let lockSpy: any
  let notifySpy: any

  beforeEach(() => {
    updateTokensSpy = spyOn(queries, 'updateCredentialTokens').mockImplementation(
      async () => ({}) as any
    )
    markRejectedSpy = spyOn(queries, 'markRefreshTokenRejected').mockImplementation(
      async () => true
    )
    lockSpy = spyOn(queries, 'withCredentialRefreshLock').mockImplementation(
      async (_pool, _id, task) => task(lockClient)
    )
    notifySpy = spyOn(alerts, 'notifyRefreshTokenRejected').mockImplementation(async () => {})
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    getCredentialSpy?.mockRestore()
    updateTokensSpy.mockRestore()
    markRejectedSpy.mockRestore()
    lockSpy.mockRestore()
    notifySpy.mockRestore()
  })

  // Every read returns the credential, including the one made under the refresh lock
  const useCredential = (credential: AnthropicCredential) => {
    getCredentialSpy = spyOn(queries, 'getCredentialById').mockImplementation(
      async () => credential
    )
  }

  const tokenResponse = () =>
    Response.json({
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
      expires_in: 28_800,
    })

  it('alerts when Anthropic rejects the refresh token', async () => {
    const credential = makeExpiredCredential('rejected')
    useCredential(credential)
    globalThis.fetch = (async () =>
      Response.json(
        { error: 'invalid_grant', error_description: 'Refresh token not found or invalid' },
        { status: 400 }
      )) as unknown as typeof fetch

    expect(await getApiKey(credential.id, pool)).toBeNull()

    expect(notifySpy).toHaveBeenCalledTimes(1)
    const [calledPool, calledCredential, usedRefreshToken, error] = notifySpy.mock.calls[0]
    expect(calledPool).toBe(pool)
    expect(calledCredential.id).toBe(credential.id)
    expect(usedRefreshToken).toBe('refresh-rejected')
    expect(error).toBeInstanceOf(OAuthRefreshError)
    expect(error.status).toBe(400)
    expect(error.errorCode).toBe('invalid_grant')
    expect(updateTokensSpy).not.toHaveBeenCalled()
  })

  it('records the rejection on the locked connection when Anthropic answers invalid_grant', async () => {
    const credential = makeExpiredCredential('invalid-grant')
    useCredential(credential)
    globalThis.fetch = (async () =>
      Response.json(
        { error: 'invalid_grant', error_description: 'Refresh token not found or invalid' },
        { status: 400 }
      )) as unknown as typeof fetch

    expect(await getApiKey(credential.id, pool)).toBeNull()

    expect(markRejectedSpy).toHaveBeenCalledTimes(1)
    expect(markRejectedSpy.mock.calls[0]).toEqual([
      lockClient,
      'invalid-grant',
      'refresh-invalid-grant',
    ])
  })

  it('does not record a rejection for a 401 without invalid_grant', async () => {
    const credential = makeExpiredCredential('unauthorized')
    useCredential(credential)
    globalThis.fetch = (async () =>
      Response.json(
        { error: { type: 'authentication_error', message: 'Unauthorized' } },
        { status: 401 }
      )) as unknown as typeof fetch

    expect(await getApiKey(credential.id, pool)).toBeNull()
    expect(markRejectedSpy).not.toHaveBeenCalled()
  })

  it('does not alert when the token endpoint is temporarily unavailable', async () => {
    const credential = makeExpiredCredential('unavailable')
    useCredential(credential)
    globalThis.fetch = (async () =>
      new Response('upstream connect error', { status: 503 })) as unknown as typeof fetch

    expect(await getApiKey(credential.id, pool)).toBeNull()
    expect(notifySpy).not.toHaveBeenCalled()
    expect(markRejectedSpy).not.toHaveBeenCalled()
  })

  it('does not alert when the token endpoint cannot be reached', async () => {
    const credential = makeExpiredCredential('unreachable')
    useCredential(credential)
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch

    expect(await getApiKey(credential.id, pool)).toBeNull()
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('stores the new tokens on the locked connection when the refresh succeeds', async () => {
    const credential = makeExpiredCredential('refreshed')
    useCredential(credential)
    globalThis.fetch = (async () => tokenResponse()) as unknown as typeof fetch

    expect(await getApiKey(credential.id, pool)).toBe('new-access-token')
    expect(lockSpy).toHaveBeenCalledTimes(1)
    expect(lockSpy.mock.calls[0][1]).toBe('refreshed')
    expect(updateTokensSpy).toHaveBeenCalledTimes(1)
    const [calledClient, calledId, tokens] = updateTokensSpy.mock.calls[0]
    expect(calledClient).toBe(lockClient)
    expect(calledId).toBe('refreshed')
    expect(tokens.oauth_access_token).toBe('new-access-token')
    expect(tokens.oauth_refresh_token).toBe('new-refresh-token')
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('gives up on a token request that does not answer, so it cannot hold the lock', async () => {
    const credential = makeExpiredCredential('hanging')
    useCredential(credential)
    // The request only ends when its signal aborts; make the timeout fire immediately
    const timeoutSpy = spyOn(AbortSignal, 'timeout').mockImplementation(() =>
      AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError'))
    )
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted) {
          reject(signal.reason)
        }
        signal?.addEventListener('abort', () => reject(signal.reason))
      })) as unknown as typeof fetch

    try {
      expect(await getApiKey(credential.id, pool)).toBeNull()
      expect(notifySpy).not.toHaveBeenCalled()
      expect(markRejectedSpy).not.toHaveBeenCalled()
    } finally {
      timeoutSpy.mockRestore()
    }
  })

  it('uses the token another proxy task stored while this one waited for the lock', async () => {
    const expired = makeExpiredCredential('refreshed-elsewhere')
    const refreshedElsewhere: AnthropicCredential = {
      ...expired,
      oauth_access_token: 'access-token-from-other-task',
      oauth_refresh_token: 'refresh-token-from-other-task',
      oauth_expires_at: new Date(Date.now() + 28_800_000),
    }
    // The first read happens before the lock, the second one under it
    const reads = [expired, refreshedElsewhere]
    getCredentialSpy = spyOn(queries, 'getCredentialById').mockImplementation(
      async () => reads.shift() ?? refreshedElsewhere
    )
    let tokenRequests = 0
    globalThis.fetch = (async () => {
      tokenRequests++
      return tokenResponse()
    }) as unknown as typeof fetch

    expect(await getApiKey(expired.id, pool)).toBe('access-token-from-other-task')
    expect(tokenRequests).toBe(0)
    expect(updateTokensSpy).not.toHaveBeenCalled()
  })
})

describe('refreshAccessToken', () => {
  const originalFetch = globalThis.fetch
  let getCredentialSpy: any
  let updateTokensSpy: any
  let markRejectedSpy: any
  let lockSpy: any
  let notifySpy: any
  let tokenRequests: number

  const validCredential = (id: string): AnthropicCredential => ({
    ...makeExpiredCredential(id),
    oauth_expires_at: new Date(Date.now() + 28_800_000),
  })

  beforeEach(() => {
    tokenRequests = 0
    updateTokensSpy = spyOn(queries, 'updateCredentialTokens').mockImplementation(
      async () => ({}) as any
    )
    markRejectedSpy = spyOn(queries, 'markRefreshTokenRejected').mockImplementation(
      async () => true
    )
    lockSpy = spyOn(queries, 'withCredentialRefreshLock').mockImplementation(
      async (_pool, _id, task) => task(lockClient)
    )
    notifySpy = spyOn(alerts, 'notifyRefreshTokenRejected').mockImplementation(async () => {})
    globalThis.fetch = (async () => {
      tokenRequests++
      return Response.json({
        access_token: 'forced-access-token',
        refresh_token: 'forced-refresh-token',
        expires_in: 28_800,
      })
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    getCredentialSpy?.mockRestore()
    updateTokensSpy.mockRestore()
    markRejectedSpy.mockRestore()
    lockSpy.mockRestore()
    notifySpy.mockRestore()
  })

  it('refreshes a still valid token under the lock when forced', async () => {
    const credential = validCredential('forced')
    getCredentialSpy = spyOn(queries, 'getCredentialById').mockImplementation(
      async () => credential
    )

    expect(await refreshAccessToken(pool, credential.id, { force: true })).toBe(
      'forced-access-token'
    )

    expect(tokenRequests).toBe(1)
    expect(lockSpy.mock.calls[0][1]).toBe('forced')
    expect(updateTokensSpy.mock.calls[0][0]).toBe(lockClient)
    expect(updateTokensSpy.mock.calls[0][2].oauth_refresh_token).toBe('forced-refresh-token')
  })

  it('keeps a still valid token without calling Anthropic when not forced', async () => {
    const credential = validCredential('not-forced')
    getCredentialSpy = spyOn(queries, 'getCredentialById').mockImplementation(
      async () => credential
    )

    expect(await refreshAccessToken(pool, credential.id)).toBe('old-access-token')
    expect(tokenRequests).toBe(0)
  })

  it('throws the rejection to its caller after recording it', async () => {
    const credential = validCredential('forced-rejected')
    getCredentialSpy = spyOn(queries, 'getCredentialById').mockImplementation(
      async () => credential
    )
    globalThis.fetch = (async () =>
      Response.json({ error: 'invalid_grant' }, { status: 400 })) as unknown as typeof fetch

    const error = await refreshAccessToken(pool, credential.id, { force: true }).catch(e => e)

    expect(error).toBeInstanceOf(OAuthRefreshError)
    expect(error.isRefreshTokenRejected).toBe(true)
    expect(markRejectedSpy).toHaveBeenCalledTimes(1)
  })
})
