import { describe, expect, test } from 'bun:test'
import type { Pool } from 'pg'
import { upsertAnthropicCredential } from '../../packages/shared/src/database/queries/credential-queries.ts'
import { toSafeCredential } from '../../packages/shared/src/database/queries/credential-queries-internal.ts'
import type { AnthropicCredential } from '../../packages/shared/src/types/credentials.ts'
import { generateAuthorizationUrl, parseOAuthLoginOptions } from './oauth-login.ts'
import { parseReloginOptions } from './oauth-relogin-all.ts'

const credential: AnthropicCredential = {
  id: '11111111-1111-1111-1111-111111111111',
  account_id: 'acc_team_alpha',
  account_name: 'Team Alpha',
  account_email: 'alpha@example.com',
  provider: 'anthropic',
  oauth_access_token: 'access-token',
  oauth_refresh_token: 'refresh-token',
  oauth_expires_at: new Date('2026-07-22T17:00:00Z'),
  oauth_scopes: ['user:inference'],
  oauth_is_max: true,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-07-22T09:00:00Z'),
  token_limit_threshold: 0.8,
  last_refresh_at: new Date('2026-07-22T09:00:00Z'),
}

describe('OAuth CLI options', () => {
  test('supports manual login mode', () => {
    expect(parseOAuthLoginOptions(['--no-browser', '--no-clipboard'])).toEqual({
      openBrowser: false,
      useClipboard: false,
      gmailAssisted: false,
      ownBrowser: false,
      help: false,
    })
  })

  test('filters bulk relogin by account', () => {
    expect(parseReloginOptions(['--account', 'acc_team_alpha', '--no-browser'])).toEqual({
      accountId: 'acc_team_alpha',
      openBrowser: false,
      useClipboard: true,
      gmailAssisted: false,
      ownBrowser: false,
      help: false,
    })
  })

  test('enables Gmail assistance and rejects incompatible browser options', () => {
    expect(parseReloginOptions(['--gmail', '--account=acc_team_alpha'])).toEqual({
      accountId: 'acc_team_alpha',
      openBrowser: true,
      useClipboard: true,
      gmailAssisted: true,
      ownBrowser: false,
      help: false,
    })
    expect(() => parseReloginOptions(['--gmail', '--no-browser'])).toThrow(
      '--gmail cannot be combined with --no-browser'
    )
  })

  test('routes Gmail assistance through the operator browser', () => {
    expect(parseReloginOptions(['--gmail', '--own-browser'])).toEqual({
      openBrowser: true,
      useClipboard: true,
      gmailAssisted: true,
      ownBrowser: true,
      help: false,
    })
    expect(() => parseReloginOptions(['--own-browser', '--no-browser'])).toThrow(
      '--own-browser cannot be combined with --no-browser'
    )
  })

  test('rejects missing or unknown options', () => {
    expect(() => parseReloginOptions(['--account'])).toThrow('--account requires an account ID')
    expect(() => parseOAuthLoginOptions(['--unknown'])).toThrow('Unknown option')
  })
})

describe('OAuth credential persistence', () => {
  test('updates relogin bookkeeping when overwriting a credential', async () => {
    let statement = ''
    const pool = {
      query: async (sql: string) => {
        statement = sql
        return { rows: [credential] }
      },
    } as unknown as Pool

    await upsertAnthropicCredential(pool, {
      account_id: credential.account_id,
      account_name: credential.account_name,
      account_email: credential.account_email,
      oauth_access_token: credential.oauth_access_token,
      oauth_refresh_token: credential.oauth_refresh_token,
      oauth_expires_at: credential.oauth_expires_at,
      oauth_scopes: credential.oauth_scopes,
      oauth_is_max: credential.oauth_is_max,
    })

    expect(statement).toContain('last_refresh_at')
    expect(statement).toContain('last_refresh_at = NOW()')
  })

  test('keeps account email out of safe credential payloads', () => {
    const safeCredential = toSafeCredential(credential)
    expect('account_email' in safeCredential).toBeFalse()
    expect('oauth_access_token' in safeCredential).toBeFalse()
    expect('oauth_refresh_token' in safeCredential).toBeFalse()
  })
})

test('authorization URL contains PKCE parameters', () => {
  const { url, verifier } = generateAuthorizationUrl()
  const authorizationUrl = new URL(url)

  expect(authorizationUrl.origin).toBe('https://claude.ai')
  expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256')
  expect(authorizationUrl.searchParams.get('state')).toBe(verifier)
})
