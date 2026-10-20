import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { Pool } from 'pg'
import { join } from 'node:path'
import {
  claimRefreshTokenAlert,
  createAnthropicCredential,
  releaseRefreshTokenAlert,
  updateCredentialTokens,
  upsertAnthropicCredential,
} from '../../packages/shared/src/database/queries'

// Only ever runs against an explicitly named local *_test database
const databaseUrl = process.env.REFRESH_ALERT_TEST_DATABASE_URL
const enabled = !!databaseUrl && new URL(databaseUrl).pathname.endsWith('_test')
const root = join(import.meta.dir, '../..')

const ACCOUNT_ID = 'refresh-alert-test-account'

describe.skipIf(!enabled)('refresh token alert claims against PostgreSQL', () => {
  let pool: Pool
  let credentialId: string

  const credentialRequest = (refreshToken: string) => ({
    account_id: ACCOUNT_ID,
    account_name: 'Refresh Alert Test',
    oauth_access_token: 'access-token',
    oauth_refresh_token: refreshToken,
    oauth_expires_at: new Date(Date.now() - 60_000),
    oauth_scopes: ['user:inference'],
  })

  const cleanUp = () => pool.query('DELETE FROM credentials WHERE account_id = $1', [ACCOUNT_ID])

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl })
  })

  beforeEach(async () => {
    await cleanUp()
    credentialId = (await createAnthropicCredential(pool, credentialRequest('refresh-a'))).id
  })

  afterAll(async () => {
    await cleanUp()
    await pool.end()
  })

  it('migration 028 is idempotent', async () => {
    for (let run = 0; run < 2; run++) {
      const child = Bun.spawn(
        ['bun', join(root, 'scripts/db/migrations/028-add-refresh-token-alert.ts'), 'up'],
        {
          cwd: root,
          env: { ...process.env, DATABASE_URL: databaseUrl },
          stdout: 'ignore',
          stderr: 'inherit',
        }
      )
      expect(await child.exited).toBe(0)
    }
  })

  it('lets exactly one of several concurrent proxy tasks claim the alert', async () => {
    const claims = await Promise.all(
      Array.from({ length: 5 }, () => claimRefreshTokenAlert(pool, credentialId, 'refresh-a'))
    )
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(await claimRefreshTokenAlert(pool, credentialId, 'refresh-a')).toBe(false)
  })

  it('does not alert for a refresh token another task already rotated', async () => {
    await updateCredentialTokens(pool, credentialId, {
      oauth_access_token: 'access-token-2',
      oauth_refresh_token: 'refresh-b',
      oauth_expires_at: new Date(Date.now() + 3_600_000),
    })

    expect(await claimRefreshTokenAlert(pool, credentialId, 'refresh-a')).toBe(false)
  })

  it('alerts again once a relogin stored a new refresh token', async () => {
    expect(await claimRefreshTokenAlert(pool, credentialId, 'refresh-a')).toBe(true)

    await upsertAnthropicCredential(pool, credentialRequest('refresh-b'))

    expect(await claimRefreshTokenAlert(pool, credentialId, 'refresh-b')).toBe(true)
  })

  it('allows a later attempt to claim the alert after it is released', async () => {
    expect(await claimRefreshTokenAlert(pool, credentialId, 'refresh-a')).toBe(true)

    await releaseRefreshTokenAlert(pool, credentialId, 'refresh-a')

    expect(await claimRefreshTokenAlert(pool, credentialId, 'refresh-a')).toBe(true)
  })

  it('leaves the credential timestamps untouched', async () => {
    const before = await pool.query(
      'SELECT updated_at, last_refresh_at FROM credentials WHERE id = $1',
      [credentialId]
    )

    await claimRefreshTokenAlert(pool, credentialId, 'refresh-a')

    const after = await pool.query(
      'SELECT updated_at, last_refresh_at FROM credentials WHERE id = $1',
      [credentialId]
    )
    expect(after.rows[0]).toEqual(before.rows[0])
  })
})
