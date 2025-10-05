import { Pool } from 'pg'
import { IAccountRepository } from './IAccountRepository'
import { ITrainRepository } from './ITrainRepository'
import { DatabaseAccountRepository } from './DatabaseAccountRepository'
import { DatabaseTrainRepository } from './DatabaseTrainRepository'
import { logger } from '../middleware/logger'

export interface Repositories {
  accountRepository: IAccountRepository
  trainRepository: ITrainRepository
}

/**
 * Factory function to create repository implementations.
 *
 * Creates database-backed credential repositories as per ADR-026.
 * Filesystem credential storage has been removed.
 *
 * @param dbPool - PostgreSQL connection pool (required)
 * @returns Repository implementations
 */
export function createRepositories(dbPool: Pool): Repositories {
  if (!dbPool) {
    throw new Error('Database pool is required for credential storage (ADR-026)')
  }

  logger.info('Creating credential repositories', {
    metadata: {
      mode: 'database',
    },
  })

  return {
    accountRepository: new DatabaseAccountRepository(dbPool),
    trainRepository: new DatabaseTrainRepository(dbPool),
  }
}
