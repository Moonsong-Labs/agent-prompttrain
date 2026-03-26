import {
  buildClaudeAnalysisPrompt,
  parseAnalysisResponse,
} from '@agent-prompttrain/shared/prompts/analysis/index.js'
import type { ConversationAnalysis } from '@agent-prompttrain/shared/types/ai-analysis'
import {
  ANTHROPIC_ANALYSIS_CONFIG,
  AI_WORKER_CONFIG,
  config,
} from '@agent-prompttrain/shared/config'
import { logger } from '../../middleware/logger.js'
import {
  sanitizeForLLM,
  validateAnalysisOutput,
  redactOutputPII,
} from '../../middleware/sanitization.js'
import { getErrorMessage } from '@agent-prompttrain/shared'

/** Response shape from Claude Messages API (proxied through our proxy) */
export interface ClaudeApiResponse {
  id: string
  type: 'message'
  role: 'assistant'
  content: Array<{
    type: 'text'
    text: string
  }>
  model: string
  stop_reason: string | null
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
  }
}

/**
 * AI Analysis service that calls Claude API through the local proxy.
 *
 * Instead of requiring a separate Anthropic API key, this service sends
 * requests to the proxy's own /v1/messages endpoint, using a dedicated
 * project's credentials for authentication and account pool routing.
 */
export class AnthropicAnalysisService {
  private modelName: string
  private proxyUrl: string
  private projectId: string
  private apiKey: string | undefined

  constructor() {
    this.modelName = ANTHROPIC_ANALYSIS_CONFIG.MODEL_NAME

    // Build the proxy URL from config
    const port = config.server.port
    this.proxyUrl = process.env.AI_ANALYSIS_PROXY_URL || `http://localhost:${port}`

    // Project ID is required - the user must create a dedicated project for analysis
    this.projectId = process.env.AI_ANALYSIS_PROJECT_ID || ''
    if (!this.projectId) {
      throw new Error(
        'AI_ANALYSIS_PROJECT_ID is not set. Create a dedicated project for AI analysis and set its ID.'
      )
    }

    // Optional API key for when client auth is enabled (project-scoped API key)
    this.apiKey = process.env.AI_ANALYSIS_API_KEY
  }

  getModelName(): string {
    return this.modelName
  }

  async analyzeConversation(
    messages: Array<{ role: 'user' | 'model'; content: string }>,
    customPrompt?: string
  ): Promise<{
    content: string
    data: ConversationAnalysis | null
    rawResponse: ClaudeApiResponse
    promptTokens: number
    completionTokens: number
  }> {
    const startTime = Date.now()
    const maxRetries = config.aiAnalysis?.maxRetries || 2

    // Sanitize all message content
    const sanitizedMessages = messages.map(msg => ({
      role: msg.role,
      content: sanitizeForLLM(msg.content),
    }))

    let lastError: Error | null = null

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const { system, messages: claudeMessages } = buildClaudeAnalysisPrompt(
          sanitizedMessages,
          undefined,
          customPrompt
        )

        logger.debug(
          `Prepared prompt with ${claudeMessages.length} messages (attempt ${attempt + 1})`,
          {
            metadata: { worker: 'analysis-worker' },
          }
        )

        const response = await this.callProxyApi(system, claudeMessages)

        const analysisText = response.content[0]?.text
        if (!analysisText) {
          throw new Error('No response content from Claude API')
        }

        // Redact any PII from the output before validation/storage
        const redactedText = redactOutputPII(analysisText)
        if (redactedText !== analysisText) {
          logger.info('PII redacted from analysis output before storage', {
            metadata: { worker: 'analysis-worker', attempt: attempt + 1 },
          })
        }

        // Validate the output structure
        const validation = validateAnalysisOutput(redactedText)

        if (validation.isValid) {
          try {
            const parsedAnalysis = parseAnalysisResponse(redactedText)
            const markdownContent = this.formatAnalysisAsMarkdown(parsedAnalysis)

            logger.info(`Analysis completed in ${Date.now() - startTime}ms`, {
              metadata: {
                worker: 'analysis-worker',
                promptTokens: response.usage.input_tokens,
                completionTokens: response.usage.output_tokens,
                attempt: attempt + 1,
              },
            })

            return {
              content: markdownContent,
              data: parsedAnalysis,
              rawResponse: response,
              promptTokens: response.usage.input_tokens,
              completionTokens: response.usage.output_tokens,
            }
          } catch (parseError) {
            logger.warn('Failed to parse JSON response, returning raw text', {
              error: {
                message: getErrorMessage(parseError),
              },
              metadata: {
                worker: 'analysis-worker',
                attempt: attempt + 1,
              },
            })

            return {
              content: redactedText,
              data: null,
              rawResponse: response,
              promptTokens: response.usage.input_tokens,
              completionTokens: response.usage.output_tokens,
            }
          }
        }

        // For structural issues, retry with enhanced prompt
        if (attempt < maxRetries) {
          logger.warn('Analysis validation failed, retrying with enhanced prompt', {
            metadata: {
              worker: 'analysis-worker',
              attempt: attempt + 1,
              issues: validation.issues,
            },
          })
          continue
        }

        throw new Error(
          `Analysis validation failed after ${maxRetries + 1} attempts: ${validation.issues.join(', ')}`
        )
      } catch (error) {
        lastError = error as Error
        logger.error('Claude API error (via proxy)', {
          error: {
            message: lastError.message,
            name: lastError.name,
            stack: lastError.stack,
          },
          metadata: {
            worker: 'analysis-worker',
            attempt: attempt + 1,
          },
        })

        // Don't retry on certain errors
        if (
          lastError.message.includes('sensitive information') ||
          lastError.message.includes('AI_ANALYSIS_PROJECT_ID')
        ) {
          break
        }
      }
    }

    throw lastError || new Error('Analysis failed')
  }

  /**
   * Calls the Claude API through the local proxy's /v1/messages endpoint.
   * The proxy handles credential resolution, token refresh, and account pool routing.
   */
  private async callProxyApi(
    system: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
  ): Promise<ClaudeApiResponse> {
    const url = `${this.proxyUrl}/v1/messages`

    const requestBody = {
      model: this.modelName,
      max_tokens: 8192,
      system,
      messages,
      temperature: 0.1,
    }

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'MSL-Project-ID': this.projectId,
    }

    // Add API key auth if configured (needed when ENABLE_CLIENT_AUTH=true)
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`
    }

    // Create an AbortController for timeout
    const controller = new AbortController()
    const timeoutMs = AI_WORKER_CONFIG.ANTHROPIC_REQUEST_TIMEOUT_MS
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Proxy API error (${response.status}): ${errorText}`)
      }

      const data = await response.json()
      return data as ClaudeApiResponse
    } catch (error) {
      clearTimeout(timeoutId)
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Proxy API request timed out after ${timeoutMs}ms`)
      }
      throw error
    }
  }

  private formatAnalysisAsMarkdown(analysis: ConversationAnalysis): string {
    return `# Conversation Analysis

## Summary
${analysis.summary}

## Key Topics
${analysis.keyTopics.map((topic: string) => `- ${topic}`).join('\n')}

## Sentiment
**${analysis.sentiment}**

## User Intent
${analysis.userIntent}

## Outcomes
${analysis.outcomes.length > 0 ? analysis.outcomes.map((outcome: string) => `- ${outcome}`).join('\n') : 'No specific outcomes identified.'}

## Action Items
${analysis.actionItems.length > 0 ? analysis.actionItems.map((item: any) => `- [ ] ${typeof item === 'string' ? item : item.description}`).join('\n') : 'No action items identified.'}

## Technical Details
### Frameworks & Technologies
${analysis.technicalDetails.frameworks.length > 0 ? analysis.technicalDetails.frameworks.map((fw: string) => `- ${fw}`).join('\n') : 'None mentioned.'}

### Issues Encountered
${analysis.technicalDetails.issues.length > 0 ? analysis.technicalDetails.issues.map((issue: string) => `- ${issue}`).join('\n') : 'No issues reported.'}

### Solutions Provided
${analysis.technicalDetails.solutions.length > 0 ? analysis.technicalDetails.solutions.map((solution: string) => `- ${solution}`).join('\n') : 'No solutions discussed.'}

## Prompting Tips
${
  analysis.promptingTips && analysis.promptingTips.length > 0
    ? analysis.promptingTips
        .map(
          (tip: any) => `
### ${tip.category}
**Issue**: ${tip.issue}
**Suggestion**: ${tip.suggestion}
${tip.example ? `**Example**: ${tip.example}` : ''}
`
        )
        .join('\n')
    : 'No specific prompting improvements identified.'
}

## Interaction Patterns
- **Prompt Clarity**: ${analysis.interactionPatterns?.promptClarity || 'N/A'}/10
- **Context Completeness**: ${analysis.interactionPatterns?.contextCompleteness || 'N/A'}/10
- **Follow-up Effectiveness**: ${analysis.interactionPatterns?.followUpEffectiveness || 'N/A'}

## Conversation Quality
- **Clarity**: ${analysis.conversationQuality.clarity}
- **Completeness**: ${analysis.conversationQuality.completeness}
- **Effectiveness**: ${analysis.conversationQuality.effectiveness}
`
  }
}
