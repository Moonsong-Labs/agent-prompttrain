/**
 * Database models for credential and project management
 */

export type ProviderType = 'anthropic' | 'bedrock'

export interface BaseCredential {
  id: string
  account_id: string
  account_name: string
  provider: ProviderType
  created_at: Date
  updated_at: Date
}

export interface AnthropicCredential extends BaseCredential {
  provider: 'anthropic'
  oauth_access_token: string
  oauth_refresh_token: string
  oauth_expires_at: Date
  oauth_scopes: string[]
  oauth_is_max: boolean
  last_refresh_at: Date | null
  aws_api_key?: never
  aws_region?: never
}

export interface BedrockCredential extends BaseCredential {
  provider: 'bedrock'
  aws_api_key: string
  aws_region: string
  oauth_access_token?: never
  oauth_refresh_token?: never
  oauth_expires_at?: never
  oauth_scopes?: never
  oauth_is_max?: never
  last_refresh_at?: never
}

export type Credential = AnthropicCredential | BedrockCredential

export interface AnthropicCredentialSafe
  extends Omit<AnthropicCredential, 'oauth_access_token' | 'oauth_refresh_token'> {
  token_status: 'valid' | 'expiring_soon' | 'expired'
}

export interface BedrockCredentialSafe extends Omit<BedrockCredential, 'aws_api_key'> {
  aws_api_key_preview: string // First 8 chars + ****
}

export type CredentialSafe = AnthropicCredentialSafe | BedrockCredentialSafe

export interface Project {
  id: string
  project_id: string
  name: string
  default_account_id: string | null
  slack_enabled: boolean
  slack_webhook_url: string | null
  slack_channel: string | null
  slack_username: string | null
  slack_icon_emoji: string | null
  is_private: boolean
  created_at: Date
  updated_at: Date
}

export interface ProjectWithAccounts extends Project {
  accounts: CredentialSafe[]
}

export interface ProjectAccount {
  id: string
  project_id: string
  credential_id: string
  created_at: Date
}

export interface ProjectApiKey {
  id: string
  project_id: string
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

export interface ProjectApiKeySafe {
  id: string
  project_id: string
  key_preview: string // prefix + "****" + suffix
  name: string | null
  created_by: string | null
  created_at: Date
  last_used_at: Date | null
  revoked_at: Date | null
  revoked_by: string | null
  status: 'active' | 'revoked'
}

export interface CreateAnthropicCredentialRequest {
  account_id: string
  account_name: string
  oauth_access_token: string
  oauth_refresh_token: string
  oauth_expires_at: Date
  oauth_scopes: string[]
  oauth_is_max?: boolean
}

export interface CreateBedrockCredentialRequest {
  account_id: string
  account_name: string
  aws_api_key: string
  aws_region?: string
}

export interface UpdateCredentialTokensRequest {
  oauth_access_token: string
  oauth_refresh_token: string
  oauth_expires_at: Date
}

export interface CreateProjectRequest {
  project_id: string
  name: string
  slack_enabled?: boolean
  slack_webhook_url?: string
  slack_channel?: string
  slack_username?: string
  slack_icon_emoji?: string
  is_private?: boolean
}

export interface UpdateProjectRequest {
  name?: string
  slack_enabled?: boolean
  slack_webhook_url?: string
  slack_channel?: string
  slack_username?: string
  slack_icon_emoji?: string
  is_private?: boolean
}

export interface CreateApiKeyRequest {
  name?: string
  created_by?: string
}

export interface UpdateApiKeyRequest {
  name?: string | null
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
