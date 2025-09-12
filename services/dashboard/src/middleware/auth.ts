import { Context, Next, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { isReadOnly, getDashboardApiKey } from '../config.js'
import { sessionService } from '../services/SessionService.js'
import { User } from '@agent-prompttrain/shared'

export type AuthContext = {
  isAuthenticated: boolean
  isReadOnly: boolean
  authType: 'oauth' | 'api_key' | 'none'
  user?: User
}

/**
 * Dashboard authentication middleware
 * Protects dashboard routes with OAuth or API key authentication
 * Supports read-only mode when DASHBOARD_API_KEY is not set
 */
export const dashboardAuth: MiddlewareHandler<{ Variables: { auth: AuthContext } }> = async (
  c,
  next
) => {
  // Skip auth for login page and OAuth routes
  if (
    c.req.path === '/dashboard/login' ||
    c.req.path === '/dashboard/login/' ||
    c.req.path === '/login' ||
    c.req.path === '/login/' ||
    c.req.path.startsWith('/dashboard/auth/') ||
    c.req.path.startsWith('/auth/')
  ) {
    return next()
  }

  // Check read-only mode dynamically
  const readOnly = isReadOnly()
  const apiKey = getDashboardApiKey()

  // Check OAuth session first
  const sessionToken = getCookie(c, 'dashboard_session')
  if (sessionToken) {
    const sessionData = await sessionService.getSessionWithUser(sessionToken)
    if (sessionData) {
      c.set('auth', {
        isAuthenticated: true,
        isReadOnly: false,
        authType: 'oauth',
        user: sessionData.user,
      })
      return next()
    }
  }

  // Set default context
  c.set('auth', {
    isAuthenticated: false,
    isReadOnly: readOnly,
    authType: 'none',
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

  // Check cookie authentication (API key)
  const authCookie = getCookie(c, 'dashboard_auth')
  if (authCookie === apiKey) {
    c.set('auth', {
      isAuthenticated: true,
      isReadOnly: false,
      authType: 'api_key',
    })
    return next()
  }

  // Check header authentication (for API calls)
  const headerKey = c.req.header('X-Dashboard-Key')
  if (headerKey === apiKey) {
    c.set('auth', {
      isAuthenticated: true,
      isReadOnly: false,
      authType: 'api_key',
    })
    return next()
  }

  // For SSE endpoints, properly validate authentication
  if (c.req.path.includes('/sse')) {
    // Check OAuth session first
    if (sessionToken) {
      const sessionData = await sessionService.getSessionWithUser(sessionToken)
      if (sessionData) {
        c.set('auth', {
          isAuthenticated: true,
          isReadOnly: false,
          authType: 'oauth',
          user: sessionData.user,
        })
        return next()
      }
    }

    // Check API key authentication
    if (authCookie === apiKey || headerKey === apiKey) {
      c.set('auth', {
        isAuthenticated: true,
        isReadOnly: false,
        authType: 'api_key',
      })
      return next()
    }

    // No valid authentication for SSE
    return c.json({ error: 'Unauthorized' }, 401)
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
 * Optional: Domain-scoped authentication
 * Allows restricting dashboard access to specific domains
 */
export const domainScopedAuth = async (c: Context, next: Next) => {
  // Get authenticated domain from context
  const authenticatedDomain = c.get('authenticatedDomain')

  // Get requested domain from query params
  const requestedDomain = c.req.query('domain')

  // If a specific domain is requested, verify access
  if (requestedDomain && authenticatedDomain !== 'admin') {
    if (authenticatedDomain !== requestedDomain) {
      return c.json({ error: 'Access denied to this domain' }, 403)
    }
  }

  return next()
}
