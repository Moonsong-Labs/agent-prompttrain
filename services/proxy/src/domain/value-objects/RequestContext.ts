import { Context } from 'hono'
import { MSL_PROJECT_ID_HEADER_LOWER, MSL_ACCOUNT_HEADER_LOWER } from '@agent-prompttrain/shared'

/**
 * Value object containing request context information
 * Immutable container for request metadata
 */
export class RequestContext {
  constructor(
    public readonly requestId: string,
    public readonly projectId: string,
    public readonly method: string,
    public readonly path: string,
    public readonly startTime: number,
    public readonly headers: Record<string, string>,
    public readonly apiKey?: string,
    public readonly honoContext?: Context,
    public readonly account?: string
  ) {}

  /**
   * Create from Hono context
   */
  static fromHono(c: Context): RequestContext {
    const requestId = c.get('requestId')
    if (!requestId) {
      throw new Error(
        'RequestContext: requestId not found in context. Ensure request-id middleware is applied.'
      )
    }

    // MSL-Project-Id header is mandatory for proper project identification
    const projectId = c.get('projectId') || c.req.header(MSL_PROJECT_ID_HEADER_LOWER)
    if (!projectId) {
      throw new Error(
        'RequestContext: MSL-Project-Id header is required. Please provide the project identifier via the MSL-Project-Id header.'
      )
    }

    const rawTrainAccount = c.get('trainAccount') || c.req.header(MSL_ACCOUNT_HEADER_LOWER)
    const trainAccount =
      rawTrainAccount && rawTrainAccount.trim() ? rawTrainAccount.trim() : undefined
    // Only accept Bearer tokens from Authorization header (not x-api-key)
    const apiKey = c.req.header('authorization')

    // Extract relevant headers
    const headers: Record<string, string> = {}
    const relevantHeaders = ['user-agent', 'x-forwarded-for', 'x-real-ip', 'content-type', 'accept']

    for (const header of relevantHeaders) {
      const value = c.req.header(header)
      if (value) {
        headers[header] = value
      }
    }

    return new RequestContext(
      requestId,
      projectId,
      c.req.method,
      c.req.path,
      Date.now(),
      headers,
      apiKey,
      c,
      trainAccount
    )
  }

  /**
   * Get elapsed time in milliseconds
   */
  getElapsedTime(): number {
    return Date.now() - this.startTime
  }

  /**
   * Create telemetry context
   */
  toTelemetry() {
    return {
      requestId: this.requestId,
      projectId: this.projectId,
      method: this.method,
      path: this.path,
      duration: this.getElapsedTime(),
      timestamp: new Date(this.startTime).toISOString(),
    }
  }
}
