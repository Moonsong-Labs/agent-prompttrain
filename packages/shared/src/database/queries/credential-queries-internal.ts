import type { AnthropicCredential, AnthropicCredentialSafe } from '../../types/credentials'

/**
 * Convert full credential to safe version (without tokens)
 * Exported for use in train queries
 */
export function toSafeCredential(credential: AnthropicCredential): AnthropicCredentialSafe {
  const now = new Date()
  const expiresAt = new Date(credential.oauth_expires_at)
  const timeUntilExpiry = expiresAt.getTime() - now.getTime()
  const fiveMinutes = 5 * 60 * 1000

  let tokenStatus: 'valid' | 'expiring_soon' | 'expired'
  if (timeUntilExpiry < 0) {
    tokenStatus = 'expired'
  } else if (timeUntilExpiry < fiveMinutes) {
    tokenStatus = 'expiring_soon'
  } else {
    tokenStatus = 'valid'
  }

  return {
    id: credential.id,
    account_id: credential.account_id,
    account_name: credential.account_name,
    oauth_expires_at: credential.oauth_expires_at,
    oauth_scopes: credential.oauth_scopes,
    oauth_is_max: credential.oauth_is_max,
    created_at: credential.created_at,
    updated_at: credential.updated_at,
    last_refresh_at: credential.last_refresh_at,
    token_status: tokenStatus,
    token_suffix: credential.oauth_access_token.slice(-4),
  }
}
