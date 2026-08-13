import { Pool } from 'pg'
import {
  AuthenticationError,
  type Credential,
  type AnthropicCredential,
  type BedrockCredential,
  type ProviderType,
  type UpstreamError,
} from '@agent-prompttrain/shared'
import { RequestContext } from '../domain/value-objects/RequestContext'
import { getApiKey } from '../credentials'
import { logger } from '../middleware/logger'
import { AccountPoolService, AccountPoolExhaustedError } from './account-pool-service'
import { UsageCacheService } from './usage-cache-service'

export interface AuthResult {
  provider: ProviderType
  type: 'oauth' | 'api_key'
  headers: Record<string, string>
  key: string
  betaHeader?: string
  accountId: string
  accountName: string
  region?: string
  credentialId?: string
  fromPool?: boolean
  reserved?: boolean
  explicitlySelected?: boolean
}

export interface AuthenticationOptions {
  excludeCredentialIds?: string[]
}

const OAUTH_BETA_HEADER = 'oauth-2025-04-20'

export class AuthenticationService {
  private readonly accountPoolService: AccountPoolService

  constructor(
    private readonly pool: Pool,
    usageCacheService?: UsageCacheService
  ) {
    const sharedUsageCache = usageCacheService ?? new UsageCacheService(pool)
    this.accountPoolService = new AccountPoolService(this.pool, sharedUsageCache)
  }

  /**
   * @param model - The Claude model requested, when known. Passed to the
   *   account pool so model-scoped limits (e.g. Claude Fable 5's separate
   *   weekly allowance) gate accounts for that model only.
   */
  async authenticate(
    context: RequestContext,
    model?: string,
    options: AuthenticationOptions = {}
  ): Promise<AuthResult> {
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

      return this.buildAuthResult(allCredentials.rows[0], context, {
        fromPool: false,
        reserved: false,
        explicitlySelected: true,
      })
    }

    // Priority 2: Account pool or default account
    let selection
    try {
      selection = await this.accountPoolService.selectAccount(projectId, model, options)
    } catch (error) {
      if (error instanceof AccountPoolExhaustedError) {
        throw error
      }
      // Only translate "no credential" errors to AuthenticationError;
      // rethrow operational failures (DB errors, etc.) as-is
      if (error instanceof Error && error.message.includes('No default credential')) {
        throw new AuthenticationError('No default account configured for this project', {
          requestId: context.requestId,
          projectId,
          hint: 'Set a default account for this project via the dashboard',
        })
      }
      throw error
    }

    if (selection.fromPool) {
      logger.info('Account selected from pool', {
        requestId: context.requestId,
        projectId,
        metadata: {
          accountId: selection.credential.account_id,
          maxUtilization: Math.round(selection.maxUtilization * 100),
        },
      })
    }

    try {
      return await this.buildAuthResult(selection.credential, context, {
        fromPool: selection.fromPool,
        reserved: selection.reserved,
        explicitlySelected: false,
      })
    } catch (error) {
      if (selection.reserved) {
        try {
          await this.accountPoolService.releaseAccount(selection.credential.id)
        } catch (releaseError) {
          logger.error('Failed to release reservation after authentication error', {
            metadata: {
              credentialId: selection.credential.id,
              error: releaseError instanceof Error ? releaseError.message : String(releaseError),
            },
          })
        }
      }
      throw error
    }
  }

  async release(auth: AuthResult): Promise<void> {
    if (auth.reserved && auth.credentialId) {
      auth.reserved = false
      try {
        await this.accountPoolService.releaseAccount(auth.credentialId)
      } catch (error) {
        logger.error('Failed to release account-pool reservation', {
          metadata: {
            credentialId: auth.credentialId,
            accountId: auth.accountId,
            error: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }
  }

  async markRateLimited(
    auth: AuthResult,
    model: string | undefined,
    error: UpstreamError
  ): Promise<string | null> {
    if (!auth.credentialId || auth.explicitlySelected || auth.accountId === 'passthrough') {
      return null
    }
    try {
      return await this.accountPoolService.markRateLimited(auth.credentialId, model, error)
    } catch (stateError) {
      logger.error('Failed to persist account rate-limit cooldown', {
        metadata: {
          credentialId: auth.credentialId,
          accountId: auth.accountId,
          model: model ?? '*',
          error: stateError instanceof Error ? stateError.message : String(stateError),
        },
      })
      return null
    }
  }

  private async buildAuthResult(
    credential: Credential,
    context: RequestContext,
    routing: Pick<AuthResult, 'fromPool' | 'reserved' | 'explicitlySelected'>
  ): Promise<AuthResult> {
    if (credential.provider === 'bedrock') {
      return this.buildBedrockAuthResult(credential, context, routing)
    }

    // Default to Anthropic when provider is missing (backwards compatibility)
    return this.buildAnthropicAuthResult(credential, context, routing)
  }

  private async buildAnthropicAuthResult(
    credential: AnthropicCredential,
    context: RequestContext,
    routing: Pick<AuthResult, 'fromPool' | 'reserved' | 'explicitlySelected'>
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
      credentialId: credential.id,
      ...routing,
    }
  }

  private buildBedrockAuthResult(
    credential: BedrockCredential,
    context: RequestContext,
    routing: Pick<AuthResult, 'fromPool' | 'reserved' | 'explicitlySelected'>
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
      credentialId: credential.id,
      ...routing,
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
