import { describe, expect, it } from 'bun:test'
import { hasRejectedRefreshToken } from '../refresh-token'

// SHA-256 of 'refresh-dead' and 'refresh-old', as PostgreSQL stores them
const REFRESH_DEAD_HASH = '76621db4f23aa952211a8ebb1b5d319cb8e390978b3ebc13095bc54382e24733'
const REFRESH_OLD_HASH = 'de1d36e8005c3eaadc5370acfd54a70781a20b4c316ab220d0d02b321d6a9d21'

describe('hasRejectedRefreshToken', () => {
  it.each([
    ['the current refresh token was rejected', 'refresh-dead', REFRESH_DEAD_HASH, true],
    ['a relogin replaced the rejected refresh token', 'refresh-new', REFRESH_OLD_HASH, false],
    ['no refresh token was rejected', 'refresh-dead', null, false],
    ['the column is missing before migration 029', 'refresh-dead', undefined, false],
  ])('%s', (_case, refreshToken, rejectedHash, expected) => {
    expect(
      hasRejectedRefreshToken({
        oauth_refresh_token: refreshToken,
        oauth_refresh_rejected_token_hash: rejectedHash,
      })
    ).toBe(expected)
  })
})
