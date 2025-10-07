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
 * Create a new train
 */
export async function createTrain(pool: Pool, request: CreateTrainRequest): Promise<Train> {
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
      slack_icon_emoji
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
 * Get train with its linked accounts
 */
export async function getTrainWithAccounts(
  pool: Pool,
  trainId: string
): Promise<TrainWithAccounts | null> {
  const train = await getTrainByTrainId(pool, trainId)
  if (!train) {
    return null
  }

  const accountsResult = await pool.query<AnthropicCredential>(
    `
    SELECT ac.*
    FROM anthropic_credentials ac
    INNER JOIN train_accounts ta ON ta.credential_id = ac.id
    WHERE ta.train_id = $1
    ORDER BY ac.account_name ASC
    `,
    [train.id]
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
 * List all trains with their accounts
 */
export async function listTrainsWithAccounts(pool: Pool): Promise<TrainWithAccounts[]> {
  const trains = await listTrains(pool)

  const trainsWithAccounts = await Promise.all(
    trains.map(async train => {
      const accountsResult = await pool.query<AnthropicCredential>(
        `
        SELECT ac.*
        FROM anthropic_credentials ac
        INNER JOIN train_accounts ta ON ta.credential_id = ac.id
        WHERE ta.train_id = $1
        ORDER BY ac.account_name ASC
        `,
        [train.id]
      )

      return {
        ...train,
        accounts: accountsResult.rows.map(cred => toSafeCredential(cred)),
      }
    })
  )

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
  const values: any[] = []
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
 * Link an account to a train
 */
export async function linkAccountToTrain(
  pool: Pool,
  trainId: string,
  credentialId: string
): Promise<void> {
  await pool.query(
    `
    INSERT INTO train_accounts (train_id, credential_id)
    VALUES ($1, $2)
    ON CONFLICT (train_id, credential_id) DO NOTHING
    `,
    [trainId, credentialId]
  )
}

/**
 * Unlink an account from a train
 */
export async function unlinkAccountFromTrain(
  pool: Pool,
  trainId: string,
  credentialId: string
): Promise<boolean> {
  const result = await pool.query(
    'DELETE FROM train_accounts WHERE train_id = $1 AND credential_id = $2',
    [trainId, credentialId]
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * Get all credentials linked to a train
 */
export async function getTrainCredentials(
  pool: Pool,
  trainId: string
): Promise<AnthropicCredential[]> {
  const result = await pool.query<AnthropicCredential>(
    `
    SELECT ac.*
    FROM anthropic_credentials ac
    INNER JOIN train_accounts ta ON ta.credential_id = ac.id
    INNER JOIN trains t ON t.id = ta.train_id
    WHERE t.train_id = $1
    ORDER BY ac.account_name ASC
    `,
    [trainId]
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
