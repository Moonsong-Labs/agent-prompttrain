import { createHash, randomUUID } from 'crypto'
import type { ClaudeMessage, ClaudeContent } from '../types/index.js'
import { hashSystemPrompt } from './conversation-hash.js'
import { stripSystemReminder } from './system-reminder.js'
import type { createLogger } from '../logger/index.js'

// Constants
const BRANCH_MAIN = 'main'
const BRANCH_PREFIX = 'branch_'
const COMPACT_PREFIX = 'compact_'
const COMPACT_CONVERSATION_PREFIX =
  'This session is being continued from a previous conversation that ran out of context'
const SUMMARY_MARKER = 'The conversation is summarized below:'
const SUMMARY_SUFFIX_MARKER = 'Please continue the conversation'
const SUMMARIZATION_SYSTEM_PROMPT =
  'You are a helpful AI assistant tasked with summarizing conversations'
const COMPACT_SEARCH_DAYS = 7 // Search window for compact conversations
// const QUERY_LIMIT = 10 // Reserved for future use0
const MIN_MESSAGES_FOR_PARENT_HASH = 3

export interface TaskInvocation {
  requestId: string
  toolUseId: string
  prompt: string
  timestamp: Date
}

export interface LinkingRequest {
  trainId: string
  messages: ClaudeMessage[]
  systemPrompt?: string | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[]
  requestId: string
  messageCount: number
  timestamp?: Date
}

export interface LinkingResult {
  conversationId: string | null
  parentRequestId: string | null
  branchId: string
  currentMessageHash: string
  parentMessageHash: string | null
  systemHash: string | null
  parentTaskRequestId?: string
  isSubtask?: boolean
  subtaskSequence?: number
}

interface CompactInfo {
  isCompact: boolean
  summaryContent: string
}

export interface ParentQueryCriteria {
  trainId: string
  messageCount?: number
  parentMessageHash?: string
  currentMessageHash?: string
  systemHash?: string | null
  excludeRequestId?: string
  beforeTimestamp?: Date
  conversationId?: string
}

interface ParentRequest {
  request_id: string
  conversation_id: string
  branch_id: string
  current_message_hash: string
  system_hash: string | null
}

export type QueryExecutor = (criteria: ParentQueryCriteria) => Promise<ParentRequest[]>

export type CompactSearchExecutor = (
  trainId: string,
  summaryContent: string,
  afterTimestamp: Date,
  beforeTimestamp?: Date
) => Promise<ParentRequest | null>

export type RequestByIdExecutor = (requestId: string) => Promise<ParentRequest | null>

export type SubtaskQueryExecutor = (
  trainId: string,
  timestamp: Date,
  debugMode?: boolean,
  subtaskPrompt?: string
) => Promise<TaskInvocation[] | undefined>

export type SubtaskSequenceQueryExecutor = (
  conversationId: string,
  beforeTimestamp: Date
) => Promise<number>

// Logger type
type Logger = ReturnType<typeof createLogger>

/**
 * ConversationLinker handles linking requests into conversations by computing message hashes
 * and finding parent-child relationships. It also supports subtask detection and branch management.
 */
export class ConversationLinker {
  /**
   * Creates a new ConversationLinker instance
   * @param queryExecutor - Executes queries to find parent requests by various criteria
   * @param logger - Logger instance for debugging and monitoring
   * @param compactSearchExecutor - Optional executor for finding compact conversation parents
   * @param requestByIdExecutor - Optional executor for fetching request details by ID
   * @param subtaskQueryExecutor - Optional executor for querying Task tool invocations
   * @param subtaskSequenceQueryExecutor - Optional executor for finding max subtask sequence in a conversation
   */
  constructor(
    private queryExecutor: QueryExecutor,
    private logger: Logger,
    private compactSearchExecutor?: CompactSearchExecutor,
    private requestByIdExecutor?: RequestByIdExecutor,
    private subtaskQueryExecutor?: SubtaskQueryExecutor,
    private subtaskSequenceQueryExecutor?: SubtaskSequenceQueryExecutor
  ) {}

  async linkConversation(request: LinkingRequest): Promise<LinkingResult> {
    const { trainId, messages, systemPrompt, requestId, timestamp } = request
    const linkingId = randomUUID()
    const traceMeta = { linkingId }

    this.logger.debug('Conversation linking process started', {
      trainId,
      metadata: {
        ...traceMeta,
        requestId,
        messageCount: messages.length,
        hasSystemPrompt: !!systemPrompt,
        timestamp: timestamp?.toISOString(),
      },
    })

    // Validate messages before processing
    if (!messages || messages.length === 0) {
      throw new Error('Cannot compute hash for empty messages array')
    }

    try {
      // Compute hashes with error handling
      const currentMessageHash = this.computeMessageHash(messages)

      // Convert system prompt to string if it's an array
      let systemPromptStr: string | undefined
      if (systemPrompt) {
        if (typeof systemPrompt === 'string') {
          systemPromptStr = systemPrompt
        } else if (Array.isArray(systemPrompt)) {
          systemPromptStr = systemPrompt.map(item => item.text).join('\n')
        }
      }

      const systemHash = systemPromptStr ? hashSystemPrompt(systemPromptStr) : null

      this.logger.debug('Computed initial hashes', {
        trainId,
        metadata: {
          ...traceMeta,
          currentMessageHash,
          systemHash,
          messageCount: messages.length,
        },
      })

      // Case 1: Single message handling
      if (messages.length === 1) {
        this.logger.debug('Processing single message', {
          trainId,
          metadata: {
            ...traceMeta,
            messageRole: messages[0].role,
          },
        })

        // Check for subtask first
        const subtaskResult = await this.detectSubtask(request, traceMeta)
        if (
          subtaskResult.isSubtask &&
          subtaskResult.parentTaskRequestId &&
          subtaskResult.subtaskSequence !== undefined
        ) {
          // Find the parent task request to inherit its conversation ID
          const parentTaskRequest = await this.findRequestById(subtaskResult.parentTaskRequestId)
          if (parentTaskRequest?.conversation_id) {
            const conversationId = parentTaskRequest.conversation_id
            const invocationIndex = subtaskResult.subtaskSequence

            // Query the database directly for base sequence
            // Timestamp ensures proper isolation for historical rebuilds
            const effectiveTimestamp = timestamp || new Date()
            const baseSequence = this.subtaskSequenceQueryExecutor
              ? await this.subtaskSequenceQueryExecutor(conversationId, effectiveTimestamp)
              : 0
            const finalSequence = baseSequence + invocationIndex

            this.logger.info('Linked as subtask', {
              trainId,
              metadata: {
                ...traceMeta,
                outcome: 'subtask_created',
                conversationId,
                parentTaskRequestId: subtaskResult.parentTaskRequestId,
                subtaskSequence: finalSequence,
              },
            })

            return {
              conversationId: conversationId,
              parentRequestId: subtaskResult.parentTaskRequestId,
              branchId: `subtask_${finalSequence}`,
              currentMessageHash,
              parentMessageHash: null, // Subtasks don't have parent message hash
              systemHash,
              isSubtask: true,
              parentTaskRequestId: subtaskResult.parentTaskRequestId,
              subtaskSequence: finalSequence,
            }
          }
        }

        const compactInfo = this.detectCompactConversation(messages[0])
        if (compactInfo) {
          this.logger.debug('Detected compact conversation', {
            trainId,
            metadata: {
              ...traceMeta,
              isCompact: true,
              summaryLength: compactInfo.summaryContent.length,
            },
          })

          // Case a: Compact conversation continuation
          const parent = await this.findCompactParent(
            trainId,
            compactInfo.summaryContent,
            timestamp,
            traceMeta
          )
          if (parent) {
            const branchId = this.generateCompactBranchId(timestamp)

            this.logger.info('Linked as compact conversation', {
              trainId,
              metadata: {
                ...traceMeta,
                outcome: 'compact_conversation',
                conversationId: parent.conversation_id,
                parentRequestId: parent.request_id,
                branchId,
              },
            })

            return {
              conversationId: parent.conversation_id,
              parentRequestId: parent.request_id,
              branchId,
              currentMessageHash,
              parentMessageHash: parent.current_message_hash,
              systemHash,
            }
          }
        }

        // Case b: Skip - no parent
        this.logger.info('Created new conversation (single message)', {
          trainId,
          metadata: {
            ...traceMeta,
            outcome: 'new_conversation',
            reason: 'Single message with no parent',
          },
        })

        return {
          conversationId: null,
          parentRequestId: null,
          branchId: BRANCH_MAIN,
          currentMessageHash,
          parentMessageHash: null,
          systemHash,
        }
      }

      // Case 2: Multiple messages - check if we can compute parent hash
      // First deduplicate to see how many unique messages we have
      const deduplicatedMessages = this.deduplicateMessages(messages)

      this.logger.debug('Processing multiple messages', {
        trainId,
        metadata: {
          ...traceMeta,
          originalCount: messages.length,
          deduplicatedCount: deduplicatedMessages.length,
        },
      })

      // If after deduplication we have fewer than 3 messages, we can't compute parent hash
      if (deduplicatedMessages.length < MIN_MESSAGES_FOR_PARENT_HASH) {
        this.logger.info('Created new conversation (insufficient messages for parent)', {
          trainId,
          metadata: {
            ...traceMeta,
            outcome: 'new_conversation',
            reason: 'Too few messages after deduplication',
            deduplicatedCount: deduplicatedMessages.length,
            minRequired: MIN_MESSAGES_FOR_PARENT_HASH,
          },
        })

        // Treat as a new conversation or single-message-like scenario
        return {
          conversationId: null,
          parentRequestId: null,
          branchId: BRANCH_MAIN,
          currentMessageHash,
          parentMessageHash: null,
          systemHash,
        }
      }

      let parentMessageHash: string
      try {
        parentMessageHash = this.computeParentHashFromDeduplicated(deduplicatedMessages)

        this.logger.debug('Computed parent hash', {
          trainId,
          metadata: {
            ...traceMeta,
            parentMessageHash,
          },
        })
      } catch (error) {
        this.logger.error('Failed to compute parent hash', {
          trainId,
          metadata: {
            ...traceMeta,
            error: error instanceof Error ? error.message : String(error),
          },
        })
        // Return as new conversation if parent hash computation fails
        return {
          conversationId: null,
          parentRequestId: null,
          branchId: BRANCH_MAIN,
          currentMessageHash,
          parentMessageHash: null,
          systemHash,
        }
      }

      // Priority matching system
      let parent: ParentRequest | null = null

      this.logger.debug('Starting parent matching with priority system', {
        trainId,
        metadata: {
          ...traceMeta,
          parentMessageHash,
          systemHash,
        },
      })

      // Priority i: Exact match (parent hash + system hash)
      if (systemHash) {
        const exactMatches = await this.findParentByHash(
          trainId,
          parentMessageHash,
          systemHash,
          requestId,
          timestamp,
          traceMeta
        )
        parent = this.selectBestParent(exactMatches, traceMeta)

        if (parent) {
          this.logger.debug('Found parent via exact match', {
            trainId,
            metadata: {
              ...traceMeta,
              parentId: parent.request_id,
              matchType: 'exact',
            },
          })
        }
      }

      // Priority ii: Summarization request - ignore system hash
      if (!parent && this.isSummarizationRequest(systemPromptStr)) {
        this.logger.debug('Attempting summarization match (ignoring system hash)', {
          trainId,
          metadata: traceMeta,
        })

        const summarizationMatches = await this.findParentByHash(
          trainId,
          parentMessageHash,
          null,
          requestId,
          timestamp,
          traceMeta
        )
        parent = this.selectBestParent(summarizationMatches, traceMeta)

        if (parent) {
          this.logger.debug('Found parent via summarization match', {
            trainId,
            metadata: {
              ...traceMeta,
              parentId: parent.request_id,
              matchType: 'summarization',
            },
          })
        }
      }

      // Priority iii: Fallback - match by message hash only
      if (!parent) {
        this.logger.debug('Attempting fallback match (message hash only)', {
          trainId,
          metadata: traceMeta,
        })

        const fallbackMatches = await this.findParentByHash(
          trainId,
          parentMessageHash,
          null,
          requestId,
          timestamp,
          traceMeta
        )
        parent = this.selectBestParent(fallbackMatches, traceMeta)

        if (parent) {
          this.logger.debug('Found parent via fallback match', {
            trainId,
            metadata: {
              ...traceMeta,
              parentId: parent.request_id,
              matchType: 'fallback',
            },
          })
        }
      }

      // Grandparent fallback: If no parent found and we have enough messages,
      // try to find the grandparent request. This handles cases where the immediate
      // parent request failed to be stored due to transient storage issues.
      if (!parent && deduplicatedMessages.length > 4) {
        this.logger.debug('Attempting grandparent fallback', {
          trainId,
          metadata: {
            ...traceMeta,
            deduplicatedCount: deduplicatedMessages.length,
          },
        })

        try {
          const grandparentHash = this.computeGrandparentHashFromDeduplicated(deduplicatedMessages)

          // Look for a request whose current_message_hash matches our computed grandparent hash
          // Using findParentByHash which searches by currentMessageHash = parentMessageHash parameter
          const grandparentMatches = await this.findParentByHash(
            trainId,
            grandparentHash,
            null, // No system hash filter for grandparent lookup
            requestId,
            timestamp,
            traceMeta
          )

          if (grandparentMatches.length > 0) {
            const grandparent = this.selectBestParent(grandparentMatches, traceMeta)
            if (grandparent) {
              this.logger.debug('Found grandparent match', {
                trainId,
                metadata: {
                  ...traceMeta,
                  grandparentId: grandparent.request_id,
                  matchType: 'grandparent',
                },
              })

              // Use grandparent's conversation_id and request_id as parent
              // but keep our original message hashes unchanged
              parent = {
                ...grandparent,
                // Override to use grandparent's request_id as our parent
                request_id: grandparent.request_id,
                // Keep the grandparent's conversation_id
                conversation_id: grandparent.conversation_id,
                // Use grandparent's branch_id
                branch_id: grandparent.branch_id,
              }
            }
          }
        } catch (error) {
          this.logger.error('Grandparent fallback failed', {
            trainId,
            metadata: {
              ...traceMeta,
              error: error instanceof Error ? error.message : String(error),
              messageCount: deduplicatedMessages.length,
            },
          })
          // Continue without grandparent - will create new conversation
        }
      }

      if (parent) {
        // Check if the parent is on a compact branch
        const isParentCompactBranch = parent.branch_id.startsWith(COMPACT_PREFIX)

        let branchId: string
        if (isParentCompactBranch) {
          // If parent is on a compact branch, preserve that branch
          // This ensures follow-ups to compact conversations stay on the same branch
          branchId = parent.branch_id

          this.logger.debug('Preserving compact branch', {
            trainId,
            metadata: {
              ...traceMeta,
              branchId,
            },
          })
        } else {
          // Normal branch detection for non-compact conversations
          // Only look for children within the same conversation
          // If parent has no conversation_id (legacy data), skip the conversation filter
          const existingChildren = await this.findChildrenOfParent(
            trainId,
            parent.current_message_hash,
            requestId,
            timestamp,
            parent.conversation_id || undefined,
            traceMeta
          )

          const isNewBranch = existingChildren.length > 0
          branchId = isNewBranch ? this.generateBranchId(timestamp) : parent.branch_id

          if (isNewBranch) {
            this.logger.debug('Creating new branch', {
              trainId,
              metadata: {
                ...traceMeta,
                branchId,
                existingChildrenCount: existingChildren.length,
              },
            })
          }
        }

        this.logger.info('Linked to existing conversation', {
          trainId,
          metadata: {
            ...traceMeta,
            outcome: 'linked_to_parent',
            conversationId: parent.conversation_id,
            parentRequestId: parent.request_id,
            branchId,
            isNewBranch: branchId !== parent.branch_id,
          },
        })

        return {
          conversationId: parent.conversation_id,
          parentRequestId: parent.request_id,
          branchId,
          currentMessageHash,
          parentMessageHash,
          systemHash,
        }
      }

      // No parent found - new conversation
      this.logger.info('Created new conversation', {
        trainId,
        metadata: {
          ...traceMeta,
          outcome: 'new_conversation',
          reason: 'No suitable parent found after all matching attempts',
        },
      })

      return {
        conversationId: null,
        parentRequestId: null,
        branchId: BRANCH_MAIN,
        currentMessageHash,
        parentMessageHash,
        systemHash,
      }
    } catch (error) {
      console.error('Error in linkConversation:', error)
      // Return safe default on any error
      return {
        conversationId: null,
        parentRequestId: null,
        branchId: BRANCH_MAIN,
        currentMessageHash: '',
        parentMessageHash: null,
        systemHash: null,
      }
    }
  }

  public computeMessageHash(messages: ClaudeMessage[]): string {
    try {
      const hash = createHash('sha256')

      if (!messages || messages.length === 0) {
        throw new Error('Cannot compute hash for empty messages array')
      }

      // Deduplicate messages first
      const deduplicatedMessages = this.deduplicateMessages(messages)

      for (const message of deduplicatedMessages) {
        if (!message || !message.role) {
          throw new Error('Invalid message: missing role')
        }

        hash.update(message.role)
        hash.update('\n')

        const normalizedContent = this.normalizeMessageContent(message.content)
        hash.update(normalizedContent)
        hash.update('\n')
      }

      return hash.digest('hex')
    } catch (error) {
      console.error('Error in computeMessageHash:', error)
      throw new Error(
        `Failed to compute message hash: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  // This version does NOT deduplicate - for internal use when messages are already deduplicated
  private computeMessageHashNoDedupe(messages: ClaudeMessage[]): string {
    try {
      const hash = createHash('sha256')

      if (!messages || messages.length === 0) {
        throw new Error('Cannot compute hash for empty messages array')
      }

      for (const message of messages) {
        if (!message || !message.role) {
          throw new Error('Invalid message: missing role')
        }

        hash.update(message.role)
        hash.update('\n')

        const normalizedContent = this.normalizeMessageContent(message.content)
        hash.update(normalizedContent)
        hash.update('\n')
      }

      return hash.digest('hex')
    } catch (error) {
      console.error('Error in computeMessageHashNoDedupe:', error)
      throw new Error(
        `Failed to compute message hash: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private normalizeMessageContent(content: string | ClaudeContent[]): string {
    if (typeof content === 'string') {
      return this.normalizeStringContent(content)
    }

    // For array content, create a deterministic string representation
    const filteredContent = this.filterSystemReminders(content)
    return this.serializeContentItems(filteredContent)
  }

  private normalizeStringContent(content: string): string {
    // Normalize string content to match array format for consistency
    return `[0]text:${content.trim().replace(/\r\n/g, '\n')}`
  }

  private filterSystemReminders(content: ClaudeContent[]): ClaudeContent[] {
    // Filter out system-reminder content items before processing
    return content.filter(item => {
      // Skip text items that contain system-reminder blocks
      if (item.type === 'text' && typeof item.text === 'string') {
        // If the entire text is just a system-reminder, filter it out
        const stripped = stripSystemReminder(item.text)
        return stripped.trim().length > 0
      }
      return true
    })
  }

  // This is because of bug https://github.com/anthropics/claude-code-action/issues/200
  private deduplicateMessages(messages: ClaudeMessage[]): ClaudeMessage[] {
    // Track seen tool IDs across all messages
    const seenToolUseIds = new Set<string>()
    const seenToolResultIds = new Set<string>()
    const deduplicatedMessages: ClaudeMessage[] = []

    for (const message of messages) {
      // For non-array content, always keep the message
      if (typeof message.content === 'string') {
        deduplicatedMessages.push(message)
        continue
      }

      // Filter the content to remove duplicate tool uses/results
      const filteredContent = message.content.filter(item => {
        if (item.type === 'tool_use' && item.id) {
          if (seenToolUseIds.has(item.id)) {
            return false // Skip duplicate tool_use
          }
          seenToolUseIds.add(item.id)
          return true
        } else if (item.type === 'tool_result' && item.tool_use_id) {
          if (seenToolResultIds.has(item.tool_use_id)) {
            return false // Skip duplicate tool_result
          }
          seenToolResultIds.add(item.tool_use_id)
          return true
        }
        // Keep all non-tool content
        return true
      })

      // Only include the message if no duplicates were found
      if (filteredContent.length === message.content.length) {
        deduplicatedMessages.push(message)
      }
    }

    return deduplicatedMessages
  }

  private serializeContentItems(content: ClaudeContent[]): string {
    return content.map((item, index) => this.serializeContentItem(item, index)).join('\n')
  }

  private serializeContentItem(item: ClaudeContent, index: number): string {
    switch (item.type) {
      case 'text':
        return this.serializeTextItem(item, index)
      case 'image':
        return this.serializeImageItem(item, index)
      case 'tool_use':
        return this.serializeToolUseItem(item, index)
      case 'tool_result':
        return this.serializeToolResultItem(item, index)
      default:
        return `[${index}]${item.type}:unknown`
    }
  }

  private serializeTextItem(item: ClaudeContent, index: number): string {
    // Strip system-reminder blocks from text content before serializing
    const cleanText = stripSystemReminder(item.text || '')
    const text = cleanText.trim().replace(/\r\n/g, '\n')
    return `[${index}]text:${text}`
  }

  private serializeImageItem(item: ClaudeContent, index: number): string {
    if (!item.source) {
      return `[${index}]image:no-source`
    }
    // Hash the image data to avoid massive strings
    const imageHash = createHash('sha256')
      .update(item.source.data || '')
      .digest('hex')
    return `[${index}]image:${item.source.media_type}:${imageHash}`
  }

  private serializeToolUseItem(item: ClaudeContent, index: number): string {
    return `[${index}]tool_use:${item.name}:${item.id}:${JSON.stringify(item.input)}`
  }

  private serializeToolResultItem(item: ClaudeContent, index: number): string {
    let contentStr = ''
    if (typeof item.content === 'string') {
      // Strip system-reminder blocks from tool_result content
      contentStr = stripSystemReminder(item.content)
    } else if (Array.isArray(item.content)) {
      contentStr = JSON.stringify(item.content)
    }
    return `[${index}]tool_result:${item.tool_use_id}:${contentStr}`
  }

  private computeParentHashFromDeduplicated(deduplicatedMessages: ClaudeMessage[]): string {
    // Parent hash is all messages except the last 2
    if (deduplicatedMessages.length < MIN_MESSAGES_FOR_PARENT_HASH) {
      throw new Error(
        `Cannot compute parent hash for less than ${MIN_MESSAGES_FOR_PARENT_HASH} messages: ${deduplicatedMessages.length}`
      )
    }

    const parentMessages = deduplicatedMessages.slice(0, -2)
    // Use the non-deduplicating version since messages are already deduplicated
    return this.computeMessageHashNoDedupe(parentMessages)
  }

  /**
   * Computes the grandparent hash from deduplicated messages by removing the last 4 messages.
   * This is used as a fallback when the parent request is missing due to storage failures.
   *
   * @param deduplicatedMessages - Already deduplicated messages array
   * @returns SHA-256 hash of messages excluding the last 4
   * @throws Error if there are fewer than 5 messages
   */
  private computeGrandparentHashFromDeduplicated(deduplicatedMessages: ClaudeMessage[]): string {
    // Grandparent hash requires at least 5 messages (to remove last 4)
    const MIN_MESSAGES_FOR_GRANDPARENT_HASH = 5

    if (deduplicatedMessages.length < MIN_MESSAGES_FOR_GRANDPARENT_HASH) {
      throw new Error(
        `Cannot compute grandparent hash for less than ${MIN_MESSAGES_FOR_GRANDPARENT_HASH} messages: ${deduplicatedMessages.length}`
      )
    }

    const grandparentMessages = deduplicatedMessages.slice(0, -4)
    // Use the non-deduplicating version since messages are already deduplicated
    return this.computeMessageHashNoDedupe(grandparentMessages)
  }

  private detectCompactConversation(message: ClaudeMessage): CompactInfo | null {
    try {
      // Add null/undefined checks
      if (!message || !message.content) {
        return null
      }

      // Ensure content is iterable
      const contentArray = Array.isArray(message.content) ? message.content : [message.content]

      // Check all content items in the message
      for (const content of contentArray) {
        let textContent: string | null = null

        if (typeof content === 'string') {
          textContent = content
        } else if (
          content &&
          typeof content === 'object' &&
          content.type === 'text' &&
          typeof content.text === 'string'
        ) {
          textContent = content.text
        }

        if (textContent && textContent.includes(COMPACT_CONVERSATION_PREFIX)) {
          // Extract the summary content after the marker
          const summaryStart = textContent.indexOf(SUMMARY_MARKER)
          if (summaryStart > -1) {
            const summaryContent = this.extractSummaryContent(
              textContent,
              summaryStart + SUMMARY_MARKER.length
            )
            return {
              isCompact: true,
              summaryContent,
            }
          }
        }
      }

      return null
    } catch (error) {
      // Log error and return null to prevent crashes
      console.error('Error in detectCompactConversation:', error)
      return null
    }
  }

  private extractSummaryContent(content: string, startIndex: number): string {
    // Extract the core summary content, removing common suffixes
    let summary = content.substring(startIndex).trim()

    // Remove the "Please continue..." suffix if present
    const suffixIndex = summary.indexOf(SUMMARY_SUFFIX_MARKER)
    if (suffixIndex > -1) {
      summary = summary.substring(0, suffixIndex).trim()
    }

    // Remove trailing punctuation that might differ
    summary = summary.replace(/[.]+$/, '').trim()

    return summary
  }

  private async findCompactParent(
    trainId: string,
    summaryContent: string,
    requestTimestamp: Date | undefined,
    traceMeta: { linkingId: string }
  ): Promise<ParentRequest | null> {
    try {
      if (!this.compactSearchExecutor) {
        this.logger.debug('No compact search executor available', {
          trainId,
          metadata: traceMeta,
        })
        // Without compact search capability, we can't find the parent
        return null
      }

      // Normalize the summary content for comparison
      const normalizedSummary = summaryContent // this.normalizeSummaryForComparison(summaryContent)

      // Search for a request whose response contains the summary
      // Look for requests within the last N days before the current request
      const afterTimestamp = new Date(requestTimestamp || new Date())
      afterTimestamp.setDate(afterTimestamp.getDate() - COMPACT_SEARCH_DAYS)

      this.logger.debug('Searching for compact parent', {
        trainId,
        metadata: {
          ...traceMeta,
          searchWindow: `${COMPACT_SEARCH_DAYS} days`,
          summaryLength: normalizedSummary.length,
        },
      })

      // afterTimestamp: N days before the request (lower bound - earliest time to search)
      // requestTimestamp: the current request time (upper bound - latest time to search)
      // This creates a time window: [requestTime - N days, requestTime]
      const result = await this.compactSearchExecutor(
        trainId,
        normalizedSummary,
        afterTimestamp,
        requestTimestamp
      )

      if (result) {
        this.logger.debug('Found compact parent', {
          trainId,
          metadata: {
            ...traceMeta,
            parentId: result.request_id,
            parentConversationId: result.conversation_id,
          },
        })
      } else {
        this.logger.debug('No compact parent found', {
          trainId,
          metadata: traceMeta,
        })
      }

      return result
    } catch (error) {
      this.logger.error('Error finding compact parent', {
        trainId,
        metadata: {
          ...traceMeta,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      return null
    }
  }

  private async findRequestById(requestId: string): Promise<ParentRequest | null> {
    try {
      if (!this.requestByIdExecutor) {
        // Without request by ID capability, we can't find the parent
        return null
      }

      return await this.requestByIdExecutor(requestId)
    } catch (error) {
      console.error('Error finding request by ID:', error)
      return null
    }
  }

  private normalizeSummaryForComparison(summary: string): string {
    // Remove common variations in formatting
    return summary
      .replace(/\s+/g, ' ')
      .replace(/<analysis>/g, '')
      .replace(/<\/analysis>/g, '')
      .replace(/<summary>/g, '')
      .replace(/<\/summary>/g, '')
      .replace(/analysis:/gi, '')
      .trim()
  }

  private async findParentByHash(
    trainId: string,
    parentMessageHash: string,
    systemHash: string | null,
    excludeRequestId: string,
    beforeTimestamp: Date | undefined,
    traceMeta: { linkingId: string }
  ): Promise<ParentRequest[]> {
    try {
      const criteria: ParentQueryCriteria = {
        trainId,
        currentMessageHash: parentMessageHash,
        systemHash,
        excludeRequestId,
        beforeTimestamp,
      }

      this.logger.debug('Searching for parent by hash', {
        trainId,
        metadata: {
          ...traceMeta,
          parentMessageHash,
          systemHash,
          hasTimestampFilter: !!beforeTimestamp,
        },
      })

      const results = await this.queryExecutor(criteria)

      this.logger.debug(`Found ${results.length} potential parents`, {
        trainId,
        metadata: {
          ...traceMeta,
          count: results.length,
          parentIds: results.map(r => r.request_id),
        },
      })

      return results
    } catch (error) {
      this.logger.error('Error finding parent by hash', {
        trainId,
        metadata: {
          ...traceMeta,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      return []
    }
  }

  private async findChildrenOfParent(
    trainId: string,
    parentMessageHash: string,
    excludeRequestId: string,
    beforeTimestamp: Date | undefined,
    conversationId: string | undefined,
    traceMeta: { linkingId: string }
  ): Promise<ParentRequest[]> {
    try {
      const criteria: ParentQueryCriteria = {
        trainId,
        parentMessageHash,
        excludeRequestId,
        beforeTimestamp,
        conversationId,
      }

      this.logger.debug('Searching for children of parent', {
        trainId,
        metadata: {
          ...traceMeta,
          parentMessageHash,
          conversationId,
        },
      })

      const results = await this.queryExecutor(criteria)

      if (results.length > 0) {
        this.logger.debug('Found existing children - branch point detected', {
          trainId,
          metadata: {
            ...traceMeta,
            childCount: results.length,
            childIds: results.map(r => r.request_id),
          },
        })
      }

      return results
    } catch (error) {
      this.logger.error('Error finding children of parent', {
        trainId,
        metadata: {
          ...traceMeta,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      return []
    }
  }

  private selectBestParent(
    candidates: ParentRequest[],
    traceMeta: { linkingId: string }
  ): ParentRequest | null {
    if (candidates.length === 0) {
      return null
    }

    if (candidates.length > 1) {
      this.logger.debug('Multiple parent candidates found, selecting first', {
        metadata: {
          ...traceMeta,
          candidateCount: candidates.length,
          selectedId: candidates[0].request_id,
        },
      })
    }

    // For now, return the first candidate
    // In the future, we might want to select based on:
    // - Recency
    // - Conversation size
    // - Branch preference
    return candidates[0]
  }

  private isSummarizationRequest(
    systemPrompt?: string | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[]
  ): boolean {
    if (!systemPrompt) {
      return false
    }

    let systemPromptStr: string
    if (typeof systemPrompt === 'string') {
      systemPromptStr = systemPrompt
    } else if (Array.isArray(systemPrompt)) {
      systemPromptStr = systemPrompt.map(item => item.text).join('\n')
    } else {
      return false
    }

    return systemPromptStr.includes(SUMMARIZATION_SYSTEM_PROMPT)
  }

  private generateBranchId(timestamp?: Date): string {
    const date = timestamp || new Date()
    const timestampStr = date.toISOString().replace(/[-:T]/g, '').slice(0, 14)
    return `${BRANCH_PREFIX}${timestampStr}`
  }

  private generateCompactBranchId(timestamp?: Date): string {
    const date = timestamp || new Date()
    const hours = date.getHours().toString().padStart(2, '0')
    const minutes = date.getMinutes().toString().padStart(2, '0')
    const seconds = date.getSeconds().toString().padStart(2, '0')
    return `${COMPACT_PREFIX}${hours}${minutes}${seconds}`
  }

  private async detectSubtask(
    request: LinkingRequest,
    traceMeta: { linkingId: string }
  ): Promise<{
    isSubtask: boolean
    parentTaskRequestId?: string
    subtaskSequence?: number
  }> {
    // Only single-message user conversations can be subtasks
    if (request.messages.length !== 1 || request.messages[0].role !== 'user') {
      return { isSubtask: false }
    }

    // Load task context if subtask executor is available
    if (!this.subtaskQueryExecutor) {
      return { isSubtask: false }
    }

    this.logger.debug('Attempting to detect subtask', {
      trainId: request.trainId,
      metadata: traceMeta,
    })

    // Extract the user message content first for optimization
    const message = request.messages[0]
    const userContent = this.extractContentText(message.content)
    if (!userContent) {
      this.logger.debug('No text content found in user message', {
        trainId: request.trainId,
        metadata: traceMeta,
      })
      return { isSubtask: false }
    }

    const timestamp = request.timestamp || new Date()
    // Pass the user content as the prompt filter for optimized querying
    const recentInvocations = await this.subtaskQueryExecutor(
      request.trainId,
      timestamp,
      false, // debugMode - controlled by the executor
      userContent // Pass the prompt for SQL-level filtering
    )

    // Check if we have task context with recent invocations
    if (!recentInvocations || recentInvocations.length === 0) {
      this.logger.debug('No recent Task invocations found', {
        trainId: request.trainId,
        metadata: traceMeta,
      })
      return { isSubtask: false }
    }

    this.logger.debug('Found recent Task invocations', {
      trainId: request.trainId,
      metadata: {
        ...traceMeta,
        invocationCount: recentInvocations.length,
      },
    })

    // Find matching task invocation
    let matchingInvocation: TaskInvocation | undefined
    let subtaskSequence = 1

    // Sort invocations by timestamp to assign sequence numbers correctly
    const sortedInvocations = [...recentInvocations].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
    )

    // Track sequence numbers by parent request ID
    const sequenceByParent = new Map<string, number>()

    for (const invocation of sortedInvocations) {
      // Count subtasks per parent request
      const currentSequence = (sequenceByParent.get(invocation.requestId) || 0) + 1
      sequenceByParent.set(invocation.requestId, currentSequence)

      // Check for exact match
      if (invocation.prompt === userContent) {
        matchingInvocation = invocation
        subtaskSequence = currentSequence
        break
      }
    }

    if (matchingInvocation) {
      this.logger.debug('Found matching Task invocation', {
        trainId: request.trainId,
        metadata: {
          ...traceMeta,
          parentTaskRequestId: matchingInvocation.requestId,
          subtaskSequence,
        },
      })

      // Note: `subtaskSequence` here represents the 1-based index of the invocation
      // within this turn. The final sequence number will be calculated in `linkConversation`.
      return {
        isSubtask: true,
        parentTaskRequestId: matchingInvocation.requestId,
        subtaskSequence,
      }
    }

    this.logger.debug('No matching Task invocation found', {
      trainId: request.trainId,
      metadata: {
        ...traceMeta,
        userContentPreview: userContent.substring(0, 100),
      },
    })

    return { isSubtask: false }
  }

  private extractContentText(content: string | ClaudeContent[]): string {
    if (typeof content === 'string') {
      return stripSystemReminder(content)
    }

    if (Array.isArray(content)) {
      return content
        .filter(item => item.type === 'text')
        .map(item => stripSystemReminder(item.text || ''))
        .filter(text => text.trim().length > 0) // Remove empty strings after stripping
        .join('\n')
    }

    return ''
  }
}
