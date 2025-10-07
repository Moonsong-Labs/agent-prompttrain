import { Pool } from 'pg'
import type {
  TrainMember,
  TrainMemberRole,
  Train,
  TrainWithAccounts,
  AnthropicCredential,
} from '../../types/index.js'
import { toSafeCredential } from './credential-queries.js'

/**
 * Add a member to a train
 * Does not modify role if member already exists (use updateTrainMemberRole for that)
 */
export async function addTrainMember(
  pool: Pool,
  trainId: string,
  userEmail: string,
  role: TrainMemberRole,
  addedBy: string
): Promise<TrainMember> {
  const result = await pool.query<TrainMember>(
    `
    INSERT INTO train_members (train_id, user_email, role, added_by)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (train_id, user_email) DO NOTHING
    RETURNING *
    `,
    [trainId, userEmail, role, addedBy]
  )

  // If no rows returned, member already exists - fetch and return existing
  if (result.rows.length === 0) {
    const existing = await pool.query<TrainMember>(
      'SELECT * FROM train_members WHERE train_id = $1 AND user_email = $2',
      [trainId, userEmail]
    )
    return existing.rows[0]
  }

  return result.rows[0]
}

/**
 * Remove a member from a train
 * Throws error if attempting to remove the last owner
 * Uses transaction with row locking to prevent race conditions
 */
export async function removeTrainMember(
  pool: Pool,
  trainId: string,
  userEmail: string
): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    // Lock the member row for update
    const memberResult = await client.query<TrainMember>(
      'SELECT * FROM train_members WHERE train_id = $1 AND user_email = $2 FOR UPDATE',
      [trainId, userEmail]
    )

    if (memberResult.rows.length === 0) {
      throw new Error('Member not found')
    }

    const member = memberResult.rows[0]

    if (member.role === 'owner') {
      // Lock all owner rows for this train to prevent concurrent modifications
      await client.query(
        'SELECT 1 FROM train_members WHERE train_id = $1 AND role = $2 FOR UPDATE',
        [trainId, 'owner']
      )

      // Count owners
      const countResult = await client.query<{ count: string }>(
        'SELECT COUNT(*) as count FROM train_members WHERE train_id = $1 AND role = $2',
        [trainId, 'owner']
      )
      const ownerCount = parseInt(countResult.rows[0]?.count ?? '0', 10)

      if (ownerCount <= 1) {
        throw new Error('Cannot remove the last owner from a train')
      }
    }

    await client.query('DELETE FROM train_members WHERE train_id = $1 AND user_email = $2', [
      trainId,
      userEmail,
    ])

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/**
 * Get all members of a train
 */
export async function getTrainMembers(pool: Pool, trainId: string): Promise<TrainMember[]> {
  const result = await pool.query<TrainMember>(
    `
    SELECT * FROM train_members
    WHERE train_id = $1
    ORDER BY role DESC, user_email ASC
    `,
    [trainId]
  )

  return result.rows
}

/**
 * Get all trains where user is a member or owner
 */
export async function getUserTrains(pool: Pool, userEmail: string): Promise<Train[]> {
  const result = await pool.query<Train>(
    `
    SELECT t.*
    FROM trains t
    INNER JOIN train_members tm ON tm.train_id = t.id
    WHERE tm.user_email = $1
    ORDER BY t.name ASC
    `,
    [userEmail]
  )

  return result.rows
}

/**
 * Get all trains where user is a member or owner, with associated accounts
 */
export async function getUserTrainsWithAccounts(
  pool: Pool,
  userEmail: string
): Promise<TrainWithAccounts[]> {
  const trains = await getUserTrains(pool, userEmail)

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
 * Check if a user is an owner of a train
 */
export async function isTrainOwner(
  pool: Pool,
  trainId: string,
  userEmail: string
): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `
    SELECT EXISTS(
      SELECT 1 FROM train_members
      WHERE train_id = $1 AND user_email = $2 AND role = 'owner'
    ) as exists
    `,
    [trainId, userEmail]
  )

  return result.rows[0]?.exists ?? false
}

/**
 * Check if a user is a member (owner or member) of a train
 */
export async function isTrainMember(
  pool: Pool,
  trainId: string,
  userEmail: string
): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `
    SELECT EXISTS(
      SELECT 1 FROM train_members
      WHERE train_id = $1 AND user_email = $2
    ) as exists
    `,
    [trainId, userEmail]
  )

  return result.rows[0]?.exists ?? false
}

/**
 * Update a member's role
 * Throws error if attempting to demote the last owner
 * Uses transaction with row locking to prevent race conditions
 */
export async function updateTrainMemberRole(
  pool: Pool,
  trainId: string,
  userEmail: string,
  newRole: TrainMemberRole
): Promise<TrainMember> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    // Lock the member row for update
    const memberResult = await client.query<TrainMember>(
      'SELECT * FROM train_members WHERE train_id = $1 AND user_email = $2 FOR UPDATE',
      [trainId, userEmail]
    )

    if (memberResult.rows.length === 0) {
      throw new Error('Member not found')
    }

    const member = memberResult.rows[0]

    if (member.role === 'owner' && newRole === 'member') {
      // Lock all owner rows for this train to prevent concurrent modifications
      await client.query(
        'SELECT 1 FROM train_members WHERE train_id = $1 AND role = $2 FOR UPDATE',
        [trainId, 'owner']
      )

      // Count owners
      const countResult = await client.query<{ count: string }>(
        'SELECT COUNT(*) as count FROM train_members WHERE train_id = $1 AND role = $2',
        [trainId, 'owner']
      )
      const ownerCount = parseInt(countResult.rows[0]?.count ?? '0', 10)

      if (ownerCount <= 1) {
        throw new Error('Cannot demote the last owner')
      }
    }

    const result = await client.query<TrainMember>(
      `
      UPDATE train_members
      SET role = $3
      WHERE train_id = $1 AND user_email = $2
      RETURNING *
      `,
      [trainId, userEmail, newRole]
    )

    await client.query('COMMIT')
    return result.rows[0]
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/**
 * Get the count of owners for a train
 */
export async function getOwnerCount(pool: Pool, trainId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `
    SELECT COUNT(*) as count
    FROM train_members
    WHERE train_id = $1 AND role = 'owner'
    `,
    [trainId]
  )

  return parseInt(result.rows[0]?.count ?? '0', 10)
}
