import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AuthenticationService } from '../src/services/AuthenticationService'
import { RequestContext } from '../src/domain/value-objects/RequestContext'
import { AuthenticationError } from '@agent-prompttrain/shared'
import { createHash } from 'crypto'

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

describe('AuthenticationService deterministic account selection', () => {
  let rootDir: string
  let accountsDir: string
  let clientKeysDir: string

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'auth-service-deterministic-'))
    accountsDir = join(rootDir, 'accounts')
    clientKeysDir = join(rootDir, 'train-client-keys')

    mkdirSync(accountsDir, { recursive: true })
    mkdirSync(clientKeysDir, { recursive: true })

    writeFileSync(
      join(accountsDir, 'primary.credentials.json'),
      JSON.stringify({
        type: 'api_key',
        accountId: 'acc_primary',
        api_key: 'sk-ant-primary',
      })
    )

    writeFileSync(
      join(accountsDir, 'secondary.credentials.json'),
      JSON.stringify({
        type: 'api_key',
        accountId: 'acc_secondary',
        api_key: 'sk-ant-secondary',
      })
    )
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  const computePreferredAccount = (trainId: string, accounts: string[]): string => {
    const key = trainId.trim() || 'default'
    const ordered = [...new Set(accounts)].sort()

    const scored = ordered.map(accountName => {
      const hashInput = `${key}::${accountName}`
      const digest = createHash('sha256').update(hashInput).digest()
      const score = digest.readBigUInt64BE(0)
      return { accountName, score }
    })

    scored.sort((a, b) => {
      if (a.score === b.score) {
        return a.accountName.localeCompare(b.accountName)
      }
      return a.score > b.score ? -1 : 1
    })

    return scored[0].accountName
  }

  it('consistently maps the same train to the same account when header missing', async () => {
    const service = new AuthenticationService({
      accountsDir,
      clientKeysDir,
    })

    const trainId = 'train-alpha'
    const expectedAccount = computePreferredAccount(trainId, ['primary', 'secondary'])

    const context1 = new RequestContext('req-1', trainId, 'POST', '/v1/messages', Date.now(), {})
    const context2 = new RequestContext('req-2', trainId, 'POST', '/v1/messages', Date.now(), {})

    const result1 = await service.authenticate(context1)
    const result2 = await service.authenticate(context2)

    expect(result1.accountName).toBe(expectedAccount)
    expect(result2.accountName).toBe(expectedAccount)
  })

  it('produces deterministic ordering across trains', async () => {
    const service = new AuthenticationService({
      accountsDir,
      clientKeysDir,
    })

    const trains = ['train-alpha', 'train-beta', 'train-gamma']
    const accounts = ['primary', 'secondary']

    const selections = await Promise.all(
      trains.map(id =>
        service.authenticate(
          new RequestContext('req-' + id, id, 'POST', '/v1/messages', Date.now(), {})
        )
      )
    )

    selections.forEach((selection, index) => {
      const expected = computePreferredAccount(trains[index], accounts)
      expect(selection.accountName).toBe(expected)
    })
  })
})
