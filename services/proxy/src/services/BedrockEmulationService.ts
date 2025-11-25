import { Context } from 'hono'
import { countTokens } from '@anthropic-ai/tokenizer'
import { createHash } from 'crypto'
import { getRequestLogger, logger } from '../middleware/logger.js'

// Define the expected shape of the request body for count_tokens
interface CountTokensRequest {
  messages: Array<{
    role: 'user' | 'assistant'
    content: string | Array<{ type: 'text'; text: string }>
  }>
  system?: string | Array<{ type: 'text'; text: string }>
}

// Cache entry with timestamp for TTL management
interface TokenCountCacheEntry {
  tokenCount: number
  timestamp: number
}

// In-flight request entry for deduplication
interface InFlightRequest {
  promise: Promise<number>
  timestamp: number
}

// Cache configuration constants
const TOKEN_COUNT_CACHE_MAX_SIZE = 1000
const TOKEN_COUNT_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const IN_FLIGHT_TIMEOUT_MS = 30 * 1000 // 30 seconds max for in-flight requests

/**
 * Service for emulating Claude API endpoints that are not natively supported by AWS Bedrock.
 * Currently implements token counting emulation using Anthropic's tokenizer.
 * Includes an LRU cache to optimize repeated token counting requests.
 * Implements in-flight request deduplication to coalesce parallel identical requests.
 */
export class BedrockEmulationService {
  private tokenCountCache: Map<string, TokenCountCacheEntry> = new Map()
  private inFlightRequests: Map<string, InFlightRequest> = new Map()
  private cacheHits = 0
  private cacheMisses = 0
  private coalesced = 0

  /**
   * Handles /v1/messages/count_tokens requests for Bedrock accounts.
   * Uses semantic serialization to approximate Claude's token counting.
   * Results are cached to optimize repeated requests with identical content.
   * Implements in-flight deduplication to coalesce parallel identical requests.
   *
   * Note: This is a best-effort approximation and may differ slightly from the
   * official API's token count due to internal model-specific tokenization details.
   */
  async handleCountTokens(c: Context): Promise<Response> {
    const reqLogger = getRequestLogger(c)

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

      // Serialize the request into a format that approximates what the model processes
      const textToTokenize = this.serializeMessagesForTokenization(body)

      // Check cache first using content hash
      const cacheKey = this.computeCacheKey(textToTokenize)
      const cachedResult = this.getCachedTokenCount(cacheKey)

      if (cachedResult !== null) {
        this.cacheHits++
        reqLogger.debug('Token count cache hit', {
          tokenCount: cachedResult,
          textLength: textToTokenize.length,
          cacheHits: this.cacheHits,
          cacheMisses: this.cacheMisses,
          coalesced: this.coalesced,
        })
        return c.json({ input_tokens: cachedResult }, 200)
      }

      // Check for in-flight request with same content (request coalescing)
      const inFlight = this.getInFlightRequest(cacheKey)
      if (inFlight !== null) {
        this.coalesced++
        reqLogger.debug('Token count request coalesced', {
          textLength: textToTokenize.length,
          cacheHits: this.cacheHits,
          cacheMisses: this.cacheMisses,
          coalesced: this.coalesced,
        })
        const tokenCount = await inFlight
        return c.json({ input_tokens: tokenCount }, 200)
      }

      // Cache miss and no in-flight request - compute token count
      this.cacheMisses++
      const tokenCount = await this.computeTokenCountWithDedup(cacheKey, textToTokenize, reqLogger)

      // Return Claude API-compatible response format
      return c.json({ input_tokens: tokenCount }, 200)
    } catch (error) {
      reqLogger.error(
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
   * Compute token count with in-flight deduplication.
   * Registers the computation as in-flight so parallel requests can wait for it.
   */
  private async computeTokenCountWithDedup(
    cacheKey: string,
    textToTokenize: string,
    reqLogger: ReturnType<typeof getRequestLogger>
  ): Promise<number> {
    // Create the computation promise
    const computePromise = (async () => {
      const tokenCount = countTokens(textToTokenize)

      // Store in cache
      this.setCachedTokenCount(cacheKey, tokenCount)

      reqLogger.debug('Token count emulation complete', {
        tokenCount,
        textLength: textToTokenize.length,
        cacheHits: this.cacheHits,
        cacheMisses: this.cacheMisses,
        coalesced: this.coalesced,
      })

      return tokenCount
    })()

    // Register as in-flight
    this.setInFlightRequest(cacheKey, computePromise)

    try {
      const result = await computePromise
      return result
    } finally {
      // Clean up in-flight entry after completion
      this.inFlightRequests.delete(cacheKey)
    }
  }

  /**
   * Compute a hash key for the serialized text to use as cache key.
   * Uses SHA-256 for collision resistance while keeping keys compact.
   */
  private computeCacheKey(text: string): string {
    return createHash('sha256').update(text).digest('hex').substring(0, 32)
  }

  /**
   * Get a cached token count if it exists and hasn't expired.
   * Returns null if not found or expired.
   */
  private getCachedTokenCount(key: string): number | null {
    const entry = this.tokenCountCache.get(key)
    if (!entry) {
      return null
    }

    // Check TTL
    const now = Date.now()
    if (now - entry.timestamp > TOKEN_COUNT_CACHE_TTL_MS) {
      this.tokenCountCache.delete(key)
      return null
    }

    // Move to end of Map for LRU behavior (delete and re-add)
    this.tokenCountCache.delete(key)
    this.tokenCountCache.set(key, entry)

    return entry.tokenCount
  }

  /**
   * Store a token count in the cache.
   * Implements LRU eviction when cache exceeds max size.
   */
  private setCachedTokenCount(key: string, tokenCount: number): void {
    // Evict oldest entries if cache is full (LRU - Map maintains insertion order)
    while (this.tokenCountCache.size >= TOKEN_COUNT_CACHE_MAX_SIZE) {
      const firstKey = this.tokenCountCache.keys().next().value
      if (firstKey) {
        this.tokenCountCache.delete(firstKey)
      } else {
        break
      }
    }

    this.tokenCountCache.set(key, {
      tokenCount,
      timestamp: Date.now(),
    })
  }

  /**
   * Get an in-flight request promise if it exists and hasn't timed out.
   * Returns null if not found or expired.
   */
  private getInFlightRequest(key: string): Promise<number> | null {
    const entry = this.inFlightRequests.get(key)
    if (!entry) {
      return null
    }

    // Check timeout
    const now = Date.now()
    if (now - entry.timestamp > IN_FLIGHT_TIMEOUT_MS) {
      this.inFlightRequests.delete(key)
      return null
    }

    return entry.promise
  }

  /**
   * Register a computation as in-flight so parallel requests can wait for it.
   */
  private setInFlightRequest(key: string, promise: Promise<number>): void {
    this.inFlightRequests.set(key, {
      promise,
      timestamp: Date.now(),
    })
  }

  /**
   * Get cache statistics for monitoring.
   */
  getCacheStats(): {
    hits: number
    misses: number
    size: number
    hitRate: number
    coalesced: number
    inFlight: number
  } {
    const total = this.cacheHits + this.cacheMisses
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      size: this.tokenCountCache.size,
      hitRate: total > 0 ? this.cacheHits / total : 0,
      coalesced: this.coalesced,
      inFlight: this.inFlightRequests.size,
    }
  }

  /**
   * Clear the token count cache and in-flight requests.
   */
  clearCache(): void {
    this.tokenCountCache.clear()
    this.inFlightRequests.clear()
    this.cacheHits = 0
    this.cacheMisses = 0
    this.coalesced = 0
    logger.info('Token count cache cleared')
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
