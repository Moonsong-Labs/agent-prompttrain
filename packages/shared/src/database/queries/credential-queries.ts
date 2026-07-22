import { Pool } from 'pg'
import type {
  Credential,
  AnthropicCredential,
  BedrockCredential,
  CredentialSafe,
  CreateAnthropicCredentialRequest,
  CreateBedrockCredentialRequest,
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
      account_email,
      provider,
      oauth_access_token,
      oauth_refresh_token,
      oauth_expires_at,
      oauth_scopes,
      oauth_is_max,
      last_refresh_at
    ) VALUES ($1, $2, $3, 'anthropic', $4, $5, $6, $7, $8, NOW())
    RETURNING *
    `,
    [
      request.account_id,
      request.account_name,
      request.account_email ?? null,
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
 * Create or overwrite an Anthropic credential by account_id.
 * Existing email is preserved when request.account_email is omitted/null.
 */
export async function upsertAnthropicCredential(
  pool: Pool,
  request: CreateAnthropicCredentialRequest
): Promise<AnthropicCredential> {
  const result = await pool.query<AnthropicCredential>(
    `
    INSERT INTO credentials (
      account_id,
      account_name,
      account_email,
      provider,
      oauth_access_token,
      oauth_refresh_token,
      oauth_expires_at,
      oauth_scopes,
      oauth_is_max
    ) VALUES ($1, $2, $3, 'anthropic', $4, $5, $6, $7, $8)
    ON CONFLICT (account_id) DO UPDATE
    SET
      account_name = EXCLUDED.account_name,
      account_email = COALESCE(EXCLUDED.account_email, credentials.account_email),
      oauth_access_token = EXCLUDED.oauth_access_token,
      oauth_refresh_token = EXCLUDED.oauth_refresh_token,
      oauth_expires_at = EXCLUDED.oauth_expires_at,
      oauth_scopes = EXCLUDED.oauth_scopes,
      oauth_is_max = EXCLUDED.oauth_is_max,
      updated_at = NOW(),
      last_refresh_at = NOW()
    WHERE credentials.provider = 'anthropic'
    RETURNING *
    `,
    [
      request.account_id,
      request.account_name,
      request.account_email ?? null,
      request.oauth_access_token,
      request.oauth_refresh_token,
      request.oauth_expires_at,
      request.oauth_scopes,
      request.oauth_is_max ?? true,
    ]
  )

  if (result.rows.length === 0) {
    throw new Error(
      `Account ID ${request.account_id} already exists for a non-Anthropic credential`
    )
  }

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
 * List all Anthropic credentials with OAuth token fields.
 * Intended for trusted maintenance scripts and internal services.
 */
export async function listAnthropicCredentials(pool: Pool): Promise<AnthropicCredential[]> {
  const result = await pool.query<AnthropicCredential>(
    `
    SELECT *
    FROM credentials
    WHERE provider = 'anthropic'
    ORDER BY account_name ASC
    `
  )

  return result.rows
}

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
