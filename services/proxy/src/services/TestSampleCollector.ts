import { promises as fs } from 'fs'
import path from 'path'
import {
  ClaudeMessagesRequest,
  MSL_PROJECT_ID_HEADER_LOWER,
  MSL_ACCOUNT_HEADER_LOWER,
} from '@agent-prompttrain/shared'
import { Context } from 'hono'
import { config } from '@agent-prompttrain/shared/config'
import { getRequestLogger } from '../middleware/logger'

interface TestSample {
  timestamp: string
  method: string
  path: string
  headers: Record<string, string>
  body: any
  queryParams: Record<string, string>
  metadata: {
    requestType: string
    isStreaming: boolean
    hasTools: boolean
    modelUsed: string
    messageCount: number
  }
  response?: {
    status: number
    headers: Record<string, string>
    body: any
    metadata?: {
      inputTokens?: number
      outputTokens?: number
      toolCalls?: number
      streamingChunks?: any[]
    }
  }
}

export class TestSampleCollector {
  private readonly samplesDir: string
  private readonly enabled: boolean
  private readonly pendingSamples: Map<string, { sample: TestSample; filename: string }>

  constructor() {
    // Use a dedicated directory for test samples
    this.samplesDir = path.join(process.cwd(), config.features.testSamplesDir || 'test-samples')
    this.enabled = config.features.collectTestSamples || false
    this.pendingSamples = new Map()
  }

  async collectSample(
    context: Context,
    validatedBody: ClaudeMessagesRequest,
    requestType: 'query_evaluation' | 'inference' | 'quota' | 'internal_operation'
  ): Promise<string | undefined> {
    if (!this.enabled) {
      return undefined
    }

    const logger = getRequestLogger(context)

    try {
      // Ensure samples directory exists
      await fs.mkdir(this.samplesDir, { recursive: true })

      // Extract headers (sanitized)
      const headers = this.sanitizeHeaders(context.req.raw.headers)

      // Determine sample type
      const sampleType = this.determineSampleType(validatedBody, requestType)

      // Create test sample
      const sample: TestSample = {
        timestamp: new Date().toISOString(),
        method: context.req.method,
        path: context.req.path,
        headers,
        body: this.sanitizeBody(validatedBody),
        queryParams: this.extractQueryParams(context),
        metadata: {
          requestType,
          isStreaming: validatedBody.stream || false,
          hasTools: !!(validatedBody.tools && validatedBody.tools.length > 0),
          modelUsed: validatedBody.model,
          messageCount: validatedBody.messages.length,
        },
      }

      // Generate a unique sample ID
      const sampleId = `${sampleType}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      const filename = `${sampleId}.json`

      // Store the sample temporarily
      this.pendingSamples.set(sampleId, { sample, filename })

      logger.debug(`Test sample prepared: ${filename}`)

      return sampleId
    } catch (error) {
      logger.error('Failed to collect test sample', error instanceof Error ? error : undefined)
      return undefined
    }
  }

  async updateSampleWithResponse(
    sampleId: string,
    response: Response,
    responseBody: any,
    metadata?: {
      inputTokens?: number
      outputTokens?: number
      toolCalls?: number
      streamingChunks?: any[]
    }
  ): Promise<void> {
    if (!this.enabled || !sampleId) {
      return
    }

    const pendingSample = this.pendingSamples.get(sampleId)
    if (!pendingSample) {
      return
    }

    try {
      // Extract response headers
      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value
      })

      // Add response data to the sample
      pendingSample.sample.response = {
        status: response.status,
        headers: this.sanitizeHeaders(response.headers),
        body: this.sanitizeResponseBody(responseBody),
        metadata,
      }

      // Write the complete sample to file
      const filepath = path.join(this.samplesDir, pendingSample.filename)
      await fs.writeFile(filepath, JSON.stringify(pendingSample.sample, null, 2), 'utf-8')

      // Clean up from pending samples
      this.pendingSamples.delete(sampleId)

      // Log completion (using import from logger module directly since we don't have context here)
      // This is a debug message for test sample collection, not critical
    } catch (error) {
      // Log error without context (this is for test sample collection, not critical path)
      console.error('Failed to update test sample with response', error)
    }
  }

  private sanitizeResponseBody(body: any): any {
    if (!body) {
      return body
    }

    // Create a deep copy
    const sanitized = JSON.parse(JSON.stringify(body))

    // Sanitize content in the response
    if (sanitized.content && Array.isArray(sanitized.content)) {
      sanitized.content = sanitized.content.map((block: any) => {
        if (block.type === 'text' && typeof block.text === 'string') {
          return {
            ...block,
            text: this.removeSensitiveContent(block.text),
          }
        }
        return block
      })
    }

    return sanitized
  }

  private determineSampleType(body: ClaudeMessagesRequest, requestType: string): string {
    const parts: string[] = []

    // Add request type
    parts.push(requestType)

    // Add streaming indicator
    if (body.stream) {
      parts.push('streaming')
    }

    // Add tools indicator
    if (body.tools && body.tools.length > 0) {
      parts.push('with_tools')
    }

    // Add system message indicator
    if (body.system) {
      parts.push('with_system')
    }

    // Add model family
    const modelFamily = this.getModelFamily(body.model)
    if (modelFamily) {
      parts.push(modelFamily)
    }

    return parts.join('_')
  }

  private getModelFamily(model: string): string {
    if (model.includes('opus')) {
      return 'opus'
    }
    if (model.includes('sonnet')) {
      return 'sonnet'
    }
    if (model.includes('haiku')) {
      return 'haiku'
    }
    return 'unknown'
  }

  private sanitizeHeaders(headers: Headers): Record<string, string> {
    const sanitized: Record<string, string> = {}

    // List of headers to include (sanitized)
    const includeHeaders = [
      'content-type',
      'user-agent',
      'accept',
      'accept-encoding',
      MSL_PROJECT_ID_HEADER_LOWER,
      MSL_ACCOUNT_HEADER_LOWER,
      'content-length',
      'anthropic-version',
      'anthropic-beta',
    ]

    headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase()

      if (includeHeaders.includes(lowerKey)) {
        sanitized[key] = value
      } else if (lowerKey === 'authorization' || lowerKey === 'x-api-key') {
        // Mask sensitive headers
        sanitized[key] = this.maskSensitiveValue(value)
      }
    })

    return sanitized
  }

  private sanitizeBody(body: ClaudeMessagesRequest): any {
    // Create a deep copy to avoid modifying the original
    const sanitized = JSON.parse(JSON.stringify(body))

    // Remove any API keys or sensitive data that might be in the messages
    if (sanitized.messages) {
      sanitized.messages = sanitized.messages.map((msg: any) => {
        if (typeof msg.content === 'string') {
          return {
            ...msg,
            content: this.removeSensitiveContent(msg.content),
          }
        } else if (Array.isArray(msg.content)) {
          // Handle content blocks
          return {
            ...msg,
            content: msg.content.map((block: any) => {
              if (block.type === 'text' && typeof block.text === 'string') {
                return {
                  ...block,
                  text: this.removeSensitiveContent(block.text),
                }
              }
              return block
            }),
          }
        }
        return msg
      })
    }

    if (sanitized.system) {
      if (typeof sanitized.system === 'string') {
        sanitized.system = this.removeSensitiveContent(sanitized.system)
      } else if (Array.isArray(sanitized.system)) {
        // Handle system as array of content blocks
        sanitized.system = sanitized.system.map((block: any) => {
          if (block.type === 'text' && typeof block.text === 'string') {
            return {
              ...block,
              text: this.removeSensitiveContent(block.text),
            }
          }
          return block
        })
      }
    }

    return sanitized
  }

  private removeSensitiveContent(content: string): string {
    // Mask common sensitive patterns
    return content
      .replace(/sk-ant-[a-zA-Z0-9-]+/g, 'sk-ant-****')
      .replace(/Bearer [a-zA-Z0-9-._~+/]+/g, 'Bearer ****')
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '****@****.com')
      .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '****-****-****-****') // Credit cards
      .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '***-**-****') // SSN
  }

  private maskSensitiveValue(value: string): string {
    if (value.startsWith('sk-ant-')) {
      return 'sk-ant-****'
    }
    if (value.startsWith('Bearer ')) {
      return 'Bearer ****'
    }
    return '****'
  }

  private extractQueryParams(context: Context): Record<string, string> {
    const url = new URL(context.req.url)
    const params: Record<string, string> = {}

    url.searchParams.forEach((value, key) => {
      params[key] = value
    })

    return params
  }

  // Get collected samples (useful for testing)
  async getCollectedSamples(): Promise<string[]> {
    if (!this.enabled) {
      return []
    }

    try {
      const files = await fs.readdir(this.samplesDir)
      return files.filter(f => f.endsWith('.json'))
    } catch {
      return []
    }
  }

  // Clear all samples (useful for cleanup)
  async clearSamples(): Promise<void> {
    if (!this.enabled) {
      return
    }

    try {
      const files = await fs.readdir(this.samplesDir)
      await Promise.all(
        files.filter(f => f.endsWith('.json')).map(f => fs.unlink(path.join(this.samplesDir, f)))
      )
    } catch {
      // Ignore errors
    }
  }
}

// Export singleton instance
export const testSampleCollector = new TestSampleCollector()
