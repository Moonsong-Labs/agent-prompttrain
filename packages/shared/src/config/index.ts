/**
 * Centralized configuration for the application
 * All configuration values should be accessed through this module
 */

// Note: Environment variables should be loaded before importing this module.
// In development, use dotenv in your entry point or use bun which loads .env automatically.

// Helper to parse environment variables
const env = {
  string: (key: string, defaultValue: string): string => {
    return process.env[key] || defaultValue
  },
  int: (key: string, defaultValue: number): number => {
    const raw = process.env[key]
    if (raw === undefined || raw === '') {
      return defaultValue
    }
    const n = Number(raw)
    return Number.isFinite(n) ? n : defaultValue
  },
  bool: (key: string, defaultValue: boolean): boolean => {
    const value = process.env[key]?.toLowerCase()
    if (value === undefined || value === '') {
      return defaultValue
    }
    return value === 'true' || value === '1'
  },
}

export const config = {
  // Server configuration
  server: {
    get port() {
      return env.int('PORT', 3000)
    },
    get host() {
      return env.string('HOST', '0.0.0.0')
    },
    get env() {
      return env.string('NODE_ENV', 'development')
    },
    get isProduction() {
      return process.env.NODE_ENV === 'production'
    },
    get timeout() {
      return env.int('PROXY_SERVER_TIMEOUT', 660000)
    }, // 11 minutes (longer than max request + retries)
  },

  // API configuration
  api: {
    get claudeBaseUrl() {
      return env.string('CLAUDE_API_BASE_URL', 'https://api.anthropic.com')
    },
    get claudeTimeout() {
      return env.int('CLAUDE_API_TIMEOUT', 600000)
    }, // 10 minutes
    get oauthClientId() {
      return env.string('CLAUDE_OAUTH_CLIENT_ID', '')
    },
  },

  // Authentication
  auth: {
    get credentialsDir() {
      return env.string('CREDENTIALS_DIR', 'credentials')
    },
  },

  // Database configuration
  database: {
    get url() {
      return env.string('DATABASE_URL', '')
    },
    get host() {
      return env.string('DB_HOST', 'localhost')
    },
    get port() {
      return env.int('DB_PORT', 5432)
    },
    get name() {
      return env.string('DB_NAME', 'claude_proxy')
    },
    get user() {
      return env.string('DB_USER', 'postgres')
    },
    get password() {
      return env.string('DB_PASSWORD', '')
    },
    get ssl() {
      return env.bool('DB_SSL', process.env.NODE_ENV === 'production')
    },
    get poolSize() {
      return env.int('DB_POOL_SIZE', 20)
    },
  },

  // Storage configuration
  storage: {
    get enabled() {
      return env.bool('STORAGE_ENABLED', false)
    },
    get batchSize() {
      return env.int('STORAGE_BATCH_SIZE', 100)
    },
    get batchInterval() {
      return env.int('STORAGE_BATCH_INTERVAL', 5000)
    },
  },

  // Rate limiting
  rateLimit: {
    get windowMs() {
      return env.int('RATE_LIMIT_WINDOW_MS', 3600000)
    }, // 1 hour
    get maxRequests() {
      return env.int('RATE_LIMIT_MAX_REQUESTS', 1000)
    },
    get maxTokens() {
      return env.int('RATE_LIMIT_MAX_TOKENS', 1000000)
    },
    get domainWindowMs() {
      return env.int('DOMAIN_RATE_LIMIT_WINDOW_MS', 3600000)
    },
    get domainMaxRequests() {
      return env.int('DOMAIN_RATE_LIMIT_MAX_REQUESTS', 5000)
    },
    get domainMaxTokens() {
      return env.int('DOMAIN_RATE_LIMIT_MAX_TOKENS', 5000000)
    },
  },

  // Request validation
  validation: {
    get maxRequestSize() {
      return env.int('MAX_REQUEST_SIZE', 10 * 1024 * 1024)
    }, // 10MB
    get maxMessageCount() {
      return env.int('MAX_MESSAGE_COUNT', 100)
    },
    get maxSystemLength() {
      return env.int('MAX_SYSTEM_LENGTH', 10000)
    },
    get maxMessageLength() {
      return env.int('MAX_MESSAGE_LENGTH', 100000)
    },
    get maxTotalLength() {
      return env.int('MAX_TOTAL_LENGTH', 500000)
    },
  },

  // Logging
  logging: {
    get level() {
      return env.string('LOG_LEVEL', 'info')
    },
    get prettyPrint() {
      return !env.bool('LOG_JSON', process.env.NODE_ENV === 'production')
    },
  },

  // Slack configuration
  slack: {
    get webhookUrl() {
      return env.string('SLACK_WEBHOOK_URL', '')
    },
    get channel() {
      return env.string('SLACK_CHANNEL', '')
    },
    get username() {
      return env.string('SLACK_USERNAME', 'Claude Proxy')
    },
    get iconEmoji() {
      return env.string('SLACK_ICON_EMOJI', ':robot_face:')
    },
    // Only enable if webhook URL is provided
    get enabled() {
      return env.bool('SLACK_ENABLED', !!env.string('SLACK_WEBHOOK_URL', ''))
    },
  },

  // Spark API configuration
  spark: {
    get apiUrl() {
      return env.string('SPARK_API_URL', 'http://localhost:8000')
    },
    get apiKey() {
      return env.string('SPARK_API_KEY', '')
    },
    get enabled() {
      return env.bool('SPARK_ENABLED', !!env.string('SPARK_API_KEY', ''))
    },
  },

  // Telemetry
  telemetry: {
    get endpoint() {
      return env.string('TELEMETRY_ENDPOINT', '')
    },
    get enabled() {
      return env.bool('TELEMETRY_ENABLED', true)
    },
  },

  // Feature flags
  features: {
    get debug() {
      return env.bool('DEBUG', false)
    },
    get enableHealthChecks() {
      return env.bool('ENABLE_HEALTH_CHECKS', true)
    },
    get enableMetrics() {
      return env.bool('ENABLE_METRICS', true)
    },
    get enableNotifications() {
      return env.bool('ENABLE_NOTIFICATIONS', true)
    },
    get enableDashboard() {
      return env.bool('ENABLE_DASHBOARD', true)
    },
    get collectTestSamples() {
      return env.bool('COLLECT_TEST_SAMPLES', false)
    },
    get testSamplesDir() {
      return env.string('TEST_SAMPLES_DIR', 'test-samples')
    },
    get enableClientAuth() {
      return env.bool('ENABLE_CLIENT_AUTH', false)
    },
  },

  // Cache configuration
  cache: {
    get messageCacheSize() {
      return env.int('MESSAGE_CACHE_SIZE', 1000)
    },
    get credentialCacheTTL() {
      return env.int('CREDENTIAL_CACHE_TTL', 3600000)
    }, // 1 hour
    get credentialCacheSize() {
      return env.int('CREDENTIAL_CACHE_SIZE', 100)
    },
  },

  // AI Analysis configuration
  aiAnalysis: {
    // Gemini API configuration
    get geminiApiKey() {
      return env.string('GEMINI_API_KEY', '')
    },
    get geminiApiUrl() {
      return env.string('GEMINI_API_URL', 'https://generativelanguage.googleapis.com/v1beta/models')
    },
    get geminiModelName() {
      return env.string('GEMINI_MODEL_NAME', 'gemini-2.0-flash-exp')
    },

    // Security configurations
    get maxRetries() {
      return env.int('AI_ANALYSIS_MAX_RETRIES', 2)
    },
    get requestTimeoutMs() {
      return env.int('AI_ANALYSIS_REQUEST_TIMEOUT_MS', 60000)
    }, // 60 seconds

    // Rate limiting
    rateLimits: {
      get creation() {
        return env.int('AI_ANALYSIS_RATE_LIMIT_CREATION', 15)
      }, // 15 per minute
      get retrieval() {
        return env.int('AI_ANALYSIS_RATE_LIMIT_RETRIEVAL', 100)
      }, // 100 per minute
    },

    // Worker configuration
    get workerEnabled() {
      return env.bool('AI_WORKER_ENABLED', false)
    },
    get workerPollIntervalMs() {
      return env.int('AI_WORKER_POLL_INTERVAL_MS', 5000)
    },
    get workerMaxConcurrentJobs() {
      return env.int('AI_WORKER_MAX_CONCURRENT_JOBS', 3)
    },
    get workerJobTimeoutMinutes() {
      return env.int('AI_WORKER_JOB_TIMEOUT_MINUTES', 5)
    },

    // Security features
    get enablePIIRedaction() {
      return env.bool('AI_ANALYSIS_ENABLE_PII_REDACTION', true)
    },
    get enablePromptInjectionProtection() {
      return env.bool('AI_ANALYSIS_ENABLE_PROMPT_INJECTION_PROTECTION', true)
    },
    get enableOutputValidation() {
      return env.bool('AI_ANALYSIS_ENABLE_OUTPUT_VALIDATION', true)
    },
    get enableAuditLogging() {
      return env.bool('AI_ANALYSIS_ENABLE_AUDIT_LOGGING', true)
    },
  },

  // MCP (Model Context Protocol) configuration
  mcp: {
    enabled: env.bool('MCP_ENABLED', false),
    github: {
      owner: env.string('MCP_GITHUB_OWNER', ''),
      repo: env.string('MCP_GITHUB_REPO', ''),
      branch: env.string('MCP_GITHUB_BRANCH', 'main'),
      token: env.string('MCP_GITHUB_TOKEN', ''),
      path: env.string('MCP_GITHUB_PATH', 'prompts/'),
    },
    sync: {
      interval: env.int('MCP_SYNC_INTERVAL', 300), // 5 minutes
      webhookSecret: env.string('MCP_GITHUB_WEBHOOK_SECRET', ''),
    },
    cache: {
      ttl: env.int('MCP_CACHE_TTL', 300), // 5 minutes
      maxSize: env.int('MCP_CACHE_SIZE', 1000),
    },
  },

  // HTTP cache configuration
  httpCache: {
    get dashboardApiMaxAge() {
      return env.int('DASHBOARD_API_CACHE_MAX_AGE', 0)
    }, // 0 = no-cache
    get staticFilesMaxAge() {
      return env.int('STATIC_FILES_CACHE_MAX_AGE', 3600)
    }, // 1 hour default
    get dashboardApiCacheControl() {
      const maxAge = this.dashboardApiMaxAge
      return maxAge > 0 ? `private, max-age=${maxAge}` : 'no-cache, no-store, must-revalidate'
    },
    get staticFilesCacheControl() {
      const maxAge = this.staticFilesMaxAge
      return `public, max-age=${maxAge}`
    },
  },
}

// Validate required configuration
export function validateConfig(): void {
  const errors: string[] = []

  // Check for critical missing configuration
  if (config.storage.enabled && !config.database.url && !config.database.host) {
    errors.push('Storage is enabled but no database configuration provided')
  }

  if (
    config.slack.enabled &&
    config.slack.webhookUrl &&
    !config.slack.webhookUrl.startsWith('https://')
  ) {
    errors.push('Invalid Slack webhook URL')
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`)
  }
}

// Export type for configuration
export type Config = typeof config

// Export AI analysis configuration
export {
  ANALYSIS_PROMPT_CONFIG,
  GEMINI_CONFIG,
  AI_WORKER_CONFIG,
  AI_ANALYSIS_CONFIG,
} from './ai-analysis.js'
