import { Pool } from 'pg'
import { getProjectCredentials } from '@agent-prompttrain/shared/database/queries'
import { AuthenticationError, type AnthropicCredential } from '@agent-prompttrain/shared'
import { RequestContext } from '../domain/value-objects/RequestContext'
import { getApiKey } from '../credentials'
import { logger } from '../middleware/logger'

export interface AuthResult {
  type: 'oauth'
  headers: Record<string, string>
  key: string
  betaHeader: string
  accountId: string
  accountName: string
}

const OAUTH_BETA_HEADER = 'oauth-2025-04-20'

export class AuthenticationService {
  constructor(private readonly pool: Pool) {}

  async authenticate(context: RequestContext): Promise<AuthResult> {
    const requestedAccount = context.account
    const projectId = context.projectId

    // Priority 1: If specific account requested via MSL-Account header, use it
    if (requestedAccount) {
      logger.info('Using account specified in MSL-Account header', {
        requestId: context.requestId,
        projectId,
        metadata: {
          accountId: requestedAccount,
        },
      })

      // Get all credentials to find the requested one
      const allCredentials = await this.pool.query<AnthropicCredential>(
        'SELECT * FROM anthropic_credentials WHERE account_id = $1',
        [requestedAccount]
      )

      if (!allCredentials.rows.length) {
        throw new AuthenticationError('Requested account not found', {
          requestId: context.requestId,
          account: requestedAccount,
          projectId,
        })
      }

      return this.buildAuthResult(allCredentials.rows[0], context)
    }

    // Priority 2: If user provides Bearer token, use user passthrough mode
    if (context.apiKey?.startsWith('Bearer ')) {
      logger.info('Using user passthrough authentication', {
        requestId: context.requestId,
        projectId,
      })

      return {
        type: 'oauth',
        headers: {
          Authorization: context.apiKey,
          'anthropic-beta': OAUTH_BETA_HEADER,
        },
        key: context.apiKey.replace('Bearer ', ''),
        betaHeader: OAUTH_BETA_HEADER,
        accountId: 'user-passthrough',
        accountName: 'User Account',
      }
    }

    // Priority 3: Use project's default account
    const credentials = await getProjectCredentials(this.pool, projectId)

    if (!credentials.length) {
      throw new AuthenticationError(
        'No default account configured for this project and no user credentials provided',
        {
          requestId: context.requestId,
          projectId,
          hint: 'Either set a default account for this project via the dashboard, or provide your Anthropic credentials via Authorization header',
        }
      )
    }

    return this.buildAuthResult(credentials[0], context)
  }

  private async buildAuthResult(
    credential: AnthropicCredential,
    context: RequestContext
  ): Promise<AuthResult> {
    // Get current access token (will refresh if needed)
    const accessToken = await getApiKey(credential.id, this.pool)

    if (!accessToken) {
      throw new AuthenticationError('Failed to retrieve access token', {
        requestId: context.requestId,
        account: credential.account_name,
      })
    }

    logger.info('Using OAuth credentials for account', {
      requestId: context.requestId,
      projectId: context.projectId,
      metadata: {
        accountName: credential.account_name,
        accountId: credential.account_id,
      },
    })

    return {
      type: 'oauth',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
      key: accessToken,
      betaHeader: OAUTH_BETA_HEADER,
      accountId: credential.account_id,
      accountName: credential.account_name,
    }
  }

  getMaskedCredentialInfo(auth: AuthResult): string {
    const maskedKey = auth.key.substring(0, 10) + '****'
    return `oauth:${maskedKey}`
  }

  clearCaches(): void {
    // No-op: database queries don't need cache clearing
  }

  destroy(): void {
    // No-op: pool is managed by container
  }
}
