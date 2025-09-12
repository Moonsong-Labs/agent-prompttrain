/**
 * Dashboard-specific configuration
 */

/**
 * Check if the dashboard is running in read-only mode
 * This is determined by the absence of DASHBOARD_API_KEY
 * Note: This is a function to allow dynamic checking in tests
 */
export const isReadOnly = () => !process.env.DASHBOARD_API_KEY

/**
 * Get the dashboard API key from environment
 * Note: This is a function to allow dynamic checking in tests
 */
export const getDashboardApiKey = () => process.env.DASHBOARD_API_KEY

// Legacy exports for backward compatibility
export const dashboardApiKey = process.env.DASHBOARD_API_KEY

/**
 * OAuth configuration
 */
export const oauthConfig = {
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: process.env.GOOGLE_REDIRECT_URI,
  allowedDomains:
    process.env.GOOGLE_ALLOWED_DOMAINS?.split(',')
      .map(d => d.trim())
      .filter(Boolean) || [],
  sessionDurationDays: process.env.SESSION_DURATION_DAYS
    ? parseInt(process.env.SESSION_DURATION_DAYS, 10)
    : 30,
} as const

/**
 * Check if OAuth is configured
 */
export const isOAuthConfigured = () =>
  !!(oauthConfig.clientId && oauthConfig.clientSecret && oauthConfig.redirectUri)

/**
 * Export configuration flags for easy access
 */
export const dashboardConfig = {
  isReadOnly: isReadOnly(),
  dashboardApiKey,
  oauth: oauthConfig,
  isOAuthConfigured: isOAuthConfigured(),
} as const
