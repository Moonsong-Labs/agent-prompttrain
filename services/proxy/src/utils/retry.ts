import { logger } from '../middleware/logger'
import { TimeoutError, UpstreamError } from '../types/errors'

// Retry configuration
export interface RetryConfig {
  maxAttempts: number
  initialDelay: number
  maxDelay: number
  factor: number
  jitter: boolean
  timeout?: number
  retryCondition?: (error: Error) => boolean
}

// Default retry configuration
export const defaultRetryConfig: RetryConfig = {
  maxAttempts: 3,
  initialDelay: 1000, // 1 second
  maxDelay: 30000, // 30 seconds
  factor: 2, // Exponential backoff factor
  jitter: true, // Add randomness to prevent thundering herd
  timeout: 60000, // 60 seconds total timeout
  retryCondition: isRetryableError,
}

// Check if error is retryable
export function isRetryableError(error: Error): boolean {
  // Network errors
  if (
    error.message.includes('ECONNREFUSED') ||
    error.message.includes('ETIMEDOUT') ||
    error.message.includes('ENOTFOUND') ||
    error.message.includes('ENETUNREACH') ||
    error.message.includes('ECONNRESET') ||
    error.message.includes('EPIPE')
  ) {
    return true
  }

  // Timeout errors
  if (error instanceof TimeoutError) {
    return true
  }

  // Upstream errors (5xx)
  if (error instanceof UpstreamError) {
    return true
  }

  // HTTP status codes
  if ('statusCode' in error) {
    const status = (error as any).statusCode
    // Retry on 429 (rate limit), 502 (bad gateway), 503 (service unavailable), 504 (gateway timeout)
    if (status === 429 || status === 502 || status === 503 || status === 504) {
      return true
    }
  }

  // Claude API specific errors
  if (error.message.includes('overloaded_error') || error.message.includes('rate_limit_error')) {
    return true
  }

  return false
}

// Calculate delay with exponential backoff
export function calculateDelay(attempt: number, config: RetryConfig): number {
  // Calculate base delay with exponential backoff
  let delay = Math.min(config.initialDelay * Math.pow(config.factor, attempt - 1), config.maxDelay)

  // Add jitter to prevent thundering herd
  if (config.jitter) {
    // Random jitter between 0% and 50% of the delay
    const jitter = delay * Math.random() * 0.5
    delay = delay + jitter
  }

  return Math.floor(delay)
}

// Sleep helper
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Retry with exponential backoff
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  context?: { requestId?: string; operation?: string }
): Promise<T> {
  const finalConfig = { ...defaultRetryConfig, ...config }
  const startTime = Date.now()
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= finalConfig.maxAttempts; attempt++) {
    try {
      // Check total timeout
      if (finalConfig.timeout && Date.now() - startTime > finalConfig.timeout) {
        throw new TimeoutError('Retry timeout exceeded', {
          attempts: attempt - 1,
          elapsed: Date.now() - startTime,
        })
      }

      // Execute function
      const result = await fn()

      // Success - log if this was a retry
      if (attempt > 1) {
        logger.info('Retry succeeded', {
          requestId: context?.requestId,
          metadata: {
            operation: context?.operation,
            attempt,
            totalTime: Date.now() - startTime,
          },
        })
      }

      return result
    } catch (error) {
      lastError = error as Error

      // Check if we should retry
      const shouldRetry = finalConfig.retryCondition!(error as Error)
      const isLastAttempt = attempt === finalConfig.maxAttempts

      if (!shouldRetry || isLastAttempt) {
        logger.warn('Retry failed - not retryable or max attempts reached', {
          requestId: context?.requestId,
          metadata: {
            operation: context?.operation,
            attempt,
            maxAttempts: finalConfig.maxAttempts,
            error: error instanceof Error ? error.message : String(error),
            retryable: shouldRetry,
          },
        })
        throw error
      }

      // Calculate delay
      const delay = calculateDelay(attempt, finalConfig)

      logger.info('Retrying after error', {
        requestId: context?.requestId,
        metadata: {
          operation: context?.operation,
          attempt,
          nextAttempt: attempt + 1,
          delay,
          error: error instanceof Error ? error.message : String(error),
          errorType: error instanceof Error ? error.constructor.name : typeof error,
        },
      })

      // Wait before retry
      await sleep(delay)
    }
  }

  // Should never reach here, but TypeScript needs this
  throw lastError || new Error('Retry failed')
}

// Retry configuration for different scenarios
export const retryConfigs = {
  // Fast retry for transient errors
  fast: {
    maxAttempts: 3,
    initialDelay: 100,
    maxDelay: 1000,
    factor: 2,
    jitter: true,
  },

  // Standard retry for most operations
  standard: defaultRetryConfig,

  // Aggressive retry for critical operations
  aggressive: {
    maxAttempts: 5,
    initialDelay: 500,
    maxDelay: 60000,
    factor: 2,
    jitter: true,
    timeout: 610000, // 10 minutes + 10 seconds (allows one full 10-minute attempt)
  },

  // Specific for Claude API rate limits
  rateLimit: {
    maxAttempts: 5,
    initialDelay: 5000, // Start with 5 seconds
    maxDelay: 60000, // Max 1 minute
    factor: 1.5, // Slower backoff
    jitter: true,
    retryCondition: (error: Error) => {
      return (
        error.message.includes('rate_limit') ||
        ('statusCode' in error && (error as any).statusCode === 429)
      )
    },
  },
}

// Helper to extract retry-after header
export function getRetryAfter(error: any): number | null {
  if (error.response?.headers) {
    const retryAfter = error.response.headers['retry-after']
    if (retryAfter) {
      // Parse as seconds
      const seconds = parseInt(retryAfter)
      if (!isNaN(seconds)) {
        return seconds * 1000 // Convert to milliseconds
      }

      // Parse as HTTP date
      const date = new Date(retryAfter)
      if (!isNaN(date.getTime())) {
        return Math.max(0, date.getTime() - Date.now())
      }
    }
  }

  return null
}

// Create a retry wrapper with rate limit awareness
export function createRateLimitAwareRetry(
  baseConfig: Partial<RetryConfig> = {}
): <T>(fn: () => Promise<T>, context?: any) => Promise<T> {
  return async function retryWrapper<T>(fn: () => Promise<T>, context?: any): Promise<T> {
    const config = { ...retryConfigs.standard, ...baseConfig }

    // Override retry condition to respect retry-after
    const originalCondition = config.retryCondition!
    config.retryCondition = (error: Error) => {
      if (!originalCondition(error)) {
        return false
      }

      // Check for retry-after header
      const retryAfter = getRetryAfter(error)
      if (retryAfter !== null) {
        // Adjust initial delay based on retry-after
        config.initialDelay = Math.max(config.initialDelay, retryAfter)
      }

      return true
    }

    return retryWithBackoff(fn, config, context)
  }
}
