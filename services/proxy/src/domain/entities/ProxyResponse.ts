import { ClaudeMessagesResponse, ClaudeStreamEvent, hasToolUse } from '@agent-prompttrain/shared'
import { logger } from '../../middleware/logger'

/**
 * Domain entity representing a proxy response
 * Encapsulates response processing logic
 */
export class ProxyResponse {
  private _inputTokens: number = 0
  private _outputTokens: number = 0
  private _cacheCreationInputTokens: number = 0
  private _cacheReadInputTokens: number = 0
  private _toolCallCount: number = 0
  private _content: string = ''
  private _fullUsageData: any = null
  private _toolCalls: Array<{ name: string; id?: string; input?: any }> = []
  private _currentToolIndex: number = -1
  private _toolInputAccumulator: string = ''

  constructor(
    public readonly requestId: string,
    public readonly streaming: boolean
  ) {}

  get inputTokens(): number {
    return this._inputTokens
  }

  get outputTokens(): number {
    return this._outputTokens
  }

  get totalTokens(): number {
    return this._inputTokens + this._outputTokens
  }

  get toolCallCount(): number {
    return this._toolCallCount
  }

  get content(): string {
    return this._content
  }

  get toolCalls(): Array<{ name: string; id?: string; input?: any }> {
    return this._toolCalls
  }

  get cacheCreationInputTokens(): number {
    return this._cacheCreationInputTokens
  }

  get cacheReadInputTokens(): number {
    return this._cacheReadInputTokens
  }

  get fullUsageData(): any {
    return this._fullUsageData
  }

  /**
   * Process a non-streaming response
   */
  processResponse(response: ClaudeMessagesResponse): void {
    this._inputTokens = response.usage?.input_tokens || 0
    this._outputTokens = response.usage?.output_tokens || 0
    this._cacheCreationInputTokens = response.usage?.cache_creation_input_tokens || 0
    this._cacheReadInputTokens = response.usage?.cache_read_input_tokens || 0
    this._fullUsageData = response.usage || null

    logger.debug('Non-streaming response token usage', {
      requestId: this.requestId,
      metadata: {
        usage: response.usage,
        inputTokens: this._inputTokens,
        outputTokens: this._outputTokens,
        cacheCreationInputTokens: this._cacheCreationInputTokens,
        cacheReadInputTokens: this._cacheReadInputTokens,
      },
    })

    // Count tool calls and extract tool info
    if (response.content && hasToolUse(response.content)) {
      const toolUses = response.content.filter(c => c.type === 'tool_use')
      this._toolCallCount = toolUses.length
      this._toolCalls = toolUses.map(tool => ({
        name: tool.name || 'unknown',
        id: tool.id,
        input: tool.input,
      }))
    }

    // Extract text content
    this._content =
      response.content
        ?.filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n') || ''
  }

  /**
   * Process a streaming event
   */
  processStreamEvent(event: ClaudeStreamEvent): void {
    // Debug logging for token tracking
    if (event.type === 'message_start' || event.type === 'message_delta') {
      logger.debug('Processing stream event with usage data', {
        requestId: this.requestId,
        metadata: {
          eventType: event.type,
          usage: event.type === 'message_start' ? event.message?.usage : event.usage,
          currentTokens: {
            input: this._inputTokens,
            output: this._outputTokens,
          },
        },
      })
    }

    switch (event.type) {
      case 'message_start':
        if (event.message?.usage) {
          this._inputTokens = event.message.usage.input_tokens || 0
          this._outputTokens = event.message.usage.output_tokens || 0
          this._cacheCreationInputTokens = event.message.usage.cache_creation_input_tokens || 0
          this._cacheReadInputTokens = event.message.usage.cache_read_input_tokens || 0
          this._fullUsageData = event.message.usage

          logger.debug('message_start usage data', {
            requestId: this.requestId,
            metadata: {
              usage: event.message.usage,
              inputTokens: this._inputTokens,
              outputTokens: this._outputTokens,
              cacheCreationInputTokens: this._cacheCreationInputTokens,
              cacheReadInputTokens: this._cacheReadInputTokens,
            },
          })
        } else {
          logger.warn('message_start event missing usage data', {
            requestId: this.requestId,
            metadata: {
              event: JSON.stringify(event),
            },
          })
        }
        break

      case 'message_delta':
        if (event.usage) {
          this._outputTokens = event.usage.output_tokens || this._outputTokens
          // Update cache tokens if provided
          if (event.usage.cache_creation_input_tokens !== undefined) {
            this._cacheCreationInputTokens = event.usage.cache_creation_input_tokens
          }
          if (event.usage.cache_read_input_tokens !== undefined) {
            this._cacheReadInputTokens = event.usage.cache_read_input_tokens
          }
          // Store the latest usage data
          this._fullUsageData = { ...this._fullUsageData, ...event.usage }

          logger.debug('message_delta usage update', {
            requestId: this.requestId,
            metadata: {
              usage: event.usage,
              outputTokens: this._outputTokens,
              cacheTokens: {
                creation: this._cacheCreationInputTokens,
                read: this._cacheReadInputTokens,
              },
            },
          })
        }
        break

      case 'content_block_start':
        if (event.content_block?.type === 'tool_use') {
          this._toolCallCount++
          this._currentToolIndex = this._toolCalls.length
          this._toolInputAccumulator = ''
          this._toolCalls.push({
            name: event.content_block.name || 'unknown',
            id: event.content_block.id,
            input: event.content_block.input || {},
          })
        }
        break

      case 'content_block_delta':
        if (event.delta?.type === 'text_delta' && event.delta.text) {
          this._content += event.delta.text
        } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
          // Accumulate tool input JSON
          this._toolInputAccumulator += event.delta.partial_json
        }
        break

      case 'content_block_stop':
        // Parse accumulated tool input when block stops
        if (this._currentToolIndex >= 0 && this._toolInputAccumulator) {
          try {
            const parsedInput = JSON.parse(this._toolInputAccumulator)
            this._toolCalls[this._currentToolIndex].input = parsedInput
          } catch (e) {
            logger.warn('Failed to parse tool input JSON', {
              requestId: this.requestId,
              metadata: {
                toolIndex: this._currentToolIndex,
                accumulator: this._toolInputAccumulator,
                error: e instanceof Error ? e.message : String(e),
              },
            })
          }
          this._currentToolIndex = -1
          this._toolInputAccumulator = ''
        }
        break

      case 'message_stop':
        // Final event in streaming response
        break
    }
  }

  /**
   * Get metrics for tracking
   */
  getMetrics() {
    return {
      inputTokens: this._inputTokens,
      outputTokens: this._outputTokens,
      totalTokens: this.totalTokens,
      cacheCreationInputTokens: this._cacheCreationInputTokens,
      cacheReadInputTokens: this._cacheReadInputTokens,
      toolCallCount: this._toolCallCount,
      hasContent: this._content.length > 0,
      fullUsageData: this._fullUsageData,
    }
  }

  /**
   * Get truncated content for notifications
   */
  getTruncatedContent(maxLines: number = 20, maxLength: number = 3000): string {
    if (!this._content) {
      return ''
    }

    // Truncate by lines first
    const lines = this._content.split('\n')
    let truncated = lines.slice(0, maxLines).join('\n')

    if (lines.length > maxLines) {
      truncated += '\n... (truncated)'
    }

    // Then truncate by total length
    if (truncated.length > maxLength) {
      truncated = truncated.substring(0, maxLength) + '... (truncated)'
    }

    return truncated
  }
}
