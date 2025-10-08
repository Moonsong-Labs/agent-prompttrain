/**
 * Interface for storage service improvements
 */

import type { ConversationSummary } from './conversation.js'

export interface StorageServiceEnhancements {
  /**
   * Get a single conversation by ID
   * @param conversationId The conversation ID
   * @returns The conversation or null if not found
   */
  getConversationById?(conversationId: string): Promise<ConversationSummary | null>

  /**
   * Get paginated conversation summaries with filtering
   * @param projectId Optional train filter
   * @param limit Number of items per page
   * @param offset Offset for pagination
   * @param search Optional search query
   * @returns Paginated results and total count
   */
  getConversationSummariesPaginated?(
    projectId?: string,
    limit?: number,
    offset?: number,
    search?: string
  ): Promise<{
    summaries: ConversationSummary[]
    totalCount: number
  }>
}

// This interface extends the existing storage service
// Implementation should be added to the actual storage service class
