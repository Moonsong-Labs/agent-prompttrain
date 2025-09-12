/**
 * Authentication related types for OAuth and session management
 */

/**
 * User entity from OAuth authentication
 */
export interface User {
  id: string
  email: string
  name: string | null
  google_id: string
  allowed_domain: string | null
  created_at: Date
  updated_at: Date
}

/**
 * Session entity for user authentication
 */
export interface Session {
  id: string
  user_id: string
  token: string
  expires_at: Date
  created_at: Date
}

/**
 * Google OAuth configuration
 */
export interface GoogleOAuthConfig {
  client_id: string
  client_secret: string
  redirect_uri: string
  allowed_domains: string[] // For Google Workspace domain restrictions
}

/**
 * OAuth tokens from Google
 */
export interface GoogleOAuthTokens {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
  scope: string
}

/**
 * Google user profile information
 */
export interface GoogleUserProfile {
  id: string
  email: string
  verified_email: boolean
  name: string
  given_name?: string
  family_name?: string
  picture?: string
  locale?: string
  hd?: string // Hosted domain for Google Workspace accounts
}

/**
 * Auth context for middleware
 */
export interface AuthContext {
  user?: User
  session?: Session
  isAuthenticated: boolean
  authType: 'oauth' | 'api_key' | 'none'
}

/**
 * Session creation parameters
 */
export interface CreateSessionParams {
  userId: string
  expiresInDays?: number
}

/**
 * OAuth error types
 */
export enum OAuthErrorType {
  INVALID_STATE = 'INVALID_STATE',
  INVALID_CODE = 'INVALID_CODE',
  DOMAIN_NOT_ALLOWED = 'DOMAIN_NOT_ALLOWED',
  TOKEN_EXCHANGE_FAILED = 'TOKEN_EXCHANGE_FAILED',
  USER_INFO_FAILED = 'USER_INFO_FAILED',
}

/**
 * OAuth error class
 */
export class OAuthError extends Error {
  constructor(
    public type: OAuthErrorType,
    message: string,
    public details?: unknown
  ) {
    super(message)
    this.name = 'OAuthError'
  }
}
