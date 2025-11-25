import { Pool } from 'pg'
import { getProjectCredentials } from '@agent-prompttrain/shared/database/queries'
import {
  AuthenticationError,
  type Credential,
  type AnthropicCredential,
  type BedrockCredential,
  type ProviderType,
} from '@agent-prompttrain/shared'
import { RequestContext } from '../domain/value-objects/RequestContext'
import { getApiKey } from '../credentials'
import { logger } from '../middleware/logger'

export interface AuthResult {
  provider: ProviderType
  type: 'oauth' | 'api_key'
  headers: Record<string, string>
  key: string
  betaHeader?: string
  accountId: string
  accountName: string
  region?: string
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
      const allCredentials = await this.pool.query<Credential>(
        'SELECT * FROM credentials WHERE account_id = $1',
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

    // Priority 2: Use project's default account
    const credentials = await getProjectCredentials(this.pool, projectId)

    if (!credentials.length) {
      throw new AuthenticationError('No default account configured for this project', {
        requestId: context.requestId,
        projectId,
        hint: 'Set a default account for this project via the dashboard',
      })
    }

    return this.buildAuthResult(credentials[0], context)
  }

  private async buildAuthResult(
    credential: Credential,
    context: RequestContext
  ): Promise<AuthResult> {
    if (credential.provider === 'bedrock') {
      return this.buildBedrockAuthResult(credential, context)
    }

    // Default to Anthropic when provider is missing (backwards compatibility)
    return this.buildAnthropicAuthResult(credential, context)
  }

  private async buildAnthropicAuthResult(
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

    logger.info('Using Anthropic OAuth credentials for account', {
      requestId: context.requestId,
      projectId: context.projectId,
      metadata: {
        accountName: credential.account_name,
        accountId: credential.account_id,
        provider: 'anthropic',
      },
    })

    return {
      provider: 'anthropic',
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

  private buildBedrockAuthResult(
    credential: BedrockCredential,
    context: RequestContext
  ): AuthResult {
    logger.info('Using Bedrock API key credentials for account', {
      requestId: context.requestId,
      projectId: context.projectId,
      metadata: {
        accountName: credential.account_name,
        accountId: credential.account_id,
        provider: 'bedrock',
        region: credential.aws_region,
      },
    })

    return {
      provider: 'bedrock',
      type: 'api_key',
      headers: {
        authorization: `Bearer ${credential.aws_api_key}`,
      },
      key: credential.aws_api_key,
      accountId: credential.account_id,
      accountName: credential.account_name,
      region: credential.aws_region,
    }
  }

  getMaskedCredentialInfo(auth: AuthResult): string {
    const maskedKey = auth.key.substring(0, 10) + '****'
    return `${auth.provider}:${auth.type}:${maskedKey}`
  }

  clearCaches(): void {
    // No-op: database queries don't need cache clearing
  }

  destroy(): void {
    // No-op: pool is managed by container
  }
}
