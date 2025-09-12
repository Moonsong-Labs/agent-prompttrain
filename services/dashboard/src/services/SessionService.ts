import { randomBytes, createHash } from 'crypto'
import { Session, CreateSessionParams, User } from '@agent-prompttrain/shared'
import { db } from '../db/index.js'

/**
 * Service for managing user sessions
 */
export class SessionService {
  private readonly DEFAULT_SESSION_DURATION_DAYS = 30
  private readonly MAX_SESSIONS_PER_USER = 5

  /**
   * Generate a cryptographically secure session token
   * @returns A secure random token
   */
  private generateToken(): string {
    return randomBytes(32).toString('hex')
  }

  /**
   * Hash a session token using SHA-256
   * @param token The token to hash
   * @returns The SHA-256 hash as hex string
   */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }

  /**
   * Create a new session for a user
   * @param params Session creation parameters
   * @returns The created session
   */
  async createSession(params: CreateSessionParams): Promise<Session> {
    const { userId, expiresInDays = this.DEFAULT_SESSION_DURATION_DAYS } = params

    // Check and enforce session limit
    const activeCount = await this.getActiveSessionCount(userId)
    if (activeCount >= this.MAX_SESSIONS_PER_USER) {
      // Delete oldest sessions to make room
      const toDelete = activeCount - this.MAX_SESSIONS_PER_USER + 1
      await db.query(
        `DELETE FROM sessions
         WHERE user_id = $1
         AND id IN (
           SELECT id FROM sessions
           WHERE user_id = $1
           ORDER BY created_at ASC
           LIMIT $2
         )`,
        [userId, toDelete]
      )
    }

    const token = this.generateToken()
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + expiresInDays)

    const tokenHash = this.hashToken(token)

    const result = await db.query<Omit<Session, 'token'>>(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, expires_at, created_at`,
      [userId, tokenHash, expiresAt]
    )

    // Return session with the unhashed token (only returned to client once)
    return { ...result.rows[0], token }
  }

  /**
   * Validate a session token
   * @param token The session token to validate
   * @returns The session if valid, null otherwise
   */
  async validateSession(token: string): Promise<Session | null> {
    const tokenHash = this.hashToken(token)

    const result = await db.query<Omit<Session, 'token'>>(
      `SELECT id, user_id, expires_at, created_at 
       FROM sessions 
       WHERE token_hash = $1 
       AND expires_at > CURRENT_TIMESTAMP`,
      [tokenHash]
    )

    if (result.rows.length === 0) {
      return null
    }

    // Return session without exposing the token
    return { ...result.rows[0], token }
  }

  /**
   * Get a session with its associated user
   * @param token The session token
   * @returns The session with user data if valid, null otherwise
   */
  async getSessionWithUser(token: string): Promise<{ session: Session; user: User } | null> {
    const tokenHash = this.hashToken(token)

    const result = await db.query(
      `SELECT 
        s.id as session_id,
        s.user_id,
        s.expires_at,
        s.created_at as session_created_at,
        u.id as user_id,
        u.email,
        u.name,
        u.google_id,
        u.allowed_domain,
        u.created_at as user_created_at,
        u.updated_at as user_updated_at
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token_hash = $1 
       AND s.expires_at > CURRENT_TIMESTAMP`,
      [tokenHash]
    )

    if (result.rows.length === 0) {
      return null
    }

    const row = result.rows[0]
    return {
      session: {
        id: row.session_id,
        user_id: row.user_id,
        token: token, // Return the original token, not the hash
        expires_at: row.expires_at,
        created_at: row.session_created_at,
      },
      user: {
        id: row.user_id,
        email: row.email,
        name: row.name,
        google_id: row.google_id,
        allowed_domain: row.allowed_domain,
        created_at: row.user_created_at,
        updated_at: row.user_updated_at,
      },
    }
  }

  /**
   * Refresh a session by extending its expiry
   * @param token The session token to refresh
   * @param expiresInDays Number of days to extend
   * @returns The updated session or null if not found
   */
  async refreshSession(
    token: string,
    expiresInDays: number = this.DEFAULT_SESSION_DURATION_DAYS
  ): Promise<Session | null> {
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + expiresInDays)

    const tokenHash = this.hashToken(token)

    const result = await db.query<Omit<Session, 'token'>>(
      `UPDATE sessions 
       SET expires_at = $2
       WHERE token_hash = $1 
       AND expires_at > CURRENT_TIMESTAMP
       RETURNING id, user_id, expires_at, created_at`,
      [tokenHash, expiresAt]
    )

    if (result.rows.length === 0) {
      return null
    }

    // Return session with the original token
    return { ...result.rows[0], token }
  }

  /**
   * Delete a session (logout)
   * @param token The session token to delete
   * @returns True if deleted, false if not found
   */
  async deleteSession(token: string): Promise<boolean> {
    const tokenHash = this.hashToken(token)

    const result = await db.query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash])

    return (result.rowCount ?? 0) > 0
  }

  /**
   * Delete all sessions for a user
   * @param userId The user ID
   * @returns Number of sessions deleted
   */
  async deleteUserSessions(userId: string): Promise<number> {
    const result = await db.query(`DELETE FROM sessions WHERE user_id = $1`, [userId])

    return result.rowCount ?? 0
  }

  /**
   * Clean up expired sessions
   * @returns Number of sessions deleted
   */
  async cleanupExpiredSessions(): Promise<number> {
    const result = await db.query(`DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP`)

    return result.rowCount ?? 0
  }

  /**
   * Get active session count for a user
   * @param userId The user ID
   * @returns Number of active sessions
   */
  async getActiveSessionCount(userId: string): Promise<number> {
    const result = await db.query<{ count: string }>(
      `SELECT COUNT(*) as count 
       FROM sessions 
       WHERE user_id = $1 
       AND expires_at > CURRENT_TIMESTAMP`,
      [userId]
    )

    return parseInt(result.rows[0].count, 10)
  }

  /**
   * Get session duration from environment or use default
   * @returns Session duration in days
   */
  getSessionDuration(): number {
    const duration = process.env.SESSION_DURATION_DAYS
    return duration ? parseInt(duration, 10) : this.DEFAULT_SESSION_DURATION_DAYS
  }
}

// Export singleton instance
export const sessionService = new SessionService()
