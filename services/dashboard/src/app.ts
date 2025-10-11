import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
// Remove static file serving - will inline CSS instead
import { container } from './container.js'
import { loggingMiddleware, logger } from './middleware/logger.js'
import { requestIdMiddleware } from './middleware/request-id.js'
// Use the new API-based dashboard routes
import { dashboardRoutes } from './routes/dashboard-api.js'
import { conversationDetailRoutes } from './routes/conversation-detail.js'
import { dashboardAuth, type AuthContext } from './middleware/auth.js'
import { getErrorMessage, getStatusCode } from '@agent-prompttrain/shared'
import { sparkProxyRoutes } from './routes/spark-proxy.js'
import { analysisRoutes } from './routes/analysis-api.js'
import { analysisPartialsRoutes } from './routes/partials/analysis.js'
import { analyticsPartialRoutes } from './routes/partials/analytics.js'
import { analyticsConversationPartialRoutes } from './routes/partials/analytics-conversation.js'
import { csrfProtection } from './middleware/csrf.js'
import credentialsRoutes from './routes/credentials.js'
import projectsRoutes from './routes/projects.js'
import apiKeysRoutes from './routes/api-keys.js'
import projectMembersRoutes from './routes/project-members.js'
import { getProjectByProjectId, isProjectMember } from '@agent-prompttrain/shared/database/queries'

/**
 * Create and configure the Dashboard application
 */
type DashboardApp = Hono<{
  Variables: {
    apiClient: unknown
    auth?: AuthContext
  }
}>

export async function createDashboardApp(): Promise<DashboardApp> {
  const app: DashboardApp = new Hono()

  // Centralized error handler
  app.onError((err, c) => {
    logger.error('Unhandled error', {
      error: err.message,
      stack: err.stack,
      path: c.req.path,
      method: c.req.method,
    })

    // Don't expose internal errors to clients
    const message = process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'

    const status = getStatusCode(err)

    return c.json(
      {
        error: {
          message,
          type: 'internal_error',
        },
      },
      status as 500
    )
  })

  // Global middleware
  app.use('*', cors())
  app.use('*', secureHeaders()) // Apply security headers
  app.use('*', requestIdMiddleware()) // Generate request ID first
  app.use('*', loggingMiddleware()) // Then use it for logging

  // Apply auth middleware first to set auth context
  app.use('/*', dashboardAuth)

  // Apply CSRF protection after auth checks
  app.use('/*', csrfProtection())

  // Pass API client to routes instead of database pool
  app.use('/*', async (c, next) => {
    c.set('apiClient', container.getApiClient())
    return next()
  })

  // Health check
  app.get('/health', async c => {
    const apiClient = container.getApiClient()
    const health: Record<string, unknown> = {
      status: 'healthy',
      service: 'agent-prompttrain-dashboard',
      version: process.env.npm_package_version || 'unknown',
      timestamp: new Date().toISOString(),
    }

    // Check proxy API connection
    try {
      // Try to fetch stats with a short timeout
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)

      await apiClient.getStats()
      clearTimeout(timeout)

      health.proxyApi = 'connected'
    } catch (error) {
      health.status = 'unhealthy'
      health.proxyApi = 'disconnected'
      health.error = getErrorMessage(error)
    }

    return c.json(health, health.status === 'healthy' ? 200 : 503)
  })

  // API endpoints for dashboard data
  app.get('/api/requests', async c => {
    const storageService = container.getStorageService()
    const projectId = c.req.query('projectId')
    const limit = parseInt(c.req.query('limit') || '100')
    const auth = c.get('auth')

    if (!auth || !auth.isAuthenticated) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    try {
      const requests = await storageService.getRequestsByTrainId(
        projectId || '',
        auth.principal,
        limit
      )
      return c.json({
        status: 'ok',
        requests,
        count: requests.length,
      })
    } catch (error) {
      logger.error('Failed to get requests', { error: getErrorMessage(error) })
      return c.json({ error: 'Failed to retrieve requests' }, 500)
    }
  })

  app.get('/api/requests/:requestId', async c => {
    const storageService = container.getStorageService()
    const requestId = c.req.param('requestId')
    const auth = c.get('auth')

    if (!auth || !auth.isAuthenticated) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    try {
      const details = await storageService.getRequestDetails(requestId)
      if (!details.request) {
        return c.json({ error: 'Request not found' }, 404)
      }

      // Check privacy access
      const pool = container.getPool()
      const project = await getProjectByProjectId(pool, details.request.projectId)

      if (!project) {
        return c.json({ error: 'Project not found' }, 404)
      }

      // Allow access if project is public OR user is a member
      if (project.is_private) {
        const isMember = await isProjectMember(pool, project.id, auth.principal)
        if (!isMember) {
          return c.json({ error: 'Access denied' }, 403)
        }
      }

      return c.json({
        status: 'ok',
        ...details,
      })
    } catch (error) {
      logger.error('Failed to get request details', { error: getErrorMessage(error) })
      return c.json({ error: 'Failed to retrieve request details' }, 500)
    }
  })

  app.get('/api/storage-stats', async c => {
    const storageService = container.getStorageService()
    const projectId = c.req.query('projectId')
    const since = c.req.query('since')
    const auth = c.get('auth')

    if (!auth || !auth.isAuthenticated) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    // Check privacy access if projectId is specified
    if (projectId) {
      const pool = container.getPool()
      const project = await getProjectByProjectId(pool, projectId)

      if (!project) {
        return c.json({ error: 'Project not found' }, 404)
      }

      if (project.is_private) {
        const isMember = await isProjectMember(pool, project.id, auth.principal)
        if (!isMember) {
          return c.json({ error: 'Access denied' }, 403)
        }
      }
    }

    try {
      const stats = await storageService.getStats(projectId, since ? new Date(since) : undefined)
      return c.json({
        status: 'ok',
        stats,
      })
    } catch (error) {
      logger.error('Failed to get storage stats', { error: getErrorMessage(error) })
      return c.json({ error: 'Failed to retrieve statistics' }, 500)
    }
  })

  app.get('/api/conversations', async c => {
    const storageService = container.getStorageService()
    const projectId = c.req.query('projectId')
    const limit = parseInt(c.req.query('limit') || '50')
    const excludeSubtasks = c.req.query('excludeSubtasks') === 'true'
    const auth = c.get('auth')

    logger.info('[PRIVACY DEBUG] /api/conversations endpoint called', {
      metadata: {
        projectId,
        limit,
        excludeSubtasks,
        authPrincipal: auth?.principal,
        isAuthenticated: auth?.isAuthenticated,
      },
    })

    if (!auth || !auth.isAuthenticated) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    try {
      const rawConversations = await storageService.getConversationSummaries(
        auth.principal,
        projectId,
        limit,
        excludeSubtasks
      )

      // Transform snake_case database fields to camelCase for API response
      const conversations = rawConversations.map(conv => ({
        conversationId: conv.conversation_id,
        projectId: conv.project_id,
        trainIds: [conv.project_id], // Backward compatibility
        accountIds: [], // TODO: fetch from requests
        firstMessageTime: conv.started_at,
        lastMessageTime: conv.last_message_at,
        messageCount: conv.total_messages || 0,
        totalTokens: conv.total_tokens || 0,
        branchCount: conv.branch_count || 1,
        modelsUsed: conv.models_used || [],
        hasSubtasks: conv.has_subtasks || false,
        branches: conv.branches || [],
      }))

      logger.info('[PRIVACY DEBUG] Returning conversations', {
        metadata: {
          count: conversations.length,
          projectIds: [...new Set(conversations.map(c => c.projectId))],
          sampleConversations: conversations.slice(0, 3).map(c => ({
            conversationId: c.conversationId,
            projectId: c.projectId,
          })),
        },
      })

      return c.json({
        status: 'ok',
        conversations,
        count: conversations.length,
      })
    } catch (error) {
      logger.error('Failed to get conversations', { error: getErrorMessage(error) })
      return c.json({ error: 'Failed to retrieve conversations' }, 500)
    }
  })

  app.get('/api/requests/:requestId/subtasks', async c => {
    const storageService = container.getStorageService()
    const requestId = c.req.param('requestId')
    const auth = c.get('auth')

    if (!auth || !auth.isAuthenticated) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    try {
      const subtasks = await storageService.getSubtasksForRequest(requestId)

      // Check privacy access if subtasks exist
      if (subtasks.length > 0) {
        const pool = container.getPool()
        const project = await getProjectByProjectId(pool, subtasks[0].projectId)

        if (!project) {
          return c.json({ error: 'Project not found' }, 404)
        }

        if (project.is_private) {
          const isMember = await isProjectMember(pool, project.id, auth.principal)
          if (!isMember) {
            return c.json({ error: 'Access denied' }, 403)
          }
        }
      }

      return c.json({
        status: 'ok',
        subtasks,
        count: subtasks.length,
      })
    } catch (error) {
      logger.error('Failed to get subtasks', { error: getErrorMessage(error), requestId })
      return c.json({ error: 'Failed to retrieve subtasks' }, 500)
    }
  })

  // Mount dashboard routes at /dashboard
  app.route('/dashboard', dashboardRoutes)
  app.route('/dashboard', conversationDetailRoutes)
  app.route('/dashboard/api', sparkProxyRoutes)

  // Mount analysis API routes
  app.route('/api', analysisRoutes)

  // Mount credential and project management routes
  app.route('/api/credentials', credentialsRoutes)
  app.route('/api/projects', projectsRoutes)
  app.route('/api/projects', apiKeysRoutes) // Nested under projects
  app.route('/api/projects', projectMembersRoutes) // Nested under projects

  // Mount analysis partials routes
  app.route('/partials/analysis', analysisPartialsRoutes)

  // Mount analytics partials routes
  app.route('/', analyticsPartialRoutes)
  app.route('/', analyticsConversationPartialRoutes)

  // Import and mount MCP proxy routes
  const { mcpProxyRoutes } = await import('./routes/mcp-proxy.js')
  app.route('/dashboard/api', mcpProxyRoutes)

  // Root redirect to dashboard
  app.get('/', c => {
    return c.redirect('/dashboard')
  })

  // Root API info endpoint
  app.get('/api', c => {
    return c.json({
      service: 'agent-prompttrain-dashboard',
      version: process.env.npm_package_version || 'unknown',
      endpoints: {
        dashboard: '/',
        health: '/health',
        requests: '/api/requests',
        stats: '/api/storage-stats',
      },
    })
  })

  // Log successful initialization
  logger.info('Dashboard application initialized', {
    proxyUrl: process.env.PROXY_API_URL || 'http://proxy:3000',
  })

  return app
}
