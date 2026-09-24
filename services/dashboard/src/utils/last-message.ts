import type { ConversationRequest } from '../types/conversation.js'

export type LastMessageType = 'user' | 'assistant' | 'tool_result'
export type ToolResultStatus = 'success' | 'error' | 'mixed'

export interface LastMessageClassification {
  hasUserMessage: boolean
  lastMessageType: LastMessageType
  toolResultStatus?: ToolResultStatus
}

/**
 * Classify a request's last message for the conversation tree
 * (works on full messages and on ADR-037 summaries alike).
 */
export function classifyLastMessage(lastMessage: any): LastMessageClassification {
  // Check if the last message in the request is a user message with text content
  let hasUserMessage = false
  if (lastMessage?.role === 'user') {
    if (typeof lastMessage.content === 'string') {
      hasUserMessage = lastMessage.content.trim().length > 0
    } else if (Array.isArray(lastMessage.content)) {
      hasUserMessage = lastMessage.content.some(
        (item: any) => item.type === 'text' && item.text && item.text.trim().length > 0
      )
    }
  }

  let lastMessageType: LastMessageType = 'assistant'
  let toolResultStatus: ToolResultStatus | undefined

  // Check if the last message in the request contains tool results
  if (lastMessage && lastMessage.content && Array.isArray(lastMessage.content)) {
    const toolResults = lastMessage.content.filter((item: any) => item.type === 'tool_result')

    if (toolResults.length > 0) {
      lastMessageType = 'tool_result'

      const hasError = toolResults.some((result: any) => result.is_error === true)
      const hasSuccess = toolResults.some((result: any) => result.is_error !== true)

      if (hasError && hasSuccess) {
        toolResultStatus = 'mixed'
      } else if (hasError) {
        toolResultStatus = 'error'
      } else {
        toolResultStatus = 'success'
      }
    }
  }

  // Override if last message is actually a user message
  if (hasUserMessage) {
    lastMessageType = 'user'
    toolResultStatus = undefined
  }

  return { hasUserMessage, lastMessageType, toolResultStatus }
}

/**
 * Helper to extract the last message content from a request
 */
export function getLastMessageContent(req: ConversationRequest): string {
  try {
    // Check if we have the optimized last_message field
    if (req.last_message) {
      const lastMessage = req.last_message

      // Handle the last message directly
      if (typeof lastMessage.content === 'string') {
        const content = lastMessage.content.trim()
        return content.length > 80 ? content.substring(0, 77) + '...' : content
      } else if (Array.isArray(lastMessage.content)) {
        for (const block of lastMessage.content) {
          if (block.type === 'text' && block.text) {
            const content = block.text.trim()
            return content.length > 80 ? content.substring(0, 77) + '...' : content
          } else if (block.type === 'tool_use' && block.name) {
            return `🔧 Tool: ${block.name}${block.input?.prompt ? ' - ' + block.input.prompt.substring(0, 50) + '...' : ''}`
          } else if (block.type === 'tool_result' && block.tool_use_id) {
            return `✅ Tool Result${block.content ? ': ' + (typeof block.content === 'string' ? block.content : JSON.stringify(block.content)).substring(0, 50) + '...' : ''}`
          }
        }
      }

      // Fallback to role-based description
      if (lastMessage.role === 'assistant') {
        return '🤖 Assistant response'
      } else if (lastMessage.role === 'user') {
        return '👤 User message'
      } else if (lastMessage.role === 'system') {
        return '⚙️ System message'
      }
    }

    // Legacy fallback for old data structure
    if (!req.body || !req.body.messages || !Array.isArray(req.body.messages)) {
      return 'Request ID: ' + req.request_id
    }

    const messages = req.body.messages
    if (messages.length === 0) {
      return 'Request ID: ' + req.request_id
    }

    // Get the last message
    const lastMessage = messages[messages.length - 1]

    // Handle different message formats
    if (typeof lastMessage.content === 'string') {
      // Simple string content
      const content = lastMessage.content.trim()
      return content.length > 80 ? content.substring(0, 77) + '...' : content
    } else if (Array.isArray(lastMessage.content)) {
      // Array of content blocks
      for (const block of lastMessage.content) {
        if (block.type === 'text' && block.text) {
          const content = block.text.trim()
          return content.length > 80 ? content.substring(0, 77) + '...' : content
        } else if (block.type === 'tool_use' && block.name) {
          return `🔧 Tool: ${block.name}${block.input?.prompt ? ' - ' + block.input.prompt.substring(0, 50) + '...' : ''}`
        } else if (block.type === 'tool_result' && block.tool_use_id) {
          return `✅ Tool Result${block.content ? ': ' + (typeof block.content === 'string' ? block.content : JSON.stringify(block.content)).substring(0, 50) + '...' : ''}`
        }
      }
    }

    // Fallback to role-based description
    if (lastMessage.role === 'assistant') {
      return '🤖 Assistant response'
    } else if (lastMessage.role === 'user') {
      return '👤 User message'
    } else if (lastMessage.role === 'system') {
      return '⚙️ System message'
    }

    return 'Request ID: ' + req.request_id
  } catch (_error) {
    return 'Request ID: ' + req.request_id
  }
}
