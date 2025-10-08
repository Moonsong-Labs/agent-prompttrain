import { Hono } from 'hono'
import { z, ZodError } from 'zod'
import { Pool } from 'pg'
import { logger } from '../middleware/logger.js'
import {
  rateLimitAnalysisCreation,
  rateLimitAnalysisRetrieval,
} from '../middleware/analysis-rate-limit.js'
import {
  ConversationAnalysisStatus,
  conversationBranchParamsSchema,
  MSL_PROJECT_ID_HEADER_LOWER,
} from '@agent-prompttrain/shared'

// Request/Response schemas
const createAnalysisSchema = z.object({
  conversationId: z.string().uuid(),
  branchId: z.string(),
  customPrompt: z.string().optional(),
})

const getAnalysisParamsSchema = conversationBranchParamsSchema

// Audit logging helper
async function auditLog(
  pool: Pool,
  data: {
    event_type: string
    outcome: string
    conversation_id: string
    branch_id: string
    projectId: string
    request_id: string
    user_context?: Record<string, unknown>
    metadata?: Record<string, unknown>
  }
) {
  try {
    await pool.query(
      `INSERT INTO analysis_audit_log 
       (event_type, outcome, conversation_id, branch_id, project_id, request_id, user_context, metadata, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        data.event_type,
        data.outcome,
        data.conversation_id,
        data.branch_id,
        data.projectId,
        data.request_id,
        JSON.stringify(data.user_context || {}),
        JSON.stringify(data.metadata || {}),
      ]
    )
  } catch (error) {
    logger.error('Failed to write audit log', { error, data })
  }
}

export const analysisRoutes = new Hono<{
  Variables: {
    pool?: Pool
    projectId?: string
    requestId?: string
  }
}>()

/**
 * POST /api/analyses - Create a new analysis request
 */
analysisRoutes.post('/', rateLimitAnalysisCreation(), async c => {
  const pool = c.get('pool')
  const projectId = c.get('projectId') || c.req.header(MSL_PROJECT_ID_HEADER_LOWER) || 'unknown'
  const requestId = c.get('requestId') || 'unknown'

  if (!pool) {
    return c.json({ error: 'Database not configured' }, 503)
  }

  try {
    // Parse and validate request body
    const body = await c.req.json()
    const { conversationId, branchId, customPrompt } = createAnalysisSchema.parse(body)

    // Log the analysis request
    await auditLog(pool, {
      event_type: 'ANALYSIS_REQUEST',
      outcome: 'INITIATED',
      conversation_id: conversationId,
      branch_id: branchId,
      projectId,
      request_id: requestId,
    })

    // Check if analysis already exists
    const existingResult = await pool.query(
      `SELECT id, status FROM conversation_analyses 
       WHERE conversation_id = $1 AND branch_id = $2`,
      [conversationId, branchId]
    )

    if (existingResult.rows.length > 0) {
      const existing = existingResult.rows[0]

      // If it's already completed, return it
      if (existing.status === ConversationAnalysisStatus.COMPLETED) {
        return c.json({
          message: 'Analysis already completed',
          analysisId: existing.id,
          status: existing.status,
        })
      }

      // If it's pending or processing, return the status
      if (
        existing.status === ConversationAnalysisStatus.PENDING ||
        existing.status === ConversationAnalysisStatus.PROCESSING
      ) {
        return c.json({
          message: 'Analysis already in progress',
          analysisId: existing.id,
          status: existing.status,
        })
      }
    }

    // Create new analysis request
    const insertResult = await pool.query(
      `INSERT INTO conversation_analyses 
       (conversation_id, branch_id, status, custom_prompt, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       RETURNING id`,
      [conversationId, branchId, ConversationAnalysisStatus.PENDING, customPrompt || null]
    )

    const analysisId = insertResult.rows[0].id

    await auditLog(pool, {
      event_type: 'ANALYSIS_REQUEST',
      outcome: 'SUCCESS',
      conversation_id: conversationId,
      branch_id: branchId,
      projectId,
      request_id: requestId,
      metadata: { analysis_id: analysisId },
    })

    return c.json(
      {
        message: 'Analysis request created',
        analysisId,
        status: ConversationAnalysisStatus.PENDING,
      },
      201
    )
  } catch (error) {
    logger.error('Failed to create analysis request', { error, requestId })

    // Check for ZodError by name due to potential instanceof issues with bundlers
    if (
      error instanceof ZodError ||
      (error as Error & { constructor?: { name?: string } })?.constructor?.name === 'ZodError'
    ) {
      return c.json(
        {
          error: 'Invalid request',
          details: (error as ZodError).errors,
        },
        400
      )
    }

    return c.json(
      {
        error: 'Failed to create analysis request',
      },
      500
    )
  }
})

/**
 * GET /api/analyses/:conversationId/:branchId - Get analysis status/result
 */
analysisRoutes.get('/:conversationId/:branchId', rateLimitAnalysisRetrieval(), async c => {
  const pool = c.get('pool')
  const projectId = c.get('projectId') || c.req.header(MSL_PROJECT_ID_HEADER_LOWER) || 'unknown'
  const requestId = c.get('requestId') || 'unknown'

  if (!pool) {
    return c.json({ error: 'Database not configured' }, 503)
  }

  try {
    // Validate parameters
    const params = getAnalysisParamsSchema.parse(c.req.param())
    const { conversationId, branchId } = params

    // Get analysis
    const result = await pool.query(
      `SELECT 
        id,
        status,
        analysis_content,
        analysis_data,
        error_message,
        created_at,
        updated_at,
        completed_at,
        prompt_tokens,
        completion_tokens
       FROM conversation_analyses
       WHERE conversation_id = $1 AND branch_id = $2`,
      [conversationId, branchId]
    )

    if (result.rows.length === 0) {
      return c.json(
        {
          error: 'Analysis not found',
        },
        404
      )
    }

    const analysis = result.rows[0]

    await auditLog(pool, {
      event_type: 'ANALYSIS_RETRIEVAL',
      outcome: 'SUCCESS',
      conversation_id: conversationId,
      branch_id: branchId,
      projectId,
      request_id: requestId,
      metadata: {
        analysis_id: analysis.id,
        status: analysis.status,
      },
    })

    return c.json({
      id: analysis.id,
      conversationId,
      branchId,
      status: analysis.status,
      content: analysis.analysis_content,
      data: analysis.analysis_data,
      error: analysis.error_message,
      createdAt: analysis.created_at,
      updatedAt: analysis.updated_at,
      completedAt: analysis.completed_at,
      tokenUsage: {
        prompt: analysis.prompt_tokens,
        completion: analysis.completion_tokens,
        total: (analysis.prompt_tokens || 0) + (analysis.completion_tokens || 0),
      },
    })
  } catch (error) {
    logger.error('Failed to get analysis', {
      error: error instanceof Error ? error.message : String(error),
      requestId,
    })

    // Check for ZodError by name due to potential instanceof issues with bundlers
    if (
      error instanceof ZodError ||
      (error as Error & { constructor?: { name?: string } })?.constructor?.name === 'ZodError'
    ) {
      return c.json(
        {
          error: 'Invalid request',
          details: (error as ZodError).errors,
        },
        400
      )
    }

    return c.json(
      {
        error: 'Failed to retrieve analysis',
      },
      500
    )
  }
})

/**
 * POST /api/analyses/:conversationId/:branchId/regenerate - Force regeneration
 */
analysisRoutes.post(
  '/:conversationId/:branchId/regenerate',
  rateLimitAnalysisCreation(),
  async c => {
    const pool = c.get('pool')
    const projectId = c.get('projectId') || c.req.header(MSL_PROJECT_ID_HEADER_LOWER) || 'unknown'
    const requestId = c.get('requestId') || 'unknown'

    if (!pool) {
      return c.json({ error: 'Database not configured' }, 503)
    }

    try {
      // Validate parameters
      const params = getAnalysisParamsSchema.parse(c.req.param())
      const { conversationId, branchId } = params

      // Parse optional body for custom prompt
      let customPrompt: string | undefined
      try {
        const body = await c.req.json()
        customPrompt = body.customPrompt
      } catch {
        // No body or invalid JSON, that's ok
      }
      // Log the regeneration request
      await auditLog(pool, {
        event_type: 'ANALYSIS_REGENERATION_REQUEST',
        outcome: 'INITIATED',
        conversation_id: conversationId,
        branch_id: branchId,
        projectId,
        request_id: requestId,
      })

      // Check if analysis exists
      const existingResult = await pool.query(
        `SELECT id, status FROM conversation_analyses 
       WHERE conversation_id = $1 AND branch_id = $2`,
        [conversationId, branchId]
      )

      let analysisId: string

      if (existingResult.rows.length > 0) {
        // Update existing analysis to pending
        analysisId = existingResult.rows[0].id
        await pool.query(
          `UPDATE conversation_analyses 
         SET status = $1, updated_at = NOW(), retry_count = retry_count + 1, custom_prompt = $3
         WHERE id = $2`,
          [ConversationAnalysisStatus.PENDING, analysisId, customPrompt || null]
        )
      } else {
        // Create new analysis
        const insertResult = await pool.query(
          `INSERT INTO conversation_analyses 
         (conversation_id, branch_id, status, custom_prompt, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         RETURNING id`,
          [conversationId, branchId, ConversationAnalysisStatus.PENDING, customPrompt || null]
        )
        analysisId = insertResult.rows[0].id
      }

      await auditLog(pool, {
        event_type: 'ANALYSIS_REGENERATION_REQUEST',
        outcome: 'SUCCESS',
        conversation_id: conversationId,
        branch_id: branchId,
        projectId,
        request_id: requestId,
        metadata: { analysis_id: analysisId },
      })

      return c.json({
        message: 'Analysis regeneration requested',
        analysisId,
        status: ConversationAnalysisStatus.PENDING,
      })
    } catch (error) {
      logger.error('Failed to regenerate analysis', { error, requestId })

      // Check for ZodError by name due to potential instanceof issues with bundlers
      if (
        error instanceof ZodError ||
        (error as Error & { constructor?: { name?: string } })?.constructor?.name === 'ZodError'
      ) {
        return c.json(
          {
            error: 'Invalid request',
            details: (error as ZodError).errors,
          },
          400
        )
      }

      return c.json(
        {
          error: 'Failed to regenerate analysis',
        },
        500
      )
    }
  }
)
