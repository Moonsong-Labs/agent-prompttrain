import { container } from '../../container.js'
import { logger } from '../../middleware/logger.js'
import { AI_WORKER_CONFIG } from '@agent-prompttrain/shared/config'
import type {
  AnalysisStatus,
  ConversationAnalysis,
} from '@agent-prompttrain/shared/types/ai-analysis'
import { getErrorMessage, getErrorStack, getErrorCode } from '@agent-prompttrain/shared'

const MAX_RETRIES = AI_WORKER_CONFIG.MAX_RETRIES
const JOB_TIMEOUT_MINUTES = AI_WORKER_CONFIG.JOB_TIMEOUT_MINUTES

export interface ConversationAnalysisJob {
  id: number
  conversation_id: string
  branch_id: string
  status: AnalysisStatus
  retry_count: number
  analysis_content?: string
  analysis_data?: ConversationAnalysis
  raw_response?: unknown
  error_message?: string
  model_used?: string
  prompt_tokens?: number
  completion_tokens?: number
  generated_at?: Date
  processing_duration_ms?: number
  created_at: Date
  updated_at: Date
  custom_prompt?: string
}

export async function claimJob(): Promise<ConversationAnalysisJob | null> {
  const pool = container.getDbPool()
  if (!pool) {
    logger.error('Database pool not available', { metadata: { worker: 'analysis-worker' } })
    return null
  }

  try {
    const claimQuery = `
      UPDATE conversation_analyses
      SET status = 'processing', updated_at = NOW()
      WHERE id = (
        SELECT id
        FROM conversation_analyses
        WHERE status = 'pending' AND retry_count < $1
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *;
    `

    const result = await pool.query(claimQuery, [MAX_RETRIES])
    const { rows } = result

    if (rows.length === 0) {
      return null
    }

    logger.debug(`Claimed job: ${rows[0].id}`, { metadata: { worker: 'analysis-worker' } })
    return rows[0] as ConversationAnalysisJob
  } catch (error) {
    logger.error('Error claiming job', {
      error: {
        message: getErrorMessage(error),
        stack: getErrorStack(error),
        code: getErrorCode(error),
      },
      metadata: { worker: 'analysis-worker' },
    })
    throw error
  }
}

export async function completeJob(
  id: number,
  analysisContent: string,
  analysisData: ConversationAnalysis | null,
  rawResponse: unknown,
  modelUsed: string,
  promptTokens: number,
  completionTokens: number,
  processingDurationMs: number
): Promise<void> {
  const pool = container.getDbPool()
  if (!pool) {
    logger.error('Database pool not available', { metadata: { worker: 'analysis-worker' } })
    throw new Error('Database pool not available')
  }

  try {
    await pool.query(
      `UPDATE conversation_analyses
       SET status = 'completed',
           analysis_content = $1,
           analysis_data = $2,
           raw_response = $3,
           model_used = $4,
           prompt_tokens = $5,
           completion_tokens = $6,
           generated_at = NOW(),
           processing_duration_ms = $7,
           updated_at = NOW(),
           completed_at = NOW()
       WHERE id = $8`,
      [
        analysisContent,
        analysisData ? JSON.stringify(analysisData) : null,
        JSON.stringify(rawResponse),
        modelUsed,
        promptTokens,
        completionTokens,
        processingDurationMs,
        id,
      ]
    )

    logger.debug(`Completed job: ${id}`, { metadata: { worker: 'analysis-worker' } })
  } catch (error) {
    logger.error(`Error completing job ${id}`, {
      error: {
        message: getErrorMessage(error),
        stack: getErrorStack(error),
        code: getErrorCode(error),
      },
      metadata: { worker: 'analysis-worker' },
    })
    throw error
  }
}

export async function failJob(job: ConversationAnalysisJob, error: Error): Promise<void> {
  const pool = container.getDbPool()
  if (!pool) {
    logger.error('Database pool not available', { metadata: { worker: 'analysis-worker' } })
    throw new Error('Database pool not available')
  }

  try {
    const currentRetries = job.retry_count || 0
    const hasMoreRetries = currentRetries < MAX_RETRIES

    const errorDetails = {
      message: error.message,
      name: error.name,
      timestamp: new Date().toISOString(),
    }

    if (hasMoreRetries) {
      let existingErrors = {}
      if (job.error_message) {
        try {
          existingErrors = JSON.parse(job.error_message)
        } catch (_parseError) {
          logger.warn(`Failed to parse existing error_message for job ${job.id}`, {
            metadata: { worker: 'analysis-worker' },
          })
          existingErrors = { parse_error: job.error_message }
        }
      }

      await pool.query(
        `UPDATE conversation_analyses
         SET status = 'pending',
             retry_count = retry_count + 1,
             error_message = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [
          JSON.stringify({
            ...existingErrors,
            [`retry_${currentRetries + 1}`]: errorDetails,
          }),
          job.id,
        ]
      )

      logger.info(
        `Job ${job.id} failed, will retry (attempt ${currentRetries + 1}/${MAX_RETRIES})`,
        { metadata: { worker: 'analysis-worker' } }
      )
    } else {
      let existingErrors = {}
      if (job.error_message) {
        try {
          existingErrors = JSON.parse(job.error_message)
        } catch (_parseError) {
          logger.warn(`Failed to parse existing error_message for job ${job.id}`, {
            metadata: { worker: 'analysis-worker' },
          })
          existingErrors = { parse_error: job.error_message }
        }
      }

      await pool.query(
        `UPDATE conversation_analyses
         SET status = 'failed',
             error_message = $1,
             updated_at = NOW(),
             completed_at = NOW()
         WHERE id = $2`,
        [
          JSON.stringify({
            ...existingErrors,
            final_error: errorDetails,
          }),
          job.id,
        ]
      )

      logger.warn(`Job ${job.id} permanently failed after ${MAX_RETRIES} retries`, {
        metadata: { worker: 'analysis-worker' },
      })
    }
  } catch (dbError) {
    logger.error(`Error updating failed job ${job.id}`, {
      error: {
        message: getErrorMessage(dbError),
        stack: getErrorStack(dbError),
        code: getErrorCode(dbError),
      },
      metadata: { worker: 'analysis-worker' },
    })
    throw dbError
  }
}

export async function resetStuckJobs(): Promise<number> {
  const pool = container.getDbPool()
  if (!pool) {
    logger.error('Database pool not available', { metadata: { worker: 'analysis-worker' } })
    return 0
  }

  try {
    const result = await pool.query(
      `UPDATE conversation_analyses
       SET status = 'pending',
           retry_count = retry_count + 1,
           error_message = CASE 
             WHEN error_message IS NULL THEN '{"stuck_job": "Reset by watchdog"}'
             ELSE CASE
               WHEN error_message::text LIKE '{%' THEN 
                 jsonb_build_object(
                   'previous_errors', error_message::jsonb,
                   'stuck_job', 'Reset by watchdog'
                 )::text
               ELSE 
                 jsonb_build_object(
                   'previous_error', error_message,
                   'stuck_job', 'Reset by watchdog'
                 )::text
             END
           END,
           updated_at = NOW()
       WHERE status = 'processing' 
         AND updated_at < NOW() - INTERVAL '${JOB_TIMEOUT_MINUTES} minutes'`
    )

    const resetCount = result.rowCount || 0
    if (resetCount > 0) {
      logger.info(`Reset ${resetCount} stuck jobs`, { metadata: { worker: 'analysis-worker' } })
    }
    return resetCount
  } catch (error) {
    logger.error('Error resetting stuck jobs', {
      error: {
        message: getErrorMessage(error),
        stack: getErrorStack(error),
        code: getErrorCode(error),
      },
      metadata: { worker: 'analysis-worker' },
    })
    throw error
  }
}

export async function failJobsExceedingMaxRetries(): Promise<number> {
  const pool = container.getDbPool()
  if (!pool) {
    logger.error('Database pool not available', { metadata: { worker: 'analysis-worker' } })
    return 0
  }

  try {
    const result = await pool.query(
      `UPDATE conversation_analyses
       SET status = 'failed',
           error_message = jsonb_build_object(
             'error', 'Maximum retry attempts exceeded',
             'max_retries', $1,
             'retry_count', retry_count,
             'failed_at', NOW()
           )::text,
           updated_at = NOW(),
           completed_at = NOW()
       WHERE status = 'pending' 
         AND retry_count >= $1`,
      [MAX_RETRIES]
    )

    const failedCount = result.rowCount || 0
    if (failedCount > 0) {
      logger.info(`Failed ${failedCount} jobs that exceeded max retries`, {
        metadata: { worker: 'analysis-worker' },
      })
    }
    return failedCount
  } catch (error) {
    logger.error('Error failing jobs with max retries', {
      error: {
        message: getErrorMessage(error),
        stack: getErrorStack(error),
        code: getErrorCode(error),
      },
      metadata: { worker: 'analysis-worker' },
    })
    throw error
  }
}

export async function fetchConversationMessages(
  conversationId: string,
  branchId: string = 'main'
): Promise<Array<{ role: 'user' | 'model'; content: string }>> {
  const pool = container.getDbPool()
  if (!pool) {
    logger.error('Database pool not available', { metadata: { worker: 'analysis-worker' } })
    throw new Error('Database pool not available')
  }

  try {
    const result = await pool.query(
      `SELECT body AS request_body, response_body, created_at
       FROM api_requests
       WHERE conversation_id = $1
         AND branch_id = $2
         AND response_body IS NOT NULL
       ORDER BY created_at ASC`,
      [conversationId, branchId]
    )

    const messages: Array<{ role: 'user' | 'model'; content: string }> = []

    for (const row of result.rows) {
      if (row.request_body?.messages) {
        const lastUserMessage = row.request_body.messages
          .filter((msg: { role: string }) => msg.role === 'user')
          .pop()

        if (lastUserMessage) {
          const content =
            typeof lastUserMessage.content === 'string'
              ? lastUserMessage.content
              : lastUserMessage.content
                  .map((block: { type: string; text?: string }) =>
                    block.type === 'text' ? block.text : ''
                  )
                  .join('\n')

          messages.push({ role: 'user', content })
        }
      }

      if (row.response_body?.content) {
        const assistantContent = row.response_body.content
          .map((block: { type: string; text?: string; name?: string }) => {
            if (block.type === 'text') {
              return block.text
            }
            if (block.type === 'tool_use') {
              return `[Tool Use: ${block.name}]`
            }
            if (block.type === 'tool_result') {
              return `[Tool Result]`
            }
            return ''
          })
          .join('\n')

        messages.push({ role: 'model', content: assistantContent })
      }
    }

    logger.debug(`Fetched ${messages.length} messages for conversation ${conversationId}`, {
      metadata: { worker: 'analysis-worker' },
    })
    return messages
  } catch (error) {
    logger.error('Error fetching conversation messages', {
      error: {
        message: getErrorMessage(error),
        stack: getErrorStack(error),
        code: getErrorCode(error),
      },
      metadata: { worker: 'analysis-worker' },
    })
    throw error
  }
}
