/**
 * Types for Anthropic OAuth usage API response
 * API: GET https://api.anthropic.com/api/oauth/usage
 * Header: anthropic-beta: oauth-2025-04-20
 */

/**
 * Individual usage window from Anthropic OAuth API
 */
export interface OAuthUsageWindow {
  /** Usage percentage (0-100) */
  utilization: number
  /** ISO timestamp when this window resets */
  resets_at: string
}

/**
 * Extra usage configuration for paid accounts
 */
export interface OAuthExtraUsage {
  is_enabled: boolean
  monthly_limit: number | null
  used_credits: number | null
  utilization: number | null
}

/**
 * Raw response from Anthropic OAuth usage API
 */
export interface AnthropicOAuthUsageResponse {
  /** 5-hour rolling window usage */
  five_hour: OAuthUsageWindow | null
  /** 7-day rolling window usage */
  seven_day: OAuthUsageWindow | null
  /** 7-day OAuth apps specific limit */
  seven_day_oauth_apps: OAuthUsageWindow | null
  /** 7-day Opus model specific limit */
  seven_day_opus: OAuthUsageWindow | null
  /** 7-day Sonnet model specific limit */
  seven_day_sonnet: OAuthUsageWindow | null
  /** Internal/experimental field */
  iguana_necktie: OAuthUsageWindow | null
  /** Extra usage for paid accounts */
  extra_usage: OAuthExtraUsage
}

/**
 * Processed OAuth usage for display in dashboard
 */
export interface OAuthUsageDisplay {
  account_id: string
  provider: 'anthropic'
  /** Whether this account has OAuth usage data available */
  available: boolean
  /** Error message if usage couldn't be fetched */
  error?: string
  /** Usage windows - only non-null windows from API */
  windows: OAuthUsageWindowDisplay[]
  /** Fetched timestamp */
  fetched_at: string
}

/**
 * Processed usage window for display
 */
export interface OAuthUsageWindowDisplay {
  /** Display name for the window */
  name: string
  /** Short label for compact display */
  short_name: string
  /** Usage percentage (0-100) */
  utilization: number
  /** Human-readable reset time */
  resets_at: string
  /** ISO timestamp for reset */
  resets_at_iso: string
}

/**
 * Response from proxy OAuth usage endpoint
 */
export interface OAuthUsageApiResponse {
  success: boolean
  data?: OAuthUsageDisplay
  error?: string
}
