import { Pool } from 'pg'
import { DecryptedAccount } from '@agent-prompttrain/shared'
import { hashApiKey } from '@agent-prompttrain/shared/utils/encryption'
import { ITrainRepository, SlackConfig } from './ITrainRepository'
import { DatabaseAccountRepository } from './DatabaseAccountRepository'
import { logger } from '../middleware/logger'

/**
 * Database-based implementation of ITrainRepository.
 *
 * Handles train-account mappings and train configuration stored in PostgreSQL.
 */
export class DatabaseTrainRepository implements ITrainRepository {
  private readonly accountRepo: DatabaseAccountRepository

  constructor(private readonly db: Pool) {
    this.accountRepo = new DatabaseAccountRepository(db)
  }

  async getAccountNamesForTrain(trainId: string): Promise<string[]> {
    try {
      const result = await this.db.query<{ account_name: string }>(
        `SELECT a.account_name
         FROM train_account_mappings tam
         JOIN accounts a ON tam.account_id = a.account_id
         WHERE tam.train_id = $1 AND a.is_active = true
         ORDER BY tam.priority DESC, a.account_name`,
        [trainId]
      )

      return result.rows.map(row => row.account_name)
    } catch (error) {
      logger.error('Failed to get account names for train', {
        trainId,
        error: error instanceof Error ? error.message : String(error),
      })
      // Return empty array on error - let authentication fall through to all accounts
      return []
    }
  }

  async getAccountsForTrain(trainId: string): Promise<DecryptedAccount[]> {
    const accountNames = await this.getAccountNamesForTrain(trainId)

    const accounts: DecryptedAccount[] = []
    for (const accountName of accountNames) {
      const account = await this.accountRepo.getAccountByName(accountName)
      if (account) {
        accounts.push(account)
      }
    }

    return accounts
  }

  async validateClientKey(trainId: string, clientKey: string): Promise<boolean> {
    try {
      // Hash the provided key
      const keyHash = hashApiKey(clientKey)

      // Query for matching hashed key in the train's client_api_keys_hashed array
      const result = await this.db.query<{ exists: boolean }>(
        `SELECT EXISTS (
          SELECT 1
          FROM trains
          WHERE train_id = $1
            AND is_active = true
            AND $2 = ANY(client_api_keys_hashed)
        ) as exists`,
        [trainId, keyHash]
      )

      return result.rows[0]?.exists || false
    } catch (error) {
      logger.error('Failed to validate client key', {
        trainId,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  async getSlackConfig(trainId: string): Promise<SlackConfig | null> {
    try {
      const result = await this.db.query<{ slack_config: any }>(
        'SELECT slack_config FROM trains WHERE train_id = $1 AND is_active = true',
        [trainId]
      )

      if (result.rowCount === 0 || !result.rows[0].slack_config) {
        return null
      }

      const config = result.rows[0].slack_config as Record<string, unknown>
      return {
        webhook_url: config.webhook_url as string | undefined,
        channel: config.channel as string | undefined,
        username: config.username as string | undefined,
        icon_emoji: config.icon_emoji as string | undefined,
        enabled: config.enabled !== false, // Default to enabled if not specified
      }
    } catch (error) {
      logger.error('Failed to get Slack config for train', {
        trainId,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }
}
