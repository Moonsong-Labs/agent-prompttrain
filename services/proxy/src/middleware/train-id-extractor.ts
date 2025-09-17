import { Context, Next } from 'hono'
import { logger } from './logger.js'

const PRIMARY_TRAIN_ID_HEADER = 'train-id'
const LEGACY_TRAIN_ID_HEADER = 'x-train-id'

/**
 * Train ID extractor middleware
 * Ensures every request includes an X-Train-Id header and stores it in context
 */
export function trainIdExtractorMiddleware() {
  return async (c: Context, next: Next) => {
    const rawHeader =
      c.req.header(PRIMARY_TRAIN_ID_HEADER) || c.req.header(LEGACY_TRAIN_ID_HEADER)

    if (!rawHeader || !rawHeader.trim()) {
      logger.warn('Missing train-id header', {
        path: c.req.path,
        method: c.req.method,
        ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
      })

      return c.json(
        {
          error: {
            code: 'bad_request',
            message: 'train-id header is required',
          },
        },
        400
      )
    }

    const trainId = rawHeader.trim()
    c.set('trainId', trainId)

    await next()
  }
}
