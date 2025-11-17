import { Context } from 'hono'
import { countTokens } from '@anthropic-ai/tokenizer'
import { getRequestLogger } from '../middleware/logger.js'

// Define the expected shape of the request body for count_tokens
interface CountTokensRequest {
  messages: Array<{
    role: 'user' | 'assistant'
    content: string | Array<{ type: 'text'; text: string }>
  }>
  system?: string | Array<{ type: 'text'; text: string }>
}

/**
 * Service for emulating Claude API endpoints that are not natively supported by AWS Bedrock.
 * Currently implements token counting emulation using Anthropic's tokenizer.
 */
export class BedrockEmulationService {
  /**
   * Handles /v1/messages/count_tokens requests for Bedrock accounts.
   * Uses semantic serialization to approximate Claude's token counting.
   *
   * Note: This is a best-effort approximation and may differ slightly from the
   * official API's token count due to internal model-specific tokenization details.
   */
  async handleCountTokens(c: Context): Promise<Response> {
    const logger = getRequestLogger(c)

    try {
      const body = await c.req.json<CountTokensRequest>()

      if (!body.messages || !Array.isArray(body.messages)) {
        return c.json(
          {
            error: {
              type: 'invalid_request_error',
              message: 'Request must include a messages array',
            },
          },
          400
        )
      }

      logger.info('Emulating token count for Bedrock request', {
        messageCount: body.messages.length,
        hasSystem: !!body.system,
      })

      // Serialize the request into a format that approximates what the model processes
      const textToTokenize = this.serializeMessagesForTokenization(body)
      const tokenCount = countTokens(textToTokenize)

      logger.info('Token count emulation complete', {
        tokenCount,
        textLength: textToTokenize.length,
      })

      // Return Claude API-compatible response format
      return c.json({ input_tokens: tokenCount }, 200)
    } catch (error) {
      logger.error(
        'Failed during Bedrock token count emulation',
        error instanceof Error ? error : undefined
      )

      return c.json(
        {
          error: {
            type: 'invalid_request_error',
            message: 'Failed to parse request body or count tokens.',
          },
        },
        400
      )
    }
  }

  /**
   * Serializes messages into a string format that approximates what Claude models process.
   * This is crucial for accurate token counting as the tokenizer operates on plain text.
   *
   * Format:
   * - System prompts appear first
   * - Each message is formatted as "Human: <content>" or "Assistant: <content>"
   * - Messages are separated by double newlines
   * - Multi-part content is concatenated
   */
  private serializeMessagesForTokenization(body: CountTokensRequest): string {
    const parts: string[] = []

    // System prompts are typically handled first
    if (body.system) {
      const systemText = Array.isArray(body.system)
        ? body.system
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join(' ')
        : body.system
      if (systemText) {
        parts.push(systemText)
      }
    }

    // Process each message
    for (const message of body.messages) {
      // Anthropic models use 'Human' and 'Assistant' roles internally
      const role = message.role === 'user' ? 'Human' : 'Assistant'

      // Handle both simple string content and complex array content
      const textContent = Array.isArray(message.content)
        ? message.content
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join(' ')
        : typeof message.content === 'string'
          ? message.content
          : ''

      parts.push(`${role}: ${textContent}`)
    }

    // Join with double newlines to separate conversation turns
    return parts.join('\n\n')
  }
}
