import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AuthenticationService } from '../src/services/AuthenticationService'
import { RequestContext } from '../src/domain/value-objects/RequestContext'
import { AuthenticationError } from '@agent-prompttrain/shared'

const createRequestContext = (trainId: string, account?: string) =>
  new RequestContext(
    'req-123',
    trainId,
    'POST',
    '/v1/messages',
    Date.now(),
    {},
    undefined,
    undefined,
    account
  )

describe('AuthenticationService', () => {
  let rootDir: string
  let accountsDir: string
  let clientKeysDir: string
  let service: AuthenticationService

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'auth-service-'))
    accountsDir = join(rootDir, 'accounts')
    clientKeysDir = join(rootDir, 'train-client-keys')

    mkdirSync(accountsDir, { recursive: true })
    mkdirSync(clientKeysDir, { recursive: true })

    writeFileSync(
      join(accountsDir, 'account-primary.credentials.json'),
      JSON.stringify(
        {
          type: 'api_key',
          accountId: 'acc_primary',
          api_key: 'sk-ant-primary',
          slack: {
            webhook_url: 'https://hooks.slack.com/services/test',
            enabled: true,
          },
        },
        null,
        2
      )
    )

    writeFileSync(
      join(accountsDir, 'account-secondary.credentials.json'),
      JSON.stringify(
        {
          type: 'api_key',
          accountId: 'acc_secondary',
          api_key: 'sk-ant-secondary',
        },
        null,
        2
      )
    )

    service = new AuthenticationService({
      accountsDir,
      clientKeysDir,
    })
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('authenticates using the requested account header', async () => {
    const context = createRequestContext('train-alpha', 'account-secondary')
    const auth = await service.authenticate(context)

    expect(auth.accountName).toBe('account-secondary')
    expect(auth.accountId).toBe('acc_secondary')
    expect(auth.type).toBe('api_key')
    expect(auth.slackConfig).toBeNull()
  })

  it('returns slack configuration when present on credentials', async () => {
    const context = createRequestContext('train-alpha', 'account-primary')
    const auth = await service.authenticate(context)

    expect(auth.accountName).toBe('account-primary')
    expect(auth.slackConfig).toMatchObject({
      webhook_url: 'https://hooks.slack.com/services/test',
      enabled: true,
    })
  })

  it('throws for invalid account identifier', async () => {
    const context = createRequestContext('train-alpha', '../escape')
    await expect(service.authenticate(context)).rejects.toBeInstanceOf(AuthenticationError)
  })

  it('falls back to available account when none specified', async () => {
    rmSync(join(accountsDir, 'account-secondary.credentials.json'), { force: true })
    const context = createRequestContext('train-alpha')
    const auth = await service.authenticate(context)

    expect(auth.accountName).toBe('account-primary')
  })

  it('reads client API keys from array file', async () => {
    writeFileSync(
      join(clientKeysDir, 'train-alpha.client-keys.json'),
      JSON.stringify(['token-a', 'token-b'])
    )

    const keys = await service.getClientApiKeys('train-alpha')
    expect(keys).toEqual(['token-a', 'token-b'])
  })

  it('reads client API keys from object file', async () => {
    writeFileSync(
      join(clientKeysDir, 'train-beta.client-keys.json'),
      JSON.stringify({ keys: ['token-c'] })
    )

    const keys = await service.getClientApiKeys('train-beta')
    expect(keys).toEqual(['token-c'])
  })

  it('returns empty list for invalid train identifier', async () => {
    const keys = await service.getClientApiKeys('../etc/passwd')
    expect(keys).toEqual([])
  })
})
