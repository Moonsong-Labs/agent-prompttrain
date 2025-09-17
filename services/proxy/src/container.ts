import { Pool } from 'pg'
import { MessageController } from './controllers/MessageController.js'
import { ProxyService } from './services/ProxyService.js'
import { AuthenticationService } from './services/AuthenticationService.js'
import { ClaudeApiClient } from './services/ClaudeApiClient.js'
import { MetricsService } from './services/MetricsService.js'
import { NotificationService } from './services/NotificationService.js'
import { StorageAdapter } from './storage/StorageAdapter.js'
import { TokenUsageService } from './services/TokenUsageService.js'
import { config } from '@agent-prompttrain/shared/config'
import { logger } from './middleware/logger.js'
import { McpServer } from './mcp/McpServer.js'
import { PromptRegistryService } from './mcp/PromptRegistryService.js'
import { GitHubSyncService } from './mcp/GitHubSyncService.js'
import { SyncScheduler } from './mcp/SyncScheduler.js'
import { JsonRpcHandler } from './mcp/JsonRpcHandler.js'

/**
 * Dependency injection container for the proxy service
 */
class Container {
  private pool?: Pool
  private storageService?: StorageAdapter
  private tokenUsageService?: TokenUsageService
  private metricsService?: MetricsService
  private notificationService?: NotificationService
  private authenticationService?: AuthenticationService
  private claudeApiClient?: ClaudeApiClient
  private proxyService?: ProxyService
  private messageController?: MessageController
  private mcpServer?: McpServer
  private promptRegistry?: PromptRegistryService
  private githubSyncService?: GitHubSyncService
  private syncScheduler?: SyncScheduler
  private jsonRpcHandler?: JsonRpcHandler

  constructor() {
    this.initializeServices()
  }

  private initializeServices(): void {
    // Initialize database pool if configured
    logger.info('Container initialization', {
      metadata: {
        storageEnabled: config.storage.enabled,
        databaseUrl: config.database.url ? 'set' : 'not set',
        databaseUrlLength: config.database.url?.length || 0,
      },
    })

    if (config.storage.enabled && config.database.url) {
      this.pool = new Pool({
        connectionString: config.database.url,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
      })

      this.pool.on('error', err => {
        logger.error('Unexpected database pool error', {
          error: { message: err.message, stack: err.stack },
        })
      })

      logger.info('Database pool created', {
        metadata: {
          poolCreated: !!this.pool,
        },
      })
    }

    // Initialize storage service if enabled
    if (this.pool && config.storage.enabled) {
      this.storageService = new StorageAdapter(this.pool)
      this.tokenUsageService = new TokenUsageService(this.pool)

      // Ensure partitions exist
      this.tokenUsageService.ensurePartitions().catch(err => {
        logger.error('Failed to ensure token usage partitions', {
          error: { message: err.message, stack: err.stack },
        })
      })
    }

    // Initialize services
    this.metricsService = new MetricsService(
      {
        enableTokenTracking: true,
        enableStorage: config.storage.enabled,
        enableTelemetry: config.telemetry.enabled,
      },
      this.storageService,
      config.telemetry.endpoint,
      this.tokenUsageService
    )
    this.notificationService = new NotificationService()
    this.authenticationService = new AuthenticationService({
      defaultApiKey: undefined,
      accountsDir: config.auth.accountsDir,
      clientKeysDir: config.auth.clientKeysDir,
    })
    this.claudeApiClient = new ClaudeApiClient({
      baseUrl: config.api.claudeBaseUrl,
      timeout: config.api.claudeTimeout,
    })

    // Wire up dependencies
    this.proxyService = new ProxyService(
      this.authenticationService,
      this.claudeApiClient,
      this.notificationService,
      this.metricsService,
      this.storageService
    )

    this.messageController = new MessageController(this.proxyService)

    // Initialize MCP services if enabled
    if (config.mcp.enabled) {
      this.promptRegistry = new PromptRegistryService()

      // Initialize the registry
      this.promptRegistry
        .initialize()
        .then(() => {
          logger.info('MCP Prompt Registry initialized')
        })
        .catch(err => {
          logger.error('Failed to initialize MCP Prompt Registry', {
            error: { message: err.message, stack: err.stack },
          })
        })

      this.mcpServer = new McpServer(this.promptRegistry)
      this.jsonRpcHandler = new JsonRpcHandler(this.mcpServer)

      // Only initialize GitHub sync if credentials are provided
      if (config.mcp.github.owner && config.mcp.github.repo && config.mcp.github.token) {
        this.githubSyncService = new GitHubSyncService(this.promptRegistry)
        this.syncScheduler = new SyncScheduler(this.githubSyncService)

        // Start the sync scheduler
        this.syncScheduler.start()
      } else {
        logger.warn('MCP enabled but GitHub credentials not configured')
      }
    }
  }

  getDbPool(): Pool | undefined {
    return this.pool
  }

  getStorageService(): StorageAdapter | undefined {
    return this.storageService
  }

  getTokenUsageService(): TokenUsageService | undefined {
    return this.tokenUsageService
  }

  getMetricsService(): MetricsService {
    if (!this.metricsService) {
      throw new Error('MetricsService not initialized')
    }
    return this.metricsService
  }

  getNotificationService(): NotificationService {
    if (!this.notificationService) {
      throw new Error('NotificationService not initialized')
    }
    return this.notificationService
  }

  getAuthenticationService(): AuthenticationService {
    if (!this.authenticationService) {
      throw new Error('AuthenticationService not initialized')
    }
    return this.authenticationService
  }

  getClaudeApiClient(): ClaudeApiClient {
    if (!this.claudeApiClient) {
      throw new Error('ClaudeApiClient not initialized')
    }
    return this.claudeApiClient
  }

  getProxyService(): ProxyService {
    if (!this.proxyService) {
      throw new Error('ProxyService not initialized')
    }
    return this.proxyService
  }

  getMessageController(): MessageController {
    if (!this.messageController) {
      throw new Error('MessageController not initialized')
    }
    return this.messageController
  }

  getMcpHandler(): JsonRpcHandler | undefined {
    return this.jsonRpcHandler
  }

  getPromptRegistry(): PromptRegistryService | undefined {
    return this.promptRegistry
  }

  getGitHubSyncService(): GitHubSyncService | undefined {
    return this.githubSyncService
  }

  getSyncScheduler(): SyncScheduler | undefined {
    return this.syncScheduler
  }

  async cleanup(): Promise<void> {
    if (this.syncScheduler) {
      this.syncScheduler.stop()
    }
    if (this.promptRegistry) {
      await this.promptRegistry.stop()
    }
    if (this.storageService) {
      await this.storageService.close()
    }
    if (this.pool) {
      await this.pool.end()
    }
  }
}

// Create singleton instance with lazy initialization
class LazyContainer {
  private instance?: Container

  private ensureInstance(): Container {
    if (!this.instance) {
      this.instance = new Container()
    }
    return this.instance
  }

  getDbPool(): Pool | undefined {
    return this.ensureInstance().getDbPool()
  }

  getStorageService(): StorageAdapter | undefined {
    return this.ensureInstance().getStorageService()
  }

  getTokenUsageService(): TokenUsageService | undefined {
    return this.ensureInstance().getTokenUsageService()
  }

  getMetricsService(): MetricsService {
    return this.ensureInstance().getMetricsService()
  }

  getNotificationService(): NotificationService {
    return this.ensureInstance().getNotificationService()
  }

  getAuthenticationService(): AuthenticationService {
    return this.ensureInstance().getAuthenticationService()
  }

  getClaudeApiClient(): ClaudeApiClient {
    return this.ensureInstance().getClaudeApiClient()
  }

  getProxyService(): ProxyService {
    return this.ensureInstance().getProxyService()
  }

  getMessageController(): MessageController {
    return this.ensureInstance().getMessageController()
  }

  getMcpHandler(): JsonRpcHandler | undefined {
    return this.ensureInstance().getMcpHandler()
  }

  getPromptRegistry(): PromptRegistryService | undefined {
    return this.ensureInstance().getPromptRegistry()
  }

  getGitHubSyncService(): GitHubSyncService | undefined {
    return this.ensureInstance().getGitHubSyncService()
  }

  getSyncScheduler(): SyncScheduler | undefined {
    return this.ensureInstance().getSyncScheduler()
  }

  async cleanup(): Promise<void> {
    if (this.instance) {
      await this.instance.cleanup()
    }
  }
}

export const container = new LazyContainer()
