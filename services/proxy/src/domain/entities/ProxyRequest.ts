import { ClaudeMessagesRequest, countSystemMessages } from '@agent-prompttrain/shared'

export type RequestType = 'query_evaluation' | 'inference' | 'quota'

/**
 * Domain entity representing a proxy request
 * Encapsulates business logic related to request processing
 */
export class ProxyRequest {
  private _requestType: RequestType | null = null

  constructor(
    public readonly raw: ClaudeMessagesRequest,
    public readonly trainId: string,
    public readonly requestId: string,
    public readonly apiKey?: string
  ) {}

  get isStreaming(): boolean {
    return this.raw.stream === true
  }

  get model(): string {
    return this.raw.model
  }

  get requestType(): RequestType {
    if (!this._requestType) {
      this._requestType = this.determineRequestType()
    }
    return this._requestType
  }

  get systemMessageCount(): number {
    return countSystemMessages(this.raw)
  }

  /**
   * Extract user content for notifications
   */
  getUserContent(): string {
    // Find the last user message
    const lastUserMessage = [...this.raw.messages].reverse().find(msg => msg.role === 'user')

    if (!lastUserMessage) {
      return ''
    }

    if (typeof lastUserMessage.content === 'string') {
      return lastUserMessage.content
    }

    // Handle array content
    const textContent = lastUserMessage.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n')

    return textContent
  }

  /**
   * Extract user content for notifications (filters system reminders for inference requests)
   */
  getUserContentForNotification(): string {
    // Find the last user message
    const lastUserMessage = [...this.raw.messages].reverse().find(msg => msg.role === 'user')

    if (!lastUserMessage) {
      return ''
    }

    if (typeof lastUserMessage.content === 'string') {
      return lastUserMessage.content
    }

    // Handle array content
    // For inference requests, ignore the first and last content items (system reminders)
    let contentArray = lastUserMessage.content.filter(c => c.type === 'text')

    // If this is an inference request and we have more than 2 text content items,
    // skip the first and last ones (which are system reminders)
    if (this.requestType === 'inference' && contentArray.length > 2) {
      contentArray = contentArray.slice(1, -1)
    }

    const textContent = contentArray.map(c => c.text).join('\n')

    return textContent
  }

  /**
   * Check if user content has changed from previous
   */
  hasUserContentChanged(previousContent: string): boolean {
    const currentContent = this.getUserContentForNotification()
    return currentContent !== previousContent
  }

  private determineRequestType(): RequestType {
    // Check if this is a quota query
    const userContent = this.getUserContent()
    if (userContent && userContent.trim().toLowerCase() === 'quota') {
      return 'quota'
    }

    // Determine request type based on system message count
    // Requests with 0 or 1 system messages are considered "query_evaluation" (insignificant)
    // Requests with 2 or more system messages are considered "inference" (significant)

    const systemMessageCount = this.countSystemMessages()

    // Always log request type determination
    // const systemFieldDisplay = this.raw.system
    //   ? (Array.isArray(this.raw.system) ? `array[${this.raw.system.length}]` : `string(length: ${this.raw.system.length})`)
    //   : 'none'

    // const resultType = systemMessageCount <= 1 ? 'query_evaluation' : 'inference'

    // logger.debug('Request type determination', {
    //   requestId: this.requestId,
    //   systemField: systemFieldDisplay,
    //   systemMessagesInArray,
    //   totalSystemMessages: systemMessageCount,
    //   messageCount: this.raw.messages.length,
    //   messageRoles: this.raw.messages.map(m => m.role),
    //   resultType: resultType
    // })

    // If there are 0 or 1 system messages, it's a query evaluation (insignificant request)
    if (systemMessageCount <= 1) {
      return 'query_evaluation'
    }

    // If there are 2 or more system messages, it's an inference (significant request)
    return 'inference'
  }

  countSystemMessages(): number {
    let count = 0

    // Handle system field - can be string or array
    if (this.raw.system) {
      if (Array.isArray(this.raw.system)) {
        count = this.raw.system.length
      } else {
        count = 1
      }
    }

    // Add system messages from messages array
    count += this.raw.messages.filter(m => m.role === 'system').length
    return count
  }

  /**
   * Create request headers for Claude API
   */
  createHeaders(authHeaders: Record<string, string>): Record<string, string> {
    // Filter out x-api-key to ensure it's never sent to Claude
    const { 'x-api-key': _, ...filteredAuthHeaders } = authHeaders

    return {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...filteredAuthHeaders,
    }
  }
}
