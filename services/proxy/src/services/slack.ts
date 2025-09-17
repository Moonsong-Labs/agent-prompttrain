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
  trainId?: string
  model?: string
  role: 'user' | 'assistant' | 'conversation'
  content: string
  timestamp: string
  apiKey?: string // Masked API key for identification
  inputTokens?: number
  outputTokens?: number
}

let webhook: IncomingWebhook | null = null
let slackConfig: SlackConfig | null = null

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
  // Use trainId-specific webhook if available, otherwise fall back to global webhook
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
  if (info.trainId && info.trainId.toLowerCase().includes('personal')) {
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
    const metadata = [info.trainId || 'Unknown', info.model || 'Unknown', info.apiKey || '']
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
  trainId?: string,
  trainWebhook?: IncomingWebhook | null
) {
  // Use trainId-specific webhook if available, otherwise fall back to global webhook
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
  if (trainId && trainId.toLowerCase().includes('personal')) {
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
              title: 'Train ID',
              value: trainId || 'Unknown',
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
