import { Pool } from 'pg'
import type {
  AnthropicCredential,
  AnthropicCredentialSafe,
  CreateCredentialRequest,
  UpdateCredentialTokensRequest,
} from '../../types/credentials'

/**
 * Create a new Anthropic credential
 */
export async function createCredential(
  pool: Pool,
  request: CreateCredentialRequest
): Promise<AnthropicCredential> {
  const result = await pool.query<AnthropicCredential>(
    `
    INSERT INTO anthropic_credentials (
      account_id,
      account_name,
      oauth_access_token,
      oauth_refresh_token,
      oauth_expires_at,
      oauth_scopes,
      oauth_is_max
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
    `,
    [
      request.account_id,
      request.account_name,
      request.oauth_access_token,
      request.oauth_refresh_token,
      request.oauth_expires_at,
      request.oauth_scopes,
      request.oauth_is_max ?? true,
    ]
  )

  return result.rows[0]
}

/**
 * Get credential by ID
 */
export async function getCredentialById(
  pool: Pool,
  id: string
): Promise<AnthropicCredential | null> {
  const result = await pool.query<AnthropicCredential>(
    'SELECT * FROM anthropic_credentials WHERE id = $1',
    [id]
  )

  return result.rows[0] || null
}

/**
 * Get credential by account ID
 */
export async function getCredentialByAccountId(
  pool: Pool,
  accountId: string
): Promise<AnthropicCredential | null> {
  const result = await pool.query<AnthropicCredential>(
    'SELECT * FROM anthropic_credentials WHERE account_id = $1',
    [accountId]
  )

  return result.rows[0] || null
}

/**
 * Get credential by account name
 */
export async function getCredentialByAccountName(
  pool: Pool,
  accountName: string
): Promise<AnthropicCredential | null> {
  const result = await pool.query<AnthropicCredential>(
    'SELECT * FROM anthropic_credentials WHERE account_name = $1',
    [accountName]
  )

  return result.rows[0] || null
}

// Export toSafeCredential from internal for use in this file and train queries
import { toSafeCredential } from './credential-queries-internal'
export { toSafeCredential } from './credential-queries-internal'

/**
 * List all credentials (safe version without tokens)
 */
export async function listCredentialsSafe(pool: Pool): Promise<AnthropicCredentialSafe[]> {
  const result = await pool.query<AnthropicCredential>(
    'SELECT * FROM anthropic_credentials ORDER BY account_name ASC'
  )

  return result.rows.map(cred => toSafeCredential(cred))
}

/**
 * Get safe credential by ID (without tokens)
 */
export async function getCredentialSafeById(
  pool: Pool,
  id: string
): Promise<AnthropicCredentialSafe | null> {
  const credential = await getCredentialById(pool, id)
  return credential ? toSafeCredential(credential) : null
}

/**
 * Update OAuth tokens for a credential
 */
export async function updateCredentialTokens(
  pool: Pool,
  id: string,
  request: UpdateCredentialTokensRequest
): Promise<AnthropicCredential> {
  const result = await pool.query<AnthropicCredential>(
    `
    UPDATE anthropic_credentials
    SET
      oauth_access_token = $2,
      oauth_refresh_token = $3,
      oauth_expires_at = $4,
      updated_at = NOW(),
      last_refresh_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [id, request.oauth_access_token, request.oauth_refresh_token, request.oauth_expires_at]
  )

  if (result.rows.length === 0) {
    throw new Error(`Credential with ID ${id} not found`)
  }

  return result.rows[0]
}

/**
 * Update last used timestamp for a credential
 */
export async function updateCredentialLastUsed(pool: Pool, id: string): Promise<void> {
  await pool.query('UPDATE anthropic_credentials SET updated_at = NOW() WHERE id = $1', [id])
}

/**
 * Delete a credential
 */
export async function deleteCredential(pool: Pool, id: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM anthropic_credentials WHERE id = $1', [id])
  return (result.rowCount ?? 0) > 0
}
