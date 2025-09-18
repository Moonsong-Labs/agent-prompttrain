/**
 * Pino-based logger implementation for high-performance structured logging
 * Designed to work with Bun runtime without transports
 */

import pino, { type Logger as PinoLogger } from 'pino'

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
    originalError?: unknown
  }
}

/**
 * Create a Pino-based logger instance for a service
 * Uses stdout for output, allowing infrastructure to handle log routing
 */
export function createPinoLogger(options: LoggerOptions): PinoLogger {
  const level = options.level || process.env.LOG_LEVEL || 'info'

  // For development, you can pipe to pino-pretty:
  // bun run dev | pino-pretty
  const pinoOptions: pino.LoggerOptions = {
    level,
    base: {
      service: options.service,
      pid: process.pid,
      hostname: process.env.HOSTNAME || 'unknown',
    },
    // Redact sensitive fields
    redact: {
      paths: ['*.password', '*.token', '*.apiKey', '*.api_key', 'headers.authorization'],
      censor: '[REDACTED]',
    },
    // Custom serializers for common objects
    serializers: {
      error: pino.stdSerializers.err,
      request: (req: any) => ({
        method: req.method,
        url: req.url,
        headers: req.headers,
        remoteAddress: req.remoteAddress,
        remotePort: req.remotePort,
      }),
      response: (res: any) => ({
        statusCode: res.statusCode,
        headers: res.headers,
      }),
    },
  }

  return pino(pinoOptions)
}

/**
 * Create a child logger with request context
 * This ensures all logs for a request include the requestId and trainId
 */
export function createRequestLogger(
  parentLogger: PinoLogger,
  context: { requestId: string; trainId?: string }
): PinoLogger {
  return parentLogger.child(context)
}

/**
 * Helper to format error objects for logging
 * Handles both Error instances and unknown thrown values
 */
export function formatError(error: unknown): Record<string, any> {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
      name: error.name,
      ...(error as any), // Include any additional properties
    }
  }

  // For non-Error objects, try to serialize them
  if (typeof error === 'object' && error !== null) {
    try {
      return {
        type: 'non-error-object',
        value: JSON.parse(JSON.stringify(error)),
      }
    } catch {
      return {
        type: 'non-error-object',
        value: String(error),
      }
    }
  }

  // For primitives
  return {
    type: 'primitive',
    value: String(error),
  }
}

/**
 * Adapter to maintain compatibility with existing logger interface
 * while using Pino under the hood
 */
export function createLogger(options: LoggerOptions) {
  const pinoLogger = createPinoLogger(options)

  return {
    debug: (message: string, context?: LogContext) => {
      pinoLogger.debug(transformContext(context), message)
    },
    info: (message: string, context?: LogContext) => {
      pinoLogger.info(transformContext(context), message)
    },
    warn: (message: string, context?: LogContext) => {
      pinoLogger.warn(transformContext(context), message)
    },
    error: (message: string, context?: LogContext) => {
      pinoLogger.error(transformContext(context), message)
    },
    // Expose the underlying Pino logger for advanced usage
    pino: pinoLogger,
  }
}

/**
 * Transform our LogContext to Pino's expected format
 */
function transformContext(context?: LogContext): Record<string, any> {
  if (!context) {
    return {}
  }

  const result: Record<string, any> = {}

  if (context.requestId) {
    result.requestId = context.requestId
  }
  if (context.trainId) {
    result.trainId = context.trainId
  }

  // Flatten metadata into the log entry
  if (context.metadata) {
    Object.assign(result, context.metadata)
  }

  // Handle error specially
  if (context.error) {
    result.error = formatError(context.error.originalError || context.error)
  }

  return result
}
