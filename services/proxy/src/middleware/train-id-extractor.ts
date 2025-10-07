import { Context, Next } from 'hono'
import { logger } from './logger.js'
import { config } from '@agent-prompttrain/shared/config'
import { MSL_TRAIN_ID_HEADER_LOWER, MSL_ACCOUNT_HEADER_LOWER } from '@agent-prompttrain/shared'

/**
 * Train ID extractor middleware (fallback)
 * Sets train ID from MSL-Train-Id header only if not already set by client auth
 * This acts as a fallback for routes that don't use API key authentication
 */
export function trainIdExtractorMiddleware() {
  return async (c: Context, next: Next) => {
    // Check if trainId was already set by client auth middleware
    const existingTrainId = c.get('trainId')

    if (!existingTrainId) {
      // Only extract from header if not already set by authentication
      const rawHeader = c.req.header(MSL_TRAIN_ID_HEADER_LOWER)
      const fallbackTrainId = config.auth.defaultTrainId || 'default'

      if (!rawHeader || !rawHeader.trim()) {
        logger.debug('No train ID from auth or header; applying fallback', {
          path: c.req.path,
          method: c.req.method,
          ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
          metadata: { fallbackTrainId },
        })
        c.set('trainId', fallbackTrainId)
      } else {
        c.set('trainId', rawHeader.trim())
      }
    }

    const rawAccount = c.req.header(MSL_ACCOUNT_HEADER_LOWER)
    if (rawAccount && rawAccount.trim()) {
      c.set('trainAccount', rawAccount.trim())
    }

    await next()
  }
}
