import { Context, Next } from 'hono'
import { MSL_PROJECT_ID_HEADER_LOWER, MSL_ACCOUNT_HEADER_LOWER } from '@agent-prompttrain/shared'

/**
 * Project ID extractor middleware
 * Sets project ID from MSL-Project-Id header only if not already set by client auth
 * MSL-Project-Id header is now mandatory - no fallback to default
 */
export function projectIdExtractorMiddleware() {
  return async (c: Context, next: Next) => {
    // Check if projectId was already set by client auth middleware
    const existingTrainId = c.get('projectId')

    if (!existingTrainId) {
      // Only extract from header if not already set by authentication
      const rawHeader = c.req.header(MSL_PROJECT_ID_HEADER_LOWER)

      if (rawHeader && rawHeader.trim()) {
        c.set('projectId', rawHeader.trim())
      }
      // If no header provided, projectId remains unset and will be caught by RequestContext.fromHono()
    }

    const rawAccount = c.req.header(MSL_ACCOUNT_HEADER_LOWER)
    if (rawAccount && rawAccount.trim()) {
      c.set('trainAccount', rawAccount.trim())
    }

    await next()
  }
}
