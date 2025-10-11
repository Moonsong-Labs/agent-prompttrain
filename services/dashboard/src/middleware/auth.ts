import { Context, Next, MiddlewareHandler } from 'hono'
import {
  getDevUserEmail,
  getSsoHeaderNames,
  getSsoAllowedDomains,
  getAlbOidcEnabled,
} from '../config.js'

export type AuthContext = {
  isAuthenticated: boolean
  principal: string
  source: 'dev' | 'sso' | 'alb-oidc'
}

/**
 * Decode AWS ALB OIDC JWT payload without verification
 * This extracts the email claim from the x-amzn-oidc-data header
 *
 * Security note: This implementation does NOT verify the JWT signature.
 * In production, you should verify the JWT using the public key from:
 * https://public-keys.auth.elb.<region>.amazonaws.com/<kid>
 *
 * @param jwt - The JWT token from x-amzn-oidc-data header
 * @returns The email claim if found, null otherwise
 */
function decodeAlbOidcJwt(jwt: string): string | null {
  try {
    // JWT format: header.payload.signature
    const parts = jwt.split('.')
    if (parts.length !== 3) {
      return null
    }

    // Decode the payload (second part)
    const payload = parts[1]
    // Base64URL decode - replace URL-safe characters and add padding if needed
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const paddedBase64 = base64 + '==='.slice((base64.length + 3) % 4)
    const decodedPayload = Buffer.from(paddedBase64, 'base64').toString('utf8')

    // Parse JSON payload
    const claims = JSON.parse(decodedPayload)

    // Extract email claim (standard OIDC claim)
    return claims.email || null
  } catch {
    // Invalid JWT format or decoding error
    return null
  }
}

/**
 * Dashboard authentication middleware
 * Supports multiple authentication methods:
 * 1. Development bypass via DASHBOARD_DEV_USER_EMAIL
 * 2. AWS ALB OIDC via x-amzn-oidc-data header
 * 3. OAuth2-proxy via forwarded headers (X-Auth-Request-Email, etc.)
 */
export const dashboardAuth: MiddlewareHandler<{ Variables: { auth: AuthContext } }> = async (
  c,
  next
) => {
  const devUserEmail = getDevUserEmail()
  const ssoHeaderNames = getSsoHeaderNames()
  const allowedDomains = getSsoAllowedDomains()
  const albOidcEnabled = getAlbOidcEnabled()

  // Development mode: use email from environment variable
  if (devUserEmail) {
    c.set('auth', {
      isAuthenticated: true,
      principal: devUserEmail,
      source: 'dev',
    })
    return next()
  }

  // AWS ALB OIDC mode: extract email from x-amzn-oidc-data JWT
  if (albOidcEnabled) {
    const albOidcData = c.req.header('x-amzn-oidc-data')
    if (albOidcData) {
      const email = decodeAlbOidcJwt(albOidcData)
      if (email) {
        // If allow list is configured, enforce it
        if (allowedDomains.length > 0) {
          const domain = email.split('@').pop()?.toLowerCase()
          if (!domain || !allowedDomains.includes(domain)) {
            return c.json({ error: 'Forbidden: Domain not allowed' }, 403)
          }
        }

        c.set('auth', {
          isAuthenticated: true,
          principal: email,
          source: 'alb-oidc',
        })
        return next()
      }
    }
  }

  // OAuth2-proxy mode: extract user email from forwarded headers
  const headerValues = ssoHeaderNames.map(headerName => ({
    name: headerName,
    value: c.req.header(headerName),
  }))

  const forwardedIdentity = headerValues.find((h): h is { name: string; value: string } =>
    Boolean(h.value)
  )

  if (forwardedIdentity) {
    const normalizedIdentity = forwardedIdentity.value.trim()

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
        <p>This dashboard requires authentication via:</p>
        <ul style="text-align: left; display: inline-block;">
          <li>AWS ALB OIDC (x-amzn-oidc-data header), or</li>
          <li>oauth2-proxy (X-Auth-Request-Email header)</li>
        </ul>
        <p>Please ensure your authentication proxy is properly configured.</p>
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
 * Optional: Project ID-scoped authentication
 * Allows restricting dashboard access to specific train identifiers
 */
export const trainScopedAuth = async (c: Context, next: Next) => {
  const authenticatedTrainId = c.get('authenticatedTrainId')
  const requestedTrainId = c.req.query('projectId')

  if (requestedTrainId && authenticatedTrainId && authenticatedTrainId !== 'admin') {
    if (authenticatedTrainId !== requestedTrainId) {
      return c.json({ error: 'Access denied to this train' }, 403)
    }
  }

  return next()
}
