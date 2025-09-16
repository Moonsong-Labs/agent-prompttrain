import { Context, Next } from 'hono'
import { isValidTrainId } from '@agent-prompttrain/shared/utils/validation'

const TRAIN_ID_HEADER = 'X-TRAIN-ID'
const DEFAULT_TRAIN_ID = 'default'
const ENABLE_HOST_FALLBACK = process.env.ENABLE_HOST_HEADER_FALLBACK === 'true'

/**
 * Extracts train-id from request headers with backward compatibility support
 *
 * Priority order:
 * 1. X-TRAIN-ID header (preferred)
 * 2. Host header fallback (if ENABLE_HOST_HEADER_FALLBACK=true)
 * 3. Default train-id
 */
export const trainIdExtractor = async (c: Context, next: Next) => {
  let trainId: string
  let source: 'header' | 'host-fallback' | 'default'

  // Try X-TRAIN-ID header first
  const headerValue = c.req.header(TRAIN_ID_HEADER)

  if (headerValue !== undefined && headerValue !== '') {
    trainId = headerValue
    source = 'header'
  } else if (ENABLE_HOST_FALLBACK) {
    // Fallback to Host header for backward compatibility
    const hostHeader = c.req.header('Host')
    if (hostHeader) {
      // Convert host to a valid train-id format
      // e.g., "api.example.com" → "api-example-com"
      //       "localhost:3000" → "localhost-3000"
      trainId = hostHeader.replace(/\./g, '-').replace(/:/g, '-').toLowerCase()
      source = 'host-fallback'

      // Log the backward compatibility usage for monitoring
      console.warn(
        `[DEPRECATED] Using Host header fallback for train-id: ${hostHeader} → ${trainId}. Please migrate to X-TRAIN-ID header.`
      )
    } else {
      trainId = DEFAULT_TRAIN_ID
      source = 'default'
    }
  } else {
    trainId = DEFAULT_TRAIN_ID
    source = 'default'
  }

  // Validate train-id to prevent injection attacks
  if (!isValidTrainId(trainId)) {
    const errorMessage =
      source === 'host-fallback'
        ? `Invalid train-id derived from Host header: "${trainId}". Train ID must contain only alphanumeric characters, underscores, and hyphens (1-255 chars). Please use X-TRAIN-ID header instead.`
        : `Invalid train-id header: "${trainId}". Train ID must contain only alphanumeric characters, underscores, and hyphens (1-255 chars).`

    return c.json(
      {
        error: 'Invalid train-id',
        message: errorMessage,
        source: source,
        ...(source === 'host-fallback' && {
          migration_note:
            'The Host header fallback is deprecated. Please migrate to using the X-TRAIN-ID header. See migration guide: docs/02-User-Guide/migration-guide.md',
        }),
      },
      400
    )
  }

  // Store both train-id and its source for debugging/monitoring
  c.set('trainId', trainId)
  c.set('trainIdSource', source)

  // Add response header to indicate the source for debugging
  if (source === 'host-fallback') {
    c.header('X-Train-ID-Source', 'host-fallback-deprecated')
    c.header('X-Migration-Notice', 'Please migrate to X-TRAIN-ID header')
  }

  await next()
}
