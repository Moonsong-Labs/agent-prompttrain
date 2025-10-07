/**
 * Dashboard-specific configuration
 */

/**
 * Get the development user email for local development bypass
 * When set, this email will be used instead of requiring oauth2-proxy headers
 * This should ONLY be used in development environments
 */
export const getDevUserEmail = () => process.env.DASHBOARD_DEV_USER_EMAIL

/**
 * Check if running in development mode (dev user email is set)
 */
export const isDevMode = () => Boolean(getDevUserEmail())

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

/**
 * Export configuration flags for easy access
 */
export const dashboardConfig = {
  devUserEmail: getDevUserEmail(),
  isDevMode: isDevMode(),
  ssoHeaders: getSsoHeaderNames(),
  ssoAllowedDomains: getSsoAllowedDomains(),
} as const
