import { Context, Next } from 'hono'
import { RateLimitError, MSL_TRAIN_ID_HEADER_LOWER } from '@agent-prompttrain/shared'
import { getRequestLogger } from './logger'

// Rate limit configuration
interface RateLimitConfig {
  windowMs: number // Time window in milliseconds
  maxRequests: number // Max requests per window
  maxTokens: number // Max tokens per window
  keyGenerator: (c: Context) => string // Function to generate rate limit key
  skipSuccessfulRequests?: boolean // Don't count successful requests
  skipFailedRequests?: boolean // Don't count failed requests
}

// Rate limit store entry
interface RateLimitEntry {
  requests: number
  tokens: number
  windowStart: number
  blocked: boolean
  blockExpiry?: number
}

// In-memory rate limit store (use Redis in production)
class RateLimitStore {
  private store = new Map<string, RateLimitEntry>()
  private cleanupInterval: NodeJS.Timeout

  constructor() {
    // Clean up expired entries every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000)
  }

  get(key: string): RateLimitEntry | undefined {
    return this.store.get(key)
  }

  set(key: string, entry: RateLimitEntry): void {
    this.store.set(key, entry)
  }

  delete(key: string): void {
    this.store.delete(key)
  }

  cleanup(): void {
    const now = Date.now()
    for (const [key, entry] of this.store.entries()) {
      // Remove entries older than 2x the window
      if (now - entry.windowStart > 2 * 3600000) {
        // 2 hours
        this.store.delete(key)
      }
    }
  }

  close(): void {
    clearInterval(this.cleanupInterval)
  }
}

// Global rate limit stores
const apiKeyStore = new RateLimitStore()
const trainStore = new RateLimitStore()

// Default configurations
const defaultApiKeyConfig: RateLimitConfig = {
  windowMs: 3600000, // 1 hour
  maxRequests: 1000, // 1000 requests per hour
  maxTokens: 1000000, // 1M tokens per hour
  keyGenerator: c => {
    const apiKey =
      c.req.header('x-api-key') ||
      c.req.header('authorization')?.replace('Bearer ', '') ||
      'default'
    return `api:${apiKey.substring(0, 10)}`
  },
}

const defaultTrainConfig: RateLimitConfig = {
  windowMs: 3600000, // 1 hour
  maxRequests: 5000, // 5000 requests per hour
  maxTokens: 5000000, // 5M tokens per hour
  keyGenerator: c => {
    const trainId = c.get('trainId') || c.req.header(MSL_TRAIN_ID_HEADER_LOWER) || 'unknown'
    return `train:${trainId}`
  },
}

// Rate limiting middleware factory
export function createRateLimiter(config: Partial<RateLimitConfig> = {}) {
  const finalConfig = { ...defaultApiKeyConfig, ...config }

  return async (c: Context, next: Next) => {
    const logger = getRequestLogger(c)
    const key = finalConfig.keyGenerator(c)
    const now = Date.now()

    // Get or create rate limit entry
    let entry = apiKeyStore.get(key)

    if (!entry || now - entry.windowStart >= finalConfig.windowMs) {
      // Create new window
      entry = {
        requests: 0,
        tokens: 0,
        windowStart: now,
        blocked: false,
      }
      apiKeyStore.set(key, entry)
    }

    // Check if currently blocked
    if (entry.blocked && entry.blockExpiry && now < entry.blockExpiry) {
      const retryAfter = Math.ceil((entry.blockExpiry - now) / 1000)
      logger.warn('Rate limit exceeded - blocked', {
        key,
        retryAfter,
        requests: entry.requests,
        maxRequests: finalConfig.maxRequests,
      })

      c.header('X-RateLimit-Limit', String(finalConfig.maxRequests))
      c.header('X-RateLimit-Remaining', '0')
      c.header('X-RateLimit-Reset', String(Math.ceil(entry.blockExpiry / 1000)))
      c.header('Retry-After', String(retryAfter))

      throw new RateLimitError('Rate limit exceeded', retryAfter)
    }

    // Check request count
    if (entry.requests >= finalConfig.maxRequests) {
      entry.blocked = true
      entry.blockExpiry = entry.windowStart + finalConfig.windowMs

      const retryAfter = Math.ceil((entry.blockExpiry - now) / 1000)
      logger.warn('Rate limit exceeded - request count', {
        key,
        requests: entry.requests,
        maxRequests: finalConfig.maxRequests,
        retryAfter,
      })

      c.header('X-RateLimit-Limit', String(finalConfig.maxRequests))
      c.header('X-RateLimit-Remaining', '0')
      c.header('X-RateLimit-Reset', String(Math.ceil(entry.blockExpiry / 1000)))
      c.header('Retry-After', String(retryAfter))

      throw new RateLimitError('Rate limit exceeded', retryAfter)
    }

    // Increment request count
    entry.requests++

    // Set rate limit headers
    const remaining = Math.max(0, finalConfig.maxRequests - entry.requests)
    const reset = Math.ceil((entry.windowStart + finalConfig.windowMs) / 1000)

    c.header('X-RateLimit-Limit', String(finalConfig.maxRequests))
    c.header('X-RateLimit-Remaining', String(remaining))
    c.header('X-RateLimit-Reset', String(reset))

    // Store entry reference for token counting
    c.set('rateLimitEntry', entry)
    c.set('rateLimitConfig', finalConfig)

    try {
      await next()

      // Update token count after successful request
      const inputTokens = c.get('inputTokens') || 0
      const outputTokens = c.get('outputTokens') || 0
      entry.tokens += inputTokens + outputTokens

      // Check token limit
      if (entry.tokens > finalConfig.maxTokens) {
        logger.warn('Token limit exceeded', {
          key,
          tokens: entry.tokens,
          maxTokens: finalConfig.maxTokens,
        })
        // Mark for blocking on next request
        entry.blocked = true
        entry.blockExpiry = entry.windowStart + finalConfig.windowMs
      }
    } catch (error) {
      // Handle based on skip configuration
      if (finalConfig.skipFailedRequests) {
        entry.requests--
      }
      throw error
    }
  }
}

// Train-based rate limiter
export function createTrainRateLimiter(config: Partial<RateLimitConfig> = {}) {
  const finalConfig = {
    ...defaultTrainConfig,
    ...config,
    keyGenerator: config.keyGenerator ?? defaultTrainConfig.keyGenerator,
  }

  return async (c: Context, next: Next) => {
    const logger = getRequestLogger(c)
    const key = finalConfig.keyGenerator(c)
    const now = Date.now()

    let entry = trainStore.get(key)

    if (!entry || now - entry.windowStart >= finalConfig.windowMs) {
      entry = {
        requests: 0,
        tokens: 0,
        windowStart: now,
        blocked: false,
      }
      trainStore.set(key, entry)
    }

    if (entry.blocked && entry.blockExpiry && now < entry.blockExpiry) {
      const retryAfter = Math.ceil((entry.blockExpiry - now) / 1000)
      logger.warn('Train rate limit exceeded', {
        key,
        retryAfter,
      })

      throw new RateLimitError('Train rate limit exceeded', retryAfter)
    }

    if (entry.requests >= finalConfig.maxRequests) {
      entry.blocked = true
      entry.blockExpiry = entry.windowStart + finalConfig.windowMs

      const retryAfter = Math.ceil((entry.blockExpiry - now) / 1000)
      logger.warn('Train rate limit exceeded', {
        key,
        requests: entry.requests,
        maxRequests: finalConfig.maxRequests,
      })

      throw new RateLimitError('Train rate limit exceeded', retryAfter)
    }

    entry.requests++

    await next()

    // Update token count
    const inputTokens = c.get('inputTokens') || 0
    const outputTokens = c.get('outputTokens') || 0
    entry.tokens += inputTokens + outputTokens

    if (entry.tokens > finalConfig.maxTokens) {
      entry.blocked = true
      entry.blockExpiry = entry.windowStart + finalConfig.windowMs
    }
  }
}

// Helper to get current rate limit status
export function getRateLimitStatus(c: Context): {
  limit: number
  remaining: number
  reset: number
  tokens: number
} | null {
  const entry = c.get('rateLimitEntry') as RateLimitEntry | undefined
  const config = c.get('rateLimitConfig') as RateLimitConfig | undefined

  if (!entry || !config) {
    return null
  }

  return {
    limit: config.maxRequests,
    remaining: Math.max(0, config.maxRequests - entry.requests),
    reset: Math.ceil((entry.windowStart + config.windowMs) / 1000),
    tokens: entry.tokens,
  }
}

// Cleanup function for graceful shutdown
export function closeRateLimitStores(): void {
  apiKeyStore.close()
  trainStore.close()
}
