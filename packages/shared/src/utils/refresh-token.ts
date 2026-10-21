import { createHash } from 'crypto'
import type { AnthropicCredential } from '../types/credentials.js'

/**
 * SHA-256 of a refresh token, as stored in the credentials table hash columns
 */
export function hashRefreshToken(refreshToken: string): string {
  return createHash('sha256').update(refreshToken, 'utf8').digest('hex')
}

/**
 * True when Anthropic rejected the credential's current refresh token, so the account
 * cannot refresh its access token until a relogin stores a new one (ADR-040)
 */
export function hasRejectedRefreshToken(
  credential: Pick<AnthropicCredential, 'oauth_refresh_token' | 'oauth_refresh_rejected_token_hash'>
): boolean {
  return (
    !!credential.oauth_refresh_rejected_token_hash &&
    credential.oauth_refresh_rejected_token_hash ===
      hashRefreshToken(credential.oauth_refresh_token ?? '')
  )
}
