#!/usr/bin/env bun

/**
 * Script to reset stuck analysis jobs.
 *
 * Resets two kinds of stuck jobs that the in-process watchdog may miss
 * (for example when the proxy worker is not running):
 *  1. Jobs in 'processing' that have not been updated within the timeout
 *     window (controlled by AI_WORKER_JOB_TIMEOUT_MINUTES, default 5).
 *  2. Jobs in 'pending' whose retry_count has reached or exceeded
 *     AI_ANALYSIS_MAX_RETRIES (default 3).
 */

import { Pool } from 'pg'
import { config } from 'dotenv'

// Load environment variables
config()

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  })

  const maxRetries = Number(process.env.AI_ANALYSIS_MAX_RETRIES) || 3
  const timeoutMinutes = Number(process.env.AI_WORKER_JOB_TIMEOUT_MINUTES) || 5

  try {
    // 1. Reset jobs stuck in 'processing' beyond the timeout window
    const stuckProcessingResult = await pool.query(
      `
      SELECT id, conversation_id, branch_id, retry_count, updated_at
      FROM conversation_analyses
      WHERE status = 'processing'
        AND updated_at < NOW() - ($1::text || ' minutes')::interval
      ORDER BY updated_at ASC
    `,
      [String(timeoutMinutes)]
    )

    console.log(
      `Found ${stuckProcessingResult.rows.length} jobs stuck in 'processing' for more than ${timeoutMinutes} minutes`
    )

    if (stuckProcessingResult.rows.length > 0) {
      const resetProcessing = await pool.query(
        `
        UPDATE conversation_analyses
        SET status = 'pending',
            retry_count = retry_count + 1,
            updated_at = NOW(),
            error_message = CASE
              WHEN error_message IS NULL THEN '{"stuck_job": "Reset by reset-stuck-analysis-jobs script"}'
              ELSE error_message
            END
        WHERE status = 'processing'
          AND updated_at < NOW() - ($1::text || ' minutes')::interval
        RETURNING id, conversation_id, branch_id
      `,
        [String(timeoutMinutes)]
      )

      console.log(`Reset ${resetProcessing.rowCount} stuck 'processing' jobs to 'pending':`)
      resetProcessing.rows.forEach(row => {
        console.log(`  - Job ${row.id}: ${row.conversation_id} (branch: ${row.branch_id})`)
      })
    }

    // 2. Reset 'pending' jobs that have reached the retry limit
    const stuckPendingResult = await pool.query(
      `
      SELECT id, conversation_id, branch_id, retry_count
      FROM conversation_analyses
      WHERE status = 'pending' AND retry_count >= $1
      ORDER BY created_at DESC
    `,
      [maxRetries]
    )

    console.log(
      `\nFound ${stuckPendingResult.rows.length} 'pending' jobs with retry_count >= ${maxRetries}`
    )

    if (stuckPendingResult.rows.length > 0) {
      const resetPending = await pool.query(
        `
        UPDATE conversation_analyses
        SET retry_count = 0,
            error_message = NULL,
            updated_at = NOW()
        WHERE status = 'pending' AND retry_count >= $1
        RETURNING id, conversation_id, branch_id
      `,
        [maxRetries]
      )

      console.log(`Reset ${resetPending.rowCount} retry-exhausted 'pending' jobs:`)
      resetPending.rows.forEach(row => {
        console.log(`  - Job ${row.id}: ${row.conversation_id} (branch: ${row.branch_id})`)
      })
    }

    if (stuckProcessingResult.rows.length === 0 && stuckPendingResult.rows.length === 0) {
      console.log('\nNo stuck jobs found.')
    }
  } catch (error) {
    console.error('Error resetting stuck jobs:', error)
  } finally {
    await pool.end()
  }
}

main()
