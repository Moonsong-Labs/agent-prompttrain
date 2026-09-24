import {
  countUserTextMessages,
  getErrorMessage,
  summarizeLastMessage,
} from '@agent-prompttrain/shared'
import { logger } from '../middleware/logger.js'

export interface SummaryColumns {
  lastMessageSummary: string | null
  userTextMessageCount: number | null
}

/**
 * Precompute the read-path summary columns for api_requests (ADR-037).
 * Never throws: a failed summary must not cost the request row.
 */
export function buildSummaryColumns(body: unknown): SummaryColumns {
  try {
    const messages = (body as { messages?: unknown } | null | undefined)?.messages
    const lastMessage = Array.isArray(messages) ? messages[messages.length - 1] : undefined
    const summary = summarizeLastMessage(lastMessage)

    return {
      lastMessageSummary: summary ? JSON.stringify(summary) : null,
      userTextMessageCount: countUserTextMessages(messages),
    }
  } catch (error) {
    logger.warn('Failed to summarize last message for storage', {
      metadata: { error: getErrorMessage(error) },
    })
    return { lastMessageSummary: null, userTextMessageCount: null }
  }
}
