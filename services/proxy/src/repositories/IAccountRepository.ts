import { DecryptedAccount } from '@agent-prompttrain/shared'

/**
 * Repository interface for account credential operations.
 *
 * Abstracts credential storage (filesystem vs database) from business logic.
 * All methods work with account names for compatibility with existing
 * AuthenticationService logic.
 */
export interface IAccountRepository {
  /**
   * List all available account names.
   * Used by AuthenticationService for deterministic account selection.
   *
   * @returns Array of account names (not IDs)
   */
  listAccountNames(): Promise<string[]>

  /**
   * Get a decrypted account by its name.
   * Handles decryption transparently for database-backed accounts.
   *
   * @param accountName - The account name (e.g., "my-account")
   * @returns Decrypted account or null if not found
   */
  getAccountByName(accountName: string): Promise<DecryptedAccount | null>

  /**
   * Get the API key or OAuth access token for an account.
   * Handles OAuth token refresh automatically if needed.
   *
   * @param accountName - The account name
   * @returns The API key or access token, or null if unavailable
   */
  getApiKey(accountName: string): Promise<string | null>

  /**
   * Update OAuth credentials after token refresh.
   * Must be concurrency-safe for database implementations (use row locking).
   *
   * @param accountName - The account name
   * @param tokens - New OAuth tokens
   */
  updateOAuthTokens(
    accountName: string,
    tokens: {
      accessToken: string
      refreshToken?: string
      expiresAt: number
      scopes?: string[]
      isMax?: boolean
    }
  ): Promise<void>

  /**
   * Update the last used timestamp for an account.
   * Used for tracking account activity.
   *
   * @param accountName - The account name
   */
  updateLastUsed(accountName: string): Promise<void>

  /**
   * Clear any cached credentials.
   * Used when credentials are updated externally.
   */
  clearCache(): void
}
