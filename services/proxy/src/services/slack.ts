import { IncomingWebhook, IncomingWebhookSendArguments } from '@slack/webhook'

export interface SlackConfig {
  webhook_url?: string
  channel?: string
  username?: string
  icon_emoji?: string
  enabled?: boolean
}

export interface MessageInfo {
  requestId: string
  projectId?: string
  model?: string
  role: 'user' | 'assistant' | 'conversation'
  content: string
  timestamp: string
  apiKey?: string // Masked API key for identification
  inputTokens?: number
  outputTokens?: number
}

export interface RefreshTokenAlertInfo {
  accountId: string
  accountName: string
  accountEmail?: string | null
  status: number
  errorCode?: string
  description?: string
}

export interface SlackAppConfig {
  webhookUrl: string
  alertWebhookUrl: string
  channel: string
  username: string
  iconEmoji: string
  enabled: boolean
}

let webhook: IncomingWebhook | null = null
let slackConfig: SlackConfig | null = null
// Receives operational alerts only, never conversation notifications
let alertWebhook: IncomingWebhook | null = null

/**
 * Initialize Slack integration
 */
export function initializeSlack(config: Partial<SlackConfig>) {
  if (!config.webhook_url) {
    slackConfig = null
    webhook = null
    return
  }

  slackConfig = {
    webhook_url: config.webhook_url,
    channel: config.channel,
    username: config.username || 'Agent Prompt Train',
    icon_emoji: config.icon_emoji || ':robot_face:',
    enabled: config.enabled !== false,
  }

  webhook = new IncomingWebhook(slackConfig.webhook_url!, {
    channel: slackConfig.channel,
    username: slackConfig.username,
    icon_emoji: slackConfig.icon_emoji,
  })
}

/**
 * Initialize the global and alert webhooks from the proxy configuration (config.slack)
 */
export function initializeSlackFromConfig(appConfig: SlackAppConfig) {
  initializeSlack(
    appConfig.enabled && appConfig.webhookUrl
      ? {
          webhook_url: appConfig.webhookUrl,
          channel: appConfig.channel || undefined,
          username: appConfig.username,
          icon_emoji: appConfig.iconEmoji,
        }
      : {}
  )
  initializeSlackAlerts({
    webhook_url: appConfig.alertWebhookUrl || undefined,
    username: appConfig.username,
    icon_emoji: appConfig.iconEmoji,
  })
}

/**
 * Parse Slack configuration from environment
 */
export function parseSlackConfig(env: any): Partial<SlackConfig> {
  return {
    webhook_url: env.SLACK_WEBHOOK_URL,
    channel: env.SLACK_CHANNEL,
    username: env.SLACK_USERNAME,
    icon_emoji: env.SLACK_ICON_EMOJI,
    enabled: env.SLACK_ENABLED !== 'false',
  }
}

/**
 * Format message content for Slack
 */
function formatMessageContent(content: any): string {
  if (!content) {
    return 'No content'
  }

  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (typeof item === 'string') {
          return item
        }
        if (item.type === 'text' && item.text) {
          return item.text
        }
        if (item.type === 'tool_use') {
          return `🔧 Tool: ${item.name}`
        }
        if (item.type === 'tool_result') {
          return `✅ Tool Result`
        }
        return JSON.stringify(item)
      })
      .join('\n')
  }

  return JSON.stringify(content)
}

/**
 * Initialize train-specific Slack webhook
 */
export function initializeTrainSlack(
  slackConfig: Partial<SlackConfig> | undefined
): IncomingWebhook | null {
  if (!slackConfig) {
    return null
  }

  if (!slackConfig.webhook_url) {
    return null
  }

  const config = {
    webhook_url: slackConfig.webhook_url,
    channel: slackConfig.channel,
    username: slackConfig.username || 'Agent Prompt Train',
    icon_emoji: slackConfig.icon_emoji || ':robot_face:',
    enabled: slackConfig.enabled !== false,
  }

  if (!config.enabled) {
    return null
  }

  return new IncomingWebhook(config.webhook_url, {
    channel: config.channel,
    username: config.username,
    icon_emoji: config.icon_emoji,
  })
}

/**
 * Send message to Slack
 */
export async function sendToSlack(info: MessageInfo, trainWebhook?: IncomingWebhook | null) {
  // Use projectId-specific webhook if available, otherwise fall back to global webhook
  const webhookToUse = trainWebhook || webhook

  // Check if webhook is properly configured and is an instance of IncomingWebhook
  if (!webhookToUse || !(webhookToUse instanceof IncomingWebhook)) {
    return
  }

  // Additional check for global webhook configuration
  if (!trainWebhook && !slackConfig?.enabled) {
    return
  }

  // Skip Slack notifications for personal trainIds (privacy protection)
  if (info.projectId && info.projectId.toLowerCase().includes('personal')) {
    return
  }

  try {
    // Format content
    let content = formatMessageContent(info.content)
    const maxLength = 3000
    if (content.length > maxLength) {
      content = content.substring(0, maxLength) + '... (truncated)'
    }

    // Create simple text message
    const text = content

    // Create footer with metadata
    const metadata = [info.projectId || 'Unknown', info.model || 'Unknown', info.apiKey || '']
      .filter(Boolean)
      .join(' | ')

    const tokenInfo =
      info.inputTokens || info.outputTokens
        ? ` | Tokens: ${info.inputTokens || 0}/${info.outputTokens || 0}`
        : ''

    const message: IncomingWebhookSendArguments = {
      text,
      attachments: [
        {
          footer: `${metadata}${tokenInfo}`,
          ts: Math.floor(new Date(info.timestamp).getTime() / 1000).toString(),
        },
      ],
    }

    await webhookToUse.send(message)
  } catch (error) {
    console.error('Failed to send message to Slack:', error)
  }
}

/**
 * Send error notification to Slack
 */
export async function sendErrorToSlack(
  requestId: string,
  error: string,
  projectId?: string,
  trainWebhook?: IncomingWebhook | null
) {
  // Use projectId-specific webhook if available, otherwise fall back to global webhook
  const webhookToUse = trainWebhook || webhook

  // Check if webhook is properly configured and is an instance of IncomingWebhook
  if (!webhookToUse || !(webhookToUse instanceof IncomingWebhook)) {
    return
  }

  // Additional check for global webhook configuration
  if (!trainWebhook && !slackConfig?.enabled) {
    return
  }

  // Skip Slack notifications for personal trainIds (privacy protection)
  if (projectId && projectId.toLowerCase().includes('personal')) {
    return
  }

  try {
    const message: IncomingWebhookSendArguments = {
      attachments: [
        {
          color: '#ff0000',
          author_name: '⚠️ Error',
          title: `Request ${requestId}`,
          text: error,
          fields: [
            {
              title: 'Project ID',
              value: projectId || 'Unknown',
              short: true,
            },
            {
              title: 'Time',
              value: new Date().toISOString(),
              short: true,
            },
          ],
          footer: 'Claude Code Proxy',
        },
      ],
    }

    await webhookToUse.send(message)
  } catch (err) {
    console.error('Failed to send error to Slack:', err)
  }
}

/**
 * Initialize the dedicated webhook for operational alerts (SLACK_ALERT_WEBHOOK_URL)
 */
export function initializeSlackAlerts(config: Partial<SlackConfig>) {
  alertWebhook = config.webhook_url
    ? new IncomingWebhook(config.webhook_url, {
        username: config.username || 'Agent Prompt Train',
        icon_emoji: config.icon_emoji || ':robot_face:',
      })
    : null
}

/**
 * Webhook for operational alerts: the dedicated alert webhook, otherwise the global
 * webhook when it is enabled
 */
function getAlertWebhook(): IncomingWebhook | null {
  if (alertWebhook) {
    return alertWebhook
  }
  return webhook instanceof IncomingWebhook && slackConfig?.enabled ? webhook : null
}

/**
 * Whether operational alerts can be sent to Slack
 */
export function isSlackAlertEnabled(): boolean {
  return getAlertWebhook() !== null
}

/**
 * Send an alert that an account's OAuth refresh token was rejected and the account
 * must be re-authorized.
 * Throws when Slack does not accept the message so the caller can retry later.
 */
export async function sendRefreshTokenExpiredToSlack(info: RefreshTokenAlertInfo): Promise<void> {
  const target = getAlertWebhook()
  if (!target) {
    return
  }

  const reason = [info.errorCode, info.description].filter(Boolean).join(': ')
  const fields = [
    { title: 'Account ID', value: info.accountId, short: true },
    { title: 'Account Name', value: info.accountName, short: true },
  ]
  if (info.accountEmail) {
    fields.push({ title: 'Email', value: info.accountEmail, short: true })
  }
  fields.push({ title: 'Time', value: new Date().toISOString(), short: true })

  const message: IncomingWebhookSendArguments = {
    text: `:key: OAuth refresh token expired for account *${info.accountName}*`,
    attachments: [
      {
        color: '#ff0000',
        title: 'Account needs to be re-authorized',
        text:
          `Anthropic rejected the refresh token (HTTP ${info.status}${reason ? ` - ${reason}` : ''}), ` +
          'so the access token can no longer be refreshed and requests using this account will fail.\n' +
          `Re-authorize with: \`bun run auth:oauth-relogin --account ${info.accountId}\``,
        fields,
        footer: 'Agent Prompt Train',
      },
    ],
  }

  await target.send(message)
}
