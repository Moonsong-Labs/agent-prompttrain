import { Pool } from 'pg'
import { config } from '@agent-prompttrain/shared/config'
import { logger } from '../middleware/logger.js'
import { enableSqlLogging } from '../utils/sql-logger.js'

let pool: Pool | undefined

/**
 * Initialize the database pool
 * Should be called during application startup
 */
export async function initializePool(): Promise<Pool | undefined> {
  if (!config.storage.enabled || !config.database.url) {
    logger.info('Database storage disabled or not configured')
    return undefined
  }

  try {
    pool = new Pool({
      connectionString: config.database.url,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    })

    // Test the connection
    await pool.query('SELECT 1')
    logger.info('Database pool initialized successfully')

    pool.on('error', err => {
      logger.error('Unexpected database pool error', {
        error: { message: err.message, stack: err.stack },
      })
    })

    // Enable SQL logging
    pool = enableSqlLogging(pool, {
      logQueries: config.features.debug || process.env.DEBUG_SQL === 'true',
      logSlowQueries: true,
      slowQueryThreshold: Number(process.env.SLOW_QUERY_THRESHOLD_MS) || 5000,
      logStackTrace: config.features.debug,
    })

    return pool
  } catch (error) {
    logger.error('Failed to initialize database pool', {
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/**
 * Get the database pool
 * Returns undefined if not initialized
 */
export function getPool(): Pool | undefined {
  return pool
}

/**
 * Close the database pool
 * Should be called during application shutdown
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = undefined
    logger.info('Database pool closed')
  }
}
