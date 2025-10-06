/**
 * @deprecated This service is being migrated to use database credentials.
 * Filesystem credential loading is no longer supported.
 * TODO: Update to query database credentials instead
 */

import { logger } from '../middleware/logger'

export interface CredentialStatus {
  trainId: string
  file: string
  type: 'api_key' | 'oauth'
  status: 'valid' | 'expired' | 'expiring_soon' | 'missing_refresh_token' | 'invalid' | 'error'
  message: string
  expiresAt?: Date
  expiresIn?: string
  hasClientApiKey: boolean
  hasSlackConfig: boolean
}

export class CredentialStatusService {
  constructor() {
    logger.warn('CredentialStatusService is deprecated - use database queries instead')
  }

  /**
   * @deprecated Use database queries to check credential status
   */
  async checkAllCredentials(): Promise<CredentialStatus[]> {
    logger.warn('checkAllCredentials is deprecated - returning empty array')
    return []
  }

  /**
   * Format credential status for logging
   */
  formatStatusForLogging(statuses: CredentialStatus[]): string[] {
    const lines: string[] = []

    // Group by status
    const byStatus = {
      valid: statuses.filter(s => s.status === 'valid'),
      expired: statuses.filter(s => s.status === 'expired'),
      expiring_soon: statuses.filter(s => s.status === 'expiring_soon'),
      missing_refresh_token: statuses.filter(s => s.status === 'missing_refresh_token'),
      invalid: statuses.filter(s => s.status === 'invalid'),
      error: statuses.filter(s => s.status === 'error'),
    }

    // Summary
    lines.push(`Credential Status Summary:`)
    lines.push(`  Total: ${statuses.length} trains`)
    lines.push(`  Valid: ${byStatus.valid.length}`)
    if (byStatus.expired.length > 0) {
      lines.push(`  Expired: ${byStatus.expired.length}`)
    }
    if (byStatus.expiring_soon.length > 0) {
      lines.push(`  Expiring Soon: ${byStatus.expiring_soon.length}`)
    }
    if (byStatus.missing_refresh_token.length > 0) {
      lines.push(`  Missing Refresh Token: ${byStatus.missing_refresh_token.length}`)
    }
    if (byStatus.invalid.length > 0) {
      lines.push(`  Invalid: ${byStatus.invalid.length}`)
    }
    if (byStatus.error.length > 0) {
      lines.push(`  Errors: ${byStatus.error.length}`)
    }

    // Details for each train
    lines.push(`\nTrain Details:`)
    for (const status of statuses) {
      const extras: string[] = []
      if (status.hasClientApiKey) {
        extras.push('client_key')
      }
      if (status.hasSlackConfig) {
        extras.push('slack')
      }

      let line = `  ${status.trainId}: ${status.type} - ${status.status}`
      if (status.expiresIn) {
        line += ` (expires in ${status.expiresIn})`
      }
      if (extras.length > 0) {
        line += ` [${extras.join(', ')}]`
      }
      lines.push(line)

      if (status.status !== 'valid') {
        lines.push(`    → ${status.message}`)
      }
    }

    // Warnings for trains that need attention
    const needsAttention = statuses.filter(
      s =>
        s.status === 'expired' ||
        s.status === 'missing_refresh_token' ||
        s.status === 'invalid' ||
        s.status === 'error'
    )

    if (needsAttention.length > 0) {
      lines.push(`\n⚠️  Trains Needing Attention:`)
      for (const status of needsAttention) {
        lines.push(`  - ${status.trainId}: ${status.message}`)
        if (status.status === 'expired' || status.status === 'missing_refresh_token') {
          lines.push(`    Run: bun run scripts/auth/oauth-login.ts credentials/${status.file}`)
        }
      }
    }

    return lines
  }
}
