#!/usr/bin/env bun

/**
 * Disable or enable a project
 *
 * When a project is disabled, its API keys are rejected at authentication time,
 * preventing any member from using the project to make API requests.
 * Disabled projects remain visible in the dashboard for historical reference.
 *
 * Usage:
 *   bun run scripts/disable-project.ts <project_id>              # Disable a project
 *   bun run scripts/disable-project.ts <project_id> --enable     # Re-enable a project
 *   bun run scripts/disable-project.ts --list-disabled            # List all disabled projects
 *
 * Requires DATABASE_URL environment variable.
 */

import { Pool } from 'pg'

interface ProjectRow {
  id: string
  project_id: string
  name: string
  disabled: boolean
  updated_at: Date
}

async function setProjectDisabled(pool: Pool, projectId: string, disabled: boolean): Promise<void> {
  // Find the project
  const findResult = await pool.query<ProjectRow>(
    'SELECT id, project_id, name, disabled FROM projects WHERE project_id = $1',
    [projectId]
  )

  if (findResult.rows.length === 0) {
    console.error(`\n❌ Project not found: ${projectId}`)
    console.error('\nAvailable projects:')
    const allProjects = await pool.query<ProjectRow>(
      'SELECT project_id, name, disabled FROM projects ORDER BY name ASC'
    )
    for (const p of allProjects.rows) {
      const status = p.disabled ? ' [DISABLED]' : ''
      console.error(`  - ${p.project_id} (${p.name})${status}`)
    }
    process.exit(1)
  }

  const project = findResult.rows[0]

  if (project.disabled === disabled) {
    console.log(
      `\nProject "${project.name}" (${project.project_id}) is already ${disabled ? 'disabled' : 'enabled'}.`
    )
    return
  }

  // Update the project
  await pool.query('UPDATE projects SET disabled = $1, updated_at = NOW() WHERE id = $2', [
    disabled,
    project.id,
  ])

  if (disabled) {
    console.log(`\n✅ Project "${project.name}" (${project.project_id}) has been disabled.`)
    console.log('   All API key authentication for this project will be rejected.')
    console.log('   Existing conversations and data remain accessible in the dashboard.')
  } else {
    console.log(`\n✅ Project "${project.name}" (${project.project_id}) has been re-enabled.`)
    console.log('   API key authentication for this project is now active again.')
  }
}

async function listDisabledProjects(pool: Pool): Promise<void> {
  const result = await pool.query<ProjectRow>(
    'SELECT project_id, name, disabled, updated_at FROM projects WHERE disabled = true ORDER BY updated_at DESC'
  )

  if (result.rows.length === 0) {
    console.log('\nNo disabled projects found.')
    return
  }

  console.log(`\nDisabled projects (${result.rows.length}):`)
  for (const p of result.rows) {
    console.log(`  - ${p.project_id} (${p.name}) — disabled since ${p.updated_at.toISOString()}`)
  }
}

async function main() {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Disable or Enable a Project

Usage:
  bun run scripts/disable-project.ts <project_id>              Disable a project
  bun run scripts/disable-project.ts <project_id> --enable     Re-enable a project
  bun run scripts/disable-project.ts --list-disabled            List all disabled projects
  bun run scripts/disable-project.ts --help                     Show this help message

When a project is disabled:
  - API key authentication is rejected for all project members
  - Existing conversations and data remain accessible in the dashboard
  - The project can be re-enabled at any time with --enable

Requires DATABASE_URL environment variable.
`)
    process.exit(0)
  }

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: databaseUrl })

  try {
    if (args.includes('--list-disabled')) {
      await listDisabledProjects(pool)
      return
    }

    // Find the project_id argument (first non-flag argument)
    const projectId = args.find(arg => !arg.startsWith('--'))

    if (!projectId) {
      console.error('❌ Please provide a project_id')
      console.error('   Usage: bun run scripts/disable-project.ts <project_id>')
      console.error('   Use --help for more information')
      process.exit(1)
    }

    const enable = args.includes('--enable')
    await setProjectDisabled(pool, projectId, !enable)
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  } finally {
    await pool.end()
  }
}

if (import.meta.main) {
  main()
}
