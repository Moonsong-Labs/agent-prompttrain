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

/**
 * Determine if SSO integration is enabled. Defaults to false unless explicitly set.
 */
export const isSsoEnabled = () => process.env.DASHBOARD_SSO_ENABLED === 'true'

/**
 * Headers forwarded by an upstream auth proxy that the dashboard should trust for identity.
 * Multiple header names can be provided as a comma separated list. Falls back to a sensible default
 * list that matches OAuth2 Proxy conventions.
 */
export const getSsoHeaderNames = (): string[] => {
  const raw = process.env.DASHBOARD_SSO_HEADERS
  if (raw && raw.trim().length > 0) {
    return raw
      .split(',')
      .map(header => header.trim())
      .filter(Boolean)
  }

  return ['X-Authenticated-User', 'X-Auth-Request-Email', 'X-Forwarded-Email']
}

/**
 * Optional allow list for email domains when authenticating via SSO headers. When set, any identity
 * outside the approved domains will be rejected even if the proxy forwarded it.
 */
export const getSsoAllowedDomains = (): string[] => {
  const raw = process.env.DASHBOARD_SSO_ALLOWED_DOMAINS
  if (!raw) {
    return []
  }

  return raw
    .split(',')
    .map(domain => domain.trim().toLowerCase())
    .filter(Boolean)
}

// Legacy exports for backward compatibility
export const dashboardApiKey = process.env.DASHBOARD_API_KEY

/**
 * Export configuration flags for easy access
 */
export const dashboardConfig = {
  isReadOnly: isReadOnly(),
  dashboardApiKey,
  ssoEnabled: isSsoEnabled(),
  ssoHeaders: getSsoHeaderNames(),
  ssoAllowedDomains: getSsoAllowedDomains(),
} as const
