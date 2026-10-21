import type { Pool } from 'pg'
import type { AnthropicCredential } from '@agent-prompttrain/shared'
import {
  claimRefreshTokenAlert,
  releaseRefreshTokenAlert,
} from '@agent-prompttrain/shared/database/queries'
import type { OAuthRefreshError } from '../credentials'
import { isSlackAlertEnabled, sendRefreshTokenExpiredToSlack } from './slack'
import { logger } from '../middleware/logger'

// Another proxy task may have used the same refresh token moments earlier and not yet
// stored the rotated one; waiting lets the claim tell that race from a real expiry
const ROTATION_SETTLE_MS = 10_000

/**
 * Alert on Slack that an account's refresh token was rejected.
 *
 * Every proxy task retries a failed refresh every few seconds, so the alert is claimed
 * in the database first: exactly one task sends it per refresh token, and none does when
 * another task already rotated the token (the rejection was a refresh race, not an
 * expiry). A relogin stores a new refresh token, which re-arms the alert.
 *
 * Never throws.
 */
export async function notifyRefreshTokenRejected(
  pool: Pool,
  credential: AnthropicCredential,
  refreshToken: string,
  error: OAuthRefreshError,
  settleMs = ROTATION_SETTLE_MS
): Promise<void> {
  if (!isSlackAlertEnabled()) {
    return
  }

  await new Promise(resolve => setTimeout(resolve, settleMs))

  try {
    if (!(await claimRefreshTokenAlert(pool, credential.id, refreshToken))) {
      return
    }
  } catch (claimError) {
    logger.error('Failed to claim refresh token alert', {
      metadata: {
        accountId: credential.account_id,
        error: claimError instanceof Error ? claimError.message : String(claimError),
      },
    })
    return
  }

  try {
    await sendRefreshTokenExpiredToSlack({
      accountId: credential.account_id,
      accountName: credential.account_name,
      accountEmail: credential.account_email,
      status: error.status,
      errorCode: error.errorCode,
      description: error.description,
    })
    logger.warn('OAuth refresh token rejected; sent Slack alert', {
      metadata: { accountId: credential.account_id, status: error.status },
    })
  } catch (sendError) {
    logger.error('Failed to send refresh token alert to Slack', {
      metadata: {
        accountId: credential.account_id,
        error: sendError instanceof Error ? sendError.message : String(sendError),
      },
    })
    await releaseRefreshTokenAlert(pool, credential.id, refreshToken).catch(() => undefined)
  }
}
