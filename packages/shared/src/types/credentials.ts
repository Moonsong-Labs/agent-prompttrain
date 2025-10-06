/**
 * Database models for credential and train management
 */

export interface AnthropicCredential {
  id: string
  account_id: string
  account_name: string
  oauth_access_token: string
  oauth_refresh_token: string
  oauth_expires_at: Date
  oauth_scopes: string[]
  oauth_is_max: boolean
  created_at: Date
  updated_at: Date
  last_refresh_at: Date | null
}

export interface AnthropicCredentialSafe {
  id: string
  account_id: string
  account_name: string
  oauth_expires_at: Date
  oauth_scopes: string[]
  oauth_is_max: boolean
  created_at: Date
  updated_at: Date
  last_refresh_at: Date | null
  token_status: 'valid' | 'expiring_soon' | 'expired'
  token_suffix: string // Last 4 characters of access token
}

export interface Train {
  id: string
  train_id: string
  name: string
  description: string | null
  slack_enabled: boolean
  slack_webhook_url: string | null
  slack_channel: string | null
  slack_username: string | null
  slack_icon_emoji: string | null
  created_at: Date
  updated_at: Date
}

export interface TrainWithAccounts extends Train {
  accounts: AnthropicCredentialSafe[]
}

export interface TrainAccount {
  id: string
  train_id: string
  credential_id: string
  created_at: Date
}

export interface TrainApiKey {
  id: string
  train_id: string
  api_key: string
  key_prefix: string
  key_suffix: string
  name: string | null
  created_by: string | null
  created_at: Date
  last_used_at: Date | null
  revoked_at: Date | null
  revoked_by: string | null
}

export interface TrainApiKeySafe {
  id: string
  train_id: string
  key_preview: string // prefix + "****" + suffix
  name: string | null
  created_by: string | null
  created_at: Date
  last_used_at: Date | null
  revoked_at: Date | null
  revoked_by: string | null
  status: 'active' | 'revoked'
}

export interface CreateCredentialRequest {
  account_id: string
  account_name: string
  oauth_access_token: string
  oauth_refresh_token: string
  oauth_expires_at: Date
  oauth_scopes: string[]
  oauth_is_max?: boolean
}

export interface UpdateCredentialTokensRequest {
  oauth_access_token: string
  oauth_refresh_token: string
  oauth_expires_at: Date
}

export interface CreateTrainRequest {
  train_id: string
  name: string
  description?: string
  slack_enabled?: boolean
  slack_webhook_url?: string
  slack_channel?: string
  slack_username?: string
  slack_icon_emoji?: string
}

export interface UpdateTrainRequest {
  name?: string
  description?: string
  slack_enabled?: boolean
  slack_webhook_url?: string
  slack_channel?: string
  slack_username?: string
  slack_icon_emoji?: string
}

export interface CreateApiKeyRequest {
  name?: string
  created_by?: string
}

export interface GeneratedApiKey {
  id: string
  api_key: string // Full key, shown only once
  key_preview: string
  name: string | null
  created_by: string | null
  created_at: Date
}

export interface SlackConfig {
  enabled: boolean
  webhook_url?: string
  channel?: string
  username?: string
  icon_emoji?: string
}
