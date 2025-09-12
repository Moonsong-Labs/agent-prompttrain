import { OAuth2Client } from 'google-auth-library'
import {
  GoogleOAuthConfig,
  GoogleOAuthTokens,
  GoogleUserProfile,
  OAuthError,
  OAuthErrorType,
} from '@agent-prompttrain/shared'

/**
 * Service for handling Google OAuth authentication
 */
export class GoogleOAuthService {
  private oauth2Client: OAuth2Client
  private config: GoogleOAuthConfig

  constructor(config: GoogleOAuthConfig) {
    this.config = config
    this.oauth2Client = new OAuth2Client(
      config.client_id,
      config.client_secret,
      config.redirect_uri
    )
  }

  /**
   * Generate the OAuth consent URL for user authorization
   * @param state Optional state parameter for CSRF protection
   * @returns The authorization URL
   */
  generateAuthUrl(state?: string): string {
    const scopes = [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ]

    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline', // Request refresh token
      scope: scopes,
      state,
      // Force consent screen to ensure we get a refresh token
      prompt: 'consent',
    })
  }

  /**
   * Exchange authorization code for tokens
   * @param code The authorization code from Google
   * @returns OAuth tokens
   */
  async handleCallback(code: string): Promise<GoogleOAuthTokens> {
    try {
      const { tokens } = await this.oauth2Client.getToken(code)

      if (!tokens.access_token) {
        throw new OAuthError(
          OAuthErrorType.TOKEN_EXCHANGE_FAILED,
          'No access token received from Google'
        )
      }

      return {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || undefined,
        expires_in: tokens.expiry_date
          ? Math.floor((tokens.expiry_date - Date.now()) / 1000)
          : 3600,
        token_type: tokens.token_type || 'Bearer',
        scope: tokens.scope || '',
      }
    } catch (error) {
      throw new OAuthError(
        OAuthErrorType.TOKEN_EXCHANGE_FAILED,
        'Failed to exchange authorization code for tokens',
        error
      )
    }
  }

  /**
   * Get user profile information from Google
   * @param accessToken The OAuth access token
   * @returns User profile information
   */
  async getUserInfo(accessToken: string): Promise<GoogleUserProfile> {
    try {
      const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const userInfo = (await response.json()) as GoogleUserProfile

      // Ensure email is verified
      if (!userInfo.verified_email) {
        throw new OAuthError(OAuthErrorType.USER_INFO_FAILED, 'Google email is not verified')
      }

      // Normalize email to lowercase
      userInfo.email = userInfo.email.toLowerCase()

      // Validate domain restriction if configured
      if (this.config.allowed_domains.length > 0) {
        const isAllowed = this.validateDomain(userInfo.email)
        if (!isAllowed) {
          throw new OAuthError(
            OAuthErrorType.DOMAIN_NOT_ALLOWED,
            `Email domain not allowed. Allowed domains: ${this.config.allowed_domains.join(', ')}`
          )
        }
      }

      return userInfo
    } catch (error) {
      if (error instanceof OAuthError) {
        throw error
      }
      throw new OAuthError(
        OAuthErrorType.USER_INFO_FAILED,
        'Failed to fetch user information from Google',
        error
      )
    }
  }

  /**
   * Validate if the email domain is allowed
   * @param email The email to validate
   * @returns True if the domain is allowed
   */
  validateDomain(email: string): boolean {
    if (this.config.allowed_domains.length === 0) {
      return true // No restrictions
    }

    const domain = email.split('@')[1]?.toLowerCase()
    if (!domain) {
      return false
    }

    // Compare domains in lowercase
    const normalizedAllowedDomains = this.config.allowed_domains.map(d => d.toLowerCase())
    return normalizedAllowedDomains.includes(domain)
  }

  /**
   * Refresh an access token using a refresh token
   * @param refreshToken The refresh token
   * @returns New OAuth tokens
   */
  async refreshAccessToken(refreshToken: string): Promise<GoogleOAuthTokens> {
    try {
      this.oauth2Client.setCredentials({ refresh_token: refreshToken })
      const { credentials } = await this.oauth2Client.refreshAccessToken()

      if (!credentials.access_token) {
        throw new OAuthError(
          OAuthErrorType.TOKEN_EXCHANGE_FAILED,
          'No access token received during refresh'
        )
      }

      return {
        access_token: credentials.access_token,
        refresh_token: credentials.refresh_token || refreshToken,
        expires_in: credentials.expiry_date
          ? Math.floor((credentials.expiry_date - Date.now()) / 1000)
          : 3600,
        token_type: credentials.token_type || 'Bearer',
        scope: credentials.scope || '',
      }
    } catch (error) {
      throw new OAuthError(
        OAuthErrorType.TOKEN_EXCHANGE_FAILED,
        'Failed to refresh access token',
        error
      )
    }
  }

  /**
   * Verify an ID token (optional, for additional security)
   * @param idToken The ID token to verify
   * @returns The decoded token payload
   */
  async verifyIdToken(idToken: string): Promise<unknown> {
    try {
      const ticket = await this.oauth2Client.verifyIdToken({
        idToken,
        audience: this.config.client_id,
      })
      return ticket.getPayload()
    } catch (error) {
      throw new OAuthError(OAuthErrorType.INVALID_CODE, 'Failed to verify ID token', error)
    }
  }
}

/**
 * Create GoogleOAuthService from environment variables
 */
export function createGoogleOAuthService(): GoogleOAuthService {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const redirectUri = process.env.GOOGLE_REDIRECT_URI
  const allowedDomains = process.env.GOOGLE_ALLOWED_DOMAINS

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'Missing required Google OAuth configuration. Please set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI environment variables.'
    )
  }

  const config: GoogleOAuthConfig = {
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    allowed_domains: allowedDomains
      ? allowedDomains
          .split(',')
          .map(d => d.trim())
          .filter(Boolean)
      : [],
  }

  return new GoogleOAuthService(config)
}
