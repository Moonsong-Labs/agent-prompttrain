import { describe, it, expect } from 'bun:test'
import { StorageWriter } from '../../services/proxy/src/storage/writer'
import mainRequestSample from '../data/inference_streaming_with_tools_with_system_opus-1750420376296-im7ygz453.json'
import subtaskRequestSample from '../data/inference_streaming_with_tools_with_system_opus-1750420386819-wixegs6ph.json'

describe('Sub-task Detection', () => {
  it('should detect Task tool invocations in response body', () => {
    // Create a mock writer to test the detection logic
    const writer = new StorageWriter(null as any) // We don't need a real pool for this test

    const taskInvocations = writer.findTaskToolInvocations(mainRequestSample.response.body)

    expect(taskInvocations).toHaveLength(1)
    expect(taskInvocations[0]).toEqual({
      id: 'toolu_01B95K5SLaSL1aSy59JQLWqC',
      name: 'Task',
      input: {
        description: 'Count code lines and folders',
        prompt: expect.stringContaining(
          'I need you to analyze the Agent Prompt Train repository structure'
        ),
      },
    })
  })

  it('should not detect Task invocations in responses without Task tools', () => {
    const writer = new StorageWriter(null as any)

    // Test with the sub-task response which shouldn't have Task invocations
    const taskInvocations = writer.findTaskToolInvocations(
      subtaskRequestSample.response?.body || {}
    )

    expect(taskInvocations).toHaveLength(0)
  })

  it('should verify timing relationship between main task and sub-task', () => {
    const mainTimestamp = new Date(mainRequestSample.timestamp)
    const subtaskTimestamp = new Date(subtaskRequestSample.timestamp)

    const timeDiffMs = subtaskTimestamp.getTime() - mainTimestamp.getTime()
    const timeDiffSeconds = timeDiffMs / 1000

    // Sub-task should start within 30 seconds of the main task
    expect(timeDiffSeconds).toBeGreaterThan(0)
    expect(timeDiffSeconds).toBeLessThan(30)

    // In this case, it should be around 10 seconds
    expect(timeDiffSeconds).toBeCloseTo(10.5, 1)
  })

  it('should match Task tool prompt with sub-task conversation prompt', () => {
    // Extract Task tool invocation from main request
    const taskTool = mainRequestSample.response.body.content.find(
      (item: any) => item.type === 'tool_use' && item.name === 'Task'
    )

    expect(taskTool).toBeDefined()
    expect(taskTool.input.prompt).toBeDefined()

    // Extract user prompt from sub-task (second content item after system reminder)
    const subtaskUserPrompt = subtaskRequestSample.body.messages[0].content[1].text

    // They should match exactly
    expect(subtaskUserPrompt).toBe(taskTool.input.prompt)
  })

  it('should have correct Task tool structure', () => {
    const taskTool = mainRequestSample.response.body.content.find(
      (item: any) => item.type === 'tool_use' && item.name === 'Task'
    )

    // Verify Task tool has required fields
    expect(taskTool).toMatchObject({
      type: 'tool_use',
      name: 'Task',
      id: expect.stringMatching(/^toolu_/),
      input: {
        description: expect.any(String),
        prompt: expect.any(String),
      },
    })
  })

  it('should verify response body contains full Claude API response structure', () => {
    const responseBody = mainRequestSample.response.body

    // Verify we're storing the complete response body, not just content
    expect(responseBody).toHaveProperty('id')
    expect(responseBody).toHaveProperty('type', 'message')
    expect(responseBody).toHaveProperty('role', 'assistant')
    expect(responseBody).toHaveProperty('content')
    expect(responseBody).toHaveProperty('model')
    expect(responseBody).toHaveProperty('stop_reason')
    expect(responseBody).toHaveProperty('usage')

    // Verify usage data is complete
    expect(responseBody.usage).toMatchObject({
      input_tokens: expect.any(Number),
      output_tokens: expect.any(Number),
    })

    // Note: total_tokens is calculated by the proxy, not part of Claude's response
    // But cache tokens are part of the response
    expect(responseBody.usage).toHaveProperty('cache_creation_input_tokens')
    expect(responseBody.usage).toHaveProperty('cache_read_input_tokens')
  })

  describe('Message Content Extraction', () => {
    it('should extract user content from array format messages skipping system reminders', () => {
      const writer = new StorageWriter(null as any)

      // Test with the subtask request which has array content
      const firstMessage = subtaskRequestSample.body.messages[0]
      const content = (writer as any).extractUserMessageContent(firstMessage)

      // The extraction should skip the system reminder and find the actual user prompt
      expect(content).toBe(subtaskRequestSample.body.messages[0].content[1].text)
      expect(content).toContain(
        'I need you to analyze the Agent Prompt Train repository structure'
      )
    })

    it('should extract user content from string format messages', () => {
      const writer = new StorageWriter(null as any)

      const stringMessage = {
        role: 'user',
        content: 'This is a simple string message',
      }

      const content = (writer as any).extractUserMessageContent(stringMessage)
      expect(content).toBe('This is a simple string message')
    })

    it('should return null for non-user messages', () => {
      const writer = new StorageWriter(null as any)

      const assistantMessage = {
        role: 'assistant',
        content: 'This is an assistant message',
      }

      const content = (writer as any).extractUserMessageContent(assistantMessage)
      expect(content).toBeNull()
    })
  })
})
