import { Pool } from 'pg'
import type {
  Project,
  ProjectWithAccounts,
  CreateProjectRequest,
  UpdateProjectRequest,
  AnthropicCredential,
  SlackConfig,
} from '../../types/credentials'
import { toSafeCredential } from './credential-queries-internal'

/**
 * Create a new project with a randomly selected default account
 */
export async function createProject(pool: Pool, request: CreateProjectRequest): Promise<Project> {
  // Get a random credential to use as default
  const credentialResult = await pool.query<{ id: string }>(
    'SELECT id FROM anthropic_credentials ORDER BY RANDOM() LIMIT 1'
  )

  const defaultAccountId = credentialResult.rows[0]?.id || null

  const result = await pool.query<Project>(
    `
    INSERT INTO projects (
      project_id,
      name,
      slack_enabled,
      slack_webhook_url,
      slack_channel,
      slack_username,
      slack_icon_emoji,
      is_private,
      default_account_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
    `,
    [
      request.project_id,
      request.name,
      request.slack_enabled ?? false,
      request.slack_webhook_url || null,
      request.slack_channel || null,
      request.slack_username || null,
      request.slack_icon_emoji || null,
      request.is_private ?? false,
      defaultAccountId,
    ]
  )

  return result.rows[0]
}

/**
 * Get train by UUID
 */
export async function getProjectById(pool: Pool, id: string): Promise<Project | null> {
  const result = await pool.query<Project>('SELECT * FROM projects WHERE id = $1', [id])
  return result.rows[0] || null
}

/**
 * Get train by project_id
 */
export async function getProjectByProjectId(
  pool: Pool,
  projectId: string
): Promise<Project | null> {
  const result = await pool.query<Project>('SELECT * FROM projects WHERE project_id = $1', [
    projectId,
  ])
  return result.rows[0] || null
}

/**
 * Get train with all available accounts
 * All projects have access to all credentials
 */
export async function getProjectWithAccounts(
  pool: Pool,
  projectId: string
): Promise<ProjectWithAccounts | null> {
  const train = await getProjectByProjectId(pool, projectId)
  if (!train) {
    return null
  }

  // All projects have access to all credentials
  const accountsResult = await pool.query<AnthropicCredential>(
    `SELECT * FROM anthropic_credentials ORDER BY account_name ASC`
  )

  return {
    ...train,
    accounts: accountsResult.rows.map(cred => toSafeCredential(cred)),
  }
}

/**
 * List all projects
 */
export async function listProjects(pool: Pool): Promise<Project[]> {
  const result = await pool.query<Project>('SELECT * FROM projects ORDER BY name ASC')
  return result.rows
}

/**
 * List all projects with all available accounts
 * All projects have access to all credentials
 */
export async function listProjectsWithAccounts(pool: Pool): Promise<ProjectWithAccounts[]> {
  const projects = await listProjects(pool)

  // Get all credentials once (shared across all projects)
  const accountsResult = await pool.query<AnthropicCredential>(
    `SELECT * FROM anthropic_credentials ORDER BY account_name ASC`
  )

  const allAccounts = accountsResult.rows.map(cred => toSafeCredential(cred))

  // All projects have access to all credentials
  const trainsWithAccounts = projects.map(train => ({
    ...train,
    accounts: allAccounts,
  }))

  return trainsWithAccounts
}

/**
 * Update train configuration
 */
export async function updateProject(
  pool: Pool,
  id: string,
  request: UpdateProjectRequest
): Promise<Project> {
  const updates: string[] = []
  const values: unknown[] = []
  let paramIndex = 1

  if (request.name !== undefined) {
    updates.push(`name = $${paramIndex++}`)
    values.push(request.name)
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
  if (request.is_private !== undefined) {
    updates.push(`is_private = $${paramIndex++}`)
    values.push(request.is_private)
  }

  if (updates.length === 0) {
    const train = await getProjectById(pool, id)
    if (!train) {
      throw new Error(`Project with ID ${id} not found`)
    }
    return train
  }

  updates.push(`updated_at = NOW()`)
  values.push(id)

  const result = await pool.query<Project>(
    `UPDATE projects SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  )

  if (result.rows.length === 0) {
    throw new Error(`Project with ID ${id} not found`)
  }

  return result.rows[0]
}

/**
 * Delete a project
 */
export async function deleteProject(pool: Pool, id: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM projects WHERE id = $1', [id])
  return (result.rowCount ?? 0) > 0
}

/**
 * Set the default account for a project
 */
export async function setProjectDefaultAccount(
  pool: Pool,
  projectId: string,
  credentialId: string
): Promise<Project> {
  const result = await pool.query<Project>(
    `
    UPDATE projects
    SET default_account_id = $2, updated_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [projectId, credentialId]
  )

  if (result.rows.length === 0) {
    throw new Error(`Project with ID ${projectId} not found`)
  }

  return result.rows[0]
}

/**
 * Get the default credential for a project
 * Returns only the project's default_account_id credential
 */
export async function getProjectCredentials(
  pool: Pool,
  projectId: string
): Promise<AnthropicCredential[]> {
  const result = await pool.query<AnthropicCredential>(
    `
    SELECT ac.*
    FROM projects p
    JOIN anthropic_credentials ac ON p.default_account_id = ac.id
    WHERE p.project_id = $1
    `,
    [projectId]
  )

  return result.rows
}

/**
 * Get Slack configuration for a project
 */
export async function getProjectSlackConfig(
  pool: Pool,
  projectId: string
): Promise<SlackConfig | null> {
  const train = await getProjectByProjectId(pool, projectId)
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

/**
 * Get train statistics (last used, 24h request count)
 */
export async function getProjectStats(
  pool: Pool,
  projectId: string
): Promise<{ lastUsedAt: Date | null; requestCount24h: number }> {
  const result = await pool.query<{ last_used_at: Date | null }>(
    `
    SELECT
      MAX(tak.last_used_at) as last_used_at
    FROM projects t
    LEFT JOIN project_api_keys tak ON t.id = tak.project_id
    WHERE t.id = $1
    GROUP BY t.id
    `,
    [projectId]
  )

  return {
    lastUsedAt: result.rows[0]?.last_used_at || null,
    requestCount24h: 0, // TODO: Implement request tracking
  }
}
