/**
 * Scheduler for periodic GitHub synchronization
 */

import type { GitHubSyncService } from './GitHubSyncService.js'
import { config, getErrorMessage, getErrorStack, getErrorCode } from '@agent-prompttrain/shared'
import { logger } from '../middleware/logger.js'

export class SyncScheduler {
  private intervalId?: NodeJS.Timer
  private isRunning = false

  constructor(private syncService: GitHubSyncService) {}

  start(): void {
    if (this.intervalId) {
      logger.info('Sync scheduler is already running')
      return
    }

    const intervalMs = config.mcp.sync.interval * 1000

    logger.info(`Starting MCP sync scheduler (interval: ${config.mcp.sync.interval}s)`)

    // Run initial sync
    this.runSync()

    // Schedule periodic syncs
    this.intervalId = setInterval(() => {
      this.runSync()
    }, intervalMs)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
      logger.info('MCP sync scheduler stopped')
    }
  }

  private async runSync(): Promise<void> {
    if (this.isRunning) {
      logger.info('Sync already in progress, skipping...')
      return
    }

    this.isRunning = true

    try {
      logger.info('Running scheduled MCP sync...')
      await this.syncService.syncRepository()
    } catch (error) {
      logger.error('Scheduled sync failed', {
        error: {
          message: getErrorMessage(error),
          stack: getErrorStack(error),
          code: getErrorCode(error),
        },
      })
    } finally {
      this.isRunning = false
    }
  }

  async triggerSync(): Promise<void> {
    if (this.isRunning) {
      throw new Error('Sync already in progress')
    }

    await this.runSync()
  }
}
