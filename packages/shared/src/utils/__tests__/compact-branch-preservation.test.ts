import { describe, it, expect } from 'bun:test'
import {
  ConversationLinker,
  type ParentRequest,
  type QueryExecutor,
  type CompactSearchExecutor,
} from '../conversation-linker'
import { createHash } from 'crypto'

describe('Compact branch preservation', () => {
  // Helper to compute message hash (matching ConversationLinker's implementation)
  const computeHash = (messages: Array<{ role: string; content: string }>) => {
    const hash = createHash('sha256')
    for (const message of messages) {
      hash.update(message.role)
      hash.update('\n')
      // Normalize string content to match array format
      const normalizedContent = `[0]text:${message.content.trim().replace(/\r\n/g, '\n')}`
      hash.update(normalizedContent)
      hash.update('\n')
    }
    return hash.digest('hex')
  }

  it('should preserve compact branch for follow-up messages', async () => {
    // Pre-compute the parent hash
    const originalMessage = { role: 'user' as const, content: 'Original compact message' }
    const parentHash = computeHash([originalMessage])

    // Mock database with a compact conversation
    const mockRequests: ParentRequest[] = [
      {
        request_id: 'compact-parent-id',
        conversation_id: 'conv-123',
        branch_id: 'compact_123456',
        current_message_hash: parentHash,
        system_hash: 'system-hash-1',
      },
    ]

    const queryExecutor: QueryExecutor = async criteria => {
      if (criteria.currentMessageHash === parentHash) {
        return mockRequests.filter(r => r.current_message_hash === criteria.currentMessageHash)
      }
      if (criteria.parentMessageHash === parentHash) {
        // Simulate no existing children
        return []
      }
      return []
    }

    const compactSearchExecutor: CompactSearchExecutor = async () => null

    // Create a no-op logger for tests
    const mockLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }

    const linker = new ConversationLinker(
      queryExecutor,
      mockLogger,
      compactSearchExecutor,
      undefined,
      undefined,
      undefined
    )

    // Simulate a follow-up to the compact conversation
    const followUpMessages = [
      originalMessage,
      { role: 'assistant' as const, content: 'Response to compact' },
      { role: 'user' as const, content: 'Follow-up question' },
    ]

    const result = await linker.linkConversation({
      projectId: 'test.com',
      messages: followUpMessages,
      systemPrompt: 'System prompt',
      requestId: 'follow-up-request-id',
      messageCount: 3,
    })

    // The follow-up should stay on the compact branch
    expect(result.conversationId).toBe('conv-123')
    expect(result.parentRequestId).toBe('compact-parent-id')
    expect(result.branchId).toBe('compact_123456') // Should preserve the compact branch
  })

  it('should create new branch for non-compact conversations with existing children', async () => {
    // Pre-compute the parent hash
    const originalMessage = { role: 'user' as const, content: 'Original message' }
    const parentHash = computeHash([originalMessage])

    // Mock database with a regular conversation
    const mockRequests: ParentRequest[] = [
      {
        request_id: 'regular-parent-id',
        conversation_id: 'conv-456',
        branch_id: 'main',
        current_message_hash: parentHash,
        system_hash: 'system-hash-1',
      },
      {
        request_id: 'existing-child-id',
        conversation_id: 'conv-456',
        branch_id: 'main',
        current_message_hash: 'hash-existing-child',
        system_hash: 'system-hash-1',
      },
    ]

    const queryExecutor: QueryExecutor = async criteria => {
      if (criteria.currentMessageHash === parentHash) {
        return mockRequests.filter(r => r.current_message_hash === criteria.currentMessageHash)
      }
      if (criteria.parentMessageHash === parentHash) {
        // Simulate existing child
        return mockRequests.filter(r => r.request_id === 'existing-child-id')
      }
      return []
    }

    const compactSearchExecutor: CompactSearchExecutor = async () => null

    // Create a no-op logger for tests
    const mockLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }

    const linker = new ConversationLinker(
      queryExecutor,
      mockLogger,
      compactSearchExecutor,
      undefined,
      undefined,
      undefined
    )

    // Simulate a new branch from regular conversation
    const branchMessages = [
      originalMessage,
      { role: 'assistant' as const, content: 'Response' },
      { role: 'user' as const, content: 'New branch question' },
    ]

    const result = await linker.linkConversation({
      projectId: 'test.com',
      messages: branchMessages,
      systemPrompt: 'System prompt',
      requestId: 'new-branch-request-id',
      messageCount: 3,
    })

    // Should create a new branch since parent has existing children
    expect(result.conversationId).toBe('conv-456')
    expect(result.parentRequestId).toBe('regular-parent-id')
    expect(result.branchId).not.toBe('main') // Should create new branch
    expect(result.branchId).toMatch(/^branch_/) // Should be a branch_* ID
  })
})
