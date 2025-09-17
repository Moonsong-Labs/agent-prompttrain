import { Context, Next } from 'hono'
import { logger } from './logger.js'
import { config } from '@agent-prompttrain/shared/config'

const PRIMARY_TRAIN_ID_HEADER = 'train-id'
const LEGACY_TRAIN_ID_HEADER = 'x-train-id'
const TRAIN_ACCOUNT_HEADER = 'x-train-account'

/**
 * Train ID extractor middleware
 * Ensures every request records a train identifier in context
 */
export function trainIdExtractorMiddleware() {
  return async (c: Context, next: Next) => {
    const rawHeader = c.req.header(PRIMARY_TRAIN_ID_HEADER) || c.req.header(LEGACY_TRAIN_ID_HEADER)
    const fallbackTrainId = config.auth.defaultTrainId || 'default'

    if (!rawHeader || !rawHeader.trim()) {
      logger.warn('Missing train-id header; applying fallback', {
        path: c.req.path,
        method: c.req.method,
        ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
        metadata: { fallbackTrainId },
      })
      c.set('trainId', fallbackTrainId)
    } else {
      c.set('trainId', rawHeader.trim())
    }

    const rawAccount = c.req.header(TRAIN_ACCOUNT_HEADER)
    if (rawAccount && rawAccount.trim()) {
      c.set('trainAccount', rawAccount.trim())
    }

    await next()
  }
}
