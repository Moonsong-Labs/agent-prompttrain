import { Pool } from 'pg'
import type {
  ProjectMember,
  ProjectMemberRole,
  Project,
  ProjectWithAccounts,
  AnthropicCredential,
} from '../../types/index.js'
import { toSafeCredential } from './credential-queries.js'

/**
 * Add a member to a project
 * Does not modify role if member already exists (use updateProjectMemberRole for that)
 */
export async function addProjectMember(
  pool: Pool,
  projectId: string,
  userEmail: string,
  role: ProjectMemberRole,
  addedBy: string
): Promise<ProjectMember> {
  const result = await pool.query<ProjectMember>(
    `
    INSERT INTO project_members (project_id, user_email, role, added_by)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (project_id, user_email) DO NOTHING
    RETURNING *
    `,
    [projectId, userEmail, role, addedBy]
  )

  // If no rows returned, member already exists - fetch and return existing
  if (result.rows.length === 0) {
    const existing = await pool.query<ProjectMember>(
      'SELECT * FROM project_members WHERE project_id = $1 AND user_email = $2',
      [projectId, userEmail]
    )
    return existing.rows[0]
  }

  return result.rows[0]
}

/**
 * Remove a member from a project
 * Throws error if attempting to remove the last owner
 * Uses transaction with row locking to prevent race conditions
 */
export async function removeProjectMember(
  pool: Pool,
  projectId: string,
  userEmail: string
): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    // Lock the member row for update
    const memberResult = await client.query<ProjectMember>(
      'SELECT * FROM project_members WHERE project_id = $1 AND user_email = $2 FOR UPDATE',
      [projectId, userEmail]
    )

    if (memberResult.rows.length === 0) {
      throw new Error('Member not found')
    }

    const member = memberResult.rows[0]

    if (member.role === 'owner') {
      // Lock all owner rows for this project to prevent concurrent modifications
      await client.query(
        'SELECT 1 FROM project_members WHERE project_id = $1 AND role = $2 FOR UPDATE',
        [projectId, 'owner']
      )

      // Count owners
      const countResult = await client.query<{ count: string }>(
        'SELECT COUNT(*) as count FROM project_members WHERE project_id = $1 AND role = $2',
        [projectId, 'owner']
      )
      const ownerCount = parseInt(countResult.rows[0]?.count ?? '0', 10)

      if (ownerCount <= 1) {
        throw new Error('Cannot remove the last owner from a project')
      }
    }

    await client.query('DELETE FROM project_members WHERE project_id = $1 AND user_email = $2', [
      projectId,
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
 * Get all members of a project
 */
export async function getProjectMembers(pool: Pool, projectId: string): Promise<ProjectMember[]> {
  const result = await pool.query<ProjectMember>(
    `
    SELECT * FROM project_members
    WHERE project_id = $1
    ORDER BY role DESC, user_email ASC
    `,
    [projectId]
  )

  return result.rows
}

/**
 * Get all projects where user is a member or owner
 */
export async function getUserProjects(pool: Pool, userEmail: string): Promise<Project[]> {
  const result = await pool.query<Project>(
    `
    SELECT t.*
    FROM projects t
    INNER JOIN project_members tm ON tm.project_id = t.id
    WHERE tm.user_email = $1
    ORDER BY t.name ASC
    `,
    [userEmail]
  )

  return result.rows
}

/**
 * Get all projects where user is a member or owner, with associated accounts
 */
export async function getUserProjectsWithAccounts(
  pool: Pool,
  userEmail: string
): Promise<ProjectWithAccounts[]> {
  const projects = await getUserProjects(pool, userEmail)

  // All projects have access to all credentials
  const accountsResult = await pool.query<AnthropicCredential>(
    `SELECT * FROM anthropic_credentials ORDER BY account_name ASC`
  )
  const allAccounts = accountsResult.rows.map(cred => toSafeCredential(cred))

  const projectsWithAccounts = projects.map(project => ({
    ...project,
    accounts: allAccounts,
  }))

  return projectsWithAccounts
}

/**
 * Check if a user is an owner of a project
 */
export async function isProjectOwner(
  pool: Pool,
  projectId: string,
  userEmail: string
): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `
    SELECT EXISTS(
      SELECT 1 FROM project_members
      WHERE project_id = $1 AND user_email = $2 AND role = 'owner'
    ) as exists
    `,
    [projectId, userEmail]
  )

  return result.rows[0]?.exists ?? false
}

/**
 * Check if a user is a member (owner or member) of a project
 */
export async function isProjectMember(
  pool: Pool,
  projectId: string,
  userEmail: string
): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `
    SELECT EXISTS(
      SELECT 1 FROM project_members
      WHERE project_id = $1 AND user_email = $2
    ) as exists
    `,
    [projectId, userEmail]
  )

  return result.rows[0]?.exists ?? false
}

/**
 * Update a member's role
 * Throws error if attempting to demote the last owner
 * Uses transaction with row locking to prevent race conditions
 */
export async function updateProjectMemberRole(
  pool: Pool,
  projectId: string,
  userEmail: string,
  newRole: ProjectMemberRole
): Promise<ProjectMember> {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    // Lock the member row for update
    const memberResult = await client.query<ProjectMember>(
      'SELECT * FROM project_members WHERE project_id = $1 AND user_email = $2 FOR UPDATE',
      [projectId, userEmail]
    )

    if (memberResult.rows.length === 0) {
      throw new Error('Member not found')
    }

    const member = memberResult.rows[0]

    if (member.role === 'owner' && newRole === 'member') {
      // Lock all owner rows for this project to prevent concurrent modifications
      await client.query(
        'SELECT 1 FROM project_members WHERE project_id = $1 AND role = $2 FOR UPDATE',
        [projectId, 'owner']
      )

      // Count owners
      const countResult = await client.query<{ count: string }>(
        'SELECT COUNT(*) as count FROM project_members WHERE project_id = $1 AND role = $2',
        [projectId, 'owner']
      )
      const ownerCount = parseInt(countResult.rows[0]?.count ?? '0', 10)

      if (ownerCount <= 1) {
        throw new Error('Cannot demote the last owner')
      }
    }

    const result = await client.query<ProjectMember>(
      `
      UPDATE project_members
      SET role = $3
      WHERE project_id = $1 AND user_email = $2
      RETURNING *
      `,
      [projectId, userEmail, newRole]
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
 * Get the count of owners for a project
 */
export async function getOwnerCount(pool: Pool, projectId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `
    SELECT COUNT(*) as count
    FROM project_members
    WHERE project_id = $1 AND role = 'owner'
    `,
    [projectId]
  )

  return parseInt(result.rows[0]?.count ?? '0', 10)
}
