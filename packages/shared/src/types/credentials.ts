/**
 * Database-backed credential types
 *
 * These types represent accounts and trains stored in the database
 * as per ADR-026: Database Credential Management
 */

export interface DatabaseAccount {
  accountId: string
  accountName: string
  credentialType: 'api_key' | 'oauth'
  apiKeyEncrypted?: string
  oauthAccessTokenEncrypted?: string
  oauthRefreshTokenEncrypted?: string
  oauthExpiresAt?: number
  oauthScopes?: string[]
  oauthIsMax?: boolean
  isActive: boolean
  createdAt: Date
  updatedAt: Date
  lastUsedAt?: Date
}

export interface DatabaseTrain {
  trainId: string
  trainName?: string
  description?: string
  clientApiKeysHashed?: string[]
  slackConfig?: Record<string, unknown>
  defaultAccountId?: string
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

export interface TrainAccountMapping {
  trainId: string
  accountId: string
  priority: number
  createdAt: Date
}

/**
 * Decrypted account for use in application logic
 */
export interface DecryptedAccount {
  accountId: string
  accountName: string
  credentialType: 'api_key' | 'oauth'
  apiKey?: string
  oauthAccessToken?: string
  oauthRefreshToken?: string
  oauthExpiresAt?: number
  oauthScopes?: string[]
  oauthIsMax?: boolean
  isActive: boolean
  lastUsedAt?: Date
}
