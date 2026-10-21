import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test'
import { Pool } from 'pg'
import { join } from 'node:path'
import {
  createAnthropicCredential,
  markRefreshTokenRejected,
  updateCredentialTokens,
  upsertAnthropicCredential,
  withCredentialRefreshLock,
} from '../../packages/shared/src/database/queries'
import { hasRejectedRefreshToken } from '../../packages/shared/src/utils/refresh-token'
import { getApiKey } from '../../services/proxy/src/credentials'

// Only ever runs against an explicitly named local *_test database
const databaseUrl = process.env.CREDENTIAL_REFRESH_TEST_DATABASE_URL
const enabled = !!databaseUrl && new URL(databaseUrl).pathname.endsWith('_test')
const root = join(import.meta.dir, '../..')

const ACCOUNT_ID = 'refresh-lock-test-account'

describe.skipIf(!enabled)('OAuth refresh coordination against PostgreSQL', () => {
  const originalFetch = globalThis.fetch
  let pool: Pool
  let credentialId: string

  const credentialRequest = (refreshToken: string, expiresAt: Date) => ({
    account_id: ACCOUNT_ID,
    account_name: 'Refresh Lock Test',
    oauth_access_token: 'access-a',
    oauth_refresh_token: refreshToken,
    oauth_expires_at: expiresAt,
    oauth_scopes: ['user:inference'],
  })

  const readCredential = async () =>
    (await pool.query('SELECT * FROM credentials WHERE id = $1', [credentialId])).rows[0]

  const cleanUp = () => pool.query('DELETE FROM credentials WHERE account_id = $1', [ACCOUNT_ID])

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl })
  })

  beforeEach(async () => {
    await cleanUp()
    const expired = new Date(Date.now() - 60_000)
    credentialId = (await createAnthropicCredential(pool, credentialRequest('refresh-a', expired)))
      .id
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  afterAll(async () => {
    await cleanUp()
    await pool.end()
  })

  it('migration 029 is idempotent', async () => {
    for (let run = 0; run < 2; run++) {
      const child = Bun.spawn(
        ['bun', join(root, 'scripts/db/migrations/029-add-credential-refresh-rejected.ts'), 'up'],
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

  it('uses the tokens another proxy task stored while it waited for the refresh lock', async () => {
    let tokenRequests = 0
    globalThis.fetch = (async () => {
      tokenRequests++
      return Response.json({
        access_token: 'access-c',
        refresh_token: 'refresh-c',
        expires_in: 28_800,
      })
    }) as unknown as typeof fetch

    // The waiting task gets its own pool, like a separate proxy instance
    const waitingTaskPool = new Pool({ connectionString: databaseUrl })
    let lockRequested!: () => void
    const lockRequestedSignal = new Promise<void>(resolve => (lockRequested = resolve))
    const connect = waitingTaskPool.connect.bind(waitingTaskPool) as (...args: unknown[]) => any
    waitingTaskPool.connect = ((...args: unknown[]) => {
      // pool.query() connects with a callback; the refresh lock connects without one
      if (args.length === 0) {
        lockRequested()
      }
      return connect(...args)
    }) as typeof waitingTaskPool.connect

    let lockHeld!: () => void
    const lockHeldSignal = new Promise<void>(resolve => (lockHeld = resolve))

    try {
      const otherTask = withCredentialRefreshLock(pool, credentialId, async client => {
        lockHeld()
        // The waiting task has read the expired token and is asking for the lock
        await lockRequestedSignal
        await Bun.sleep(200)
        await updateCredentialTokens(client, credentialId, {
          oauth_access_token: 'access-b',
          oauth_refresh_token: 'refresh-b',
          oauth_expires_at: new Date(Date.now() + 28_800_000),
        })
      })
      await lockHeldSignal

      const accessToken = await getApiKey(credentialId, waitingTaskPool)
      await otherTask

      expect(accessToken).toBe('access-b')
      expect(tokenRequests).toBe(0)
      expect((await readCredential()).oauth_refresh_token).toBe('refresh-b')
    } finally {
      await waitingTaskPool.end()
    }
  })

  it('records the rejection when Anthropic answers invalid_grant', async () => {
    globalThis.fetch = (async () =>
      Response.json(
        { error: 'invalid_grant', error_description: 'Refresh token not found or invalid' },
        { status: 400 }
      )) as unknown as typeof fetch

    expect(await getApiKey(credentialId, pool)).toBeNull()

    expect(hasRejectedRefreshToken(await readCredential())).toBe(true)
  })

  it('does not record a rejection when the token endpoint is unavailable', async () => {
    globalThis.fetch = (async () =>
      new Response('upstream connect error', { status: 503 })) as unknown as typeof fetch

    expect(await getApiKey(credentialId, pool)).toBeNull()

    expect(hasRejectedRefreshToken(await readCredential())).toBe(false)
  })

  it('does not record a rejection for a refresh token the credential no longer holds', async () => {
    await upsertAnthropicCredential(
      pool,
      credentialRequest('refresh-b', new Date(Date.now() + 28_800_000))
    )

    expect(await markRefreshTokenRejected(pool, credentialId, 'refresh-a')).toBe(false)
    expect(hasRejectedRefreshToken(await readCredential())).toBe(false)
  })

  it('clears the rejection when a refresh stores new tokens', async () => {
    expect(await markRefreshTokenRejected(pool, credentialId, 'refresh-a')).toBe(true)

    await updateCredentialTokens(pool, credentialId, {
      oauth_access_token: 'access-b',
      oauth_refresh_token: 'refresh-b',
      oauth_expires_at: new Date(Date.now() + 28_800_000),
    })

    expect(hasRejectedRefreshToken(await readCredential())).toBe(false)
  })

  it('clears the rejection when a relogin stores new tokens', async () => {
    expect(await markRefreshTokenRejected(pool, credentialId, 'refresh-a')).toBe(true)

    await upsertAnthropicCredential(
      pool,
      credentialRequest('refresh-b', new Date(Date.now() + 28_800_000))
    )

    expect(hasRejectedRefreshToken(await readCredential())).toBe(false)
  })
})
