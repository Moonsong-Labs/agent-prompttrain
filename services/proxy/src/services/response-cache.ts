import { logger } from '../middleware/logger.js'

interface CacheEntry<T> {
  data: T
  expiresAt: number
}

/**
 * Simple in-memory response cache with TTL for expensive API queries.
 * Prevents repeated execution of slow database queries on rapid page loads.
 */
export class ResponseCache {
  private cache = new Map<string, CacheEntry<unknown>>()
  private readonly maxEntries: number

  constructor(maxEntries = 200) {
    this.maxEntries = maxEntries
  }

  /**
   * Get a cached value if it exists and hasn't expired.
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key)
    if (!entry) {
      return null
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return null
    }

    return entry.data as T
  }

  /**
   * Cache a value with the given TTL in seconds.
   */
  set<T>(key: string, data: T, ttlSeconds: number): void {
    // Evict oldest entries if at capacity
    if (this.cache.size >= this.maxEntries) {
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) {
        this.cache.delete(firstKey)
      }
    }

    this.cache.set(key, {
      data,
      expiresAt: Date.now() + ttlSeconds * 1000,
    })
  }

  /**
   * Get a value from cache, or compute and cache it if missing/expired.
   */
  async getOrCompute<T>(key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key)
    if (cached !== null) {
      logger.debug('Cache hit', { metadata: { cacheKey: key } })
      return cached
    }

    const data = await compute()
    this.set(key, data, ttlSeconds)
    return data
  }

  /**
   * Clear all entries or entries matching a prefix.
   */
  clear(prefix?: string): void {
    if (!prefix) {
      this.cache.clear()
      return
    }

    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key)
      }
    }
  }

  get size(): number {
    return this.cache.size
  }
}

/** Shared cache instance for API responses */
export const apiResponseCache = new ResponseCache()
