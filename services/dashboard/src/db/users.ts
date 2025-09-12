import { User, GoogleUserProfile } from '@agent-prompttrain/shared'
import { db } from './index.js'

/**
 * Database queries for user management
 */

/**
 * Find or create a user from Google profile
 * @param profile Google user profile
 * @returns The user (existing or newly created)
 */
export async function findOrCreateUser(profile: GoogleUserProfile): Promise<User> {
  // First try to find existing user
  const existingResult = await db.query<User>(`SELECT * FROM users WHERE google_id = $1`, [
    profile.id,
  ])

  if (existingResult.rows.length > 0) {
    // Update user info if changed
    const existingUser = existingResult.rows[0]
    if (existingUser.email !== profile.email || existingUser.name !== profile.name) {
      const updateResult = await db.query<User>(
        `UPDATE users 
         SET email = $2, name = $3, updated_at = CURRENT_TIMESTAMP
         WHERE google_id = $1
         RETURNING *`,
        [profile.id, profile.email, profile.name]
      )
      return updateResult.rows[0]
    }
    return existingUser
  }

  // Create new user
  const createResult = await db.query<User>(
    `INSERT INTO users (email, name, google_id, allowed_domain)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [
      profile.email,
      profile.name,
      profile.id,
      profile.hd || null, // Hosted domain for Google Workspace
    ]
  )

  return createResult.rows[0]
}

/**
 * Get a user by ID
 * @param id User ID
 * @returns The user or null if not found
 */
export async function getUserById(id: string): Promise<User | null> {
  const result = await db.query<User>(`SELECT * FROM users WHERE id = $1`, [id])

  return result.rows[0] || null
}

/**
 * Get a user by email
 * @param email User email
 * @returns The user or null if not found
 */
export async function getUserByEmail(email: string): Promise<User | null> {
  const result = await db.query<User>(`SELECT * FROM users WHERE email = $1`, [email])

  return result.rows[0] || null
}

/**
 * Get a user by Google ID
 * @param googleId Google account ID
 * @returns The user or null if not found
 */
export async function getUserByGoogleId(googleId: string): Promise<User | null> {
  const result = await db.query<User>(`SELECT * FROM users WHERE google_id = $1`, [googleId])

  return result.rows[0] || null
}

/**
 * Update user information
 * @param id User ID
 * @param data Partial user data to update
 * @returns The updated user or null if not found
 */
export async function updateUser(
  id: string,
  data: Partial<Pick<User, 'email' | 'name' | 'allowed_domain'>>
): Promise<User | null> {
  const fields: string[] = []
  const values: unknown[] = []
  let paramCount = 1

  if (data.email !== undefined) {
    fields.push(`email = $${paramCount++}`)
    values.push(data.email)
  }
  if (data.name !== undefined) {
    fields.push(`name = $${paramCount++}`)
    values.push(data.name)
  }
  if (data.allowed_domain !== undefined) {
    fields.push(`allowed_domain = $${paramCount++}`)
    values.push(data.allowed_domain)
  }

  if (fields.length === 0) {
    return getUserById(id)
  }

  fields.push(`updated_at = CURRENT_TIMESTAMP`)
  values.push(id)

  const result = await db.query<User>(
    `UPDATE users 
     SET ${fields.join(', ')}
     WHERE id = $${paramCount}
     RETURNING *`,
    values
  )

  return result.rows[0] || null
}

/**
 * Delete a user (cascades to sessions)
 * @param id User ID
 * @returns True if deleted, false if not found
 */
export async function deleteUser(id: string): Promise<boolean> {
  const result = await db.query(`DELETE FROM users WHERE id = $1`, [id])

  return (result.rowCount ?? 0) > 0
}

/**
 * Get users by domain
 * @param domain The domain to filter by
 * @returns List of users in that domain
 */
export async function getUsersByDomain(domain: string): Promise<User[]> {
  const result = await db.query<User>(
    `SELECT * FROM users 
     WHERE email LIKE $1 
     OR allowed_domain = $2
     ORDER BY created_at DESC`,
    [`%@${domain}`, domain]
  )

  return result.rows
}

/**
 * Count total users
 * @returns Total number of users
 */
export async function getUserCount(): Promise<number> {
  const result = await db.query<{ count: string }>(`SELECT COUNT(*) as count FROM users`)

  return parseInt(result.rows[0].count, 10)
}

/**
 * Get users with pagination
 * @param limit Number of users to return
 * @param offset Number of users to skip
 * @returns List of users
 */
export async function getUsers(limit: number = 50, offset: number = 0): Promise<User[]> {
  const result = await db.query<User>(
    `SELECT * FROM users 
     ORDER BY created_at DESC 
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  )

  return result.rows
}
