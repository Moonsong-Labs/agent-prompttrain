/**
 * Structured logging types for the Agent Prompt Train
 */

// Base log entry with common fields
export interface BaseLogEntry {
  timestamp: string
  level: 'debug' | 'info' | 'warn' | 'error'
  service: string
  message: string
  requestId?: string
  domain?: string
  projectId?: string
}

// HTTP request logging
export interface HttpRequestLog extends BaseLogEntry {
  eventType: 'http_request'
  method: string
  path: string
  statusCode?: number
  duration?: number
  ip?: string
  userAgent?: string
  headers?: Record<string, any>
  error?: {
    message: string
    stack?: string
    code?: string
  }
}

// System event logging
export interface SystemEventLog extends BaseLogEntry {
  eventType: 'system_event'
  version?: string
  port?: number
  systemField?: string
  proxyUrl?: string
  hasPool?: boolean
  metadata?: Record<string, any>
}

// API/Authentication logging
export interface AuthLog extends BaseLogEntry {
  eventType: 'auth'
  credentialPath?: string
  hasRefreshToken?: boolean
  keyPreview?: string
  expectedPath?: string
}

// Metrics/Usage logging
export interface MetricsLog extends BaseLogEntry {
  eventType: 'metrics'
  model?: string
  usage?: any
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
}

// Error logging
export interface ErrorLog extends BaseLogEntry {
  eventType: 'error'
  error: {
    message: string
    stack?: string
    code?: string
    originalError?: unknown
  }
  context?: Record<string, any>
}

// Storage/Database logging
export interface StorageLog extends BaseLogEntry {
  eventType: 'storage'
  operation: 'read' | 'write' | 'delete' | 'query'
  table?: string
  params?: Record<string, any>
  duration?: number
  error?: {
    message: string
    code?: string
  }
}

// Streaming/SSE logging
export interface StreamingLog extends BaseLogEntry {
  eventType: 'streaming'
  event?: string
  data?: any
  usage?: any
  chunk?: string
}

// Union type for all log entries
export type LogEntry =
  | BaseLogEntry
  | HttpRequestLog
  | SystemEventLog
  | AuthLog
  | MetricsLog
  | ErrorLog
  | StorageLog
  | StreamingLog

// Type guard functions
export function isHttpRequestLog(log: LogEntry): log is HttpRequestLog {
  return 'eventType' in log && log.eventType === 'http_request'
}

export function isSystemEventLog(log: LogEntry): log is SystemEventLog {
  return 'eventType' in log && log.eventType === 'system_event'
}

export function isAuthLog(log: LogEntry): log is AuthLog {
  return 'eventType' in log && log.eventType === 'auth'
}

export function isMetricsLog(log: LogEntry): log is MetricsLog {
  return 'eventType' in log && log.eventType === 'metrics'
}

export function isErrorLog(log: LogEntry): log is ErrorLog {
  return 'eventType' in log && log.eventType === 'error'
}

export function isStorageLog(log: LogEntry): log is StorageLog {
  return 'eventType' in log && log.eventType === 'storage'
}

export function isStreamingLog(log: LogEntry): log is StreamingLog {
  return 'eventType' in log && log.eventType === 'streaming'
}
