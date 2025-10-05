import { Pool } from 'pg'
import { config } from '@agent-prompttrain/shared/config'
import { IAccountRepository } from './IAccountRepository'
import { ITrainRepository } from './ITrainRepository'
import { FilesystemAccountRepository } from './FilesystemAccountRepository'
import { FilesystemTrainRepository } from './FilesystemTrainRepository'
import { DatabaseAccountRepository } from './DatabaseAccountRepository'
import { DatabaseTrainRepository } from './DatabaseTrainRepository'
import { logger } from '../middleware/logger'

export interface Repositories {
  accountRepository: IAccountRepository
  trainRepository: ITrainRepository
}

/**
 * Factory function to create repository implementations based on configuration.
 *
 * Uses the USE_DATABASE_CREDENTIALS feature flag to switch between
 * filesystem-based and database-based credential storage.
 *
 * @param dbPool - PostgreSQL connection pool (required for database mode)
 * @param accountsDir - Directory for filesystem account credentials
 * @param clientKeysDir - Directory for filesystem client keys
 * @returns Repository implementations
 */
export function createRepositories(
  dbPool: Pool | undefined,
  accountsDir: string,
  clientKeysDir: string
): Repositories {
  const useDatabaseStorage = config.credentials.useDatabaseStorage

  logger.info('Creating credential repositories', {
    metadata: {
      mode: useDatabaseStorage ? 'database' : 'filesystem',
      accountsDir: useDatabaseStorage ? undefined : accountsDir,
      clientKeysDir: useDatabaseStorage ? undefined : clientKeysDir,
    },
  })

  if (useDatabaseStorage) {
    // Database mode
    if (!dbPool) {
      throw new Error('Database pool is required when USE_DATABASE_CREDENTIALS=true')
    }

    return {
      accountRepository: new DatabaseAccountRepository(dbPool),
      trainRepository: new DatabaseTrainRepository(dbPool),
    }
  }

  // Filesystem mode (default)
  return {
    accountRepository: new FilesystemAccountRepository(accountsDir),
    trainRepository: new FilesystemTrainRepository(clientKeysDir),
  }
}
