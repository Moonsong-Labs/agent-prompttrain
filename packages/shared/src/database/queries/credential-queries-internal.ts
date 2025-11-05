import type {
  Credential,
  AnthropicCredential,
  BedrockCredential,
  CredentialSafe,
  AnthropicCredentialSafe,
  BedrockCredentialSafe,
} from '../../types/credentials'

/**
 * Convert full Anthropic credential to safe version (without tokens)
 */
function toSafeAnthropicCredential(credential: AnthropicCredential): AnthropicCredentialSafe {
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
    provider: 'anthropic',
    oauth_expires_at: credential.oauth_expires_at,
    oauth_scopes: credential.oauth_scopes,
    oauth_is_max: credential.oauth_is_max,
    created_at: credential.created_at,
    updated_at: credential.updated_at,
    last_refresh_at: credential.last_refresh_at,
    token_status: tokenStatus,
  }
}

/**
 * Convert full Bedrock credential to safe version (without API key)
 */
function toSafeBedrockCredential(credential: BedrockCredential): BedrockCredentialSafe {
  return {
    id: credential.id,
    account_id: credential.account_id,
    account_name: credential.account_name,
    provider: 'bedrock',
    aws_region: credential.aws_region,
    aws_api_key_preview: credential.aws_api_key.substring(0, 8) + '****',
    created_at: credential.created_at,
    updated_at: credential.updated_at,
  }
}

/**
 * Convert full credential to safe version (without sensitive data)
 * Exported for use in train queries
 */
export function toSafeCredential(credential: Credential): CredentialSafe {
  if (credential.provider === 'anthropic') {
    return toSafeAnthropicCredential(credential)
  } else {
    return toSafeBedrockCredential(credential)
  }
}
