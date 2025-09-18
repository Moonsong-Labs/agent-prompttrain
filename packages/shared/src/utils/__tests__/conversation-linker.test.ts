import { describe, test, expect, beforeEach } from 'bun:test'
import {
  ConversationLinker,
  type QueryExecutor,
  type CompactSearchExecutor,
  type LinkingRequest,
  type ParentQueryCriteria,
  type RequestByIdExecutor,
  type SubtaskQueryExecutor,
  type SubtaskSequenceQueryExecutor,
} from '../conversation-linker'
import { hashMessagesOnly, hashSystemPrompt } from '../conversation-hash.js'
import type { ClaudeMessage } from '../../types/index.js'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'

describe('ConversationLinker', () => {
  let linker: ConversationLinker
  let mockQueryExecutor: QueryExecutor
  let mockCompactSearchExecutor: CompactSearchExecutor
  let mockLogger: any

  beforeEach(() => {
    mockQueryExecutor = async (_criteria: ParentQueryCriteria) => {
      return []
    }

    mockCompactSearchExecutor = async (_trainId, _summaryContent, _beforeTimestamp) => {
      return null
    }

    // Create a no-op logger for tests
    mockLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }

    linker = new ConversationLinker(
      mockQueryExecutor,
      mockLogger,
      mockCompactSearchExecutor,
      undefined,
      undefined,
      undefined
    )
  })

  describe('linkConversation', () => {
    test('should handle single message without compact conversation', async () => {
      const request: LinkingRequest = {
        trainId: 'test.com',
        messages: [
          {
            role: 'user',
            content: 'Hello, how are you?',
          },
        ],
        systemPrompt: 'You are a helpful assistant',
        requestId: 'test-request-1',
        messageCount: 1,
      }

      const result = await linker.linkConversation(request)

      expect(result.conversationId).toBeNull()
      expect(result.parentRequestId).toBeNull()
      expect(result.branchId).toBe('main')
      expect(result.currentMessageHash).toBeTruthy()
      expect(result.parentMessageHash).toBeNull()
      expect(result.systemHash).toBeTruthy()
      // Single-message conversations can be potential sub-tasks
    })

    test('should handle single user message (potential sub-task)', async () => {
      const request: LinkingRequest = {
        trainId: 'test.com',
        messages: [
          {
            role: 'user',
            content: 'Analyze the security vulnerabilities in the authentication module',
          },
        ],
        systemPrompt: 'You are a helpful assistant',
        requestId: 'test-request-subtask',
        messageCount: 1,
      }

      const result = await linker.linkConversation(request)

      expect(result.conversationId).toBeNull()
      expect(result.parentRequestId).toBeNull()
      expect(result.branchId).toBe('main')
      // Single-message conversations are handled by the proxy service for sub-task detection
      expect(result.parentTaskRequestId).toBeUndefined()
      expect(result.isSubtask).toBeUndefined()
    })

    test('should handle single assistant message', async () => {
      const request: LinkingRequest = {
        trainId: 'test.com',
        messages: [
          {
            role: 'assistant',
            content: 'I can help with that analysis',
          },
        ],
        systemPrompt: 'You are a helpful assistant',
        requestId: 'test-assistant-message',
        messageCount: 1,
      }

      const result = await linker.linkConversation(request)

      // No special handling for non-user messages
      expect(result.conversationId).toBeNull()
      expect(result.parentRequestId).toBeNull()
    })

    test('should handle empty user message', async () => {
      const request: LinkingRequest = {
        trainId: 'test.com',
        messages: [
          {
            role: 'user',
            content: '   \n \t ',
          },
        ],
        systemPrompt: 'You are a helpful assistant',
        requestId: 'test-empty-message',
        messageCount: 1,
      }

      const result = await linker.linkConversation(request)

      // Empty messages are handled normally
      expect(result.conversationId).toBeNull()
      expect(result.parentRequestId).toBeNull()
    })

    test('should handle non-text content', async () => {
      const request: LinkingRequest = {
        trainId: 'test.com',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'base64data',
                },
              },
            ],
          },
        ],
        systemPrompt: 'You are a helpful assistant',
        requestId: 'test-image-only',
        messageCount: 1,
      }

      const result = await linker.linkConversation(request)

      // Non-text content is handled normally
      expect(result.conversationId).toBeNull()
      expect(result.parentRequestId).toBeNull()
    })

    test('should handle multi-message conversations', async () => {
      const request: LinkingRequest = {
        trainId: 'test.com',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
          { role: 'user', content: 'Can you help me?' },
        ],
        systemPrompt: 'You are a helpful assistant',
        requestId: 'test-multi-message',
        messageCount: 3,
      }

      const result = await linker.linkConversation(request)

      // Multi-message conversations are not potential sub-tasks
      expect(result.conversationId).toBeNull()
      expect(result.parentRequestId).toBeNull()
    })

    test('should detect compact conversation in single message', async () => {
      const request: LinkingRequest = {
        trainId: 'test.com',
        messages: [
          {
            role: 'user',
            content:
              'This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:\n\nUser asked about weather.\n\nPlease continue the conversation from where we left off.',
          },
        ],
        systemPrompt: 'You are a helpful assistant',
        requestId: 'test-request-2',
        messageCount: 1,
      }

      // Mock finding a parent for compact conversation
      mockCompactSearchExecutor = async (_trainId, summaryContent, _beforeTimestamp) => {
        if (summaryContent.toLowerCase().includes('user asked about weather')) {
          return {
            request_id: 'parent-request-1',
            conversation_id: 'conv-123',
            branch_id: 'main',
            current_message_hash: 'parent-hash',
            system_hash: 'system-hash',
          }
        }
        return null
      }
      linker = new ConversationLinker(
        mockQueryExecutor,
        mockLogger,
        mockCompactSearchExecutor,
        undefined,
        undefined,
        undefined
      )

      const result = await linker.linkConversation(request)

      expect(result.conversationId).toBe('conv-123')
      expect(result.parentRequestId).toBe('parent-request-1')
      expect(result.branchId).toMatch(/^compact_\d{6}$/)
      expect(result.parentMessageHash).toBe('parent-hash')
    })

    test('should compute parent hash for multiple messages', async () => {
      const request: LinkingRequest = {
        trainId: 'test.com',
        messages: [
          { role: 'user', content: 'What is the weather?' },
          { role: 'assistant', content: 'I can help with weather information.' },
          { role: 'user', content: 'Show me the forecast' },
        ],
        systemPrompt: 'You are a weather assistant',
        requestId: 'test-request-3',
        messageCount: 3,
      }

      const result = await linker.linkConversation(request)

      expect(result.currentMessageHash).toBeTruthy()
      expect(result.parentMessageHash).toBeTruthy()
      expect(result.systemHash).toBeTruthy()
    })

    test('should handle system prompt as array', async () => {
      const request: LinkingRequest = {
        trainId: 'test.com',
        messages: [{ role: 'user', content: 'Hello' }],
        systemPrompt: [
          { type: 'text', text: 'You are helpful' },
          { type: 'text', text: 'Be concise' },
        ],
        requestId: 'test-request-4',
        messageCount: 1,
      }

      const result = await linker.linkConversation(request)

      expect(result.systemHash).toBeTruthy()
    })

    test('should not allow empty messages', async () => {
      const request: LinkingRequest = {
        trainId: 'test.com',
        messages: [], // Empty messages should trigger error handling
        systemPrompt: 'You are helpful',
        requestId: 'test-request-5',
        messageCount: 0,
      }

      const promise = linker.linkConversation(request)

      await expect(promise).rejects.toThrow('Cannot compute hash for empty messages array')
    })
  })

  describe('Message content normalization', () => {
    test('should normalize string content', async () => {
      const request: LinkingRequest = {
        trainId: 'test.com',
        messages: [{ role: 'user', content: '  Hello world\r\n  ' }],
        systemPrompt: 'Test',
        requestId: 'test-1',
        messageCount: 1,
      }

      const result = await linker.linkConversation(request)
      expect(result.currentMessageHash).toBeTruthy()
    })

    test('should filter system reminders', async () => {
      const request: LinkingRequest = {
        trainId: 'test.com',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '<system-reminder>This is a reminder</system-reminder>' },
              { type: 'text', text: 'Actual user message' },
            ],
          },
        ],
        systemPrompt: 'Test',
        requestId: 'test-2',
        messageCount: 1,
      }

      const result = await linker.linkConversation(request)
      expect(result.currentMessageHash).toBeTruthy()
    })

    test('should deduplicate tool use and results', async () => {
      const request: LinkingRequest = {
        trainId: 'test.com',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tool-1', name: 'calculator', input: { a: 1 } },
              { type: 'tool_use', id: 'tool-1', name: 'calculator', input: { a: 1 } }, // Duplicate
              { type: 'tool_result', tool_use_id: 'tool-1', content: 'Result 1' },
              { type: 'tool_result', tool_use_id: 'tool-1', content: 'Result 1' }, // Duplicate
            ],
          },
        ],
        systemPrompt: 'Test',
        requestId: 'test-3',
        messageCount: 1,
      }

      const result = await linker.linkConversation(request)
      expect(result.currentMessageHash).toBeTruthy()
    })
  })

  describe('Priority-based parent matching', () => {
    test('should prioritize exact match with system hash', async () => {
      const messages = [
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Second' },
        { role: 'user', content: 'Third' },
      ]

      mockQueryExecutor = async criteria => {
        // Return a match when looking for parent
        if (criteria.currentMessageHash) {
          return [
            {
              request_id: 'exact-match',
              conversation_id: 'conv-exact',
              branch_id: 'main',
              current_message_hash: criteria.currentMessageHash as string,
              system_hash: 'expected-hash',
            },
          ]
        }
        return []
      }
      linker = new ConversationLinker(
        mockQueryExecutor,
        mockLogger,
        mockCompactSearchExecutor,
        undefined,
        undefined,
        undefined
      )

      const request: LinkingRequest = {
        trainId: 'test.com',
        messages,
        systemPrompt: 'Test system prompt',
        requestId: 'test-request',
        messageCount: 3,
      }

      const result = await linker.linkConversation(request)

      expect(result.conversationId).toBe('conv-exact')
      expect(result.parentRequestId).toBe('exact-match')
    })

    test('should ignore system hash for summarization requests', async () => {
      const messages = [
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Second' },
        { role: 'user', content: 'Third' },
      ]

      let queriedWithoutSystemHash = false
      mockQueryExecutor = async criteria => {
        if (criteria.systemHash === null) {
          queriedWithoutSystemHash = true
          return [
            {
              request_id: 'summarization-match',
              conversation_id: 'conv-summary',
              branch_id: 'main',
              current_message_hash: criteria.currentMessageHash as string,
              system_hash: null,
            },
          ]
        }
        return []
      }
      linker = new ConversationLinker(
        mockQueryExecutor,
        mockLogger,
        mockCompactSearchExecutor,
        undefined,
        undefined,
        undefined
      )

      const request: LinkingRequest = {
        trainId: 'test.com',
        messages,
        systemPrompt: 'You are a helpful AI assistant tasked with summarizing conversations',
        requestId: 'test-request',
        messageCount: 3,
      }

      const result = await linker.linkConversation(request)

      expect(queriedWithoutSystemHash).toBe(true)
      expect(result.conversationId).toBe('conv-summary')
    })
  })

  describe('Branch detection', () => {
    test('should create new branch when parent has existing children', async () => {
      const messages = [
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Second' },
        { role: 'user', content: 'Third' },
      ]

      let childrenQueried = false
      mockQueryExecutor = async criteria => {
        if (criteria.parentMessageHash) {
          childrenQueried = true
          // Return existing children
          return [
            {
              request_id: 'existing-child',
              conversation_id: 'conv-1',
              branch_id: 'main',
              current_message_hash: 'child-hash',
              system_hash: null,
            },
          ]
        } else if (criteria.currentMessageHash) {
          // Return parent match
          return [
            {
              request_id: 'parent-1',
              conversation_id: 'conv-1',
              branch_id: 'main',
              current_message_hash: criteria.currentMessageHash,
              system_hash: null,
            },
          ]
        }
        return []
      }
      linker = new ConversationLinker(
        mockQueryExecutor,
        mockLogger,
        mockCompactSearchExecutor,
        undefined,
        undefined,
        undefined
      )

      const request: LinkingRequest = {
        trainId: 'test.com',
        messages,
        systemPrompt: 'Test',
        requestId: 'test-request',
        messageCount: 3,
      }

      const result = await linker.linkConversation(request)

      expect(childrenQueried).toBe(true)
      expect(result.conversationId).toBe('conv-1')
      expect(result.branchId).toMatch(/^branch_\d+$/)
    })
  })
})

describe('ConversationLinker - JSON File Tests', () => {
  const fixturesDir = join(__dirname, 'fixtures', 'conversation-linking')

  test('should correctly link parent-child conversations from JSON fixtures', async () => {
    // Read all test files from fixtures directory
    let files: string[] = []
    try {
      files = await readdir(fixturesDir)
    } catch (_error) {
      // No fixtures directory found, skipping JSON file tests
      return
    }

    const jsonFiles = files.filter(f => f.endsWith('.json'))

    for (const file of jsonFiles) {
      const filePath = join(fixturesDir, file)
      const content = await readFile(filePath, 'utf-8')
      const testCase = JSON.parse(content)
      // Running test case from file

      // Compute the actual parent hash from parent messages before creating mocks
      let computedParentHash: string | null = null
      if (
        testCase.parent &&
        testCase.parent.body?.messages &&
        testCase.parent.body.messages.length > 0
      ) {
        // Create a temporary linker just to compute the hash
        const tempLinker = new ConversationLinker(
          async () => [],
          async () => null,
          undefined,
          undefined,
          undefined
        )
        computedParentHash = tempLinker.computeMessageHash(testCase.parent.body.messages)

        // Check if computed hash matches stored hash
        if (computedParentHash !== testCase.parent.current_message_hash) {
          // Hash mismatch in fixture - using computed hash for test
        }
      }

      // Use computed hash if available, otherwise fall back to stored hash
      const parentHashToUse = computedParentHash || testCase.parent?.current_message_hash

      // Create mock executors that return the parent when queried
      const mockQueryExecutor: QueryExecutor = async criteria => {
        // Skip normal parent linking for subtask test cases
        if (testCase.expectedParentTaskRequestId) {
          return []
        }

        // For normal linking, we look for parent by current_message_hash
        if (criteria.currentMessageHash && testCase.parent && parentHashToUse) {
          // The child is looking for a parent whose current_message_hash matches
          // the child's parent_message_hash (first N-2 messages)
          if (parentHashToUse === criteria.currentMessageHash) {
            return [
              {
                request_id: testCase.parent.request_id,
                conversation_id: testCase.parent.conversation_id,
                branch_id: testCase.parent.branch_id || 'main',
                current_message_hash: parentHashToUse,
                system_hash: testCase.parent.system_hash,
              },
            ]
          }
        }
        // For branch detection
        if (criteria.parentMessageHash && testCase.existingChild) {
          return [
            {
              request_id: testCase.existingChild.request_id,
              conversation_id: testCase.existingChild.conversation_id,
              branch_id: testCase.existingChild.branch_id,
              current_message_hash: testCase.existingChild.current_message_hash,
              system_hash: null,
            },
          ]
        }
        return []
      }

      const mockCompactSearchExecutor: CompactSearchExecutor = async (
        _trainId,
        summaryContent,
        _afterTimestamp,
        _beforeTimestamp
      ) => {
        // Skip compact search for subtask test cases
        if (testCase.expectedParentTaskRequestId) {
          return null
        }

        // Handle compact conversation cases if needed
        if (testCase.type === 'compact' && testCase.expectedSummaryContent && testCase.parent) {
          // For compact conversations, check if the summaries match after normalization
          // The ConversationLinker has already normalized the summaryContent it passes here
          if (
            summaryContent.startsWith(testCase.expectedSummaryContent) ||
            testCase.expectedSummaryContent.startsWith(summaryContent)
          ) {
            return {
              request_id: testCase.parent.request_id,
              conversation_id: testCase.parent.conversation_id,
              branch_id: testCase.parent.branch_id || 'main',
              current_message_hash: parentHashToUse || '',
              system_hash: testCase.parent.system_hash,
            }
          }
        }
        return null
      }

      // Create mock subtask executors if needed
      const mockRequestByIdExecutor: RequestByIdExecutor | undefined =
        testCase.expectedParentTaskRequestId
          ? async (requestId: string) => {
              if (requestId === testCase.expectedParentTaskRequestId) {
                return {
                  request_id: testCase.expectedParentTaskRequestId,
                  conversation_id: testCase.parent?.conversation_id || 'test-conversation',
                  branch_id: testCase.parent?.branch_id || 'main',
                  current_message_hash: testCase.parent?.current_message_hash || '',
                  system_hash: testCase.parent?.system_hash || null,
                }
              }
              return null
            }
          : undefined

      const mockSubtaskQueryExecutor: SubtaskQueryExecutor | undefined =
        testCase.expectedParentTaskRequestId
          ? async (
              _trainId: string,
              _timestamp: Date,
              _debugMode?: boolean,
              _subtaskPrompt?: string
            ) => {
              // Return a task invocation that matches the child message for subtask detection
              if (
                testCase.child.body.messages.length === 1 &&
                testCase.child.body.messages[0].role === 'user'
              ) {
                // Extract the actual user message content from the child
                const userMessage = testCase.child.body.messages[0]
                let promptText = ''

                if (typeof userMessage.content === 'string') {
                  promptText = userMessage.content
                } else if (Array.isArray(userMessage.content)) {
                  // Extract all non-system-reminder text content and join them
                  const textParts = userMessage.content
                    .filter(
                      item => item.type === 'text' && !item.text.startsWith('<system-reminder>')
                    )
                    .map(item => item.text)
                    .filter(text => text.trim().length > 0)

                  promptText = textParts.join('\n').trim()
                }

                // Return the task invocation that matches this prompt
                return [
                  {
                    requestId: testCase.expectedParentTaskRequestId,
                    toolUseId: 'test-tool-id',
                    prompt: promptText,
                    timestamp: new Date('2025-01-01T11:59:55Z'), // 5 seconds before the test timestamp
                  },
                ]
              }
              return undefined
            }
          : undefined

      const mockSubtaskSequenceQueryExecutor: SubtaskSequenceQueryExecutor | undefined =
        testCase.expectedParentTaskRequestId
          ? async () => 0 // Return 0 for base sequence
          : undefined

      // Create a no-op logger for this test
      const testLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const linker = new ConversationLinker(
        mockQueryExecutor,
        testLogger,
        mockCompactSearchExecutor,
        mockRequestByIdExecutor,
        mockSubtaskQueryExecutor,
        mockSubtaskSequenceQueryExecutor
      )

      // Extract messages from child request body
      const childMessages = testCase.child.body.messages
      const childSystemPrompt = testCase.child.body.system

      // Use a fixed timestamp for the test to ensure consistency
      const testTimestamp = new Date('2025-01-01T12:00:00Z')

      // Verify subtask has single message
      if (testCase.expectedParentTaskRequestId && childMessages.length > 1) {
        // Subtask test has multiple messages, expected 1
      }

      const request: LinkingRequest = {
        trainId: testCase.child.trainId ?? 'train-fixture',
        messages: childMessages,
        systemPrompt: childSystemPrompt,
        requestId: testCase.child.request_id,
        messageCount: childMessages.length,
        timestamp: testTimestamp, // Add timestamp for temporal awareness
      }

      const result = await linker.linkConversation(request)

      if (testCase.expectedParentTaskRequestId !== undefined) {
        // Check if parentTaskRequestId matches expected
        if (result.parentTaskRequestId !== testCase.expectedParentTaskRequestId) {
          // Test failure - parentTaskRequestId mismatch
        }
        expect(result.parentTaskRequestId).toBe(testCase.expectedParentTaskRequestId)
      }

      // Verify the linking worked correctly
      if (testCase.expectedLink && testCase.parent) {
        expect(result.conversationId).toBe(testCase.parent.conversation_id)
        expect(result.parentRequestId).toBe(testCase.parent.request_id)

        if (testCase.expectedBranchPattern) {
          expect(result.branchId).toMatch(new RegExp(testCase.expectedBranchPattern))
        } else if (testCase.expectedBranchId) {
          // If a specific branch ID is expected
          expect(result.branchId).toBe(testCase.expectedBranchId)
        } else if (!testCase.existingChild) {
          // If no branch pattern is expected and there's no existing child (no branching),
          // the branch should be the same as the parent's branch
          expect(result.branchId).toBe(testCase.parent.branch_id || 'main')
        }
      } else {
        // Should not link
        expect(result.conversationId).toBeNull()
        expect(result.parentRequestId).toBeNull()
      }
    }
  })
})

describe('Dual Hash System - Message and System Hashing', () => {
  describe('hashMessagesOnly', () => {
    test('should hash single message correctly', () => {
      const messages: ClaudeMessage[] = [{ role: 'user', content: 'Hello world' }]

      const hash = hashMessagesOnly(messages)
      expect(hash).toBeTruthy()
      expect(hash.length).toBe(64) // SHA-256 produces 64 hex characters
    })

    test('should produce consistent hash for same messages', () => {
      const messages: ClaudeMessage[] = [
        { role: 'user', content: 'What is the weather?' },
        { role: 'assistant', content: 'I can help with weather information.' },
      ]

      const hash1 = hashMessagesOnly(messages)
      const hash2 = hashMessagesOnly(messages)
      expect(hash1).toBe(hash2)
    })

    test('should produce different hash for different messages', () => {
      const messages1: ClaudeMessage[] = [{ role: 'user', content: 'Hello' }]
      const messages2: ClaudeMessage[] = [{ role: 'user', content: 'Hi' }]

      const hash1 = hashMessagesOnly(messages1)
      const hash2 = hashMessagesOnly(messages2)
      expect(hash1).not.toBe(hash2)
    })

    test('should normalize string and array content to same hash', () => {
      const messages1: ClaudeMessage[] = [{ role: 'user', content: 'Hello world' }]
      const messages2: ClaudeMessage[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hello world' }] },
      ]

      const hash1 = hashMessagesOnly(messages1)
      const hash2 = hashMessagesOnly(messages2)
      expect(hash1).toBe(hash2)
    })

    test('should filter out system reminder content', () => {
      const messagesWithReminder: ClaudeMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: '<system-reminder>This is a reminder</system-reminder>' },
            { type: 'text', text: 'Actual user message' },
          ],
        },
      ]
      const messagesWithoutReminder: ClaudeMessage[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Actual user message' }],
        },
      ]

      const hash1 = hashMessagesOnly(messagesWithReminder)
      const hash2 = hashMessagesOnly(messagesWithoutReminder)
      expect(hash1).toBe(hash2)
    })

    test('should deduplicate tool use messages', () => {
      const messagesWithDuplicates: ClaudeMessage[] = [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'calculator', input: { a: 1 } },
            { type: 'text', text: 'Using calculator' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'calculator', input: { a: 1 } },
            { type: 'text', text: 'Using calculator' },
          ],
        },
      ]
      const messagesWithoutDuplicates: ClaudeMessage[] = [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'calculator', input: { a: 1 } },
            { type: 'text', text: 'Using calculator' },
          ],
        },
      ]

      const hash1 = hashMessagesOnly(messagesWithDuplicates)
      const hash2 = hashMessagesOnly(messagesWithoutDuplicates)
      expect(hash1).toBe(hash2)
    })
  })

  describe('hashSystemPrompt', () => {
    test('should hash string system prompt', () => {
      const system = 'You are a helpful assistant'
      const hash = hashSystemPrompt(system)

      expect(hash).toBeTruthy()
      expect(hash).not.toBeNull()
      expect(hash?.length).toBe(64)
    })

    test('should hash array system prompt', () => {
      const system = [
        { type: 'text', text: 'You are a helpful assistant' },
        { type: 'text', text: 'Be concise' },
      ]
      const hash = hashSystemPrompt(system)

      expect(hash).toBeTruthy()
      expect(hash?.length).toBe(64)
    })

    test('should return null for undefined system', () => {
      const hash = hashSystemPrompt(undefined)
      expect(hash).toBeNull()
    })

    test('should return null for empty string system', () => {
      const hash = hashSystemPrompt('')
      expect(hash).toBeNull()
    })

    test('should produce consistent hash for same system prompt', () => {
      const system = 'You are a coding assistant'
      const hash1 = hashSystemPrompt(system)
      const hash2 = hashSystemPrompt(system)
      expect(hash1).toBe(hash2)
    })

    test('should produce different hash for different system prompts', () => {
      const system1 = 'You are a helpful assistant'
      const system2 = 'You are a coding assistant'
      const hash1 = hashSystemPrompt(system1)
      const hash2 = hashSystemPrompt(system2)
      expect(hash1).not.toBe(hash2)
    })

    test('should handle cache control in array system prompts', () => {
      const system = [
        {
          type: 'text',
          text: 'You are helpful',
          cache_control: { type: 'ephemeral' },
        },
      ]
      const hash = hashSystemPrompt(system)
      expect(hash).toBeTruthy()
    })
  })

  describe('hashConversationState with dual hash system', () => {
    test('should produce same hash regardless of system changes when using messages only', () => {
      const messages: ClaudeMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ]

      const hash1 = hashMessagesOnly(messages)
      const hash2 = hashMessagesOnly(messages)

      // Same messages should always produce same hash
      expect(hash1).toBe(hash2)

      // And this should be true even if we had different systems
      const system1 = 'You are a helpful assistant'
      const system2 = 'You are a helpful assistant with git status: modified'

      const sysHash1 = hashSystemPrompt(system1)
      const sysHash2 = hashSystemPrompt(system2)

      // System hashes should be different
      expect(sysHash1).not.toBe(sysHash2)

      // But message hashes remain the same
      const msgHash1 = hashMessagesOnly(messages)
      const msgHash2 = hashMessagesOnly(messages)
      expect(msgHash1).toBe(msgHash2)
    })
  })

  describe('Integration with ConversationLinker', () => {
    test('should properly separate system and message hashes in linking result', async () => {
      // Create a no-op logger for this test
      const testLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const linker = new ConversationLinker(
        async () => [], // mockQueryExecutor
        testLogger,
        async () => null, // mockCompactSearchExecutor
        undefined,
        undefined,
        undefined
      )

      const request: LinkingRequest = {
        trainId: 'test.com',
        messages: [
          { role: 'user', content: 'What is TypeScript?' },
          { role: 'assistant', content: 'TypeScript is a programming language.' },
          { role: 'user', content: 'Tell me more' },
        ],
        systemPrompt: 'You are a programming tutor',
        requestId: 'test-123',
        messageCount: 3,
      }

      const result = await linker.linkConversation(request)

      // Should have both message hash and system hash
      expect(result.currentMessageHash).toBeTruthy()
      expect(result.systemHash).toBeTruthy()

      // Verify system hash matches what we expect
      const expectedSystemHash = hashSystemPrompt('You are a programming tutor')
      expect(result.systemHash).toBe(expectedSystemHash)
    })

    test('should maintain conversation link when system prompt changes', async () => {
      let queryResults: ParentRequest[] = []

      // Create a no-op logger for this test
      const testLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const linker = new ConversationLinker(
        async criteria => {
          // Return our mock parent if searching by message hash
          if (criteria.currentMessageHash) {
            return queryResults
          }
          return []
        },
        testLogger,
        async () => null,
        undefined,
        undefined,
        undefined
      )

      // First request with original system prompt
      const messages1: ClaudeMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ]

      const request1: LinkingRequest = {
        trainId: 'test.com',
        messages: messages1,
        systemPrompt: 'You are helpful',
        requestId: 'req-1',
        messageCount: 2,
      }

      const result1 = await linker.linkConversation(request1)

      // Set up mock to return this as parent
      queryResults = [
        {
          request_id: 'req-1',
          conversation_id: 'conv-123',
          branch_id: 'main',
          current_message_hash: result1.currentMessageHash,
          system_hash: result1.systemHash,
        },
      ]

      // Second request with same messages but different system prompt
      const messages2: ClaudeMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
      ]

      const request2: LinkingRequest = {
        trainId: 'test.com',
        messages: messages2,
        systemPrompt: 'You are helpful. Git status: modified files', // Changed system
        requestId: 'req-2',
        messageCount: 3,
      }

      const result2 = await linker.linkConversation(request2)

      // Should link to same conversation despite system change
      expect(result2.conversationId).toBe('conv-123')
      expect(result2.parentRequestId).toBe('req-1')

      // But system hashes should be different
      expect(result2.systemHash).not.toBe(result1.systemHash)
    })
  })
})
