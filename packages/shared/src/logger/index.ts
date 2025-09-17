/**
 * Shared logger configuration and factory
 * Provides consistent logging across all services
 */

export * from './types.js'

export interface LoggerOptions {
  level?: string
  service: string
  prettyPrint?: boolean
}

export interface LogContext {
  requestId?: string
  trainId?: string
  metadata?: Record<string, any>
  error?: {
    message: string
    stack?: string
    code?: string
  }
}

/**
 * Create a logger instance for a service
 * This factory pattern allows each service to have its own logger
 * while maintaining consistent configuration
 */
export function createLogger(options: LoggerOptions) {
  const level = options.level || process.env.LOG_LEVEL || 'info'
  const prettyPrint = options.prettyPrint ?? process.env.NODE_ENV !== 'production'

  return {
    debug: (message: string, context?: LogContext) => {
      if (!shouldLog('debug', level)) {
        return
      }
      log('debug', options.service, message, context, prettyPrint)
    },
    info: (message: string, context?: LogContext) => {
      if (!shouldLog('info', level)) {
        return
      }
      log('info', options.service, message, context, prettyPrint)
    },
    warn: (message: string, context?: LogContext) => {
      if (!shouldLog('warn', level)) {
        return
      }
      log('warn', options.service, message, context, prettyPrint)
    },
    error: (message: string, context?: LogContext) => {
      if (!shouldLog('error', level)) {
        return
      }
      log('error', options.service, message, context, prettyPrint)
    },
  }
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
type LogLevel = (typeof LOG_LEVELS)[number]

function shouldLog(messageLevel: LogLevel, configuredLevel: string): boolean {
  const messageLevelIndex = LOG_LEVELS.indexOf(messageLevel)
  const configuredLevelIndex = LOG_LEVELS.indexOf(configuredLevel as LogLevel)
  return messageLevelIndex >= configuredLevelIndex
}

function log(
  level: LogLevel,
  service: string,
  message: string,
  context?: LogContext,
  prettyPrint?: boolean
) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service,
    message,
    ...context,
  }

  const output = prettyPrint ? formatPretty(entry) : JSON.stringify(entry)

  switch (level) {
    case 'debug':
    case 'info':
      console.log(output)
      break
    case 'warn':
      console.warn(output)
      break
    case 'error':
      console.error(output)
      break
  }
}

function formatPretty(entry: any): string {
  const { timestamp, level, service, message, ...rest } = entry
  const prefix = `[${timestamp}] ${level.toUpperCase()} [${service}] ${message}`

  if (Object.keys(rest).length > 0) {
    return `${prefix}\n${JSON.stringify(rest, null, 2)}`
  }
  return prefix
}
