import { describe, test, expect, beforeEach } from 'bun:test'
import { ConversationLinker, type LinkingRequest } from '../conversation-linker'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'

// Simulates the proxy service's subtask linking logic
interface TaskInvocation {
  request_id: string
  tool_use_id: string
  prompt: string
  timestamp: Date
}

interface SubtaskLinkingResult {
  isSubtask?: boolean
  parentTaskRequestId?: string
}

class SubtaskLinker {
  private taskInvocations: TaskInvocation[] = []
  private conversationLinker: ConversationLinker

  constructor() {
    // Create a no-op logger for tests
    const mockLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }

    this.conversationLinker = new ConversationLinker(
      async () => [],
      mockLogger,
      async () => null,
      undefined,
      undefined,
      undefined
    )
  }

  // Simulate storing Task tool invocations (what proxy does when processing responses)
  storeTaskInvocation(invocation: TaskInvocation) {
    this.taskInvocations.push(invocation)
  }

  // Simulate the full subtask linking process
  async linkSubtask(request: LinkingRequest): Promise<SubtaskLinkingResult> {
    // Phase 1: ConversationLinker detection
    const _linkingResult = await this.conversationLinker.linkConversation(request)

    // If not a single-message conversation, return early
    if (request.messageCount !== 1) {
      return {}
    }

    // Phase 2: Match against Task invocations (proxy service logic)
    const userMessage = request.messages[0]?.content
    let messageText: string | null = null

    if (typeof userMessage === 'string') {
      messageText = userMessage
    } else if (Array.isArray(userMessage)) {
      // Extract text from content array, filtering out system reminders
      const textContent = userMessage.find(
        item => item.type === 'text' && !item.text.startsWith('<system-reminder>')
      )
      messageText = textContent?.text || null
    }

    if (!messageText) {
      return {
        isSubtask: false,
      }
    }

    // Find matching task invocation within time window (30 seconds)
    const now = request.timestamp || new Date()
    const timeWindowStart = new Date(now.getTime() - 30000)

    const matchingTask = this.taskInvocations.find(
      task =>
        task.prompt === messageText && task.timestamp >= timeWindowStart && task.timestamp <= now
    )

    if (matchingTask) {
      return {
        isSubtask: true,
        parentTaskRequestId: matchingTask.request_id,
      }
    }

    return {
      isSubtask: false,
    }
  }
}

describe('SubtaskLinker', () => {
  let linker: SubtaskLinker

  beforeEach(() => {
    linker = new SubtaskLinker()
  })

  describe('Basic subtask detection', () => {
    test('should detect and link a matching subtask', async () => {
      // Simulate a Task tool invocation
      const parentRequestId = 'parent-123'
      const taskPrompt = 'Analyze the security vulnerabilities in the authentication module'
      const invocationTime = new Date()

      linker.storeTaskInvocation({
        request_id: parentRequestId,
        tool_use_id: 'tool-456',
        prompt: taskPrompt,
        timestamp: invocationTime,
      })

      // Simulate a new conversation with matching prompt
      const request: LinkingRequest = {
        projectId: 'test.com',
        messages: [
          {
            role: 'user',
            content: taskPrompt,
          },
        ],
        systemPrompt: 'You are a helpful assistant',
        requestId: 'subtask-789',
        messageCount: 1,
        timestamp: new Date(invocationTime.getTime() + 5000), // 5 seconds later
      }

      const result = await linker.linkSubtask(request)

      expect(result.isSubtask).toBe(true)
      expect(result.parentTaskRequestId).toBe(parentRequestId)
    })

    test('should not link if prompt does not match', async () => {
      // Store a different task
      linker.storeTaskInvocation({
        request_id: 'parent-123',
        tool_use_id: 'tool-456',
        prompt: 'Different task',
        timestamp: new Date(),
      })

      const request: LinkingRequest = {
        projectId: 'test.com',
        messages: [
          {
            role: 'user',
            content: 'Analyze the security vulnerabilities',
          },
        ],
        systemPrompt: 'You are a helpful assistant',
        requestId: 'subtask-789',
        messageCount: 1,
      }

      const result = await linker.linkSubtask(request)

      expect(result.isSubtask).toBe(false)
      expect(result.parentTaskRequestId).toBeUndefined()
    })

    test('should not link if outside time window', async () => {
      const taskPrompt = 'Analyze the security vulnerabilities'
      const oldTime = new Date(Date.now() - 60000) // 1 minute ago

      linker.storeTaskInvocation({
        request_id: 'parent-123',
        tool_use_id: 'tool-456',
        prompt: taskPrompt,
        timestamp: oldTime,
      })

      const request: LinkingRequest = {
        projectId: 'test.com',
        messages: [
          {
            role: 'user',
            content: taskPrompt,
          },
        ],
        systemPrompt: 'You are a helpful assistant',
        requestId: 'subtask-789',
        messageCount: 1,
        timestamp: new Date(),
      }

      const result = await linker.linkSubtask(request)

      expect(result.isSubtask).toBe(false)
    })

    test('should not detect subtask for multi-message conversation', async () => {
      const request: LinkingRequest = {
        projectId: 'test.com',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi!' },
          { role: 'user', content: 'Analyze something' },
        ],
        systemPrompt: 'You are a helpful assistant',
        requestId: 'test-123',
        messageCount: 3,
      }

      const result = await linker.linkSubtask(request)

      // Multi-message conversations are not checked for subtasks
      expect(result.isSubtask).toBeUndefined()
    })
  })
})

// JSON Fixture Tests
describe('SubtaskLinker - JSON Fixture Tests', () => {
  const fixturesDir = join(__dirname, 'fixtures', 'subtask-linking')

  test('should correctly handle subtask fixtures', async () => {
    // Read all test files from fixtures directory
    let files: string[] = []
    try {
      files = await readdir(fixturesDir)
    } catch (_error) {
      // No fixtures directory found, skipping JSON file tests
      // No subtask fixtures directory found
      return
    }

    const jsonFiles = files.filter(f => f.endsWith('.json'))

    for (const file of jsonFiles) {
      const filePath = join(fixturesDir, file)
      const content = await readFile(filePath, 'utf-8')
      const testCase = JSON.parse(content)

      const linker = new SubtaskLinker()

      // If parent exists with Task invocations, store them
      if (testCase.parent?.task_invocations) {
        for (const invocation of testCase.parent.task_invocations) {
          linker.storeTaskInvocation({
            request_id: testCase.parent.request_id,
            tool_use_id: invocation.tool_use_id,
            prompt: invocation.prompt,
            timestamp: new Date(invocation.timestamp || testCase.parent.timestamp),
          })
        }
      } else if (testCase.parent?.response_body?.content) {
        // Alternative: Extract Task invocations from response body
        for (const content of testCase.parent.response_body.content) {
          if (content.type === 'tool_use' && content.name === 'Task') {
            const invocation = {
              request_id: testCase.parent.request_id,
              tool_use_id: content.id,
              prompt: content.input.prompt,
              timestamp: testCase.parent.timestamp
                ? new Date(testCase.parent.timestamp)
                : new Date(),
            }
            linker.storeTaskInvocation(invocation)
          }
        }
      }

      // Process the child request
      const childMessages = testCase.child.body.messages
      const childSystemPrompt = testCase.child.body.system

      const request: LinkingRequest = {
        projectId: testCase.child.projectId ?? 'train-fixture',
        messages: childMessages,
        systemPrompt: childSystemPrompt,
        requestId: testCase.child.request_id,
        messageCount: childMessages.length,
        timestamp: testCase.child.timestamp ? new Date(testCase.child.timestamp) : new Date(),
      }

      const result = await linker.linkSubtask(request)

      // Verify expectations
      if (testCase.expectedIsSubtask !== undefined) {
        expect(result.isSubtask).toBe(testCase.expectedIsSubtask)
      }

      if (testCase.expectedParentTaskRequestId !== undefined) {
        expect(result.parentTaskRequestId).toBe(testCase.expectedParentTaskRequestId)
      }

      // Test passed
    }
  })
})
