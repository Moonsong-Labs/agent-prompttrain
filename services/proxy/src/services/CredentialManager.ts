/**
 * CredentialManager - Manages credential caching and lifecycle
 *
 * This class encapsulates credential caching logic and provides
 * lifecycle management for cleanup operations. It replaces the
 * global state and setInterval from credentials.ts.
 *
 * Note: This class is now primarily used for OAuth token refresh
 * management (tracking active refreshes, failures, metrics).
 * Credential data itself is stored in the database.
 */

interface FailedRefresh {
  timestamp: number
  error: string
}

interface RefreshMetrics {
  attempts: number
  successes: number
  failures: number
  concurrentWaits: number
  totalRefreshTime: number
}

export class CredentialManager {
  // Refresh token management
  private activeRefreshes = new Map<string, Promise<string | null>>()
  private refreshTimestamps = new Map<string, number>()
  private failedRefreshCache = new Map<string, FailedRefresh>()
  private readonly FAILED_REFRESH_COOLDOWN = 5000 // 5 seconds
  private readonly REFRESH_TIMEOUT = 60000 // 1 minute

  // Metrics
  private refreshMetrics: RefreshMetrics = {
    attempts: 0,
    successes: 0,
    failures: 0,
    concurrentWaits: 0,
    totalRefreshTime: 0,
  }

  // Cleanup interval handle
  private cleanupIntervalId?: NodeJS.Timeout
  private readonly CLEANUP_INTERVAL = 300000 // 5 minutes

  constructor() {
    // No-op constructor - cache removed, using database for credentials
  }

  /**
   * Get active refresh promise for a credential
   */
  getActiveRefresh(credentialPath: string): Promise<string | null> | undefined {
    return this.activeRefreshes.get(credentialPath)
  }

  /**
   * Set active refresh promise
   */
  setActiveRefresh(credentialPath: string, promise: Promise<string | null>): void {
    this.activeRefreshes.set(credentialPath, promise)
    this.refreshTimestamps.set(credentialPath, Date.now())
  }

  /**
   * Remove active refresh
   */
  removeActiveRefresh(credentialPath: string): void {
    this.activeRefreshes.delete(credentialPath)
    this.refreshTimestamps.delete(credentialPath)
  }

  /**
   * Check if refresh recently failed
   */
  hasRecentFailure(credentialPath: string): { failed: boolean; error?: string } {
    const failedRefresh = this.failedRefreshCache.get(credentialPath)
    if (failedRefresh && Date.now() - failedRefresh.timestamp < this.FAILED_REFRESH_COOLDOWN) {
      return { failed: true, error: failedRefresh.error }
    }
    return { failed: false }
  }

  /**
   * Record a failed refresh
   */
  recordFailedRefresh(credentialPath: string, error: string): void {
    this.failedRefreshCache.set(credentialPath, {
      timestamp: Date.now(),
      error,
    })
  }

  /**
   * Update refresh metrics
   */
  updateMetrics(event: 'attempt' | 'success' | 'failure' | 'concurrent', duration?: number): void {
    switch (event) {
      case 'attempt':
        this.refreshMetrics.attempts++
        break
      case 'success':
        this.refreshMetrics.successes++
        if (duration) {
          this.refreshMetrics.totalRefreshTime += duration
        }
        break
      case 'failure':
        this.refreshMetrics.failures++
        break
      case 'concurrent':
        this.refreshMetrics.concurrentWaits++
        break
    }
  }

  /**
   * Get current refresh metrics
   */
  getRefreshMetrics() {
    return {
      ...this.refreshMetrics,
      currentActiveRefreshes: this.activeRefreshes.size,
      currentFailedRefreshes: this.failedRefreshCache.size,
    }
  }

  /**
   * Start periodic cleanup (for long-running services)
   */
  startPeriodicCleanup(): void {
    if (this.cleanupIntervalId) {
      return // Already running
    }

    this.cleanupIntervalId = setInterval(() => {
      this.performCleanup()
    }, this.CLEANUP_INTERVAL)

    // Don't let the interval prevent process exit in Node.js
    if (this.cleanupIntervalId.unref) {
      this.cleanupIntervalId.unref()
    }
  }

  /**
   * Stop periodic cleanup (for graceful shutdown)
   */
  stopPeriodicCleanup(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId)
      this.cleanupIntervalId = undefined
    }
  }

  /**
   * Perform cleanup of expired entries
   */
  private performCleanup(): void {
    const now = Date.now()

    // Clean stuck refresh operations
    for (const [key, timestamp] of this.refreshTimestamps.entries()) {
      if (now - timestamp > this.REFRESH_TIMEOUT) {
        console.warn(
          `Cleaning up stuck refresh operation for ${key} (timed out after ${this.REFRESH_TIMEOUT}ms)`
        )
        this.activeRefreshes.delete(key)
        this.refreshTimestamps.delete(key)
      }
    }

    // Clean expired failed refresh entries
    for (const [key, failure] of this.failedRefreshCache.entries()) {
      if (now - failure.timestamp > this.FAILED_REFRESH_COOLDOWN) {
        this.failedRefreshCache.delete(key)
      }
    }

    // Log metrics periodically
    if (this.refreshMetrics.attempts > 0) {
      console.warn('OAuth refresh metrics:', {
        attempts: this.refreshMetrics.attempts,
        successes: this.refreshMetrics.successes,
        failures: this.refreshMetrics.failures,
        successRate:
          ((this.refreshMetrics.successes / this.refreshMetrics.attempts) * 100).toFixed(2) + '%',
        avgRefreshTime:
          (this.refreshMetrics.totalRefreshTime / this.refreshMetrics.attempts).toFixed(0) + 'ms',
        currentActiveRefreshes: this.activeRefreshes.size,
      })
    }
  }

  /**
   * Perform immediate cleanup (useful for scripts)
   */
  cleanup(): void {
    this.performCleanup()
  }
}
