import { Context, Next } from 'hono'
import { customAlphabet } from 'nanoid'
import { getErrorMessage, getErrorStack, getErrorCode } from '@claude-nexus/shared'

// Generate short request IDs
const generateRequestId = customAlphabet('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', 12)

// Log levels
export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error'
}

// Structured log entry
interface LogEntry {
  timestamp: string
  level: LogLevel
  requestId: string
  message: string
  domain?: string
  method?: string
  path?: string
  statusCode?: number
  duration?: number
  error?: any
  metadata?: Record<string, any>
  stack?: string
  proxyUrl?: string
  params?: Record<string, any>
}

// Logger configuration
interface LoggerConfig {
  level: LogLevel
  prettyPrint: boolean
  maskSensitiveData: boolean
}

class Logger {
  private config: LoggerConfig

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = {
      level: (process.env.LOG_LEVEL as LogLevel) || LogLevel.INFO,
      prettyPrint: process.env.NODE_ENV !== 'production',
      maskSensitiveData: true,
      ...config
    }
  }

  private shouldLog(level: LogLevel): boolean {
    const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR]
    const currentLevelIndex = levels.indexOf(this.config.level)
    const messageLevelIndex = levels.indexOf(level)
    return messageLevelIndex >= currentLevelIndex
  }

  private maskSensitive(obj: any): any {
    if (!this.config.maskSensitiveData) return obj
    
    const sensitiveKeys = ['api_key', 'apiKey', 'x-api-key', 'authorization', 
                          'password', 'secret', 'token', 'refreshToken', 'accessToken']
    
    if (typeof obj === 'string') {
      // Mask API keys
      if (obj.startsWith('sk-ant-')) {
        return obj.substring(0, 10) + '****'
      }
      if (obj.startsWith('Bearer ')) {
        return 'Bearer ****'
      }
      return obj
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.maskSensitive(item))
    }
    
    if (obj && typeof obj === 'object') {
      const masked: any = {}
      for (const [key, value] of Object.entries(obj)) {
        if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk.toLowerCase()))) {
          masked[key] = '****'
        } else {
          masked[key] = this.maskSensitive(value)
        }
      }
      return masked
    }
    
    return obj
  }

  private formatLog(entry: LogEntry): string {
    const masked = this.maskSensitive(entry)
    
    if (this.config.prettyPrint) {
      const { timestamp, level, requestId, message, ...rest } = masked
      const prefix = `[${timestamp}] ${level.toUpperCase()} [${requestId}] ${message}`
      
      if (Object.keys(rest).length > 0) {
        return `${prefix}\n${JSON.stringify(rest, null, 2)}`
      }
      return prefix
    }
    
    return JSON.stringify(masked)
  }

  log(level: LogLevel, message: string, context: Partial<LogEntry> = {}) {
    if (!this.shouldLog(level)) return
    
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      requestId: context.requestId || 'system',
      message,
      ...context
    }
    
    const formatted = this.formatLog(entry)
    
    switch (level) {
      case LogLevel.DEBUG:
      case LogLevel.INFO:
        console.log(formatted)
        break
      case LogLevel.WARN:
        console.warn(formatted)
        break
      case LogLevel.ERROR:
        console.error(formatted)
        break
    }
  }

  debug(message: string, context?: Partial<LogEntry>) {
    this.log(LogLevel.DEBUG, message, context)
  }

  info(message: string, context?: Partial<LogEntry>) {
    this.log(LogLevel.INFO, message, context)
  }

  warn(message: string, context?: Partial<LogEntry>) {
    this.log(LogLevel.WARN, message, context)
  }

  error(message: string, context?: Partial<LogEntry>) {
    this.log(LogLevel.ERROR, message, context)
  }
}

// Global logger instance
export const logger = new Logger()

// Logging middleware
export function loggingMiddleware() {
  return async (c: Context, next: Next) => {
    const requestId = generateRequestId()
    const startTime = Date.now()
    
    // Attach request ID to context
    c.set('requestId', requestId)
    
    // Extract request info
    const domain = c.req.header('host') || 'unknown'
    const method = c.req.method
    const path = c.req.path
    const userAgent = c.req.header('user-agent')
    
    // Log incoming request
    logger.info('Incoming request', {
      requestId,
      domain,
      method,
      path,
      metadata: {
        userAgent,
        ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
        headers: logger['config'].level === LogLevel.DEBUG ? c.req.header() : undefined
      }
    })
    
    try {
      await next()
      
      // Log successful response
      const duration = Date.now() - startTime
      logger.info('Request completed', {
        requestId,
        domain,
        method,
        path,
        statusCode: c.res.status,
        duration,
        metadata: {
          contentLength: c.res.headers.get('content-length')
        }
      })
    } catch (error) {
      // Log error
      const duration = Date.now() - startTime
      logger.error('Request failed', {
        requestId,
        domain,
        method,
        path,
        statusCode: c.res.status || 500,
        duration,
        error: {
          message: getErrorMessage(error),
          stack: getErrorStack(error),
          code: getErrorCode(error)
        }
      })
      
      throw error
    }
  }
}

// Helper to get logger with request context
export function getRequestLogger(c: Context): {
  debug: (message: string, metadata?: Record<string, any>) => void
  info: (message: string, metadata?: Record<string, any>) => void
  warn: (message: string, metadata?: Record<string, any>) => void
  error: (message: string, error?: Error, metadata?: Record<string, any>) => void
} {
  const requestId = c.get('requestId') || 'unknown'
  const domain = c.req.header('host') || 'unknown'
  
  return {
    debug: (message: string, metadata?: Record<string, any>) => {
      logger.debug(message, { requestId, domain, metadata })
    },
    info: (message: string, metadata?: Record<string, any>) => {
      logger.info(message, { requestId, domain, metadata })
    },
    warn: (message: string, metadata?: Record<string, any>) => {
      logger.warn(message, { requestId, domain, metadata })
    },
    error: (message: string, error?: Error, metadata?: Record<string, any>) => {
      logger.error(message, {
        requestId,
        domain,
        error: error ? {
          message: error.message,
          stack: error.stack,
          code: (error as any).code
        } : undefined,
        metadata
      })
    }
  }
}