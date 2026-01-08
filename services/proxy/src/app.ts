import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { container, initializeContainer } from './container.js'
import { config, validateConfig, isProxyMode, isApiMode } from '@agent-prompttrain/shared/config'
import { loggingMiddleware, logger } from './middleware/logger.js'
import { requestIdMiddleware } from './middleware/request-id.js'
import { validationMiddleware } from './middleware/validation.js'
import { createRateLimiter, createTrainRateLimiter } from './middleware/rate-limit.js'
import { createHealthRoutes } from './routes/health.js'
import { apiRoutes } from './routes/api.js'
import { sparkApiRoutes } from './routes/spark-api.js'
import { analysisRoutes } from './routes/analyses.js'
import { initializeAnalysisRateLimiters } from './middleware/analysis-rate-limit.js'
import { createMcpApiRoutes } from './routes/mcp-api.js'
import { initializeSlack } from './services/slack.js'
import { initializeDatabase } from './storage/writer.js'
import { apiAuthMiddleware } from './middleware/api-auth.js'
import { projectIdExtractorMiddleware } from './middleware/project-id-extractor.js'
import { clientAuthMiddleware } from './middleware/client-auth.js'
import { HonoVariables, HonoBindings, MSL_PROJECT_ID_HEADER_LOWER } from '@agent-prompttrain/shared'

/**
 * Create and configure the Proxy application
 */
export async function createProxyApp(): Promise<
  Hono<{ Variables: HonoVariables; Bindings: HonoBindings }>
> {
  // Validate configuration
  validateConfig()

  // Ensure container dependencies are ready
  await initializeContainer()

  // Initialize external services
  await initializeExternalServices()

  // Initialize AI analysis rate limiters
  initializeAnalysisRateLimiters()

  // Log pool status after initialization
  const pool = container.getDbPool()
  logger.info('Proxy app initialization', {
    metadata: {
      hasPool: !!pool,
      storageEnabled: config.storage.enabled,
      databaseUrl: config.database.url ? 'configured' : 'not configured',
    },
  })

  const app = new Hono<{ Variables: HonoVariables; Bindings: HonoBindings }>()

  // Centralized error handler
  app.onError((err, c) => {
    const requestId = c.get('requestId') || 'unknown'

    logger.error('Unhandled error', {
      error: { message: err.message, stack: err.stack },
      requestId,
      path: c.req.path,
      method: c.req.method,
      projectId: c.get('projectId') || c.req.header(MSL_PROJECT_ID_HEADER_LOWER),
      metadata: {},
    })

    // Don't expose internal errors to clients
    const message = config.server.env === 'development' ? err.message : 'Internal server error'

    return c.json(
      {
        error: {
          message,
          type: 'internal_error',
          request_id: requestId,
        },
      },
      ((err as { status?: number }).status || 500) as 500
    )
  })

  // Global middleware
  app.use('*', cors())
  app.use('*', requestIdMiddleware()) // Generate request ID first
  app.use('*', loggingMiddleware()) // Then use it for logging

  // ============================================
  // PROXY MODE ENDPOINTS (Claude Code / Client)
  // ============================================
  if (isProxyMode()) {
    // Client authentication for proxy routes
    // Apply before rate limiting to protect against unauthenticated requests
    // This sets projectId from API key authentication
    if (config.features.enableClientAuth !== false) {
      app.use('/v1/*', clientAuthMiddleware())
      // Also protect Claude-specific /api/* routes used by claude-code CLI
      app.use('/api/event_logging/*', clientAuthMiddleware())
    }

    // Project ID extraction fallback for proxy endpoints only
    // Only sets projectId if not already set by client auth
    app.use('/v1/*', projectIdExtractorMiddleware())
    app.use('/api/event_logging/*', projectIdExtractorMiddleware())

    // Rate limiting
    if (config.features.enableMetrics) {
      app.use('/v1/*', createRateLimiter())
      app.use('/v1/*', createTrainRateLimiter())
      app.use('/api/event_logging/*', createRateLimiter())
      app.use('/api/event_logging/*', createTrainRateLimiter())
    }

    // Validation middleware ONLY for /v1/messages
    // Don't apply to generic proxy routes as they have different schemas
    app.use('/v1/messages', validationMiddleware())
  }

  // ============================================
  // SHARED ENDPOINTS (Available in all modes)
  // ============================================

  // Health check routes - always available in all service modes
  const healthRoutes = createHealthRoutes({
    pool: container.getDbPool(),
    version: process.env.npm_package_version,
  })
  app.route('/health', healthRoutes)

  if (isProxyMode()) {
    // Token stats endpoint (proxy mode)
    app.get('/token-stats', c => {
      const projectId = c.req.query('projectId')
      const stats = container.getMetricsService().getStats(projectId)
      return c.json(stats)
    })

    // OAuth refresh metrics endpoint (proxy mode)
    app.get('/oauth-metrics', async c => {
      const { getRefreshMetrics } = await import('./credentials.js')
      const metrics = getRefreshMetrics()
      return c.json(metrics)
    })
  }

  // ============================================
  // API MODE ENDPOINTS (Dashboard)
  // ============================================
  if (isApiMode()) {
    // Dashboard API routes with authentication
    app.use('/api/*', apiAuthMiddleware())
    app.use('/api/*', async (c, next) => {
      // Inject pool into context for API routes
      const pool = container.getDbPool()
      if (!pool) {
        logger.error('Database pool not available for API request', {
          path: c.req.path,
        })
        return c.json(
          {
            error: {
              code: 'service_unavailable',
              message: 'Database service is not available',
            },
          },
          503
        )
      }
      c.set('pool', pool)
      await next()
    })
    app.route('/api', apiRoutes)

    // Spark API routes (protected by same auth as dashboard API)
    app.route('/api', sparkApiRoutes)

    // AI Analysis routes (protected by same auth as dashboard API)
    app.route('/api/analyses', analysisRoutes)
  }

  // ============================================
  // MCP ROUTES (Conditional based on mode and MCP_ENABLED)
  // ============================================
  if (config.mcp.enabled) {
    const mcpHandler = container.getMcpHandler()
    const promptRegistry = container.getPromptRegistry()
    const syncService = container.getGitHubSyncService()
    const syncScheduler = container.getSyncScheduler()

    // MCP JSON-RPC endpoints (proxy mode - for Claude Code)
    if (isProxyMode() && mcpHandler) {
      // Apply client authentication to MCP routes
      app.use('/mcp/*', clientAuthMiddleware())

      // Project ID extraction for MCP routes
      app.use('/mcp/*', projectIdExtractorMiddleware())

      // Apply rate limiting to MCP routes
      if (config.features.enableMetrics) {
        app.use('/mcp/*', createRateLimiter())
        app.use('/mcp/*', createTrainRateLimiter())
      }

      // MCP JSON-RPC endpoint (now protected by auth)
      app.post('/mcp', c => mcpHandler.handle(c))

      // MCP discovery endpoint (now protected by auth)
      app.get('/mcp', c => {
        return c.json({
          name: 'agent-prompttrain-mcp-server',
          version: '1.0.0',
          capabilities: {
            prompts: {
              listPrompts: true,
              getPrompt: true,
            },
          },
        })
      })
    }

    // MCP Dashboard API routes (api mode - for dashboard management)
    if (isApiMode() && promptRegistry) {
      const mcpApiRoutes = createMcpApiRoutes(
        promptRegistry,
        syncService || null,
        syncScheduler || null
      )
      app.route('/api/mcp', mcpApiRoutes)
      logger.info('MCP API routes registered at /api/mcp')
    } else if (config.mcp.enabled && !promptRegistry) {
      logger.warn('MCP API routes not registered - prompt registry not available')
    }
  }

  if (isProxyMode()) {
    // Client setup files (proxy mode)
    app.get('/client-setup/:filename', async c => {
      const filename = c.req.param('filename')

      // Validate filename to prevent directory traversal
      if (!filename || filename.includes('..') || filename.includes('/')) {
        return c.text('Invalid filename', 400)
      }

      try {
        const fs = await import('fs')
        const path = await import('path')
        const { fileURLToPath } = await import('url')

        // Get the directory of this source file
        const __filename = fileURLToPath(import.meta.url)
        const __dirname = path.dirname(__filename)

        // Navigate from services/proxy/src to project root, then to client-setup
        const projectRoot = path.join(__dirname, '..', '..', '..')
        const filePath = path.join(projectRoot, 'client-setup', filename)

        if (!fs.existsSync(filePath)) {
          return c.text('File not found', 404)
        }

        const content = fs.readFileSync(filePath, 'utf-8')
        const contentType = filename.endsWith('.json')
          ? 'application/json'
          : filename.endsWith('.js')
            ? 'application/javascript'
            : filename.endsWith('.sh')
              ? 'text/x-shellscript'
              : 'text/plain'

        return c.text(content, 200, {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=3600',
        })
      } catch (error) {
        logger.error('Failed to serve client setup file', {
          metadata: {
            filename,
            error: error instanceof Error ? error.message : String(error),
          },
        })
        return c.text('Internal server error', 500)
      }
    })

    // Main API routes (proxy mode - Claude API forwarding)
    const messageController = container.getMessageController()
    app.post('/v1/messages', c => messageController.handle(c))
    app.options('/v1/messages', c => messageController.handleOptions(c))

    // Native Bedrock Runtime API endpoints
    // These support direct Bedrock-style requests without transformation
    // Client authentication is applied for project ID tracking
    if (config.features.enableClientAuth !== false) {
      app.use('/model/*', clientAuthMiddleware())
    }
    app.use('/model/*', projectIdExtractorMiddleware())

    // Rate limiting for native Bedrock endpoints
    if (config.features.enableMetrics) {
      app.use('/model/*', createRateLimiter())
      app.use('/model/*', createTrainRateLimiter())
    }

    const bedrockNativeController = container.getBedrockNativeController()
    app.post('/model/:modelId/invoke', c => bedrockNativeController.handleInvoke(c))
    app.post('/model/:modelId/invoke-with-response-stream', c =>
      bedrockNativeController.handleInvokeStream(c)
    )

    // Generic proxy for all other /v1/* endpoints
    // IMPORTANT: This MUST be after specific routes like /v1/messages
    // Handles arbitrary endpoints differently based on provider:
    // - Claude accounts: proxies to Anthropic API
    // - Bedrock accounts: emulates /v1/messages/count_tokens, returns 501 for others
    const genericProxyController = container.getGenericProxyController()
    app.all('/v1/*', c => genericProxyController.handle(c))

    // Claude-specific /api/* routes (used by claude-code CLI for telemetry)
    // These endpoints silently accept requests without forwarding to Claude API
    // This avoids unnecessary external calls for telemetry that is not needed
    app.all('/api/event_logging/*', c => c.json({ status: 'ok' }, 200))
  }

  // Root endpoint
  app.get('/', c => {
    const endpoints: Record<string, unknown> = {}
    const mode = config.service.mode

    // Add mode-specific endpoints
    if (isProxyMode()) {
      endpoints.api = '/v1/messages'
      endpoints['bedrock-native'] = {
        invoke: '/model/{modelId}/invoke',
        'invoke-stream': '/model/{modelId}/invoke-with-response-stream',
      }
      endpoints['event-logging'] = '/api/event_logging/*'
      endpoints.stats = '/token-stats'
      endpoints['oauth-metrics'] = '/oauth-metrics'
      endpoints['client-setup'] = '/client-setup/*'
    }

    if (isApiMode()) {
      endpoints['dashboard-api'] = {
        stats: '/api/stats',
        'dashboard-stats': '/api/dashboard/stats',
        requests: '/api/requests',
        'request-details': '/api/requests/:id',
        projectIds: '/api/train-ids',
        conversations: '/api/conversations',
        'token-usage': {
          current: '/api/token-usage/current',
          daily: '/api/token-usage/daily',
          'time-series': '/api/token-usage/time-series',
          accounts: '/api/token-usage/accounts',
        },
        usage: {
          'requests-hourly': '/api/usage/requests/hourly',
          'tokens-hourly': '/api/usage/tokens/hourly',
        },
        analytics: {
          'token-usage-sliding-window': '/api/analytics/token-usage/sliding-window',
        },
        spark: '/api/spark/*',
        analyses: '/api/analyses/*',
      }
    }

    // Always available
    endpoints.health = '/health'

    if (config.mcp.enabled) {
      const mcpEndpoints: Record<string, unknown> = {}
      if (isProxyMode()) {
        mcpEndpoints.discovery = '/mcp'
        mcpEndpoints.rpc = '/mcp'
      }
      if (isApiMode()) {
        mcpEndpoints['dashboard-api'] = {
          prompts: '/api/mcp/prompts',
          sync: '/api/mcp/sync',
          'sync-status': '/api/mcp/sync/status',
        }
      }
      if (Object.keys(mcpEndpoints).length > 0) {
        endpoints.mcp = mcpEndpoints
      }
    }

    return c.json({
      service: 'agent-prompttrain',
      version: process.env.npm_package_version || 'unknown',
      status: 'operational',
      mode,
      endpoints,
    })
  })

  return app
}

/**
 * Initialize external services
 */
async function initializeExternalServices(): Promise<void> {
  // Initialize database if configured
  const pool = container.getDbPool()
  if (pool) {
    try {
      await initializeDatabase(pool)
      logger.info('Database initialized successfully')
    } catch (error) {
      logger.error('Failed to initialize database', {
        error: error instanceof Error ? { message: error.message } : { message: String(error) },
      })
      if (config.storage.enabled) {
        throw error // Fatal if storage is required
      }
    }
  }

  // Initialize Slack if configured
  if (config.slack.enabled && config.slack.webhookUrl) {
    try {
      initializeSlack(config.slack)
      logger.info('Slack integration initialized')
    } catch (error) {
      logger.error('Failed to initialize Slack', {
        error: error instanceof Error ? { message: error.message } : { message: String(error) },
      })
      // Non-fatal, continue without Slack
    }
  }

  // Log startup configuration
  logger.info('Proxy service starting', {
    metadata: {
      version: process.env.npm_package_version || 'unknown',
      environment: config.server.env,
      serviceMode: config.service.mode,
      features: {
        storage: config.storage.enabled,
        slack: config.slack.enabled,
        telemetry: config.telemetry.enabled,
        healthChecks: config.features.enableHealthChecks,
        mcp: config.mcp.enabled,
      },
      endpoints: {
        proxyMode: isProxyMode(),
        apiMode: isApiMode(),
      },
      mcp: config.mcp.enabled
        ? {
            github: {
              owner: config.mcp.github.owner || 'not configured',
              repo: config.mcp.github.repo || 'not configured',
              path: config.mcp.github.path,
            },
            sync: {
              interval: config.mcp.sync.interval,
            },
          }
        : undefined,
    },
  })
}
