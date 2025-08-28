#!/usr/bin/env bun
import { Pool } from 'pg'
import { getErrorMessage } from '@agent-prompttrain/shared'

/**
 * Migration script to add sub-task tracking columns to the database
 * and retroactively process existing Task tool invocations.
 * This migration is idempotent - it can be run multiple times safely.
 */
async function migrateSubtaskSchema() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: databaseUrl })

  try {
    console.log('Starting sub-task tracking schema migration...')

    // Start transaction
    await pool.query('BEGIN')

    // Add new columns to api_requests table
    console.log('Adding sub-task tracking columns...')
    await pool.query(`
      ALTER TABLE api_requests
      ADD COLUMN IF NOT EXISTS parent_task_request_id UUID REFERENCES api_requests(request_id),
      ADD COLUMN IF NOT EXISTS is_subtask BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS task_tool_invocation JSONB
    `)

    // Create indexes for efficient lookups
    console.log('Creating indexes...')
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_requests_parent_task_request_id 
      ON api_requests(parent_task_request_id)
    `)

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_requests_is_subtask 
      ON api_requests(is_subtask)
    `)

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_requests_task_tool_invocation_gin
      ON api_requests USING GIN(task_tool_invocation)
      WHERE task_tool_invocation IS NOT NULL
    `)

    // Add column comments
    console.log('Adding column comments...')
    await pool.query(`
      COMMENT ON COLUMN api_requests.parent_task_request_id IS 'References the request that spawned this sub-task via Task tool';
      COMMENT ON COLUMN api_requests.is_subtask IS 'Indicates if this conversation was spawned as a sub-task';
      COMMENT ON COLUMN api_requests.task_tool_invocation IS 'Stores the Task tool invocation details from parent request';
    `)

    // Verify all columns exist
    console.log('Verifying migration...')
    const columnCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'api_requests' 
      AND column_name IN ('parent_task_request_id', 'is_subtask', 'task_tool_invocation')
    `)

    const foundColumns = columnCheck.rows.map(row => row.column_name)
    const expectedColumns = ['parent_task_request_id', 'is_subtask', 'task_tool_invocation']
    const missingColumns = expectedColumns.filter(col => !foundColumns.includes(col))

    if (missingColumns.length > 0) {
      throw new Error(`Missing columns after migration: ${missingColumns.join(', ')}`)
    }

    console.log('✅ Schema migration completed successfully!')

    // Process existing data (idempotent)
    console.log('\n🔍 Processing existing Task tool invocations...')

    // Count how many requests already have task_tool_invocation populated
    const {
      rows: [{ processed_count }],
    } = await pool.query(`
      SELECT COUNT(*) as processed_count 
      FROM api_requests 
      WHERE task_tool_invocation IS NOT NULL
    `)

    console.log(`Found ${processed_count} requests already processed`)

    // Find all requests that have Task tool invocations in their response body but haven't been processed yet
    const findTasksQuery = `
      WITH unprocessed_tasks AS (
        SELECT request_id, response_body, conversation_id, timestamp
        FROM api_requests
        WHERE response_body IS NOT NULL
          AND response_body->'content' IS NOT NULL
          AND task_tool_invocation IS NULL
          AND jsonb_typeof(response_body->'content') = 'array'
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(response_body->'content') AS elem
            WHERE elem->>'type' = 'tool_use' AND elem->>'name' = 'Task'
          )
      )
      SELECT * FROM unprocessed_tasks
    `

    const { rows: requests } = await pool.query(findTasksQuery)
    console.log(`Found ${requests.length} new requests to process`)

    if (requests.length > 0) {
      // Process all requests in a single batch operation
      console.log('🔄 Processing Task invocations in batch...')

      // Extract task invocations and update in batch
      const updateTaskInvocationsQuery = `
        WITH task_extractions AS (
          SELECT 
            request_id,
            jsonb_agg(
              jsonb_build_object(
                'id', elem->>'id',
                'name', COALESCE(elem->>'name', 'Task'),
                'prompt', COALESCE(elem->'input'->>'prompt', ''),
                'description', COALESCE(elem->'input'->>'description', '')
              ) ORDER BY ordinality
            ) as task_invocations
          FROM api_requests,
            jsonb_array_elements(response_body->'content') WITH ORDINALITY AS t(elem, ordinality)
          WHERE response_body IS NOT NULL
            AND task_tool_invocation IS NULL
            AND elem->>'type' = 'tool_use' 
            AND elem->>'name' = 'Task'
          GROUP BY request_id
        )
        UPDATE api_requests ar
        SET task_tool_invocation = te.task_invocations
        FROM task_extractions te
        WHERE ar.request_id = te.request_id
        RETURNING ar.request_id
      `

      const { rowCount: processedCount } = await pool.query(updateTaskInvocationsQuery)
      console.log(`✅ Updated ${processedCount} requests with Task invocations`)

      // Now perform batch linking based on prompts AND timing
      console.log('🔗 Performing batch subtask linking...')

      const batchLinkQuery = `
        WITH parent_task_prompts AS (
          SELECT 
            ar.request_id,
            ar.timestamp,
            ar.conversation_id as parent_conversation_id,
            jsonb_array_elements(ar.task_tool_invocation) as task,
            (jsonb_array_elements(ar.task_tool_invocation)->>'prompt') as prompt
          FROM api_requests ar
          WHERE ar.task_tool_invocation IS NOT NULL
            AND (jsonb_array_elements(ar.task_tool_invocation)->>'prompt') != ''
        ),
        first_messages AS (
          SELECT DISTINCT ON (ar.conversation_id)
            ar.conversation_id,
            ar.timestamp,
            ar.body->'messages'->0->>'content' as string_content,
            ar.body->'messages'->0->'content'->0->>'text' as array_content_0,
            ar.body->'messages'->0->'content'->1->>'text' as array_content_1
          FROM api_requests ar
          WHERE ar.timestamp = (
            SELECT MIN(timestamp) FROM api_requests WHERE conversation_id = ar.conversation_id
          )
          AND ar.body->'messages'->0->>'role' = 'user'
          AND ar.parent_task_request_id IS NULL  -- Not already linked
          ORDER BY ar.conversation_id, ar.timestamp
        ),
        matched_subtasks AS (
          SELECT DISTINCT
            ptp.request_id as parent_request_id,
            fm.conversation_id as subtask_conversation_id
          FROM parent_task_prompts ptp
          JOIN first_messages fm ON (
            fm.timestamp > ptp.timestamp AND
            fm.timestamp < ptp.timestamp + interval '30 seconds' AND
            fm.conversation_id != ptp.parent_conversation_id AND
            (
              fm.string_content = ptp.prompt OR
              fm.array_content_0 = ptp.prompt OR
              fm.array_content_1 = ptp.prompt
            )
          )
        )
        UPDATE api_requests ar
        SET 
          parent_task_request_id = ms.parent_request_id,
          is_subtask = true
        FROM matched_subtasks ms
        WHERE ar.conversation_id = ms.subtask_conversation_id
        RETURNING ar.conversation_id, ar.parent_task_request_id
      `

      const { rowCount: linkedCount } = await pool.query(batchLinkQuery)
      console.log(`✅ Linked ${linkedCount || 0} sub-task conversations based on prompt matching`)

      // Update task invocations with linked conversation IDs
      // TODO: Handle multiple sub-tasks per parent (MEDIUM)
      // Currently only updates the first task invocation (index 0) in the array.
      // If a parent request spawns multiple sub-tasks, only the first gets linked.
      // Need to match sub-task prompts to specific array indices for complete linking.
      // See: https://github.com/Moonsong-Labs/agent-prompttrain-proxy/pull/13#review
      if (linkedCount && linkedCount > 0) {
        const updateLinkedConversationsQuery = `
          WITH linked_tasks AS (
            SELECT 
              parent_task_request_id,
              conversation_id,
              ROW_NUMBER() OVER (PARTITION BY parent_task_request_id ORDER BY MIN(request_id)) as rn
            FROM api_requests
            WHERE parent_task_request_id IS NOT NULL
            GROUP BY parent_task_request_id, conversation_id
          )
          UPDATE api_requests ar
          SET task_tool_invocation = jsonb_set(
            COALESCE(ar.task_tool_invocation, '[]'::jsonb),
            '{0,linked_conversation_id}',
            to_jsonb(lt.conversation_id)
          )
          FROM linked_tasks lt
          WHERE ar.request_id = lt.parent_task_request_id
          AND lt.rn = 1
          AND NOT (ar.task_tool_invocation->0->>'linked_conversation_id' IS NOT NULL)
        `

        await pool.query(updateLinkedConversationsQuery)
      }
    }

    // Commit transaction
    await pool.query('COMMIT')

    // Final summary
    const {
      rows: [summary],
    } = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE task_tool_invocation IS NOT NULL) as tasks_with_invocations,
        COUNT(*) FILTER (WHERE is_subtask = true) as subtask_conversations,
        COUNT(DISTINCT parent_task_request_id) as parent_tasks_with_subtasks
      FROM api_requests
    `)

    console.log('\n✨ Migration and data processing complete!')
    console.log(`   - ${summary.tasks_with_invocations} requests with Task invocations`)
    console.log(`   - ${summary.subtask_conversations} sub-task conversations`)
    console.log(`   - ${summary.parent_tasks_with_subtasks} parent tasks with linked sub-tasks`)
  } catch (error) {
    // Rollback on error
    await pool.query('ROLLBACK')
    console.error('Migration failed:', getErrorMessage(error))
    process.exit(1)
  } finally {
    await pool.end()
  }
}

// Run migration
migrateSubtaskSchema().catch(console.error)
