// Safety margin to account for discrepancies between local and server-side tokenizers
const TOKENIZER_SAFETY_MARGIN = Number(process.env.AI_TOKENIZER_SAFETY_MARGIN) || 0.95

// Helper function to parse JSON from environment variables
function parseEnvJson<T>(envVar: string | undefined, defaultValue: T): T {
  if (!envVar) {
    return defaultValue
  }
  try {
    return JSON.parse(envVar) as T
  } catch {
    console.warn(`Failed to parse JSON from environment variable: ${envVar}`)
    return defaultValue
  }
}

export const ANALYSIS_PROMPT_CONFIG = {
  // Using Gemini 1.5 Pro's 1M context window, leaving room for response.
  // We can tune this based on observed output token sizes.
  MAX_CONTEXT_TOKENS: Number(process.env.AI_MAX_CONTEXT_TOKENS) || 1000000,
  // Apply safety margin to avoid potential tokenizer discrepancies
  MAX_PROMPT_TOKENS:
    Number(process.env.AI_MAX_PROMPT_TOKENS) ||
    Math.floor((Number(process.env.AI_MAX_PROMPT_TOKENS_BASE) || 900000) * TOKENIZER_SAFETY_MARGIN), // ~855k with 5% margin
  TRUNCATION_STRATEGY: parseEnvJson(process.env.AI_TRUNCATION_STRATEGY, {
    HEAD_MESSAGES: Number(process.env.AI_HEAD_MESSAGES) || 5,
    TAIL_MESSAGES: Number(process.env.AI_TAIL_MESSAGES) || 20,
  }),
  // Token to character ratio varies by content type
  // For typical text: ~4 chars/token, for repeated chars: ~16 chars/token
  ESTIMATED_CHARS_PER_TOKEN: Number(process.env.AI_ESTIMATED_CHARS_PER_TOKEN) || 12, // Conservative middle ground
  // Prompt version can be overridden by environment variables
  PROMPT_VERSION: process.env.AI_ANALYSIS_PROMPT_VERSION || 'v1',
  // Safety margin documentation
  TOKENIZER_SAFETY_MARGIN,
}

// Gemini API Configuration
// Use getters to read environment variables lazily after dotenv has loaded
export const GEMINI_CONFIG = {
  get API_URL() {
    return process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta/models'
  },
  get API_KEY() {
    return process.env.GEMINI_API_KEY || ''
  },
  get MODEL_NAME() {
    return process.env.GEMINI_MODEL_NAME || 'gemini-2.5-pro'
  },
}

// AI Analysis Worker Configuration
// Use getters to read environment variables lazily after dotenv has loaded
export const AI_WORKER_CONFIG = {
  get ENABLED() {
    return process.env.AI_WORKER_ENABLED === 'true'
  },
  get POLL_INTERVAL_MS() {
    return Number(process.env.AI_WORKER_POLL_INTERVAL_MS) || 5000
  },
  get MAX_CONCURRENT_JOBS() {
    return Number(process.env.AI_WORKER_MAX_CONCURRENT_JOBS) || 3
  },
  get JOB_TIMEOUT_MINUTES() {
    return Number(process.env.AI_WORKER_JOB_TIMEOUT_MINUTES) || 5
  },
  // New resilience configurations
  // Note: Some errors are non-retryable (schema validation, PII detection, etc.)
  // and will fail immediately regardless of this setting
  get MAX_RETRIES() {
    return Number(process.env.AI_ANALYSIS_MAX_RETRIES) || 3
  },
  get GEMINI_REQUEST_TIMEOUT_MS() {
    return Number(process.env.AI_ANALYSIS_GEMINI_REQUEST_TIMEOUT_MS) || 60000
  },
}

// Feature Flags and Analysis Configuration
export const AI_ANALYSIS_CONFIG = {
  // Token limits for prompt truncation (different from total context limits)
  // Renamed for clarity: This is the target token count for input message truncation
  INPUT_TRUNCATION_TARGET_TOKENS:
    Number(process.env.AI_ANALYSIS_INPUT_TRUNCATION_TARGET_TOKENS) || 8192,
  TRUNCATE_FIRST_N_TOKENS: Number(process.env.AI_ANALYSIS_TRUNCATE_FIRST_N_TOKENS) || 1000,
  TRUNCATE_LAST_M_TOKENS: Number(process.env.AI_ANALYSIS_TRUNCATE_LAST_M_TOKENS) || 4000,
}
