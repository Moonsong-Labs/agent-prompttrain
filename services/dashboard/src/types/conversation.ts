/**
 * Type definitions for conversation-related data
 */

export interface ConversationRequest {
  request_id: string
  timestamp: string
  branch_id?: string
  model: string
  total_tokens: number
  error?: any
  current_message_hash?: string
  parent_message_hash?: string
  request_tokens?: number
  response_tokens?: number
  duration?: number
  duration_ms?: number
  hasToolUse?: boolean
  hasToolResult?: boolean
  messageTypeSummary?: string[]
  message_count?: number
  parent_task_request_id?: string
  is_subtask?: boolean
  task_tool_invocation?: any
  parent_request_id?: string
  body?: any
  last_message?: any
  response_body?: any
  account_id?: string
}

export interface ConversationSummary {
  conversation_id: string
  message_count: number
  first_message: Date
  last_message: Date
  total_tokens: number
  branches: string[]
  requests: ConversationRequest[]
  trainId?: string
}

export interface ApiRequest extends ConversationRequest {
  trainId: string
  status_code?: number
  request_body?: any
  response_body?: any
  path?: string
  method?: string
  headers?: Record<string, string>
  input_tokens?: number
  output_tokens?: number
  request_type?: string
  tool_call_count?: number
  conversation_id?: string
}
