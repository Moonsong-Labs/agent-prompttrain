import { Pool, type PoolClient } from 'pg'
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
 * A pool, or a client holding a transaction
 */
export type Queryable = Pick<Pool, 'query'>

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
export async function getCredentialById(pool: Queryable, id: string): Promise<Credential | null> {
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
  pool: Queryable,
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

// SHA-256 of the refresh token, so the alert marker never stores a usable token
const REFRESH_TOKEN_HASH_SQL = `encode(sha256(convert_to($2::text, 'UTF8')), 'hex')`

/**
 * Claim the right to alert that this refresh token was rejected (Anthropic only).
 *
 * Returns true for exactly one caller per refresh token, across all proxy instances.
 * Returns false when the alert was already claimed, or when the credential no longer
 * holds this refresh token (another instance rotated it, so it has not expired).
 */
export async function claimRefreshTokenAlert(
  pool: Pool,
  id: string,
  refreshToken: string
): Promise<boolean> {
  const result = await pool.query(
    `
    UPDATE credentials
    SET oauth_refresh_alerted_token_hash = ${REFRESH_TOKEN_HASH_SQL}
    WHERE id = $1
      AND provider = 'anthropic'
      AND COALESCE(oauth_refresh_token, '') = $2
      AND oauth_refresh_alerted_token_hash IS DISTINCT FROM ${REFRESH_TOKEN_HASH_SQL}
    `,
    [id, refreshToken]
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * Run `task` while holding the cluster-wide OAuth refresh lock of a credential (ADR-040).
 *
 * Anthropic revokes a refresh token that is presented twice, so proxy instances must not
 * refresh the same credential at once. The lock is held by a transaction on the client
 * given to `task`: queries run on it see what the previous holder stored. What `task`
 * wrote is committed even when it throws, so it can record a failure before rethrowing.
 */
export async function withCredentialRefreshLock<T>(
  pool: Pool,
  id: string,
  task: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`oauth-refresh:${id}`])
      return await task(client)
    } finally {
      // Releases the lock; a transaction aborted by a failed statement is rolled back instead
      await client.query('COMMIT')
    }
  } finally {
    client.release()
  }
}

/**
 * Record that Anthropic rejected this refresh token (Anthropic only), so account pools
 * skip the credential until new tokens are stored.
 *
 * Returns false when the credential no longer holds this refresh token (a relogin or
 * another instance stored a new one) or the rejection was already recorded.
 */
export async function markRefreshTokenRejected(
  pool: Queryable,
  id: string,
  refreshToken: string
): Promise<boolean> {
  const result = await pool.query(
    `
    UPDATE credentials
    SET oauth_refresh_rejected_token_hash = ${REFRESH_TOKEN_HASH_SQL}
    WHERE id = $1
      AND provider = 'anthropic'
      AND COALESCE(oauth_refresh_token, '') = $2
      AND oauth_refresh_rejected_token_hash IS DISTINCT FROM ${REFRESH_TOKEN_HASH_SQL}
    `,
    [id, refreshToken]
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * Release a refresh token alert claim so a later attempt can send it again
 */
export async function releaseRefreshTokenAlert(
  pool: Pool,
  id: string,
  refreshToken: string
): Promise<void> {
  await pool.query(
    `
    UPDATE credentials
    SET oauth_refresh_alerted_token_hash = NULL
    WHERE id = $1 AND oauth_refresh_alerted_token_hash = ${REFRESH_TOKEN_HASH_SQL}
    `,
    [id, refreshToken]
  )
}
