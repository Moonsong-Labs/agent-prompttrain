import { logger } from '../middleware/logger.js'
import {
  retryWithBackoff as sharedRetryWithBackoff,
  defaultRetryConfig,
  isRetryableError,
  calculateDelay,
  retryConfigs,
  getRetryAfter,
  type RetryConfig,
  type RetryLogger,
} from '@agent-prompttrain/shared'

// Re-export all the types and functions
export type { RetryConfig, RetryLogger }
export { defaultRetryConfig, isRetryableError, calculateDelay, retryConfigs, getRetryAfter }

// Create logger adapter for proxy
const proxyRetryLogger: RetryLogger = {
  info: (message: string, context?: any) => logger.info(message, context),
  warn: (message: string, context?: any) => logger.warn(message, context),
}

// Proxy-specific retry with logging
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  context?: { requestId?: string; operation?: string }
): Promise<T> {
  return sharedRetryWithBackoff(fn, { ...config, logger: proxyRetryLogger }, context)
}
