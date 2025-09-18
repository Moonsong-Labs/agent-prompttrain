import { Context, Next, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import {
  isReadOnly,
  getDashboardApiKey,
  isSsoEnabled,
  getSsoHeaderNames,
  getSsoAllowedDomains,
} from '../config.js'

export type AuthContext = {
  isAuthenticated: boolean
  isReadOnly: boolean
  principal?: string
  source?: 'api-key' | 'sso'
}

/**
 * Dashboard authentication middleware
 * Protects dashboard routes with API key authentication
 * Supports read-only mode when DASHBOARD_API_KEY is not set
 */
export const dashboardAuth: MiddlewareHandler<{ Variables: { auth: AuthContext } }> = async (
  c,
  next
) => {
  // Skip auth for login page
  if (
    c.req.path === '/dashboard/login' ||
    c.req.path === '/dashboard/login/' ||
    c.req.path === '/login' ||
    c.req.path === '/login/'
  ) {
    return next()
  }

  // Check read-only mode dynamically
  const readOnly = isReadOnly()
  const apiKey = getDashboardApiKey()
  const ssoEnabled = isSsoEnabled()
  const ssoHeaderNames = getSsoHeaderNames()
  const allowedDomains = getSsoAllowedDomains()

  // Set read-only mode in context
  c.set('auth', {
    isAuthenticated: false,
    isReadOnly: readOnly,
  })

  // If in read-only mode, allow access without authentication
  if (readOnly) {
    return next()
  }

  // Check for dashboard API key in environment
  if (!apiKey) {
    // This should not happen given the isReadOnly check above, but keep for safety
    return c.html(
      `
      <div style="text-align: center; padding: 50px; font-family: sans-serif;">
        <h1>Dashboard Not Configured</h1>
        <p>Please set DASHBOARD_API_KEY environment variable to enable the dashboard.</p>
      </div>
    `,
      503
    )
  }

  // Check cookie authentication
  const authCookie = getCookie(c, 'dashboard_auth')
  if (authCookie === apiKey) {
    c.set('auth', {
      isAuthenticated: true,
      isReadOnly: false,
      principal: 'api-key-cookie',
      source: 'api-key',
    })
    return next()
  }

  // Check header authentication (for API calls)
  const headerKey = c.req.header('X-Dashboard-Key')
  if (headerKey === apiKey) {
    c.set('auth', {
      isAuthenticated: true,
      isReadOnly: false,
      principal: 'api-key-header',
      source: 'api-key',
    })
    return next()
  }

  if (ssoEnabled) {
    const forwardedIdentity = ssoHeaderNames
      .map(headerName => c.req.header(headerName))
      .find((value): value is string => Boolean(value))

    if (forwardedIdentity) {
      const normalizedIdentity = forwardedIdentity.trim()

      // If allow list is configured enforce it for email-style principals
      if (allowedDomains.length > 0 && normalizedIdentity.includes('@')) {
        const domain = normalizedIdentity.split('@').pop()?.toLowerCase()
        if (!domain || !allowedDomains.includes(domain)) {
          return c.json({ error: 'Forbidden' }, 403)
        }
      }

      c.set('auth', {
        isAuthenticated: true,
        isReadOnly: false,
        principal: normalizedIdentity,
        source: 'sso',
      })

      return next()
    }
  }

  // For SSE endpoints, check if user has auth cookie (browsers send cookies with EventSource)
  if (c.req.path.includes('/sse') && authCookie) {
    // Even if cookie doesn't match, let it through if it exists
    // The SSE handler can do additional validation
    return next()
  }

  // Redirect to login for HTML requests
  const acceptHeader = c.req.header('Accept') || ''
  if (acceptHeader.includes('text/html')) {
    return c.redirect('/dashboard/login')
  }

  // Return 401 for API requests
  return c.json({ error: 'Unauthorized' }, 401)
}

/**
 * Optional: Train ID-scoped authentication
 * Allows restricting dashboard access to specific train identifiers
 */
export const trainScopedAuth = async (c: Context, next: Next) => {
  const authenticatedTrainId = c.get('authenticatedTrainId')
  const requestedTrainId = c.req.query('trainId')

  if (requestedTrainId && authenticatedTrainId && authenticatedTrainId !== 'admin') {
    if (authenticatedTrainId !== requestedTrainId) {
      return c.json({ error: 'Access denied to this train' }, 403)
    }
  }

  return next()
}
