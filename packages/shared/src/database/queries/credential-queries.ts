import { Pool } from 'pg'
import type {
  Credential,
  AnthropicCredential,
  BedrockCredential,
  CredentialSafe,
  CreateAnthropicCredentialRequest,
  CreateBedrockCredentialRequest,
  CreateCredentialRequest,
  UpdateCredentialTokensRequest,
} from '../../types/credentials'

/**
 * Create a new Anthropic credential
 */
export async function createAnthropicCredential(
  pool: Pool,
  request: CreateAnthropicCredentialRequest
): Promise<AnthropicCredential> {
  const result = await pool.query<AnthropicCredential>(
    `
    INSERT INTO credentials (
      account_id,
      account_name,
      provider,
      oauth_access_token,
      oauth_refresh_token,
      oauth_expires_at,
      oauth_scopes,
      oauth_is_max
    ) VALUES ($1, $2, 'anthropic', $3, $4, $5, $6, $7)
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
 * Create a new Bedrock credential
 */
export async function createBedrockCredential(
  pool: Pool,
  request: CreateBedrockCredentialRequest
): Promise<BedrockCredential> {
  const result = await pool.query<BedrockCredential>(
    `
    INSERT INTO credentials (
      account_id,
      account_name,
      provider,
      aws_api_key,
      aws_region
    ) VALUES ($1, $2, 'bedrock', $3, $4)
    RETURNING *
    `,
    [
      request.account_id,
      request.account_name,
      request.aws_api_key,
      request.aws_region ?? 'us-east-1',
    ]
  )

  return result.rows[0]
}

/**
 * Create a new credential (legacy function for backward compatibility)
 * @deprecated Use createAnthropicCredential or createBedrockCredential instead
 */
export async function createCredential(
  pool: Pool,
  request: CreateCredentialRequest
): Promise<Credential> {
  if ('oauth_access_token' in request) {
    return createAnthropicCredential(pool, request)
  } else {
    return createBedrockCredential(pool, request)
  }
}

/**
 * Get credential by ID
 */
export async function getCredentialById(pool: Pool, id: string): Promise<Credential | null> {
  const result = await pool.query<Credential>('SELECT * FROM credentials WHERE id = $1', [id])

  return result.rows[0] || null
}

/**
 * Get credential by account ID
 */
export async function getCredentialByAccountId(
  pool: Pool,
  accountId: string
): Promise<Credential | null> {
  const result = await pool.query<Credential>('SELECT * FROM credentials WHERE account_id = $1', [
    accountId,
  ])

  return result.rows[0] || null
}

/**
 * Get credential by account name
 */
export async function getCredentialByAccountName(
  pool: Pool,
  accountName: string
): Promise<Credential | null> {
  const result = await pool.query<Credential>('SELECT * FROM credentials WHERE account_name = $1', [
    accountName,
  ])

  return result.rows[0] || null
}

// Export toSafeCredential from internal for use in this file and train queries
import { toSafeCredential } from './credential-queries-internal'
export { toSafeCredential } from './credential-queries-internal'

/**
 * List all credentials (safe version without tokens)
 */
export async function listCredentialsSafe(pool: Pool): Promise<CredentialSafe[]> {
  const result = await pool.query<Credential>('SELECT * FROM credentials ORDER BY account_name ASC')

  return result.rows.map(cred => toSafeCredential(cred))
}

/**
 * Get safe credential by ID (without tokens)
 */
export async function getCredentialSafeById(
  pool: Pool,
  id: string
): Promise<CredentialSafe | null> {
  const credential = await getCredentialById(pool, id)
  return credential ? toSafeCredential(credential) : null
}

/**
 * Update OAuth tokens for a credential (Anthropic only)
 */
export async function updateCredentialTokens(
  pool: Pool,
  id: string,
  request: UpdateCredentialTokensRequest
): Promise<AnthropicCredential> {
  const result = await pool.query<AnthropicCredential>(
    `
    UPDATE credentials
    SET
      oauth_access_token = $2,
      oauth_refresh_token = $3,
      oauth_expires_at = $4,
      updated_at = NOW(),
      last_refresh_at = NOW()
    WHERE id = $1 AND provider = 'anthropic'
    RETURNING *
    `,
    [id, request.oauth_access_token, request.oauth_refresh_token, request.oauth_expires_at]
  )

  if (result.rows.length === 0) {
    throw new Error(`Anthropic credential with ID ${id} not found`)
  }

  return result.rows[0]
}

/**
 * Update last used timestamp for a credential
 */
export async function updateCredentialLastUsed(pool: Pool, id: string): Promise<void> {
  await pool.query('UPDATE credentials SET updated_at = NOW() WHERE id = $1', [id])
}

/**
 * Delete a credential
 */
export async function deleteCredential(pool: Pool, id: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM credentials WHERE id = $1', [id])
  return (result.rowCount ?? 0) > 0
}
