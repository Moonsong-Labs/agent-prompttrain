import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import type { Pool } from 'pg'
import type { AnthropicCredential } from '@agent-prompttrain/shared'
import * as queries from '@agent-prompttrain/shared/database/queries'
import * as alerts from '../src/services/refresh-token-alert'
import { getApiKey, OAuthRefreshError } from '../src/credentials'

const pool = {} as Pool

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
  let notifySpy: any

  beforeEach(() => {
    updateTokensSpy = spyOn(queries, 'updateCredentialTokens').mockImplementation(
      async () => ({}) as any
    )
    notifySpy = spyOn(alerts, 'notifyRefreshTokenRejected').mockImplementation(async () => {})
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    getCredentialSpy?.mockRestore()
    updateTokensSpy.mockRestore()
    notifySpy.mockRestore()
  })

  const useCredential = (credential: AnthropicCredential) => {
    getCredentialSpy = spyOn(queries, 'getCredentialById').mockImplementation(
      async () => credential
    )
  }

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

  it('does not alert when the token endpoint is temporarily unavailable', async () => {
    const credential = makeExpiredCredential('unavailable')
    useCredential(credential)
    globalThis.fetch = (async () =>
      new Response('upstream connect error', { status: 503 })) as unknown as typeof fetch

    expect(await getApiKey(credential.id, pool)).toBeNull()
    expect(notifySpy).not.toHaveBeenCalled()
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

  it('stores the new tokens when the refresh succeeds', async () => {
    const credential = makeExpiredCredential('refreshed')
    useCredential(credential)
    globalThis.fetch = (async () =>
      Response.json({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 28_800,
      })) as unknown as typeof fetch

    expect(await getApiKey(credential.id, pool)).toBe('new-access-token')
    expect(updateTokensSpy).toHaveBeenCalledTimes(1)
    expect(notifySpy).not.toHaveBeenCalled()
  })
})
