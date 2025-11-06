import { Context, Next } from 'hono'
import { logger } from './logger.js'
import { config } from '@agent-prompttrain/shared/config'
import { MSL_PROJECT_ID_HEADER_LOWER, MSL_ACCOUNT_HEADER_LOWER } from '@agent-prompttrain/shared'

/**
 * Project ID extractor middleware (fallback)
 * Sets train ID from MSL-Project-Id header only if not already set by client auth
 * This acts as a fallback for routes that don't use API key authentication
 */
export function projectIdExtractorMiddleware() {
  return async (c: Context, next: Next) => {
    // Check if projectId was already set by client auth middleware
    const existingTrainId = c.get('projectId')

    if (!existingTrainId) {
      // Only extract from header if not already set by authentication
      const rawHeader = c.req.header(MSL_PROJECT_ID_HEADER_LOWER)
      const fallbackTrainId = config.auth.defaultTrainId || 'default'

      logger.debug('Project ID extractor: checking for project ID', {
        path: c.req.path,
        method: c.req.method,
        metadata: {
          hasExistingTrainId: !!existingTrainId,
          hasHeaderValue: !!rawHeader,
          headerValue: rawHeader ? rawHeader.substring(0, 10) + '...' : 'none',
          willUseFallback: !rawHeader || !rawHeader.trim(),
        },
      })

      if (!rawHeader || !rawHeader.trim()) {
        logger.debug('No train ID from auth or header; applying fallback', {
          path: c.req.path,
          method: c.req.method,
          ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
          metadata: { fallbackTrainId },
        })
        c.set('projectId', fallbackTrainId)
      } else {
        c.set('projectId', rawHeader.trim())
      }
    } else {
      logger.debug('Project ID extractor: projectId already set by auth', {
        path: c.req.path,
        projectId: existingTrainId,
      })
    }

    const rawAccount = c.req.header(MSL_ACCOUNT_HEADER_LOWER)
    if (rawAccount && rawAccount.trim()) {
      c.set('trainAccount', rawAccount.trim())
    }

    await next()
  }
}
