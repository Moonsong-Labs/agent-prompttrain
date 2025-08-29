import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { container } from './container.js'
import { config, validateConfig } from '@agent-prompttrain/shared/config'
import { loggingMiddleware, logger } from './middleware/logger.js'
import { requestIdMiddleware } from './middleware/request-id.js'
import { validationMiddleware } from './middleware/validation.js'
import { createRateLimiter, createDomainRateLimiter } from './middleware/rate-limit.js'
import { createHealthRoutes } from './routes/health.js'
import { apiRoutes } from './routes/api.js'
import { sparkApiRoutes } from './routes/spark-api.js'
import { analysisRoutes } from './routes/analyses.js'
import { initializeAnalysisRateLimiters } from './middleware/analysis-rate-limit.js'
import { createMcpApiRoutes } from './routes/mcp-api.js'
import { initializeSlack } from './services/slack.js'
import { initializeDatabase } from './storage/writer.js'
import { apiAuthMiddleware } from './middleware/api-auth.js'
import { domainExtractorMiddleware } from './middleware/domain-extractor.js'
import { clientAuthMiddleware } from './middleware/client-auth.js'
import { HonoVariables, HonoBindings } from '@agent-prompttrain/shared'

/**
 * Create and configure the Proxy application
 */
export async function createProxyApp(): Promise<
  Hono<{ Variables: HonoVariables; Bindings: HonoBindings }>
> {
  // Validate configuration
  validateConfig()

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
      domain: c.get('domain'),
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

  // Domain extraction for all routes
  app.use('*', domainExtractorMiddleware())

  // Client authentication for proxy routes
  // Apply before rate limiting to protect against unauthenticated requests
  if (config.features.enableClientAuth !== false) {
    app.use('/v1/*', clientAuthMiddleware())
  }

  // Rate limiting
  if (config.features.enableMetrics) {
    app.use('/v1/*', createRateLimiter())
    app.use('/v1/*', createDomainRateLimiter())
  }

  // Validation for API routes
  app.use('/v1/*', validationMiddleware())

  // Health check routes
  if (config.features.enableHealthChecks) {
    const healthRoutes = createHealthRoutes({
      pool: container.getDbPool(),
      version: process.env.npm_package_version,
    })
    app.route('/health', healthRoutes)
  }

  // Token stats endpoint
  app.get('/token-stats', c => {
    const domain = c.req.query('domain')
    const stats = container.getMetricsService().getStats(domain)
    return c.json(stats)
  })

  // OAuth refresh metrics endpoint
  app.get('/oauth-metrics', async c => {
    const { getRefreshMetrics } = await import('./credentials.js')
    const metrics = getRefreshMetrics()
    return c.json(metrics)
  })

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

  // MCP routes
  if (config.mcp.enabled) {
    // Apply client authentication to MCP routes
    app.use('/mcp/*', clientAuthMiddleware())

    // Apply rate limiting to MCP routes
    if (config.features.enableMetrics) {
      app.use('/mcp/*', createRateLimiter())
      app.use('/mcp/*', createDomainRateLimiter())
    }

    const mcpHandler = container.getMcpHandler()
    const promptRegistry = container.getPromptRegistry()
    const syncService = container.getGitHubSyncService()
    const syncScheduler = container.getSyncScheduler()

    if (mcpHandler) {
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

    // MCP Dashboard API routes (protected by dashboard auth)
    if (promptRegistry) {
      const mcpApiRoutes = createMcpApiRoutes(
        promptRegistry,
        syncService || null,
        syncScheduler || null
      )
      app.route('/api/mcp', mcpApiRoutes)
      logger.info('MCP API routes registered at /api/mcp')
    } else {
      logger.warn('MCP API routes not registered - prompt registry not available')
    }
  }

  // Client setup files
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

  // Main API routes
  const messageController = container.getMessageController()
  app.post('/v1/messages', c => messageController.handle(c))
  app.options('/v1/messages', c => messageController.handleOptions(c))

  // Root endpoint
  app.get('/', c => {
    const endpoints: any = {
      api: '/v1/messages',
      health: '/health',
      stats: '/token-stats',
      'client-setup': '/client-setup/*',
      'dashboard-api': {
        stats: '/api/stats',
        requests: '/api/requests',
        'request-details': '/api/requests/:id',
        domains: '/api/domains',
      },
    }

    if (config.mcp.enabled) {
      endpoints.mcp = {
        discovery: '/mcp',
        rpc: '/mcp',
        'dashboard-api': {
          prompts: '/api/mcp/prompts',
          sync: '/api/mcp/sync',
          'sync-status': '/api/mcp/sync/status',
        },
      }
    }

    return c.json({
      service: 'agent-prompttrain',
      version: process.env.npm_package_version || 'unknown',
      status: 'operational',
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
      features: {
        storage: config.storage.enabled,
        slack: config.slack.enabled,
        telemetry: config.telemetry.enabled,
        healthChecks: config.features.enableHealthChecks,
        mcp: config.mcp.enabled,
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
