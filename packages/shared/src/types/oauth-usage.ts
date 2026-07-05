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
 * Scope of a limit entry. Model-scoped limits (e.g. a separate weekly
 * allowance for Claude Fable 5) carry a `model` object; `id` and/or
 * `display_name` may be populated.
 */
export interface OAuthLimitScope {
  model: { id: string | null; display_name: string | null } | null
  surface: string | null
}

/**
 * A single entry in the `limits` array of the OAuth usage response.
 *
 * This is the forward-compatible limit surface: Anthropic has migrated
 * model-specific data out of the legacy `seven_day_opus`/`seven_day_sonnet`
 * fields (now null in live responses) into this array. Known kinds:
 * `session` (mirrors five_hour), `weekly_all` (mirrors seven_day), and
 * `weekly_scoped` (model-specific weekly limit, e.g. Claude Fable 5).
 */
export interface OAuthLimitEntry {
  kind: string
  group: string | null
  /** Usage percentage (0-100) */
  percent: number | null
  severity: string | null
  /** ISO timestamp when this limit resets (null when not active) */
  resets_at: string | null
  scope: OAuthLimitScope | null
  is_active: boolean | null
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
  /** 7-day Opus model specific limit (legacy — null in current responses) */
  seven_day_opus: OAuthUsageWindow | null
  /** 7-day Sonnet model specific limit (legacy — null in current responses) */
  seven_day_sonnet: OAuthUsageWindow | null
  /** Internal/experimental field */
  iguana_necktie: OAuthUsageWindow | null
  /**
   * Structured limits, including model-scoped weekly limits (e.g. Claude
   * Fable 5). Optional: older cached entries may not carry it.
   */
  limits?: OAuthLimitEntry[] | null
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
  /** Whether this data is extrapolated due to API rate limiting */
  is_estimated?: boolean
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
