import { Pool } from 'pg'
import { randomBytes } from 'crypto'
import type {
  ProjectApiKey,
  ProjectApiKeySafe,
  CreateApiKeyRequest,
  GeneratedApiKey,
} from '../../types/credentials'

const KEY_PREFIX = 'cnp_live_'
const KEY_LENGTH = 32 // Random part length

/**
 * Generate a random API key
 */
function generateApiKey(): string {
  const randomPart = randomBytes(KEY_LENGTH)
    .toString('base64')
    .replace(/[+/=]/g, '')
    .substring(0, KEY_LENGTH)

  return `${KEY_PREFIX}${randomPart}`
}

/**
 * Generate a new API key for a project
 */
export async function createTrainApiKey(
  pool: Pool,
  trainUuid: string,
  request: CreateApiKeyRequest
): Promise<GeneratedApiKey> {
  const apiKey = generateApiKey()
  const keySuffix = apiKey.slice(-4)
  const keyPreview = `${KEY_PREFIX}****${keySuffix}`

  const result = await pool.query<ProjectApiKey>(
    `
    INSERT INTO project_api_keys (
      project_id,
      api_key,
      key_prefix,
      key_suffix,
      name,
      created_by
    ) VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
    `,
    [trainUuid, apiKey, KEY_PREFIX, keySuffix, request.name || null, request.created_by || null]
  )

  const key = result.rows[0]

  return {
    id: key.id,
    api_key: apiKey, // Full key, shown only once
    key_preview: keyPreview,
    name: key.name,
    created_by: key.created_by,
    created_at: key.created_at,
  }
}

/**
 * Verify an API key and return the associated train ID
 * This is the primary authentication method - identifies the project from the API key
 */
export async function verifyApiKeyAndGetTrain(
  pool: Pool,
  apiKey: string
): Promise<{ trainApiKey: ProjectApiKey; projectId: string } | null> {
  const result = await pool.query<ProjectApiKey & { project_id: string }>(
    `
    SELECT tak.*, t.project_id
    FROM project_api_keys tak
    INNER JOIN projects t ON t.id = tak.project_id
    WHERE tak.api_key = $1
      AND tak.revoked_at IS NULL
    `,
    [apiKey]
  )

  if (result.rows.length === 0) {
    return null
  }

  const row = result.rows[0]

  // Update last_used_at
  await pool.query('UPDATE project_api_keys SET last_used_at = NOW() WHERE id = $1', [row.id])

  return {
    trainApiKey: row,
    projectId: row.project_id,
  }
}

/**
 * Verify an API key for a project (legacy method - prefer verifyApiKeyAndGetTrain)
 * @deprecated Use verifyApiKeyAndGetTrain instead
 */
export async function verifyTrainApiKey(
  pool: Pool,
  projectId: string,
  apiKey: string
): Promise<ProjectApiKey | null> {
  const result = await pool.query<ProjectApiKey>(
    `
    SELECT tak.*
    FROM project_api_keys tak
    INNER JOIN projects t ON t.id = tak.project_id
    WHERE t.project_id = $1
      AND tak.api_key = $2
      AND tak.revoked_at IS NULL
    `,
    [projectId, apiKey]
  )

  if (result.rows.length === 0) {
    return null
  }

  const key = result.rows[0]

  // Update last_used_at
  await pool.query('UPDATE project_api_keys SET last_used_at = NOW() WHERE id = $1', [key.id])

  return key
}

/**
 * List all API keys for a project (safe version)
 */
export async function listTrainApiKeys(
  pool: Pool,
  trainUuid: string
): Promise<ProjectApiKeySafe[]> {
  const result = await pool.query<ProjectApiKey>(
    `
    SELECT *
    FROM project_api_keys
    WHERE project_id = $1
    ORDER BY created_at DESC
    `,
    [trainUuid]
  )

  return result.rows.map(key => toSafeApiKey(key))
}

/**
 * Get API key by ID (safe version)
 */
export async function getTrainApiKeySafe(
  pool: Pool,
  keyId: string
): Promise<ProjectApiKeySafe | null> {
  const result = await pool.query<ProjectApiKey>('SELECT * FROM project_api_keys WHERE id = $1', [
    keyId,
  ])

  if (result.rows.length === 0) {
    return null
  }

  return toSafeApiKey(result.rows[0])
}

/**
 * Revoke an API key
 */
export async function revokeTrainApiKey(
  pool: Pool,
  keyId: string,
  revokedBy?: string
): Promise<boolean> {
  const result = await pool.query(
    `
    UPDATE project_api_keys
    SET revoked_at = NOW(), revoked_by = $2
    WHERE id = $1 AND revoked_at IS NULL
    RETURNING id
    `,
    [keyId, revokedBy || null]
  )

  return (result.rowCount ?? 0) > 0
}

/**
 * Update an API key name
 */
export async function updateTrainApiKeyName(
  pool: Pool,
  keyId: string,
  name: string | null
): Promise<boolean> {
  const result = await pool.query(
    `
    UPDATE project_api_keys
    SET name = $2
    WHERE id = $1 AND revoked_at IS NULL
    `,
    [keyId, name]
  )

  return (result.rowCount ?? 0) > 0
}

/**
 * Delete an API key
 */
export async function deleteTrainApiKey(pool: Pool, keyId: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM project_api_keys WHERE id = $1', [keyId])
  return (result.rowCount ?? 0) > 0
}

/**
 * Convert full API key to safe version (without full key)
 */
function toSafeApiKey(key: ProjectApiKey): ProjectApiKeySafe {
  return {
    id: key.id,
    project_id: key.project_id,
    key_preview: `${key.key_prefix}****${key.key_suffix}`,
    name: key.name,
    created_by: key.created_by,
    created_at: key.created_at,
    last_used_at: key.last_used_at,
    revoked_at: key.revoked_at,
    revoked_by: key.revoked_by,
    status: key.revoked_at ? 'revoked' : 'active',
  }
}
