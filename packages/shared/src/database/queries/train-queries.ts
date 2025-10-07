import { Pool } from 'pg'
import type {
  Train,
  TrainWithAccounts,
  CreateTrainRequest,
  UpdateTrainRequest,
  AnthropicCredential,
  SlackConfig,
} from '../../types/credentials'
import { toSafeCredential } from './credential-queries-internal'

/**
 * Create a new train with a randomly selected default account
 */
export async function createTrain(pool: Pool, request: CreateTrainRequest): Promise<Train> {
  // Get a random credential to use as default
  const credentialResult = await pool.query<{ id: string }>(
    'SELECT id FROM anthropic_credentials ORDER BY RANDOM() LIMIT 1'
  )

  const defaultAccountId = credentialResult.rows[0]?.id || null

  const result = await pool.query<Train>(
    `
    INSERT INTO trains (
      train_id,
      name,
      description,
      slack_enabled,
      slack_webhook_url,
      slack_channel,
      slack_username,
      slack_icon_emoji,
      default_account_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
    `,
    [
      request.train_id,
      request.name,
      request.description || null,
      request.slack_enabled ?? false,
      request.slack_webhook_url || null,
      request.slack_channel || null,
      request.slack_username || null,
      request.slack_icon_emoji || null,
      defaultAccountId,
    ]
  )

  return result.rows[0]
}

/**
 * Get train by UUID
 */
export async function getTrainById(pool: Pool, id: string): Promise<Train | null> {
  const result = await pool.query<Train>('SELECT * FROM trains WHERE id = $1', [id])
  return result.rows[0] || null
}

/**
 * Get train by train_id
 */
export async function getTrainByTrainId(pool: Pool, trainId: string): Promise<Train | null> {
  const result = await pool.query<Train>('SELECT * FROM trains WHERE train_id = $1', [trainId])
  return result.rows[0] || null
}

/**
 * Get train with all available accounts
 * All trains have access to all credentials
 */
export async function getTrainWithAccounts(
  pool: Pool,
  trainId: string
): Promise<TrainWithAccounts | null> {
  const train = await getTrainByTrainId(pool, trainId)
  if (!train) {
    return null
  }

  // All trains have access to all credentials
  const accountsResult = await pool.query<AnthropicCredential>(
    `SELECT * FROM anthropic_credentials ORDER BY account_name ASC`
  )

  return {
    ...train,
    accounts: accountsResult.rows.map(cred => toSafeCredential(cred)),
  }
}

/**
 * List all trains
 */
export async function listTrains(pool: Pool): Promise<Train[]> {
  const result = await pool.query<Train>('SELECT * FROM trains ORDER BY name ASC')
  return result.rows
}

/**
 * List all trains with all available accounts
 * All trains have access to all credentials
 */
export async function listTrainsWithAccounts(pool: Pool): Promise<TrainWithAccounts[]> {
  const trains = await listTrains(pool)

  // Get all credentials once (shared across all trains)
  const accountsResult = await pool.query<AnthropicCredential>(
    `SELECT * FROM anthropic_credentials ORDER BY account_name ASC`
  )

  const allAccounts = accountsResult.rows.map(cred => toSafeCredential(cred))

  // All trains have access to all credentials
  const trainsWithAccounts = trains.map(train => ({
    ...train,
    accounts: allAccounts,
  }))

  return trainsWithAccounts
}

/**
 * Update train configuration
 */
export async function updateTrain(
  pool: Pool,
  id: string,
  request: UpdateTrainRequest
): Promise<Train> {
  const updates: string[] = []
  const values: unknown[] = []
  let paramIndex = 1

  if (request.name !== undefined) {
    updates.push(`name = $${paramIndex++}`)
    values.push(request.name)
  }
  if (request.description !== undefined) {
    updates.push(`description = $${paramIndex++}`)
    values.push(request.description)
  }
  if (request.slack_enabled !== undefined) {
    updates.push(`slack_enabled = $${paramIndex++}`)
    values.push(request.slack_enabled)
  }
  if (request.slack_webhook_url !== undefined) {
    updates.push(`slack_webhook_url = $${paramIndex++}`)
    values.push(request.slack_webhook_url)
  }
  if (request.slack_channel !== undefined) {
    updates.push(`slack_channel = $${paramIndex++}`)
    values.push(request.slack_channel)
  }
  if (request.slack_username !== undefined) {
    updates.push(`slack_username = $${paramIndex++}`)
    values.push(request.slack_username)
  }
  if (request.slack_icon_emoji !== undefined) {
    updates.push(`slack_icon_emoji = $${paramIndex++}`)
    values.push(request.slack_icon_emoji)
  }

  if (updates.length === 0) {
    const train = await getTrainById(pool, id)
    if (!train) {
      throw new Error(`Train with ID ${id} not found`)
    }
    return train
  }

  updates.push(`updated_at = NOW()`)
  values.push(id)

  const result = await pool.query<Train>(
    `UPDATE trains SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  )

  if (result.rows.length === 0) {
    throw new Error(`Train with ID ${id} not found`)
  }

  return result.rows[0]
}

/**
 * Delete a train
 */
export async function deleteTrain(pool: Pool, id: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM trains WHERE id = $1', [id])
  return (result.rowCount ?? 0) > 0
}

/**
 * Set the default account for a train
 */
export async function setTrainDefaultAccount(
  pool: Pool,
  trainId: string,
  credentialId: string
): Promise<Train> {
  const result = await pool.query<Train>(
    `
    UPDATE trains
    SET default_account_id = $2, updated_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [trainId, credentialId]
  )

  if (result.rows.length === 0) {
    throw new Error(`Train with ID ${trainId} not found`)
  }

  return result.rows[0]
}

/**
 * Get all credentials available to a train (all credentials)
 */
export async function getTrainCredentials(
  pool: Pool,
  _trainId: string
): Promise<AnthropicCredential[]> {
  // All trains have access to all credentials
  const result = await pool.query<AnthropicCredential>(
    `SELECT * FROM anthropic_credentials ORDER BY account_name ASC`
  )

  return result.rows
}

/**
 * Get Slack configuration for a train
 */
export async function getTrainSlackConfig(
  pool: Pool,
  trainId: string
): Promise<SlackConfig | null> {
  const train = await getTrainByTrainId(pool, trainId)
  if (!train) {
    return null
  }

  if (!train.slack_enabled) {
    return null
  }

  return {
    enabled: train.slack_enabled,
    webhook_url: train.slack_webhook_url || undefined,
    channel: train.slack_channel || undefined,
    username: train.slack_username || undefined,
    icon_emoji: train.slack_icon_emoji || undefined,
  }
}
