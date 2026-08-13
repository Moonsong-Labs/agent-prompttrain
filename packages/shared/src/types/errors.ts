/**
 * Custom error types for better error handling and debugging
 */

export class BaseError extends Error {
  public readonly timestamp: Date
  public readonly context?: Record<string, any>

  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 500,
    context?: Record<string, any>
  ) {
    super(message)
    this.name = this.constructor.name
    this.timestamp = new Date()
    this.context = context
    Error.captureStackTrace(this, this.constructor)
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      timestamp: this.timestamp,
      context: this.context,
      stack: this.stack,
    }
  }
}

export class ValidationError extends BaseError {
  constructor(message: string, context?: Record<string, any>) {
    super('VALIDATION_ERROR', message, 400, context)
  }
}

export class AuthenticationError extends BaseError {
  constructor(message: string, context?: Record<string, any>) {
    super('AUTHENTICATION_ERROR', message, 401, context)
  }
}

export class AuthorizationError extends BaseError {
  constructor(message: string, context?: Record<string, any>) {
    super('AUTHORIZATION_ERROR', message, 403, context)
  }
}

export class NotFoundError extends BaseError {
  constructor(message: string, context?: Record<string, any>) {
    super('NOT_FOUND', message, 404, context)
  }
}

export class RateLimitError extends BaseError {
  public readonly retryAfter?: number

  constructor(message: string, retryAfter?: number, context?: Record<string, any>) {
    super('RATE_LIMIT_ERROR', message, 429, context)
    this.retryAfter = retryAfter
  }
}

export class UpstreamError extends BaseError {
  public readonly upstreamResponse?: any
  public readonly upstreamHeaders?: Record<string, string>

  constructor(
    message: string,
    public readonly upstreamStatus?: number,
    context?: Record<string, any>,
    upstreamResponse?: any,
    upstreamHeaders?: Record<string, string>
  ) {
    super('UPSTREAM_ERROR', message, upstreamStatus || 502, context)
    this.upstreamResponse = upstreamResponse
    this.upstreamHeaders = upstreamHeaders
  }
}

export class TimeoutError extends BaseError {
  constructor(message: string, context?: Record<string, any>) {
    super('TIMEOUT_ERROR', message, 504, context)
  }
}

export class ConfigurationError extends BaseError {
  constructor(message: string, context?: Record<string, any>) {
    super('CONFIGURATION_ERROR', message, 500, context)
  }
}

export class StorageError extends BaseError {
  constructor(message: string, context?: Record<string, any>) {
    super('STORAGE_ERROR', message, 500, context)
  }
}

// Error handler middleware
export function isOperationalError(error: Error): boolean {
  if (error instanceof BaseError) {
    return true
  }
  return false
}

// Map error codes to Claude API error types
const errorCodeToType: Record<string, string> = {
  AUTHENTICATION_ERROR: 'authentication_error',
  AUTHORIZATION_ERROR: 'permission_error',
  VALIDATION_ERROR: 'invalid_request_error',
  RATE_LIMIT_ERROR: 'rate_limit_error',
  NOT_FOUND: 'not_found_error',
  UPSTREAM_ERROR: 'api_error',
  TIMEOUT_ERROR: 'timeout_error',
  CONFIGURATION_ERROR: 'internal_error',
  STORAGE_ERROR: 'internal_error',
  INTERNAL_ERROR: 'internal_error',
}

// Serialize error for API response
export function serializeError(error: Error): any {
  // Special handling for UpstreamError to return Claude's original error format
  if (error instanceof UpstreamError && error.upstreamResponse) {
    // Return Claude's error response directly to maintain compatibility
    return error.upstreamResponse
  }

  if (error instanceof BaseError) {
    // Use Claude's error format for compatibility
    return {
      error: {
        type: errorCodeToType[error.code] || 'internal_error',
        message: error.message,
        request_id: error.context?.requestId,
      },
    }
  }

  // Handle non-operational errors
  return {
    error: {
      code: 'INTERNAL_ERROR',
      message: error.message || 'An unexpected error occurred',
      statusCode: 500,
      timestamp: new Date(),
    },
  }
}
