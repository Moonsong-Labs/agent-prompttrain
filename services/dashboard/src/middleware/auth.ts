import { Context, Next, MiddlewareHandler } from 'hono'
import { getDevUserEmail, getSsoHeaderNames, getSsoAllowedDomains } from '../config.js'

export type AuthContext = {
  isAuthenticated: boolean
  principal: string
  source: 'dev' | 'sso'
}

/**
 * Dashboard authentication middleware
 * Enforces mandatory user authentication via oauth2-proxy headers
 * In development, allows bypass via DASHBOARD_DEV_USER_EMAIL environment variable
 */
export const dashboardAuth: MiddlewareHandler<{ Variables: { auth: AuthContext } }> = async (
  c,
  next
) => {
  const devUserEmail = getDevUserEmail()
  const ssoHeaderNames = getSsoHeaderNames()
  const allowedDomains = getSsoAllowedDomains()

  // Development mode: use email from environment variable
  if (devUserEmail) {
    c.set('auth', {
      isAuthenticated: true,
      principal: devUserEmail,
      source: 'dev',
    })
    return next()
  }

  // Production mode: extract user email from oauth2-proxy headers
  const forwardedIdentity = ssoHeaderNames
    .map(headerName => c.req.header(headerName))
    .find((value): value is string => Boolean(value))

  if (forwardedIdentity) {
    const normalizedIdentity = forwardedIdentity.trim()

    // If allow list is configured, enforce it for email-style principals
    if (allowedDomains.length > 0 && normalizedIdentity.includes('@')) {
      const domain = normalizedIdentity.split('@').pop()?.toLowerCase()
      if (!domain || !allowedDomains.includes(domain)) {
        return c.json({ error: 'Forbidden: Domain not allowed' }, 403)
      }
    }

    c.set('auth', {
      isAuthenticated: true,
      principal: normalizedIdentity,
      source: 'sso',
    })

    return next()
  }

  // No valid authentication found
  const acceptHeader = c.req.header('Accept') || ''
  if (acceptHeader.includes('text/html')) {
    return c.html(
      `
      <div style="text-align: center; padding: 50px; font-family: sans-serif;">
        <h1>Authentication Required</h1>
        <p>This dashboard requires oauth2-proxy authentication.</p>
        <p>Please ensure oauth2-proxy is properly configured.</p>
        <p>For development, set DASHBOARD_DEV_USER_EMAIL in your .env file.</p>
      </div>
    `,
      401
    )
  }

  // Return 401 for API requests
  return c.json({ error: 'Unauthorized: No valid authentication headers found' }, 401)
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
