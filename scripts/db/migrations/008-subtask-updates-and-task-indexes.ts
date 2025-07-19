#!/usr/bin/env bun
/**
 * Migration 008: Update subtask conversation IDs and optimize Task queries
 *
 * This migration:
 * 1. Updates subtasks to inherit their parent task's conversation_id
 * 2. Fixes subtask branch numbering to use sequential subtask_N format
 * 3. Creates indexes to optimize queries for Task tool invocations
 *
 * Key changes:
 * - Subtasks now properly belong to their parent's conversation
 * - Branch IDs follow a consistent subtask_1, subtask_2... pattern
 * - Optimized indexes for finding Task tool invocations in response_body
 *
 * Note: For production deployments with large tables, consider using
 * CREATE INDEX CONCURRENTLY to avoid locking the table during index creation.
 */

import { Pool } from 'pg'
import dotenv from 'dotenv'
import path from 'path'

// Load environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env') })

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

// Constants
const MIGRATION_NAME = '008-subtask-updates-and-task-indexes'
const SUBTASK_BRANCH_PREFIX = 'subtask_'
const SUBTASK_BRANCH_PATTERN = 'subtask_%'
const TASK_TOOL_NAME = 'Task'

async function migrate() {
  const client = await pool.connect()

  try {
    console.log(`Starting migration: ${MIGRATION_NAME}...`)

    await client.query('BEGIN')

    // First, let's analyze the current state
    console.log('Analyzing current subtask state...')
    const analysisResult = await client.query(`
      SELECT 
        COUNT(*) FILTER (WHERE is_subtask = true) as total_subtasks,
        COUNT(*) FILTER (WHERE is_subtask = true AND parent_task_request_id IS NOT NULL) as subtasks_with_parent,
        COUNT(*) FILTER (WHERE is_subtask = true AND conversation_id IS NOT NULL) as subtasks_with_conversation,
        COUNT(*) FILTER (WHERE is_subtask = true AND branch_id LIKE '${SUBTASK_BRANCH_PATTERN}') as subtasks_with_branch
      FROM api_requests
    `)
    console.log('Current state:', analysisResult.rows[0])

    // Update subtasks to inherit parent's conversation_id
    console.log('Updating subtask conversation IDs to match parent tasks...')

    const updateQuery = `
      WITH parent_conversations AS (
        -- Find parent task conversations
        SELECT 
          child.request_id AS subtask_id,
          parent.conversation_id AS parent_conversation_id,
          parent.branch_id AS parent_branch_id
        FROM api_requests child
        INNER JOIN api_requests parent ON 
          child.parent_task_request_id = parent.request_id
        WHERE child.is_subtask = true
          AND child.parent_task_request_id IS NOT NULL
          AND parent.conversation_id IS NOT NULL
      )
      UPDATE api_requests
      SET 
        conversation_id = parent_conversations.parent_conversation_id,
        -- Keep the subtask branch if it exists, otherwise generate one
        branch_id = CASE 
          WHEN api_requests.branch_id LIKE '${SUBTASK_BRANCH_PATTERN}' THEN api_requests.branch_id
          ELSE '${SUBTASK_BRANCH_PREFIX}1'
        END
      FROM parent_conversations
      WHERE api_requests.request_id = parent_conversations.subtask_id
        AND (
          -- Update if conversation_id doesn't match parent
          api_requests.conversation_id IS DISTINCT FROM parent_conversations.parent_conversation_id
          OR 
          -- Or if branch_id is not a subtask branch
          api_requests.branch_id NOT LIKE '${SUBTASK_BRANCH_PATTERN}'
        );
    `

    const result = await client.query(updateQuery)
    console.log(`Updated ${result.rowCount} subtask records`)

    // Update orphaned subtasks (where parent_task_request_id exists but parent is missing)
    console.log('Checking for orphaned subtasks...')
    const orphanedResult = await client.query(`
      SELECT COUNT(*) as orphaned_count
      FROM api_requests child
      WHERE child.is_subtask = true
        AND child.parent_task_request_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM api_requests parent 
          WHERE parent.request_id = child.parent_task_request_id
        )
    `)
    console.log(`Found ${orphanedResult.rows[0].orphaned_count} orphaned subtasks`)

    // Generate proper subtask branch IDs for subtasks
    console.log('Fixing subtask branch numbering...')
    const branchFixQuery = `
      WITH subtask_numbering AS (
        SELECT 
          request_id,
          parent_task_request_id,
          ROW_NUMBER() OVER (
            PARTITION BY parent_task_request_id 
            ORDER BY timestamp, request_id
          ) as subtask_number
        FROM api_requests
        WHERE is_subtask = true
          AND parent_task_request_id IS NOT NULL
      )
      UPDATE api_requests
      SET branch_id = '${SUBTASK_BRANCH_PREFIX}' || subtask_numbering.subtask_number
      FROM subtask_numbering
      WHERE api_requests.request_id = subtask_numbering.request_id
        AND api_requests.branch_id != ('${SUBTASK_BRANCH_PREFIX}' || subtask_numbering.subtask_number);
    `

    const branchResult = await client.query(branchFixQuery)
    console.log(`Fixed branch IDs for ${branchResult.rowCount} subtasks`)

    // Create indexes for Task invocation queries
    console.log('\nCreating indexes for Task invocation queries...')

    // Create a GIN index for faster JSONB searches on response_body
    console.log('Creating GIN index on response_body for Task tool searches...')
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_requests_response_body_task
      ON api_requests USING gin (response_body)
      WHERE response_body IS NOT NULL;
    `)

    // Create a composite index for domain + timestamp queries
    console.log('Creating composite index for domain and timestamp...')
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_requests_domain_timestamp_response
      ON api_requests(domain, timestamp DESC)
      WHERE response_body IS NOT NULL;
    `)

    // Add a JSONB path index for finding Task tool invocations
    console.log('Creating JSONB path index for Task tool searches...')
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_requests_task_invocation
      ON api_requests ((jsonb_path_exists(response_body, '$.content[*] ? (@.name == "${TASK_TOOL_NAME}")')))
      WHERE response_body IS NOT NULL;
    `)

    await client.query('COMMIT')
    console.log('Migration 008 completed successfully!')

    // Report final statistics
    const finalStats = await client.query(`
      SELECT 
        COUNT(*) FILTER (WHERE is_subtask = true) as total_subtasks,
        COUNT(*) FILTER (WHERE is_subtask = true AND parent_task_request_id IS NOT NULL) as subtasks_with_parent,
        COUNT(*) FILTER (WHERE is_subtask = true AND conversation_id IS NOT NULL) as subtasks_with_conversation,
        COUNT(*) FILTER (WHERE is_subtask = true AND branch_id LIKE '${SUBTASK_BRANCH_PATTERN}') as subtasks_with_branch,
        COUNT(*) FILTER (
          WHERE is_subtask = true 
          AND parent_task_request_id IS NOT NULL
          AND conversation_id = (
            SELECT conversation_id 
            FROM api_requests p 
            WHERE p.request_id = api_requests.parent_task_request_id
          )
        ) as subtasks_matching_parent_conversation
      FROM api_requests
    `)
    console.log('Final state:', finalStats.rows[0])

    // Report on created indexes
    console.log('\nVerifying created indexes...')
    const indexCheck = await client.query(`
      SELECT 
        indexname,
        indexdef
      FROM pg_indexes
      WHERE tablename = 'api_requests'
        AND indexname IN (
          'idx_api_requests_response_body_task',
          'idx_api_requests_domain_timestamp_response',
          'idx_api_requests_task_invocation'
        )
      ORDER BY indexname;
    `)

    console.log('Created Task-related indexes:')
    for (const row of indexCheck.rows) {
      console.log(`  ✓ ${row.indexname}`)
    }
  } catch (error) {
    await client.query('ROLLBACK')
    console.error(`Migration ${MIGRATION_NAME} failed:`, error)
    throw error
  } finally {
    client.release()
  }
}

// Rollback function for reversibility
async function rollback() {
  const client = await pool.connect()

  try {
    console.log(`Rolling back migration ${MIGRATION_NAME}...`)

    await client.query('BEGIN')

    // Drop indexes first
    console.log('Dropping Task invocation indexes...')
    await client.query('DROP INDEX IF EXISTS idx_api_requests_task_invocation;')
    await client.query('DROP INDEX IF EXISTS idx_api_requests_domain_timestamp_response;')
    await client.query('DROP INDEX IF EXISTS idx_api_requests_response_body_task;')

    // Reset subtask conversation_ids and branch_ids to their original state
    // This is a simplified rollback - in production you'd want to store the original values
    console.log('Resetting subtask conversation IDs and branch IDs...')

    const rollbackQuery = `
      UPDATE api_requests
      SET 
        conversation_id = NULL,
        branch_id = 'main'
      WHERE is_subtask = true
        AND parent_task_request_id IS NOT NULL;
    `

    const result = await client.query(rollbackQuery)
    console.log(`Reset ${result.rowCount} subtask records`)

    await client.query('COMMIT')
    console.log(`Rollback ${MIGRATION_NAME} completed successfully!`)
  } catch (error) {
    await client.query('ROLLBACK')
    console.error(`Rollback ${MIGRATION_NAME} failed:`, error)
    throw error
  } finally {
    client.release()
  }
}

// Main execution
async function main() {
  const command = process.argv[2]

  try {
    if (command === 'rollback') {
      await rollback()
    } else {
      await migrate()
    }
  } catch (error) {
    console.error(`${MIGRATION_NAME} error:`, error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

main()
