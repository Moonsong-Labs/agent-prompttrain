import { Pool } from 'pg'
import { StorageReader } from './storage/reader.js'
import { ProxyApiClient } from './services/api-client.js'
import { logger } from './middleware/logger.js'
import { config } from '@agent-prompttrain/shared/config'

/**
 * Dependency injection container for the dashboard service
 */
class Container {
  private pool?: Pool
  private storageReader?: StorageReader
  private apiClient!: ProxyApiClient

  constructor() {
    this.initializeServices()
  }

  private initializeServices(): void {
    // Initialize API client
    const proxyUrl = process.env.PROXY_API_URL || 'http://proxy:3000'
    this.apiClient = new ProxyApiClient(proxyUrl)
    logger.info('Dashboard initialized with Proxy API client', { proxyUrl })

    // Keep database initialization for now (will be removed in Phase 3)
    const databaseUrl = config.database.url || this.buildDatabaseUrl()

    if (databaseUrl) {
      this.pool = new Pool({
        connectionString: databaseUrl,
        max: 10, // Dashboard needs fewer connections
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
      })

      this.pool.on('error', err => {
        logger.error('Unexpected database pool error', { error: { message: err.message } })
      })

      this.storageReader = new StorageReader(this.pool)
    }
    // Database is now optional - dashboard can work with just API
  }

  private buildDatabaseUrl(): string | undefined {
    const { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD } = process.env

    if (DB_HOST && DB_NAME && DB_USER) {
      const port = DB_PORT || '5432'
      const password = DB_PASSWORD ? `:${DB_PASSWORD}` : ''
      return `postgresql://${DB_USER}${password}@${DB_HOST}:${port}/${DB_NAME}`
    }

    return undefined
  }

  getPool(): Pool {
    if (!this.pool) {
      throw new Error('Database pool not initialized')
    }
    return this.pool
  }

  getStorageService(): StorageReader {
    if (!this.storageReader) {
      throw new Error('StorageReader not initialized')
    }
    return this.storageReader
  }

  getApiClient(): ProxyApiClient {
    return this.apiClient
  }

  async cleanup(): Promise<void> {
    if (this.pool) {
      await this.pool.end()
    }
  }
}

// Create singleton instance
export const container = new Container()
