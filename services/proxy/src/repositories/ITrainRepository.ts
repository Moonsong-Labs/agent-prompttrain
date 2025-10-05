import { DecryptedAccount } from '@agent-prompttrain/shared'

/**
 * Slack configuration for a train.
 * Moved from accounts to trains per ADR-026.
 */
export interface SlackConfig {
  webhook_url?: string
  channel?: string
  username?: string
  icon_emoji?: string
  enabled?: boolean
}

/**
 * Repository interface for train-specific operations.
 *
 * Handles train-account mappings and train configuration.
 */
export interface ITrainRepository {
  /**
   * Get all account names mapped to a specific train.
   * Returns accounts in priority order (highest priority first).
   *
   * @param trainId - The train identifier
   * @returns Array of account names in priority order
   */
  getAccountNamesForTrain(trainId: string): Promise<string[]>

  /**
   * Get all decrypted accounts for a train.
   * Returns accounts in priority order for deterministic selection.
   *
   * @param trainId - The train identifier
   * @returns Array of decrypted accounts in priority order
   */
  getAccountsForTrain(trainId: string): Promise<DecryptedAccount[]>

  /**
   * Get the hashed client API keys for a train.
   * Returns SHA-256 hashes (hex-encoded) for comparison.
   *
   * @param trainId - The train identifier
   * @returns Array of SHA-256 hashed client API keys (hex strings)
   */
  getClientApiKeysHashed(trainId: string): Promise<string[]>

  /**
   * Validate a client API key for a train.
   * Client keys are hashed (SHA-256) for security.
   *
   * @param trainId - The train identifier
   * @param clientKey - The client API key to validate
   * @returns True if the key is valid for this train
   */
  validateClientKey(trainId: string, clientKey: string): Promise<boolean>

  /**
   * Get the Slack configuration for a train.
   * Returns null if Slack is not configured for this train.
   *
   * @param trainId - The train identifier
   * @returns Slack configuration or null
   */
  getSlackConfig(trainId: string): Promise<SlackConfig | null>
}
