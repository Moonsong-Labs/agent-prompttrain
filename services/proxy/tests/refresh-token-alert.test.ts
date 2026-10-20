import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { IncomingWebhook } from '@slack/webhook'
import type { Pool } from 'pg'
import type { AnthropicCredential } from '@agent-prompttrain/shared'
import * as queries from '@agent-prompttrain/shared/database/queries'
import {
  initializeSlack,
  initializeSlackAlerts,
  initializeSlackFromConfig,
  sendToSlack,
} from '../src/services/slack'
import { notifyRefreshTokenRejected } from '../src/services/refresh-token-alert'
import { OAuthRefreshError } from '../src/credentials'

const pool = {} as Pool

const credential: AnthropicCredential = {
  id: 'cred-1',
  account_id: 'acc_team_alpha',
  account_name: 'Team Alpha',
  account_email: 'alpha@example.com',
  provider: 'anthropic',
  token_limit_threshold: 0.95,
  oauth_access_token: 'old-access-token',
  oauth_refresh_token: 'refresh-token',
  oauth_expires_at: new Date(Date.now() - 60_000),
  oauth_scopes: ['user:inference'],
  oauth_is_max: true,
  last_refresh_at: null,
  created_at: new Date(),
  updated_at: new Date(),
}

const GLOBAL_WEBHOOK = 'https://hooks.slack.com/services/T000/B000/GLOBAL'
const ALERT_WEBHOOK = 'https://hooks.slack.com/services/T000/B000/ALERTS'

const rejection = new OAuthRefreshError(
  'Failed to refresh token: 400 - invalid_grant',
  400,
  'invalid_grant',
  'Refresh token not found or invalid'
)

describe('notifyRefreshTokenRejected', () => {
  let sendSpy: any
  let claimSpy: any
  let releaseSpy: any
  let sentTo: string[]

  beforeEach(() => {
    initializeSlack({ webhook_url: GLOBAL_WEBHOOK })
    sentTo = []
    sendSpy = spyOn(IncomingWebhook.prototype, 'send').mockImplementation(async function (
      this: any
    ) {
      sentTo.push(this.url)
      return { text: 'ok' } as any
    })
    claimSpy = spyOn(queries, 'claimRefreshTokenAlert').mockImplementation(async () => true)
    releaseSpy = spyOn(queries, 'releaseRefreshTokenAlert').mockImplementation(async () => {})
  })

  afterEach(() => {
    initializeSlack({})
    initializeSlackAlerts({})
    sendSpy.mockRestore()
    claimSpy.mockRestore()
    releaseSpy.mockRestore()
  })

  it('waits before claiming so a token rotation by another proxy task can be stored first', async () => {
    const pending = notifyRefreshTokenRejected(pool, credential, 'refresh-token', rejection, 50)

    await Bun.sleep(10)
    expect(claimSpy).not.toHaveBeenCalled()

    await pending
    expect(claimSpy).toHaveBeenCalledTimes(1)
  })

  it('posts a Slack alert naming the account and the relogin command', async () => {
    await notifyRefreshTokenRejected(pool, credential, 'refresh-token', rejection, 0)

    expect(claimSpy).toHaveBeenCalledWith(pool, 'cred-1', 'refresh-token')
    expect(sendSpy).toHaveBeenCalledTimes(1)
    const message = JSON.stringify(sendSpy.mock.calls[0][0])
    expect(message).toContain('Team Alpha')
    expect(message).toContain('acc_team_alpha')
    expect(message).toContain('alpha@example.com')
    expect(message).toContain('invalid_grant')
    expect(message).toContain('bun run scripts/auth/oauth-relogin-all.ts --account acc_team_alpha')
    expect(message).not.toContain('refresh-token')
  })

  it('posts to the dedicated alert webhook when the global webhook is not set', async () => {
    initializeSlack({})
    initializeSlackAlerts({ webhook_url: ALERT_WEBHOOK })

    await notifyRefreshTokenRejected(pool, credential, 'refresh-token', rejection, 0)

    expect(sentTo).toEqual([ALERT_WEBHOOK])
  })

  it('prefers the dedicated alert webhook over the global webhook', async () => {
    initializeSlackAlerts({ webhook_url: ALERT_WEBHOOK })

    await notifyRefreshTokenRejected(pool, credential, 'refresh-token', rejection, 0)

    expect(sentTo).toEqual([ALERT_WEBHOOK])
  })

  it('falls back to the global webhook when no dedicated alert webhook is set', async () => {
    await notifyRefreshTokenRejected(pool, credential, 'refresh-token', rejection, 0)

    expect(sentTo).toEqual([GLOBAL_WEBHOOK])
  })

  it('never mirrors conversations to the dedicated alert webhook', async () => {
    initializeSlack({})
    initializeSlackAlerts({ webhook_url: ALERT_WEBHOOK })

    await sendToSlack({
      requestId: 'req-1',
      projectId: 'team-alpha',
      role: 'conversation',
      content: 'User: hello',
      timestamp: new Date().toISOString(),
    })

    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('stays silent when another proxy task already alerted for this refresh token', async () => {
    claimSpy.mockImplementation(async () => false)

    await notifyRefreshTokenRejected(pool, credential, 'refresh-token', rejection, 0)

    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('does not claim the alert when no Slack webhook is configured', async () => {
    initializeSlack({})

    await notifyRefreshTokenRejected(pool, credential, 'refresh-token', rejection, 0)

    expect(claimSpy).not.toHaveBeenCalled()
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('does not claim the alert when the global webhook is disabled and no alert webhook is set', async () => {
    initializeSlack({ webhook_url: GLOBAL_WEBHOOK, enabled: false })

    await notifyRefreshTokenRejected(pool, credential, 'refresh-token', rejection, 0)

    expect(claimSpy).not.toHaveBeenCalled()
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('releases the claim so a later attempt can retry when Slack rejects the message', async () => {
    sendSpy.mockImplementation(async () => {
      throw new Error('An HTTP protocol error occurred: statusCode = 500')
    })

    await notifyRefreshTokenRejected(pool, credential, 'refresh-token', rejection, 0)

    expect(releaseSpy).toHaveBeenCalledWith(pool, 'cred-1', 'refresh-token')
  })

  it('never throws when the database is unavailable', async () => {
    claimSpy.mockImplementation(async () => {
      throw new Error('column "oauth_refresh_alerted_token_hash" does not exist')
    })

    await notifyRefreshTokenRejected(pool, credential, 'refresh-token', rejection, 0)

    expect(sendSpy).not.toHaveBeenCalled()
  })
})

describe('initializeSlackFromConfig', () => {
  let sendSpy: any
  let claimSpy: any
  let sentTo: string[]

  const proxyConfig = (overrides: Record<string, unknown> = {}) => ({
    webhookUrl: '',
    alertWebhookUrl: '',
    channel: '',
    username: 'Claude Proxy',
    iconEmoji: ':robot_face:',
    enabled: false,
    ...overrides,
  })

  const conversation = () =>
    sendToSlack({
      requestId: 'req-1',
      projectId: 'team-alpha',
      role: 'conversation',
      content: 'User: hello',
      timestamp: new Date().toISOString(),
    })

  beforeEach(() => {
    sentTo = []
    sendSpy = spyOn(IncomingWebhook.prototype, 'send').mockImplementation(async function (
      this: any
    ) {
      sentTo.push(this.url)
      return { text: 'ok' } as any
    })
    claimSpy = spyOn(queries, 'claimRefreshTokenAlert').mockImplementation(async () => true)
  })

  afterEach(() => {
    initializeSlack({})
    initializeSlackAlerts({})
    sendSpy.mockRestore()
    claimSpy.mockRestore()
  })

  it('sends alerts and conversations to SLACK_WEBHOOK_URL from the proxy config', async () => {
    initializeSlackFromConfig(proxyConfig({ webhookUrl: GLOBAL_WEBHOOK, enabled: true }))

    await notifyRefreshTokenRejected(pool, credential, 'refresh-token', rejection, 0)
    await conversation()

    expect(sentTo).toEqual([GLOBAL_WEBHOOK, GLOBAL_WEBHOOK])
  })

  it('sends only alerts when only SLACK_ALERT_WEBHOOK_URL is configured', async () => {
    initializeSlackFromConfig(proxyConfig({ alertWebhookUrl: ALERT_WEBHOOK }))

    await notifyRefreshTokenRejected(pool, credential, 'refresh-token', rejection, 0)
    await conversation()

    expect(sentTo).toEqual([ALERT_WEBHOOK])
  })

  it('keeps SLACK_WEBHOOK_URL off when SLACK_ENABLED is false', async () => {
    initializeSlackFromConfig(proxyConfig({ webhookUrl: GLOBAL_WEBHOOK, enabled: false }))

    await notifyRefreshTokenRejected(pool, credential, 'refresh-token', rejection, 0)
    await conversation()

    expect(sentTo).toEqual([])
  })
})
