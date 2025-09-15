import { readdirSync, statSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { loadCredentials, ClaudeCredentials } from '../credentials'
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
  private credentialsDir: string

  constructor(credentialsDir: string = process.env.CREDENTIALS_DIR || 'credentials') {
    // Resolve the credentials directory path
    if (credentialsDir.startsWith('~')) {
      this.credentialsDir = join(homedir(), credentialsDir.slice(1))
    } else if (credentialsDir.startsWith('/') || credentialsDir.includes(':')) {
      this.credentialsDir = credentialsDir
    } else {
      this.credentialsDir = resolve(process.cwd(), credentialsDir)
    }
  }

  /**
   * Check the status of all credential files in the credentials directory
   */
  async checkAllCredentials(): Promise<CredentialStatus[]> {
    const statuses: CredentialStatus[] = []

    try {
      // Check if directory exists
      if (!existsSync(this.credentialsDir)) {
        logger.info('Credentials directory does not exist', {
          metadata: { credentialsDir: this.credentialsDir },
        })
        return statuses
      }

      // Get all .credentials.json files
      const files = readdirSync(this.credentialsDir)
        .filter(file => file.endsWith('.credentials.json'))
        .sort()

      logger.info(`Found ${files.length} credential files to check`, {
        metadata: { credentialsDir: this.credentialsDir },
      })

      for (const file of files) {
        const status = await this.checkCredentialFile(file)
        statuses.push(status)
      }
    } catch (error) {
      logger.error('Failed to read credentials directory', {
        error: error instanceof Error ? { message: error.message } : { message: String(error) },
        metadata: { credentialsDir: this.credentialsDir },
      })
    }

    return statuses
  }

  /**
   * Check the status of a single credential file
   */
  private async checkCredentialFile(filename: string): Promise<CredentialStatus> {
    const trainId = filename.replace('.credentials.json', '')
    const filePath = join(this.credentialsDir, filename)

    try {
      // Check if file exists and is readable
      const stats = statSync(filePath)
      if (!stats.isFile()) {
        return {
          trainId,
          file: filename,
          type: 'api_key',
          status: 'error',
          message: 'Not a file',
          hasClientApiKey: false,
          hasSlackConfig: false,
        }
      }

      // Load credentials
      const credentials = loadCredentials(filePath)
      if (!credentials) {
        return {
          trainId,
          file: filename,
          type: 'api_key',
          status: 'invalid',
          message: 'Failed to load credentials',
          hasClientApiKey: false,
          hasSlackConfig: false,
        }
      }

      // Check credential type and status
      if (credentials.type === 'oauth' && credentials.oauth) {
        return this.checkOAuthStatus(trainId, filename, credentials)
      } else if (credentials.type === 'api_key' && credentials.api_key) {
        return {
          trainId,
          file: filename,
          type: 'api_key',
          status: 'valid',
          message: 'API key configured',
          hasClientApiKey: !!credentials.client_api_key,
          hasSlackConfig: !!credentials.slack,
        }
      } else {
        return {
          trainId,
          file: filename,
          type: credentials.type || 'api_key',
          status: 'invalid',
          message: `Missing ${credentials.type === 'oauth' ? 'OAuth data' : 'API key'}`,
          hasClientApiKey: !!credentials.client_api_key,
          hasSlackConfig: !!credentials.slack,
        }
      }
    } catch (error) {
      return {
        trainId,
        file: filename,
        type: 'api_key',
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        hasClientApiKey: false,
        hasSlackConfig: false,
      }
    }
  }

  /**
   * Check OAuth credential status
   */
  private checkOAuthStatus(
    trainId: string,
    filename: string,
    credentials: ClaudeCredentials
  ): CredentialStatus {
    const oauth = credentials.oauth!
    const now = Date.now()
    const expiresAt = oauth.expiresAt || 0
    const expiresIn = expiresAt - now

    // Check if refresh token is available
    if (!oauth.refreshToken) {
      return {
        trainId,
        file: filename,
        type: 'oauth',
        status: 'missing_refresh_token',
        message: 'No refresh token - re-authentication required when token expires',
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        hasClientApiKey: !!credentials.client_api_key,
        hasSlackConfig: !!credentials.slack,
      }
    }

    // Check expiration status
    if (now >= expiresAt) {
      return {
        trainId,
        file: filename,
        type: 'oauth',
        status: 'expired',
        message: 'Token expired - will refresh on next use',
        expiresAt: new Date(expiresAt),
        hasClientApiKey: !!credentials.client_api_key,
        hasSlackConfig: !!credentials.slack,
      }
    }

    // Check if expiring soon (within 24 hours)
    const twentyFourHours = 24 * 60 * 60 * 1000
    if (expiresIn <= twentyFourHours) {
      const hours = Math.floor(expiresIn / (1000 * 60 * 60))
      const minutes = Math.floor((expiresIn % (1000 * 60 * 60)) / (1000 * 60))

      return {
        trainId,
        file: filename,
        type: 'oauth',
        status: 'expiring_soon',
        message: `Token expiring soon - will refresh on next use`,
        expiresAt: new Date(expiresAt),
        expiresIn: `${hours}h ${minutes}m`,
        hasClientApiKey: !!credentials.client_api_key,
        hasSlackConfig: !!credentials.slack,
      }
    }

    // Token is valid
    const days = Math.floor(expiresIn / (1000 * 60 * 60 * 24))
    const hours = Math.floor((expiresIn % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))

    return {
      trainId,
      file: filename,
      type: 'oauth',
      status: 'valid',
      message: 'OAuth token valid',
      expiresAt: new Date(expiresAt),
      expiresIn: `${days}d ${hours}h`,
      hasClientApiKey: !!credentials.client_api_key,
      hasSlackConfig: !!credentials.slack,
    }
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
    lines.push(`  Total: ${statuses.length} domains`)
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

    // Details for each domain
    lines.push(`\nDomain Details:`)
    for (const status of statuses) {
      const extras: string[] = []
      if (status.hasClientApiKey) {
        extras.push('client_key')
      }
      if (status.hasSlackConfig) {
        extras.push('slack')
      }

      let line = `  ${status.domain}: ${status.type} - ${status.status}`
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

    // Warnings for domains that need attention
    const needsAttention = statuses.filter(
      s =>
        s.status === 'expired' ||
        s.status === 'missing_refresh_token' ||
        s.status === 'invalid' ||
        s.status === 'error'
    )

    if (needsAttention.length > 0) {
      lines.push(`\n⚠️  Domains Needing Attention:`)
      for (const status of needsAttention) {
        lines.push(`  - ${status.domain}: ${status.message}`)
        if (status.status === 'expired' || status.status === 'missing_refresh_token') {
          lines.push(`    Run: bun run scripts/oauth-login.ts credentials/${status.file}`)
        }
      }
    }

    return lines
  }
}
