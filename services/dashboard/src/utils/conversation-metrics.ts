/**
 * Utilities for calculating conversation metrics including tool execution times
 * and user reply times (excluding tool execution periods)
 */

import { hasVisibleText } from '@agent-prompttrain/shared'
import type { ConversationRequest } from '../types/conversation.js'

interface ToolExecution {
  toolUseRequestId: string
  toolResultRequestId: string
  toolUseTimestamp: Date
  toolResultTimestamp: Date
  durationMs: number
  toolName?: string
}

interface ReplyInterval {
  assistantRequestId: string
  userRequestId: string
  assistantTimestamp: Date
  userTimestamp: Date
  rawDurationMs: number
  toolExecutionMs: number
  netDurationMs: number
}

export interface ConversationMetrics {
  toolExecution: {
    totalMs: number
    averageMs: number
    count: number
    executions: ToolExecution[]
  }
  userReply: {
    totalMs: number
    averageMs: number
    count: number
    intervals: ReplyInterval[]
  }
  userInteractions: {
    count: number
    requests: string[]
  }
}

/**
 * Find tool execution pairs across requests
 * Counts tool_result messages in the last_message of each request
 * and pairs them with corresponding tool_use for timing
 */
function findToolExecutions(requests: ConversationRequest[]): ToolExecution[] {
  const executions: ToolExecution[] = []

  // Map to store tool uses by their ID
  const toolUseMap = new Map<string, { request: ConversationRequest; toolName: string }>()

  // First pass: collect all tool uses
  requests.forEach(request => {
    // Check response_body for tool uses
    if (request.response_body?.content && Array.isArray(request.response_body.content)) {
      request.response_body.content.forEach((item: any) => {
        if (item.type === 'tool_use' && item.id) {
          toolUseMap.set(item.id, {
            request: request,
            toolName: item.name || 'unknown',
          })
        }
      })
    }
  })

  // Second pass: find tool results in last_message or messages
  requests.forEach(request => {
    // Check last_message first (optimized field)
    const lastMessage =
      request.last_message ||
      (request.body?.messages &&
        Array.isArray(request.body.messages) &&
        request.body.messages[request.body.messages.length - 1])

    if (lastMessage?.role === 'user' && lastMessage.content && Array.isArray(lastMessage.content)) {
      lastMessage.content.forEach((item: any) => {
        if (item.type === 'tool_result' && item.tool_use_id) {
          const toolUseInfo = toolUseMap.get(item.tool_use_id)
          if (toolUseInfo) {
            // Simple calculation: tool_result timestamp - tool_use timestamp
            const toolUseTime = new Date(toolUseInfo.request.timestamp)
            const toolResultTime = new Date(request.timestamp)
            const durationMs = toolResultTime.getTime() - toolUseTime.getTime()

            // Only include if duration is positive (result after use)
            if (durationMs > 0) {
              executions.push({
                toolUseRequestId: toolUseInfo.request.request_id,
                toolResultRequestId: request.request_id,
                toolUseTimestamp: toolUseTime,
                toolResultTimestamp: toolResultTime,
                durationMs,
                toolName: toolUseInfo.toolName,
              })
            }
          } else {
            // Even if we can't find the matching tool_use, count this tool_result
            // This handles cases where tool_use might be from a different conversation/branch
            executions.push({
              toolUseRequestId: '',
              toolResultRequestId: request.request_id,
              toolUseTimestamp: new Date(request.timestamp),
              toolResultTimestamp: new Date(request.timestamp),
              durationMs: 0,
              toolName: 'unknown',
            })
          }
        }
      })
    }
  })

  return executions
}

/**
 * Find user reply intervals and calculate net duration excluding tool execution
 * Time to reply = time between assistant text response and next user text message
 * Only counts direct consecutive pairs to avoid overlapping intervals
 */
function findReplyIntervals(
  requests: ConversationRequest[],
  toolExecutions: ToolExecution[]
): ReplyInterval[] {
  const intervals: ReplyInterval[] = []
  let lastAssistantTextIndex = -1

  // Go through requests in order
  for (let i = 0; i < requests.length; i++) {
    const request = requests[i]

    // First check if this request has user content with visible text
    const lastMessage =
      request.last_message ||
      (request.body?.messages &&
        Array.isArray(request.body.messages) &&
        request.body.messages[request.body.messages.length - 1])

    if (lastMessage?.role === 'user' && hasVisibleText(lastMessage)) {
      // If we have a previous assistant text response, create an interval
      if (lastAssistantTextIndex >= 0 && lastAssistantTextIndex < i) {
        const assistantRequest = requests[lastAssistantTextIndex]
        const assistantTime = new Date(assistantRequest.timestamp)
        const userTime = new Date(request.timestamp)
        const rawDuration = userTime.getTime() - assistantTime.getTime()

        // Calculate tool execution time that overlaps this interval
        let toolExecutionMs = 0
        for (const exec of toolExecutions) {
          // Tool execution must start after assistant message and complete before user message
          if (exec.toolUseTimestamp >= assistantTime && exec.toolResultTimestamp <= userTime) {
            toolExecutionMs += exec.durationMs
          }
        }

        intervals.push({
          assistantRequestId: assistantRequest.request_id,
          userRequestId: request.request_id,
          assistantTimestamp: assistantTime,
          userTimestamp: userTime,
          rawDurationMs: rawDuration,
          toolExecutionMs,
          netDurationMs: rawDuration - toolExecutionMs,
        })

        // Reset so we don't pair this assistant response again
        lastAssistantTextIndex = -1
      }
    }

    // Then check if this request has an assistant response with visible text
    // Do this after user check to handle requests that have both
    if (request.response_body?.content && Array.isArray(request.response_body.content)) {
      const hasAssistantText = request.response_body.content.some(
        (item: any) => item.type === 'text' && item.text && item.text.trim().length > 0
      )

      if (hasAssistantText) {
        lastAssistantTextIndex = i
      }
    }
  }

  return intervals
}

/**
 * Count user interactions from messages in the last request
 */
function countUserInteractionsFromLastRequest(lastRequest: ConversationRequest): {
  count: number
  requests: string[]
} {
  const messages = lastRequest.body?.messages || []
  let userCount = 0

  // Count user messages with visible text
  for (const message of messages) {
    if (message.role === 'user' && hasVisibleText(message)) {
      userCount++
    }
  }

  return {
    count: userCount,
    requests: [], // We don't have individual request IDs from just the messages
  }
}

/**
 * Count user interactions (requests with user messages containing visible text)
 */
function countUserInteractions(requests: ConversationRequest[]): {
  count: number
  requests: string[]
} {
  // Find the last request per branch that carries either a precomputed count or a full body
  const lastRequestPerBranch = new Map<string, ConversationRequest>()

  for (const request of requests) {
    const branch = request.branch_id || 'main'
    if (
      (typeof request.user_text_message_count === 'number' || request.body?.messages) &&
      (!lastRequestPerBranch.has(branch) ||
        new Date(request.timestamp) > new Date(lastRequestPerBranch.get(branch)!.timestamp))
    ) {
      lastRequestPerBranch.set(branch, request)
    }
  }

  // Use the first branch's latest request (unchanged selection rule)
  if (lastRequestPerBranch.size > 0) {
    const lastRequest = Array.from(lastRequestPerBranch.values())[0]
    if (typeof lastRequest.user_text_message_count === 'number') {
      return { count: lastRequest.user_text_message_count, requests: [] }
    }
    return countUserInteractionsFromLastRequest(lastRequest)
  }

  // Fallback to old method if no full body available
  const userRequests: string[] = []

  for (const request of requests) {
    const messages = request.body?.messages || []
    const lastMessage = messages[messages.length - 1]

    // Count requests where the last message is from user and has visible text
    if (lastMessage?.role === 'user' && hasVisibleText(lastMessage)) {
      userRequests.push(request.request_id)
    }
  }

  return {
    count: userRequests.length,
    requests: userRequests,
  }
}

/**
 * Calculate conversation metrics for tool execution and user reply times
 */
export function calculateConversationMetrics(requests: ConversationRequest[]): ConversationMetrics {
  // Sort requests by timestamp
  const sortedRequests = [...requests].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  )

  // Find tool executions
  const toolExecutions = findToolExecutions(sortedRequests)

  // Find reply intervals
  const replyIntervals = findReplyIntervals(sortedRequests, toolExecutions)

  // Count user interactions
  const userInteractions = countUserInteractions(sortedRequests)

  // Calculate tool execution metrics
  const toolTotalMs = toolExecutions.reduce((sum, exec) => sum + exec.durationMs, 0)
  const toolCount = toolExecutions.length

  // Calculate user reply metrics (using net duration)
  const replyTotalMs = replyIntervals.reduce((sum, interval) => sum + interval.netDurationMs, 0)
  const replyCount = replyIntervals.length

  return {
    toolExecution: {
      totalMs: toolTotalMs,
      averageMs: toolCount > 0 ? toolTotalMs / toolCount : 0,
      count: toolCount,
      executions: toolExecutions,
    },
    userReply: {
      totalMs: replyTotalMs,
      averageMs: replyCount > 0 ? replyTotalMs / replyCount : 0,
      count: replyCount,
      intervals: replyIntervals,
    },
    userInteractions: userInteractions,
  }
}

/**
 * Format duration in milliseconds to human-readable string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`
  } else if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`
  } else if (ms < 3600000) {
    const minutes = Math.floor(ms / 60000)
    const seconds = Math.round((ms % 60000) / 1000)
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  } else {
    const hours = Math.floor(ms / 3600000)
    const minutes = Math.round((ms % 3600000) / 60000)
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }
}
