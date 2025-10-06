import { Pool } from 'pg'
import { createHash } from 'crypto'
import { getTrainCredentials } from '@agent-prompttrain/shared/database/queries'
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
    const trainId = context.trainId

    // Get all credentials linked to this train
    const credentials = await getTrainCredentials(this.pool, trainId)

    if (!credentials.length) {
      throw new AuthenticationError('No credentials configured for this train', {
        requestId: context.requestId,
        trainId,
        hint: 'Link at least one credential to this train via the dashboard',
      })
    }

    // If specific account requested, use it
    if (requestedAccount) {
      const credential = credentials.find(c => c.account_name === requestedAccount)
      if (!credential) {
        throw new AuthenticationError('Requested account not linked to train', {
          requestId: context.requestId,
          account: requestedAccount,
          trainId,
        })
      }
      return this.buildAuthResult(credential, context)
    }

    // Otherwise, use deterministic selection
    const orderedCredentials = this.rankCredentials(trainId, credentials)

    for (const credential of orderedCredentials) {
      try {
        return await this.buildAuthResult(credential, context)
      } catch (error) {
        logger.warn('Skipping credential due to token refresh failure', {
          requestId: context.requestId,
          metadata: {
            accountName: credential.account_name,
            error: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }

    throw new AuthenticationError('No valid credentials available for authentication', {
      requestId: context.requestId,
      trainId,
    })
  }

  private rankCredentials(
    trainId: string,
    credentials: AnthropicCredential[]
  ): AnthropicCredential[] {
    if (credentials.length <= 1) {
      return credentials
    }

    const scored = credentials.map(credential => {
      const hashInput = `${trainId}::${credential.account_name}`
      const digest = createHash('sha256').update(hashInput).digest()
      const score = digest.readBigUInt64BE(0)
      return { credential, score }
    })

    scored.sort((a, b) => {
      if (a.score === b.score) {
        return a.credential.account_name.localeCompare(b.credential.account_name)
      }
      return a.score > b.score ? -1 : 1
    })

    return scored.map(entry => entry.credential)
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
      trainId: context.trainId,
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
