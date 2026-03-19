/**
 * TypeScript interfaces for Claude API types
 */

// Request types
export interface ClaudeMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | ClaudeContent[]
}

export interface ClaudeContent {
  type: 'text' | 'image' | 'tool_use' | 'tool_result'
  text?: string
  source?: {
    type: 'base64'
    media_type: string
    data: string
  }
  id?: string
  name?: string
  input?: any
  tool_use_id?: string
  content?: string | ClaudeContent[]
}

export interface ClaudeTool {
  name?: string
  description?: string
  input_schema?: {
    type?: 'object' | string
    properties?: Record<string, any>
    required?: string[]
    [key: string]: any // Allow any additional fields
  }
  [key: string]: any // Allow any additional fields at tool level
}

export interface SystemContentBlock {
  type: 'text'
  text: string
  cache_control?: {
    type: 'ephemeral'
  }
}

export interface ClaudeMessagesRequest {
  model: string
  messages: ClaudeMessage[]
  system?: string | SystemContentBlock[]
  max_tokens: number
  metadata?: {
    user_id?: string
  }
  stop_sequences?: string[]
  stream?: boolean
  temperature?: number
  top_k?: number
  top_p?: number
  tools?: ClaudeTool[]
  tool_choice?: {
    type: 'auto' | 'any' | 'tool'
    name?: string
  }
  thinking?: {
    budget_tokens?: number
    [key: string]: any // Allow any additional thinking fields
  }
  [key: string]: any // Allow any additional fields in the request
}

// Response types
export interface ClaudeMessagesResponse {
  id: string
  type: 'message'
  role: 'assistant'
  content: ClaudeContent[]
  model: string
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

// Streaming response types
export interface ClaudeStreamEvent {
  type:
    | 'message_start'
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'message_delta'
    | 'message_stop'
    | 'ping'
    | 'error'
  message?: ClaudeMessagesResponse
  index?: number
  content_block?: ClaudeContent
  delta?: {
    type?: 'text_delta' | 'input_json_delta'
    text?: string
    partial_json?: string
    stop_reason?: string
    stop_sequence?: string
  }
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  error?: {
    type: string
    message: string
  }
}

// Error response types
export interface ClaudeErrorResponse {
  error: {
    type: string
    message: string
  }
}

// Type guards
export function isClaudeError(response: any): response is ClaudeErrorResponse {
  return response && typeof response === 'object' && 'error' in response
}

export function isStreamEvent(data: any): data is ClaudeStreamEvent {
  return data && typeof data === 'object' && 'type' in data
}

export function hasToolUse(content: ClaudeContent[]): boolean {
  return content.some(c => c.type === 'tool_use')
}

// Request validation
export function validateClaudeRequest(request: any): request is ClaudeMessagesRequest {
  if (!request || typeof request !== 'object') {
    return false
  }

  // Required fields
  if (!request.model || typeof request.model !== 'string') {
    return false
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    return false
  }

  // Validate messages
  for (const message of request.messages) {
    if (!message.role || !['user', 'assistant', 'system'].includes(message.role)) {
      return false
    }
    if (!message.content && message.content !== '') {
      return false
    }
  }

  // Optional fields validation
  if (request.stream !== undefined && typeof request.stream !== 'boolean') {
    return false
  }
  if (
    request.temperature !== undefined &&
    (typeof request.temperature !== 'number' || request.temperature < 0 || request.temperature > 1)
  ) {
    return false
  }

  return true
}

// Helper to count system messages
export function countSystemMessages(request: ClaudeMessagesRequest): number {
  let count = 0

  // Handle system field - can be string or array
  if (request.system) {
    if (Array.isArray(request.system)) {
      count = request.system.length
    } else {
      count = 1
    }
  }

  // Add system messages from messages array
  count += request.messages.filter(m => m.role === 'system').length
  return count
}
