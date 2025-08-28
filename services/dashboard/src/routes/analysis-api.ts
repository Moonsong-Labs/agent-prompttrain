import { Hono } from 'hono'
import { ProxyApiClient } from '../services/api-client.js'
import { logger } from '../middleware/logger.js'
import {
  getErrorMessage,
  CreateAnalysisRequestSchema,
  type CreateAnalysisResponse,
  type GetAnalysisResponse,
  type RegenerateAnalysisResponse,
  isValidUUID,
} from '@agent-prompttrain/shared'
import { HttpError } from '../errors/HttpError.js'

export const analysisRoutes = new Hono<{
  Variables: {
    apiClient?: ProxyApiClient
  }
}>()

/**
 * POST /api/analyses
 * Create a new conversation analysis request
 */
analysisRoutes.post('/analyses', async c => {
  const apiClient = c.get('apiClient')
  if (!apiClient) {
    return c.json({ error: 'API client not configured' }, 503)
  }

  try {
    // Parse and validate request body
    const body = await c.req.json()
    const parseResult = CreateAnalysisRequestSchema.safeParse(body)

    if (!parseResult.success) {
      return c.json(
        {
          error: 'Invalid request data',
          details: parseResult.error.errors,
        },
        400
      )
    }

    // Forward to proxy service
    const response = await apiClient.post<CreateAnalysisResponse>('/api/analyses', parseResult.data)

    return c.json(response, 201)
  } catch (error) {
    // Check if it's a 409 Conflict (analysis already exists)
    if (HttpError.isHttpError(error) && error.status === 409) {
      return c.json(error.data || { error: 'Analysis already exists' }, 409)
    }

    logger.error('Failed to create analysis', {
      error: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
    return c.json({ error: 'Failed to create analysis' }, 500)
  }
})

/**
 * GET /api/analyses/:conversationId/:branchId
 * Get analysis status/result for a specific conversation branch
 */
analysisRoutes.get('/analyses/:conversationId/:branchId', async c => {
  const apiClient = c.get('apiClient')
  if (!apiClient) {
    return c.json({ error: 'API client not configured' }, 503)
  }

  const conversationId = c.req.param('conversationId')
  const branchId = c.req.param('branchId')

  // Validate UUID format for conversationId
  if (!isValidUUID(conversationId)) {
    return c.json({ error: 'Invalid conversation ID format' }, 400)
  }

  try {
    // Forward to proxy service
    const response = await apiClient.get<GetAnalysisResponse>(
      `/api/analyses/${conversationId}/${branchId}`
    )

    return c.json(response)
  } catch (error) {
    // Handle 404 Not Found
    if (HttpError.isHttpError(error) && error.status === 404) {
      return c.json({ error: 'Analysis not found' }, 404)
    }
    logger.error('Failed to get analysis', {
      error: getErrorMessage(error),
    })
    return c.json({ error: 'Failed to retrieve analysis' }, 500)
  }
})

/**
 * POST /api/analyses/:conversationId/:branchId/regenerate
 * Force regeneration of analysis for a specific conversation branch
 */
analysisRoutes.post('/analyses/:conversationId/:branchId/regenerate', async c => {
  const apiClient = c.get('apiClient')
  if (!apiClient) {
    return c.json({ error: 'API client not configured' }, 503)
  }

  const conversationId = c.req.param('conversationId')
  const branchId = c.req.param('branchId')

  // Validate UUID format for conversationId
  if (!isValidUUID(conversationId)) {
    return c.json({ error: 'Invalid conversation ID format' }, 400)
  }

  try {
    // Forward to proxy service
    const response = await apiClient.post<RegenerateAnalysisResponse>(
      `/api/analyses/${conversationId}/${branchId}/regenerate`
    )

    return c.json(response)
  } catch (error) {
    // Handle 404 Not Found
    if (HttpError.isHttpError(error) && error.status === 404) {
      return c.json({ error: 'Conversation not found' }, 404)
    }

    logger.error('Failed to regenerate analysis', {
      error: getErrorMessage(error),
    })
    return c.json({ error: 'Failed to regenerate analysis' }, 500)
  }
})
