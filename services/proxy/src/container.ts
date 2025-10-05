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
import { createRepositories } from './repositories/create-repositories.js'
import type { IAccountRepository } from './repositories/IAccountRepository.js'
import type { ITrainRepository } from './repositories/ITrainRepository.js'

/**
 * Dependency injection container for the proxy service
 */
class Container {
  private pool?: Pool
  private storageService?: StorageAdapter
  private tokenUsageService?: TokenUsageService
  private metricsService?: MetricsService
  private notificationService?: NotificationService
  private accountRepository?: IAccountRepository
  private trainRepository?: ITrainRepository
  private authenticationService?: AuthenticationService
  private claudeApiClient?: ClaudeApiClient
  private proxyService?: ProxyService
  private messageController?: MessageController
  private mcpServer?: McpServer
  private promptRegistry?: PromptRegistryService
  private githubSyncService?: GitHubSyncService
  private syncScheduler?: SyncScheduler
  private jsonRpcHandler?: JsonRpcHandler
  private initialized = false
  private initializationPromise?: Promise<void>

  constructor() {}

  async init(): Promise<void> {
    if (this.initialized) {
      return
    }

    if (this.initializationPromise) {
      await this.initializationPromise
      return
    }

    this.initializationPromise = this.initializeServices()

    try {
      await this.initializationPromise
      this.initialized = true
    } catch (error) {
      this.initialized = false
      throw error
    } finally {
      this.initializationPromise = undefined
    }
  }

  private async initializeServices(): Promise<void> {
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
      try {
        await this.tokenUsageService.ensurePartitions()
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        logger.error('Failed to ensure token usage partitions', {
          error: { message: error.message, stack: error.stack },
        })
      }
    }

    // Initialize repositories (requires database pool - ADR-026)
    if (!this.pool) {
      throw new Error('Database pool is required for credential storage (ADR-026)')
    }

    const repositories = createRepositories(this.pool)
    this.accountRepository = repositories.accountRepository
    this.trainRepository = repositories.trainRepository

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
      accountRepository: this.accountRepository,
      trainRepository: this.trainRepository,
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
      try {
        await this.promptRegistry.initialize()
        logger.info('MCP Prompt Registry initialized')
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        logger.error('Failed to initialize MCP Prompt Registry', {
          error: { message: error.message, stack: error.stack },
        })
        throw error
      }

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

  getAccountRepository(): IAccountRepository {
    if (!this.accountRepository) {
      throw new Error('AccountRepository not initialized')
    }
    return this.accountRepository
  }

  getTrainRepository(): ITrainRepository {
    if (!this.trainRepository) {
      throw new Error('TrainRepository not initialized')
    }
    return this.trainRepository
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
    this.initialized = false

    if (this.syncScheduler) {
      this.syncScheduler.stop()
      this.syncScheduler = undefined
    }
    if (this.promptRegistry) {
      await this.promptRegistry.stop()
      this.promptRegistry = undefined
    }
    if (this.storageService) {
      await this.storageService.close()
      this.storageService = undefined
    }
    if (this.pool) {
      await this.pool.end()
      this.pool = undefined
    }

    this.tokenUsageService = undefined
    this.metricsService = undefined
    this.notificationService = undefined
    this.accountRepository = undefined
    this.trainRepository = undefined
    this.authenticationService = undefined
    this.claudeApiClient = undefined
    this.proxyService = undefined
    this.messageController = undefined
    this.mcpServer = undefined
    this.githubSyncService = undefined
    this.jsonRpcHandler = undefined
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

  async init(): Promise<void> {
    const instance = this.ensureInstance()
    await instance.init()
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

  getAccountRepository(): IAccountRepository {
    return this.ensureInstance().getAccountRepository()
  }

  getTrainRepository(): ITrainRepository {
    return this.ensureInstance().getTrainRepository()
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
      this.instance = undefined
    }
  }
}

export const container = new LazyContainer()

export async function initializeContainer(): Promise<void> {
  await container.init()
}

export async function disposeContainer(): Promise<void> {
  await container.cleanup()
}
