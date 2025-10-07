import { describe, it, expect } from 'bun:test'
import { truncateConversation, type Message } from '../truncation'
import { ANALYSIS_PROMPT_CONFIG } from '../../config/ai-analysis'

describe('truncateConversation', () => {
  // Helper to create test messages
  const createMessage = (role: 'user' | 'model', content: string, index?: number): Message => ({
    role,
    content: `${content}${index !== undefined ? ` (Message ${index})` : ''}`,
  })

  // Helper to create array of messages
  const createMessages = (count: number): Message[] => {
    const messages: Message[] = []
    for (let i = 0; i < count; i++) {
      messages.push(createMessage(i % 2 === 0 ? 'user' : 'model', 'Test message', i))
    }
    return messages
  }

  // Test configuration values
  const _HEAD_MESSAGES = ANALYSIS_PROMPT_CONFIG.TRUNCATION_STRATEGY.HEAD_MESSAGES // 5
  const TAIL_MESSAGES = ANALYSIS_PROMPT_CONFIG.TRUNCATION_STRATEGY.TAIL_MESSAGES // 20

  describe('basic functionality', () => {
    it('should return all messages if within token limit', () => {
      const messages = createMessages(10)
      const result = truncateConversation(messages)

      expect(result).toEqual(messages)
      expect(result.length).toBe(10)
    })

    it('should handle empty conversation', () => {
      const result = truncateConversation([])
      expect(result).toEqual([])
    })

    it('should handle single message', () => {
      const messages = [createMessage('user', 'Hello')]
      const result = truncateConversation(messages)

      expect(result).toEqual(messages)
      expect(result.length).toBe(1)
    })
  })

  describe('truncation scenarios', () => {
    it(
      'should truncate long conversation preserving head and tail',
      () => {
        // Create a very long message to force truncation
        // With ~12 chars per token (config default), we need ~10M chars to exceed 855k tokens
        const longContent = 'The quick brown fox jumps over the lazy dog. '.repeat(5000) // ~225k chars
        const messages: Message[] = []

        // Add 50 messages with long content - this will be ~11M chars total, ~900k tokens
        for (let i = 0; i < 50; i++) {
          messages.push(
            createMessage(i % 2 === 0 ? 'user' : 'model', longContent + ` (Message ${i})`, i)
          )
        }

        const result = truncateConversation(messages)

        // Should have truncated the conversation
        expect(result.length).toBeLessThan(messages.length)

        // Should contain truncation marker
        const hasTruncationMarker = result.some(
          msg => msg.content === '[...conversation truncated...]'
        )
        expect(hasTruncationMarker).toBe(true)

        // If truncation marker is first, it means no head messages fit
        const _firstContentMessage =
          result[0].content === '[...conversation truncated...]' ? result[1] : result[0]

        // Last message should be from the tail
        expect(result[result.length - 1].content).toContain('Message 49')

        // Verify we have messages from the conversation
        const hasMessageContent = result.some(msg => msg.content.includes('Message'))
        expect(hasMessageContent).toBe(true)
      },
      { timeout: 30000 }
    )

    it('should handle conversation shorter than head + tail size', () => {
      const messages = createMessages(22) // Less than 5 + 20
      const result = truncateConversation(messages)

      // Should return all messages without duplication
      expect(result.length).toBe(22)
      expect(result).toEqual(messages)
    })

    it('should handle exactly head + tail size', () => {
      const messages = createMessages(25) // Exactly 5 + 20
      const result = truncateConversation(messages)

      // Should return all messages without duplication
      expect(result.length).toBe(25)
      expect(result).toEqual(messages)
    })
  })

  describe('edge cases', () => {
    it(
      'should handle when tail alone exceeds token limit',
      () => {
        // Create messages where even 20 tail messages exceed the limit
        // Each message needs ~43k tokens, so ~520k chars per message (12 chars/token)
        const veryLongContent = 'B'.repeat(520000) // Each message is huge
        const messages: Message[] = []

        for (let i = 0; i < 30; i++) {
          messages.push(createMessage(i % 2 === 0 ? 'user' : 'model', veryLongContent, i))
        }

        const result = truncateConversation(messages)

        // Should have fewer than the configured tail messages
        expect(result.length).toBeLessThan(TAIL_MESSAGES)

        // Should still preserve the most recent messages
        expect(result[result.length - 1].content).toContain('Message 29')
      },
      { timeout: 40000 }
    )

    it(
      'should truncate single message that exceeds limit',
      () => {
        // Create a single message that exceeds the entire token limit
        // With 200k max tokens and ~4 chars/token, we need more than 800k chars
        const hugeContent = 'The quick brown fox jumps over the lazy dog. '.repeat(18000) // ~810k chars
        const messages = [createMessage('user', hugeContent)]

        const result = truncateConversation(messages)

        expect(result.length).toBe(1)
        expect(result[0].content).toContain('[CONTENT TRUNCATED]')
        expect(result[0].content.length).toBeLessThan(hugeContent.length)
      },
      { timeout: 40000 }
    )

    it('should handle mixed message sizes correctly', () => {
      const messages: Message[] = [
        createMessage('user', 'Short', 0),
        createMessage('model', 'A'.repeat(50000), 1), // Long
        createMessage('user', 'Short', 2),
        createMessage('model', 'B'.repeat(100000), 3), // Very long
        createMessage('user', 'Short', 4),
        createMessage('model', 'Short', 5),
        ...createMessages(20).map((msg, i) => ({
          ...msg,
          content: msg.content + ` (Message ${i + 6})`,
        })),
      ]

      const result = truncateConversation(messages)

      // Should include truncation marker
      const truncationIndex = result.findIndex(
        msg => msg.content === '[...conversation truncated...]'
      )

      if (truncationIndex > -1) {
        // Messages before truncation should be from head
        expect(result[0].content).toContain('Message 0')

        // Messages after truncation should be from tail
        const lastMessage = result[result.length - 1]
        expect(lastMessage.content).toMatch(/Message \d+/)
      }
    })
  })

  describe('truncation marker placement', () => {
    it(
      'should place truncation marker between non-consecutive messages',
      () => {
        // Create scenario where we'll have gaps
        // Need enough to trigger truncation: 100 messages * 120k chars = 12M chars ~= 1M tokens
        const longContent = 'D'.repeat(120000)
        const messages: Message[] = []

        for (let i = 0; i < 100; i++) {
          messages.push(createMessage(i % 2 === 0 ? 'user' : 'model', longContent, i))
        }

        const result = truncateConversation(messages)

        // Find truncation marker
        const truncationIndex = result.findIndex(
          msg => msg.content === '[...conversation truncated...]'
        )

        expect(truncationIndex).toBeGreaterThan(0)
        expect(truncationIndex).toBeLessThan(result.length - 1)

        // Check that there's a gap in message indices around the truncation marker
        if (truncationIndex > 0) {
          const beforeIndex = parseInt(
            result[truncationIndex - 1].content.match(/Message (\d+)/)?.[1] || '0'
          )
          const afterIndex = parseInt(
            result[truncationIndex + 1].content.match(/Message (\d+)/)?.[1] || '0'
          )

          expect(afterIndex - beforeIndex).toBeGreaterThan(1)
        }
      },
      { timeout: 60000 }
    )

    it('should not duplicate messages when head and tail overlap', () => {
      const messages = createMessages(8) // Less than head + tail
      const result = truncateConversation(messages)

      // Check for duplicates
      const contents = result.map(m => m.content)
      const uniqueContents = new Set(contents)

      expect(contents.length).toBe(uniqueContents.size)
      expect(result.length).toBe(8)
    })
  })

  describe('role preservation', () => {
    it('should preserve message roles correctly', () => {
      const messages: Message[] = [
        createMessage('user', 'Question 1'),
        createMessage('model', 'Answer 1'),
        createMessage('user', 'Question 2'),
        createMessage('model', 'Answer 2'),
      ]

      const result = truncateConversation(messages)

      expect(result[0].role).toBe('user')
      expect(result[1].role).toBe('model')
      expect(result[2].role).toBe('user')
      expect(result[3].role).toBe('model')
    })

    it(
      'should use user role for truncation marker',
      () => {
        // Need enough content to trigger truncation
        const longContent = 'The quick brown fox jumps over the lazy dog. '.repeat(5000)
        const messages = createMessages(50).map(msg => ({
          ...msg,
          content: longContent,
        }))

        const result = truncateConversation(messages)
        const truncationMarker = result.find(
          msg => msg.content === '[...conversation truncated...]'
        )

        expect(truncationMarker).toBeDefined()
        expect(truncationMarker?.role).toBe('user')
      },
      { timeout: 30000 }
    )
  })
})
