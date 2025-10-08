// Re-export all shared modules
export * from './types/index.js'
export * from './config/index.js'
export * from './logger/index.js'
export * from './utils/errors.js'
export * from './utils/conversation-hash.js'
export * from './utils/conversation-linker.js'
export * from './utils/system-reminder.js'
export * from './utils/validation.js'

// Re-export specific functions to ensure they're available
export {
  getErrorMessage,
  getErrorStack,
  getErrorCode,
  hasStatusCode,
  isError,
  getStatusCode,
} from './utils/errors.js'

export { createLogger } from './logger/index.js'

export {
  hashMessagesOnly,
  hashSystemPrompt,
  extractMessageHashes,
  generateConversationId,
} from './utils/conversation-hash.js'

export { config } from './config/index.js'

export {
  ConversationLinker,
  type QueryExecutor,
  type CompactSearchExecutor,
  type RequestByIdExecutor,
  type SubtaskQueryExecutor,
  type SubtaskSequenceQueryExecutor,
  type LinkingRequest,
  type LinkingResult,
  type ParentQueryCriteria,
  type TaskInvocation,
} from './utils/conversation-linker.js'

export { stripSystemReminder, containsSystemReminder } from './utils/system-reminder.js'

// Export retry utilities
export {
  retryWithBackoff,
  defaultRetryConfig,
  isRetryableError,
  calculateDelay,
  retryConfigs,
  getRetryAfter,
} from './utils/retry.js'
export type { RetryConfig, RetryLogger } from './utils/retry.js'

// Export formatting utilities
export {
  formatNumber,
  formatDuration,
  formatTimestamp,
  formatRelativeTime,
  escapeHtml,
} from './utils/formatters.js'

// Export model limits configuration
export {
  MODEL_CONTEXT_RULES,
  DEFAULT_CONTEXT_LIMIT,
  BATTERY_THRESHOLDS,
  getModelContextLimit,
  getBatteryColor,
  getBatteryLevel,
  type ModelContextRule,
} from './constants/model-limits.js'

export {
  MSL_PROJECT_ID_HEADER,
  MSL_PROJECT_ID_HEADER_LOWER,
  MSL_ACCOUNT_HEADER,
  MSL_ACCOUNT_HEADER_LOWER,
} from './constants/http-headers.js'

// Export AI analysis types and configuration
export {
  ConversationAnalysisSchema,
  type ConversationAnalysis,
  type AnalysisStatus,
  ConversationAnalysisStatus,
  CreateAnalysisRequestSchema,
  type CreateAnalysisRequest,
  type CreateAnalysisResponse,
  type GetAnalysisResponse,
  type RegenerateAnalysisResponse,
  type AnalysisConflictResponse,
} from './types/ai-analysis.js'
export {
  ANALYSIS_PROMPT_CONFIG,
  GEMINI_CONFIG,
  AI_WORKER_CONFIG,
  AI_ANALYSIS_CONFIG,
} from './config/ai-analysis.js'

// Export prompt utilities
export {
  truncateConversation,
  buildAnalysisPrompt,
  parseAnalysisResponse,
  getAnalysisPromptTemplate,
  type Message,
  type GeminiContent,
} from './prompts/index.js'
