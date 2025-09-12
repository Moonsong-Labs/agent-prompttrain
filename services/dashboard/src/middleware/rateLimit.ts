import { Context, Next } from 'hono'

interface RateLimitRecord {
  count: number
  resetAt: number
}

/**
 * Simple in-memory rate limiter middleware
 * @param max Maximum requests allowed
 * @param windowMs Time window in milliseconds
 * @returns Middleware function
 */
export function rateLimit(max: number, windowMs: number) {
  const hits = new Map<string, RateLimitRecord>()

  return async (c: Context, next: Next) => {
    // Get client IP
    const ip =
      c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
      c.req.header('cf-connecting-ip') ||
      c.req.header('x-real-ip') ||
      'unknown'

    const now = Date.now()

    // Get or create rate limit record
    let record = hits.get(ip)
    if (!record || record.resetAt <= now) {
      record = { count: 0, resetAt: now + windowMs }
    }

    record.count++
    hits.set(ip, record)

    // Clean up old entries periodically (every 100 requests)
    if (hits.size > 100) {
      for (const [key, value] of hits.entries()) {
        if (value.resetAt <= now) {
          hits.delete(key)
        }
      }
    }

    // Check if rate limit exceeded
    if (record.count > max) {
      // Set rate limit headers
      c.header('X-RateLimit-Limit', max.toString())
      c.header('X-RateLimit-Remaining', '0')
      c.header('X-RateLimit-Reset', Math.floor(record.resetAt / 1000).toString())
      c.header('Retry-After', Math.ceil((record.resetAt - now) / 1000).toString())

      return c.text('Too Many Requests', 429)
    }

    // Set rate limit headers
    c.header('X-RateLimit-Limit', max.toString())
    c.header('X-RateLimit-Remaining', (max - record.count).toString())
    c.header('X-RateLimit-Reset', Math.floor(record.resetAt / 1000).toString())

    return next()
  }
}

/**
 * Strict rate limiter for authentication endpoints
 * 10 requests per 10 minutes by default
 */
export const authRateLimit = rateLimit(10, 10 * 60 * 1000)

/**
 * More lenient rate limiter for OAuth callbacks
 * 20 requests per 10 minutes by default
 */
export const callbackRateLimit = rateLimit(20, 10 * 60 * 1000)
