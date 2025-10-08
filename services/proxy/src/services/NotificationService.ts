import { ProxyRequest } from '../domain/entities/ProxyRequest'
import { ProxyResponse } from '../domain/entities/ProxyResponse'
import { RequestContext } from '../domain/value-objects/RequestContext'
import { AuthResult } from './AuthenticationService'
import { sendToSlack, initializeTrainSlack, MessageInfo } from './slack.js'
import { logger } from '../middleware/logger'
import type { SlackConfig } from '@agent-prompttrain/shared'

export interface NotificationConfig {
  enabled: boolean
  maxLines: number
  maxLength: number
}

/**
 * Service responsible for sending notifications
 * Currently supports Slack, but could be extended to other channels
 */
export class NotificationService {
  private previousMessages = new Map<string, string>()
  private readonly maxCacheSize = 1000

  constructor(
    private config: NotificationConfig = {
      enabled: true,
      maxLines: 20,
      maxLength: 3000,
    }
  ) {}

  /**
   * Send notification for a request/response pair
   */
  async notify(
    request: ProxyRequest,
    response: ProxyResponse,
    context: RequestContext,
    auth: AuthResult,
    slackConfig: SlackConfig | null = null
  ): Promise<void> {
    if (!this.config.enabled) {
      return
    }

    // Only send notifications for inference requests
    if (request.requestType !== 'inference') {
      return
    }

    try {
      const accountWebhook = slackConfig ? initializeTrainSlack(slackConfig) : null

      // Check if user message changed
      const userContent = request.getUserContentForNotification()
      const previousContent = this.getPreviousMessage(context.projectId)
      const userMessageChanged = userContent !== previousContent

      if (userContent) {
        this.setPreviousMessage(context.projectId, userContent)
      }

      // Only send notifications when user message changes
      if (!userMessageChanged) {
        return
      }

      // Prepare the conversation message
      let conversationMessage = ''

      // Add user message
      if (userContent) {
        conversationMessage += `:bust_in_silhouette: User: ${userContent}\n`
      }

      // Add assistant response
      const assistantContent = response.getTruncatedContent(
        this.config.maxLines,
        this.config.maxLength
      )
      if (assistantContent) {
        conversationMessage += `:robot_face: Claude: ${assistantContent}\n`
      }

      // Add tool calls if any
      const toolCalls = response.toolCalls
      if (toolCalls.length > 0) {
        for (const tool of toolCalls) {
          let toolMessage = `    :wrench: ${tool.name}`

          // Add human-friendly description based on tool name and input
          if (tool.input) {
            switch (tool.name) {
              case 'Read':
                if (tool.input.file_path) {
                  const pathParts = tool.input.file_path.split('/')
                  const fileName = pathParts.slice(-2).join('/')
                  toolMessage += ` - Reading file: ${fileName}`
                }
                break
              case 'Write':
                if (tool.input.file_path) {
                  const pathParts = tool.input.file_path.split('/')
                  const fileName = pathParts.slice(-2).join('/')
                  toolMessage += ` - Writing file: ${fileName}`
                }
                break
              case 'Edit':
              case 'MultiEdit':
                if (tool.input.file_path) {
                  const pathParts = tool.input.file_path.split('/')
                  const fileName = pathParts.slice(-2).join('/')
                  toolMessage += ` - Editing file: ${fileName}`
                }
                break
              case 'Bash':
                if (tool.input.command) {
                  const cmd =
                    tool.input.command.length > 50
                      ? tool.input.command.substring(0, 50) + '...'
                      : tool.input.command
                  toolMessage += ` - Running: \`${cmd}\``
                }
                break
              case 'Grep':
                if (tool.input.pattern) {
                  const pattern =
                    tool.input.pattern.length > 30
                      ? tool.input.pattern.substring(0, 30) + '...'
                      : tool.input.pattern
                  toolMessage += ` - Searching for: "${pattern}"`
                }
                break
              case 'Glob':
                if (tool.input.pattern) {
                  toolMessage += ` - Finding files: ${tool.input.pattern}`
                }
                break
              case 'LS':
                if (tool.input.path) {
                  const pathParts = tool.input.path.split('/')
                  const dirName = pathParts.slice(-2).join('/')
                  toolMessage += ` - Listing: ${dirName}/`
                }
                break
              case 'TodoWrite':
                if (tool.input.todos && Array.isArray(tool.input.todos)) {
                  const todos = tool.input.todos
                  const pending = todos.filter((t: any) => t.status === 'pending').length
                  const inProgress = todos.filter((t: any) => t.status === 'in_progress').length
                  const completed = todos.filter((t: any) => t.status === 'completed').length

                  const statusParts = []
                  if (pending > 0) {
                    statusParts.push(`${pending} pending`)
                  }
                  if (inProgress > 0) {
                    statusParts.push(`${inProgress} in progress`)
                  }
                  if (completed > 0) {
                    statusParts.push(`${completed} completed`)
                  }

                  if (statusParts.length > 0) {
                    toolMessage += ` - Tasks: ${statusParts.join(', ')}`
                  } else {
                    toolMessage += ` - Managing ${todos.length} task${todos.length !== 1 ? 's' : ''}`
                  }
                }
                break
              case 'TodoRead':
                toolMessage += ` - Checking task list`
                break
              case 'WebSearch':
                if (tool.input.query) {
                  const query =
                    tool.input.query.length > 40
                      ? tool.input.query.substring(0, 40) + '...'
                      : tool.input.query
                  toolMessage += ` - Searching web: "${query}"`
                }
                break
              case 'WebFetch':
                if (tool.input.url) {
                  try {
                    const url = new URL(tool.input.url)
                    toolMessage += ` - Fetching: ${url.hostname}`
                  } catch {
                    toolMessage += ` - Fetching URL`
                  }
                }
                break
              default:
                // For other tools, check if there's a prompt or description
                if (tool.input.prompt && typeof tool.input.prompt === 'string') {
                  const prompt =
                    tool.input.prompt.length > 40
                      ? tool.input.prompt.substring(0, 40) + '...'
                      : tool.input.prompt
                  toolMessage += ` - ${prompt}`
                } else if (tool.input.description && typeof tool.input.description === 'string') {
                  const desc =
                    tool.input.description.length > 40
                      ? tool.input.description.substring(0, 40) + '...'
                      : tool.input.description
                  toolMessage += ` - ${desc}`
                }
            }
          }

          conversationMessage += `${toolMessage}\n`
        }
      }

      // Send the conversation to Slack
      await sendToSlack(
        {
          requestId: context.requestId,
          projectId: context.projectId,
          model: request.model,
          role: 'conversation',
          content: conversationMessage,
          timestamp: new Date().toISOString(),
          apiKey: this.getMaskedCredentialInfo(auth),
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
        },
        accountWebhook
      )
    } catch (error) {
      // Don't fail the request if notification fails
      logger.error('Failed to send notification', {
        requestId: context.requestId,
        projectId: context.projectId,
        error: error instanceof Error ? { message: error.message } : { message: String(error) },
      })
    }
  }

  /**
   * Send error notification
   */
  async notifyError(error: Error, context: RequestContext): Promise<void> {
    if (!this.config.enabled) {
      return
    }

    try {
      // Get Slack config for the project
      const accountWebhook = null

      await sendToSlack(
        {
          requestId: context.requestId,
          projectId: context.projectId,
          role: 'assistant',
          content: `Error: ${error.message}`,
          timestamp: new Date().toISOString(),
          metadata: {
            errorType: error.constructor.name,
            path: context.path,
          },
        } as MessageInfo,
        accountWebhook
      )
    } catch (notifyError) {
      logger.error('Failed to send error notification', {
        requestId: context.requestId,
        metadata: {
          originalError: error.message,
          notifyError: notifyError instanceof Error ? notifyError.message : String(notifyError),
        },
      })
    }
  }

  /**
   * Build notification payload
   */
  private buildNotification(
    request: ProxyRequest,
    response: ProxyResponse,
    context: RequestContext,
    auth: AuthResult,
    userMessageChanged: boolean
  ) {
    const metrics = response.getMetrics()

    // Build metadata
    const metadata = {
      projectId: context.projectId,
      model: request.model,
      streaming: request.isStreaming ? 'Yes' : 'No',
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      totalTokens: metrics.totalTokens,
      toolCalls: metrics.toolCallCount,
      requestType: request.requestType,
      apiKeyInfo: 'OAuth',
      accountName: auth.accountName,
      processingTime: `${context.getElapsedTime()}ms`,
    }

    // Prepare content
    const userContent = userMessageChanged ? request.getUserContent() : undefined
    const assistantContent = response.getTruncatedContent(
      this.config.maxLines,
      this.config.maxLength
    )

    return {
      message: userMessageChanged ? 'New conversation' : 'Continued conversation',
      userContent,
      assistantContent,
      metadata,
    }
  }

  private getMaskedCredentialInfo(auth: AuthResult): string | undefined {
    if (!auth.key) {
      return undefined
    }
    const maskedKey = auth.key.length > 10 ? `${auth.key.slice(0, 10)}****` : '****'
    return `oauth:${maskedKey}`
  }

  /**
   * Get previous message for a project ID
   */
  private getPreviousMessage(projectId: string): string {
    return this.previousMessages.get(projectId) || ''
  }

  /**
   * Set previous message for a project ID
   */
  private setPreviousMessage(projectId: string, message: string): void {
    // Implement cache size limit
    if (this.previousMessages.size >= this.maxCacheSize) {
      const firstKey = this.previousMessages.keys().next().value
      if (firstKey !== undefined) {
        this.previousMessages.delete(firstKey)
      }
    }
    this.previousMessages.set(projectId, message)
  }
}
