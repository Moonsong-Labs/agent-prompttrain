import { Hono } from 'hono'
import { html } from 'hono/html'
import { setCookie, getCookie } from 'hono/cookie'
import { timingSafeEqual, randomBytes } from 'crypto'
import { layout } from '../layout/index.js'
import { isReadOnly } from '../config.js'
import { createGoogleOAuthService } from '../services/GoogleOAuthService.js'
import { sessionService } from '../services/SessionService.js'
import { findOrCreateUser } from '../db/users.js'
import { OAuthError, OAuthErrorType } from '@agent-prompttrain/shared'
import { authRateLimit, callbackRateLimit } from '../middleware/rateLimit.js'

type AuthVariables = {
  Variables: {
    csrfToken?: string
  }
}

export const authRoutes = new Hono<AuthVariables>()

// OAuth configuration check
const isOAuthConfigured = () => {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REDIRECT_URI
  )
}

// Generate state parameter for CSRF protection
const generateState = () => randomBytes(16).toString('hex')

/**
 * Login page
 */
authRoutes.get('/login', c => {
  // If in read-only mode, redirect to dashboard
  if (isReadOnly()) {
    return c.redirect('/dashboard')
  }

  // Get the CSRF token from context
  const csrfToken = c.get('csrfToken') || ''

  const showOAuth = isOAuthConfigured()
  const error = c.req.query('error')

  const content = html`
    <div
      style="max-width: 400px; margin: 4rem auto; background: white; padding: 2rem; border-radius: 0.5rem; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);"
    >
      <h2 style="margin: 0 0 1.5rem 0;">Dashboard Login</h2>

      ${error
        ? html`
            <div
              style="margin-bottom: 1rem; padding: 0.75rem; background: #fee; border: 1px solid #fcc; border-radius: 0.375rem; color: #c00;"
            >
              ${error === 'invalid'
                ? 'Invalid API key'
                : error === 'oauth_failed'
                  ? 'OAuth login failed'
                  : error === 'domain_not_allowed'
                    ? 'Your email domain is not allowed'
                    : 'Login failed'}
            </div>
          `
        : ''}
      ${showOAuth
        ? html`
            <div style="margin-bottom: 1.5rem;">
              <a
                href="/dashboard/auth/google"
                class="btn"
                style="display: flex; align-items: center; justify-content: center; width: 100%; text-decoration: none; background: #4285f4; color: white;"
              >
                <svg width="18" height="18" viewBox="0 0 18 18" style="margin-right: 0.5rem;">
                  <path
                    fill="#ffffff"
                    d="M17.64,9.20454545 C17.64,8.56636364 17.5827273,7.95272727 17.4763636,7.36363636 L9,7.36363636 L9,10.845 L13.8436364,10.845 C13.635,11.97 13.0009091,12.9231818 12.0477273,13.5613636 L12.0477273,15.8195455 L14.9563636,15.8195455 C16.6581818,14.2527273 17.64,11.9454545 17.64,9.20454545 L17.64,9.20454545 Z"
                  />
                  <path
                    fill="#ffffff"
                    d="M9,18 C11.43,18 13.4672727,17.1940909 14.9563636,15.8195455 L12.0477273,13.5613636 C11.2418182,14.1013636 10.2109091,14.4204545 9,14.4204545 C6.65590909,14.4204545 4.67181818,12.8372727 3.96409091,10.71 L0.957272727,10.71 L0.957272727,13.0418182 C2.43818182,15.9831818 5.48181818,18 9,18 L9,18 Z"
                  />
                  <path
                    fill="#ffffff"
                    d="M3.96409091,10.71 C3.78409091,10.17 3.68181818,9.59318182 3.68181818,9 C3.68181818,8.40681818 3.78409091,7.83 3.96409091,7.29 L3.96409091,4.95818182 L0.957272727,4.95818182 C0.347727273,6.17318182 0,7.54772727 0,9 C0,10.4522727 0.347727273,11.8268182 0.957272727,13.0418182 L3.96409091,10.71 L3.96409091,10.71 Z"
                  />
                  <path
                    fill="#ffffff"
                    d="M9,3.57954545 C10.3213636,3.57954545 11.5077273,4.03363636 12.4404545,4.92545455 L15.0218182,2.34409091 C13.4631818,0.891818182 11.4259091,0 9,0 C5.48181818,0 2.43818182,2.01681818 0.957272727,4.95818182 L3.96409091,7.29 C4.67181818,5.16272727 6.65590909,3.57954545 9,3.57954545 L9,3.57954545 Z"
                  />
                </svg>
                Sign in with Google
              </a>
            </div>

            <div style="text-align: center; margin: 1rem 0; color: #6b7280; font-size: 0.875rem;">
              — or —
            </div>
          `
        : ''}

      <form method="POST" action="/dashboard/login">
        <input type="hidden" name="_csrf" value="${csrfToken}" />
        <div style="margin-bottom: 1rem;">
          <label style="display: block; margin-bottom: 0.5rem; font-size: 0.875rem; color: #374151;"
            >API Key</label
          >
          <input
            type="password"
            name="key"
            required
            style="width: 100%; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 0.375rem;"
            placeholder="Enter your dashboard API key"
          />
        </div>
        <button type="submit" class="btn" style="width: 100%;">Login with API Key</button>
      </form>
      <p style="margin-top: 1rem; font-size: 0.875rem; color: #6b7280; text-align: center;">
        ${showOAuth
          ? 'Google OAuth or API key authentication'
          : 'Set DASHBOARD_API_KEY environment variable'}
      </p>
    </div>
  `

  // Pass the context to layout so it can inject the CSRF token
  return c.html(layout('Login', content, '', c))
})

/**
 * Handle login POST
 */
authRoutes.post('/login', authRateLimit, async c => {
  // If in read-only mode, redirect to dashboard
  if (isReadOnly()) {
    return c.redirect('/dashboard')
  }

  const { key } = await c.req.parseBody()
  const apiKey = process.env.DASHBOARD_API_KEY

  let isValid = false
  if (typeof key === 'string' && apiKey) {
    const keyBuffer = Buffer.from(key)
    const apiKeyBuffer = Buffer.from(apiKey)
    if (keyBuffer.length === apiKeyBuffer.length) {
      isValid = timingSafeEqual(keyBuffer, apiKeyBuffer)
    }
  }

  if (isValid) {
    setCookie(c, 'dashboard_auth', key as string, {
      httpOnly: true, // Prevent client-side script access for security
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Lax',
      maxAge: 60 * 60 * 24 * 7, // 7 days
    })
    return c.redirect('/dashboard')
  }

  return c.redirect('/dashboard/login?error=invalid')
})

/**
 * Logout
 */
authRoutes.get('/logout', async c => {
  // Clear session if using OAuth
  const sessionToken = getCookie(c, 'dashboard_session')
  if (sessionToken) {
    await sessionService.deleteSession(sessionToken)
    setCookie(c, 'dashboard_session', '', { maxAge: 0 })
  }

  // Clear API key auth
  setCookie(c, 'dashboard_auth', '', { maxAge: 0 })
  return c.redirect('/dashboard/login')
})

/**
 * Google OAuth login
 */
authRoutes.get('/auth/google', authRateLimit, c => {
  if (!isOAuthConfigured()) {
    return c.redirect('/dashboard/login?error=oauth_not_configured')
  }

  try {
    const oauthService = createGoogleOAuthService()
    const state = generateState()

    // Store state in a secure cookie for CSRF protection
    setCookie(c, 'oauth_state', state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Lax',
      maxAge: 60 * 10, // 10 minutes
    })

    const authUrl = oauthService.generateAuthUrl(state)
    return c.redirect(authUrl)
  } catch (error) {
    console.error('OAuth initialization error:', error)
    return c.redirect('/dashboard/login?error=oauth_failed')
  }
})

/**
 * Google OAuth callback
 */
authRoutes.get('/auth/google/callback', callbackRateLimit, async c => {
  if (!isOAuthConfigured()) {
    return c.redirect('/dashboard/login?error=oauth_not_configured')
  }

  const code = c.req.query('code')
  const state = c.req.query('state')
  const error = c.req.query('error')

  // Handle OAuth errors
  if (error) {
    console.error('OAuth error:', error)
    return c.redirect('/dashboard/login?error=oauth_failed')
  }

  if (!code || !state) {
    return c.redirect('/dashboard/login?error=oauth_failed')
  }

  // Verify state for CSRF protection
  const storedState = getCookie(c, 'oauth_state')
  setCookie(c, 'oauth_state', '', { maxAge: 0 }) // Clear state cookie

  if (!storedState || storedState !== state) {
    console.error('OAuth state mismatch')
    return c.redirect('/dashboard/login?error=oauth_failed')
  }

  try {
    const oauthService = createGoogleOAuthService()

    // Exchange code for tokens
    const tokens = await oauthService.handleCallback(code)

    // Get user info
    const userProfile = await oauthService.getUserInfo(tokens.access_token)

    // Find or create user
    const user = await findOrCreateUser(userProfile)

    // Create session
    const session = await sessionService.createSession({
      userId: user.id,
      expiresInDays: sessionService.getSessionDuration(),
    })

    // Set session cookie
    setCookie(c, 'dashboard_session', session.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Lax',
      maxAge: 60 * 60 * 24 * sessionService.getSessionDuration(),
    })

    return c.redirect('/dashboard')
  } catch (error) {
    console.error('OAuth callback error:', error)

    if (error instanceof OAuthError && error.type === OAuthErrorType.DOMAIN_NOT_ALLOWED) {
      return c.redirect('/dashboard/login?error=domain_not_allowed')
    }

    return c.redirect('/dashboard/login?error=oauth_failed')
  }
})
