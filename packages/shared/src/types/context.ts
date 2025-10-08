/**
 * Typed context variables for Hono
 * Ensures type safety across middleware and handlers
 */
export type HonoVariables = {
  // Request identification
  requestId: string

  // Authentication
  apiKey?: string
  teamId?: string
  credential?: any // OAuth or API key credential

  // Request/Response data
  validatedBody?: any
  originalRequest?: any
  claudeResponse?: any

  // Metrics
  inputTokens?: number
  outputTokens?: number
  startTime?: number

  // Post-response tasks
  postRequestTasks?: (() => Promise<void>)[]

  // Request metadata
  projectId?: string
  trainAccount?: string
  requestType?: 'query_evaluation' | 'inference'
  model?: string

  // Database pool (used in proxy service)
  pool?: any
}

/**
 * Typed bindings for edge runtime environments
 */
export type HonoBindings = {
  // Environment variables
  DATABASE_URL?: string
  SLACK_WEBHOOK_URL?: string
  DEBUG?: string

  // Cloudflare bindings (if deployed to Workers)
  KV?: any
  DO?: any
  QUEUE?: any
}
