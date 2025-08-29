import { Context, Next } from 'hono'
import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible'
import { logger } from './logger.js'
// import { container } from '../container.js'
import { config } from '@agent-prompttrain/shared/config'

// Different rate limiters for different operations
let analysisCreationLimiter: RateLimiterMemory | RateLimiterRedis
let analysisRetrievalLimiter: RateLimiterMemory | RateLimiterRedis

// Initialize rate limiters
export function initializeAnalysisRateLimiters() {
  // For now, use in-memory rate limiting
  // TODO: Switch to Redis when available for distributed rate limiting

  // Analysis creation - expensive operation (15 per minute per user)
  analysisCreationLimiter = new RateLimiterMemory({
    keyPrefix: 'rate_limit_analysis_create',
    points: config.aiAnalysis?.rateLimits?.creation || 15,
    duration: 60, // 60 seconds
    blockDuration: 60, // Block for 60 seconds after limit exceeded
  })

  // Analysis retrieval - cheap operation (100 per minute per user)
  analysisRetrievalLimiter = new RateLimiterMemory({
    keyPrefix: 'rate_limit_analysis_retrieve',
    points: config.aiAnalysis?.rateLimits?.retrieval || 100,
    duration: 60, // 60 seconds
    blockDuration: 60, // Block for 60 seconds after limit exceeded
  })

  logger.info('Analysis rate limiters initialized', {
    metadata: {
      creationLimit: config.aiAnalysis?.rateLimits?.creation || 15,
      retrievalLimit: config.aiAnalysis?.rateLimits?.retrieval || 100,
    },
  })
}

// Middleware for rate limiting analysis creation
export function rateLimitAnalysisCreation() {
  return async (c: Context, next: Next) => {
    const requestId = c.get('requestId')
    const domain = c.get('domain')

    if (!analysisCreationLimiter) {
      initializeAnalysisRateLimiters()
    }

    try {
      // Use domain as the key for rate limiting
      // This ensures rate limits are per-domain (tenant)
      const key = domain || 'unknown'

      await analysisCreationLimiter.consume(key)

      logger.debug('Analysis creation rate limit check passed', {
        requestId,
        domain,
      })

      await next()
    } catch (rejRes) {
      // Rate limit exceeded
      logger.warn('Analysis creation rate limit exceeded', {
        requestId,
        domain,
        metadata: {
          remainingPoints:
            (rejRes as { remainingPoints?: number; msBeforeNext?: number }).remainingPoints || 0,
          msBeforeNext:
            (rejRes as { remainingPoints?: number; msBeforeNext?: number }).msBeforeNext || 0,
        },
      })

      const retryAfter = Math.round(
        ((rejRes as { remainingPoints?: number; msBeforeNext?: number }).msBeforeNext || 60000) /
          1000
      )

      return c.json(
        {
          error: {
            type: 'rate_limit_error',
            message: 'Too many analysis requests. Please try again later.',
            retry_after: retryAfter,
          },
        },
        429,
        {
          'Retry-After': retryAfter.toString(),
          'X-RateLimit-Limit': analysisCreationLimiter.points.toString(),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': new Date(
            Date.now() +
              ((rejRes as { remainingPoints?: number; msBeforeNext?: number }).msBeforeNext ||
                60000)
          ).toISOString(),
        }
      )
    }
  }
}

// Middleware for rate limiting analysis retrieval
export function rateLimitAnalysisRetrieval() {
  return async (c: Context, next: Next) => {
    const requestId = c.get('requestId')
    const domain = c.get('domain')

    if (!analysisRetrievalLimiter) {
      initializeAnalysisRateLimiters()
    }

    try {
      // Use domain as the key for rate limiting
      const key = domain || 'unknown'

      await analysisRetrievalLimiter.consume(key)

      logger.debug('Analysis retrieval rate limit check passed', {
        requestId,
        domain,
      })

      await next()
    } catch (rejRes) {
      // Rate limit exceeded
      logger.warn('Analysis retrieval rate limit exceeded', {
        requestId,
        domain,
        metadata: {
          remainingPoints:
            (rejRes as { remainingPoints?: number; msBeforeNext?: number }).remainingPoints || 0,
          msBeforeNext:
            (rejRes as { remainingPoints?: number; msBeforeNext?: number }).msBeforeNext || 0,
        },
      })

      const retryAfter = Math.round(
        ((rejRes as { remainingPoints?: number; msBeforeNext?: number }).msBeforeNext || 60000) /
          1000
      )

      return c.json(
        {
          error: {
            type: 'rate_limit_error',
            message: 'Too many requests. Please try again later.',
            retry_after: retryAfter,
          },
        },
        429,
        {
          'Retry-After': retryAfter.toString(),
          'X-RateLimit-Limit': analysisRetrievalLimiter.points.toString(),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': new Date(
            Date.now() +
              ((rejRes as { remainingPoints?: number; msBeforeNext?: number }).msBeforeNext ||
                60000)
          ).toISOString(),
        }
      )
    }
  }
}

// Helper to get current rate limit status
export async function getRateLimitStatus(domain: string, limiterType: 'creation' | 'retrieval') {
  const limiter = limiterType === 'creation' ? analysisCreationLimiter : analysisRetrievalLimiter

  if (!limiter) {
    return null
  }

  try {
    const res = await limiter.get(domain)
    return {
      remainingPoints: res ? limiter.points - res.consumedPoints : limiter.points,
      totalPoints: limiter.points,
      resetAt: res ? new Date(res.msBeforeNext + Date.now()) : null,
    }
  } catch (error) {
    logger.error('Error getting rate limit status', {
      error,
      metadata: { domain, limiterType },
    })
    return null
  }
}
