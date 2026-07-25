/**
 * Conversation hashing utilities
 *
 * IMPORTANT: ConversationLinker is the source of truth for message hashing.
 * This file only contains:
 * - hashSystemPrompt: Used by ConversationLinker for system prompt hashing
 * - hashMessagesOnly: Wrapper around ConversationLinker.computeMessageHash
 * - extractMessageHashes: Dual hash system for conversation tracking
 * - generateConversationId: UUID generation for new conversations
 *
 * Test-only functions have been moved to test-utilities/conversation-hash-test-utils.ts
 */

import { createHash } from 'crypto'
import type { ClaudeMessage } from '../types/claude.js'
import { stripSystemReminder } from './system-reminder.js'
import { ConversationLinker } from './conversation-linker.js'

// Note: hashMessage has been moved to test-utilities/conversation-hash-test-utils.ts
// Use ConversationLinker.computeMessageHash for production code

/**
 * Internal function for normalizing message content used by hashSystemPrompt
 * @private
 */
function normalizeMessageContent(content: string | any[]): string {
  if (typeof content === 'string') {
    // Normalize string content to match array format for consistency
    // This ensures "hello" and [{type: "text", text: "hello"}] produce the same hash
    return `[0]text:${content.trim().replace(/\r\n/g, '\n')}`
  }

  // For array content, create a deterministic string representation
  // Filter out system-reminder content items before processing
  const filteredContent = content.filter(item => {
    // Skip text items that contain system-reminder blocks
    if (item.type === 'text' && typeof item.text === 'string') {
      // If the entire text is just a system-reminder, filter it out
      const stripped = stripSystemReminder(item.text)
      return stripped.trim().length > 0
    }
    return true
  })

  // Deduplicate tool_use and tool_result items by their IDs
  const seenToolUseIds = new Set<string>()
  const seenToolResultIds = new Set<string>()
  const dedupedContent = filteredContent.filter(item => {
    if (item.type === 'tool_use' && item.id) {
      if (seenToolUseIds.has(item.id)) {
        return false // Skip duplicate
      }
      seenToolUseIds.add(item.id)
      return true
    }
    if (item.type === 'tool_result' && item.tool_use_id) {
      if (seenToolResultIds.has(item.tool_use_id)) {
        return false // Skip duplicate
      }
      seenToolResultIds.add(item.tool_use_id)
      return true
    }
    return true // Keep all other types
  })

  // DO NOT sort - preserve the original order as it's semantically important
  return dedupedContent
    .map((item, index) => {
      // Extract only the essential fields, ignoring cache_control and other metadata
      switch (item.type) {
        case 'text': {
          // Strip system-reminder blocks from text content before hashing
          const cleanText = stripSystemReminder(item.text || '')
          return `[${index}]text:${cleanText.trim().replace(/\r\n/g, '\n')}`
        }
        case 'image': {
          // For images, hash the data to avoid storing large base64 strings
          const imageHash = item.source?.data
            ? createHash('sha256').update(item.source.data).digest('hex')
            : 'no-data'
          return `[${index}]image:${item.source?.media_type || 'unknown'}:${imageHash}`
        }
        case 'tool_use':
          return `[${index}]tool_use:${item.name}:${item.id}:${JSON.stringify(item.input || {})}`
        case 'tool_result': {
          let resultContent =
            typeof item.content === 'string' ? item.content : JSON.stringify(item.content || [])
          // Remove system-reminder blocks from tool_result content
          if (typeof item.content === 'string') {
            resultContent = stripSystemReminder(item.content).trim()
          }
          return `[${index}]tool_result:${item.tool_use_id}:${resultContent}`
        }
        default: {
          // For unknown types, only include type and essential content
          const essentialItem = { type: item.type, content: item.content, text: item.text }
          return `[${index}]${item.type}:${JSON.stringify(essentialItem)}`
        }
      }
    })
    .join('|')
}

// Note: hashConversationState has been moved to test-utilities/conversation-hash-test-utils.ts
// Use ConversationLinker.computeMessageHash for production code

/**
 * Volatile prelude Claude Code prepends to the system prompt, e.g.
 * `x-anthropic-billing-header: cc_version=2.1.219.d53; cc_entrypoint=cli; ...`
 *
 * The `cc_version` changes with every Claude Code release, so leaving it in makes the
 * system hash churn mid-session and defeats the exact (message + system) parent match.
 */
const BILLING_HEADER_PATTERN = /^[ \t]*x-anthropic-billing-header:.*$/gim

/**
 * Stable opening lines of the Claude Code system prompts. Everything after the marker is
 * environment- and repo-specific (working directory, model name, git status), so the
 * marker alone is hashed - mirroring the long-standing behaviour for the original
 * "You are an interactive CLI tool..." prompt.
 */
const CLAUDE_CODE_PROMPT_MARKERS = [
  'You are an interactive CLI tool that helps users with software engineering tasks',
  "You are Claude Code, Anthropic's official CLI for Claude",
  "You are an agent for Claude Code, Anthropic's official CLI for Claude",
] as const

/**
 * Finds the Claude Code prompt marker the text starts with, if any.
 */
function matchClaudeCodePromptMarker(text: string): string | null {
  const trimmed = text.trim()
  return CLAUDE_CODE_PROMPT_MARKERS.find(marker => trimmed.startsWith(marker)) ?? null
}

/**
 * Removes transient/volatile context from system prompts to ensure stable hashing
 * @param systemPrompt - The system prompt content
 * @returns The stable part of the system prompt
 */
function getStableSystemPrompt(systemPrompt: string | any[]): string {
  if (typeof systemPrompt === 'string') {
    // Drop the billing header prelude before looking for the prompt marker - since
    // Claude Code 2.1 it is prepended ahead of the actual system prompt.
    const withoutBillingHeader = systemPrompt.replace(BILLING_HEADER_PATTERN, '')

    // Special case: If the system prompt starts with a known Claude Code prompt,
    // only include this stable snippet to avoid dynamic content differences
    const marker = matchClaudeCodePromptMarker(withoutBillingHeader)
    if (marker) {
      // Return just the stable prefix, ignoring all the dynamic content that follows
      return marker
    }

    let stable = withoutBillingHeader

    // Remove transient_context blocks (future-proofing)
    stable = stable.replace(/<transient_context>[\s\S]*?<\/transient_context>/g, '')

    // Remove system-reminder blocks
    stable = stripSystemReminder(stable)

    // Remove the git status section. Claude Code appends it last and it changes on
    // every commit, so everything from the marker onwards is dropped.
    stable = stable.replace(/gitStatus:[\s\S]*$/, '')

    // Remove standalone Status: sections that contain git information
    // This captures multi-line status blocks that contain file changes
    stable = stable.replace(/(?:^|\n)Status:\s*\n(?:[^\n]*\n)*?(?=\n\n|$)/gm, '\n')

    // Remove Current branch: lines
    stable = stable.replace(/(?:^|\n)Current branch:.*$/gm, '')

    // Remove Main branch: lines
    stable = stable.replace(/(?:^|\n)Main branch.*:.*$/gm, '')

    // Remove Recent commits: sections including the content
    stable = stable.replace(/(?:^|\n)Recent commits:.*\n(?:(?!^\n).*\n)*/gm, '\n')

    // Clean up multiple consecutive newlines
    stable = stable.replace(/\n{3,}/g, '\n\n')

    return stable.trim()
  }

  if (Array.isArray(systemPrompt)) {
    // Drop the volatile billing-header block (cc_version changes every release)
    const stableItems = systemPrompt.filter(
      item =>
        !(
          item?.type === 'text' &&
          typeof item.text === 'string' &&
          /^\s*x-anthropic-billing-header:/i.test(item.text)
        )
    )

    // If any block is a known Claude Code prompt, hash only that marker so the
    // environment-specific tail (cwd, model, git status) cannot churn the hash.
    for (const item of stableItems) {
      if (item?.type !== 'text' || typeof item.text !== 'string') {
        continue
      }
      const marker = matchClaudeCodePromptMarker(item.text)
      if (marker) {
        return normalizeMessageContent([{ type: 'text', text: marker }])
      }
    }

    // No Claude Code prompt - apply normalization which already filters system-reminders
    return normalizeMessageContent(stableItems)
  }

  return normalizeMessageContent(systemPrompt)
}

// Note: hashConversationStateWithSystem has been moved to test-utilities/conversation-hash-test-utils.ts
// Use ConversationLinker for production code

/**
 * Hashes only the messages without system prompt
 * @param messages - Array of messages
 * @returns A hash representing the messages only
 */
export function hashMessagesOnly(messages: ClaudeMessage[]): string {
  // Create a no-op logger for hash computation
  const mockLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }

  // Use ConversationLinker as the source of truth for hashing
  const linker = new ConversationLinker(
    async () => [], // Dummy query executor - we only need the hash method
    mockLogger,
    async () => null, // Dummy compact search executor
    undefined, // requestByIdExecutor
    undefined, // subtaskQueryExecutor
    undefined // subtaskSequenceQueryExecutor
  )
  return linker.computeMessageHash(messages)
}

/**
 * Hashes only the system prompt
 * @param system - System prompt (string or array of content blocks)
 * @returns A hash of the system prompt or null if no system
 */
export function hashSystemPrompt(system?: string | any[]): string | null {
  if (!system) {
    return null
  }

  const stableSystemContent = getStableSystemPrompt(system)
  if (!stableSystemContent) {
    return null
  }

  return createHash('sha256').update(stableSystemContent, 'utf8').digest('hex')
}

/**
 * Extracts the current and parent conversation state hashes (dual hash system)
 *
 * For Claude conversations, we need to handle the pattern where:
 * - First request: [user_msg]
 * - Second request: [user_msg, assistant_response, user_msg2]
 * - Third request: [user_msg, assistant_response, user_msg2, assistant_response2, user_msg3]
 *
 * To find the parent, we look for a request whose full message list matches
 * a prefix of our current messages (excluding the last 2 messages - the latest exchange)
 *
 * NEW: Returns separate hashes for messages and system to enable conversation linking
 * that survives system prompt changes
 *
 * @param messages - Array of messages from the request
 * @param system - Optional system prompt (string or array of content blocks)
 * @returns Object containing message hashes and system hash
 */
export function extractMessageHashes(
  messages: ClaudeMessage[],
  system?: string | any[]
): {
  currentMessageHash: string
  parentMessageHash: string | null
  systemHash: string | null
} {
  if (!messages || messages.length === 0) {
    throw new Error('Cannot extract hashes from empty messages array')
  }

  // Injected `role: 'system'` messages are ephemeral and must not shift the
  // parent-hash offsets - see ConversationLinker.filterConversationMessages
  const conversationMessages = ConversationLinker.filterConversationMessages(messages)

  if (conversationMessages.length === 0) {
    throw new Error('Cannot extract hashes from empty messages array')
  }

  // Hash messages only (no system) for conversation linking
  const currentMessageHash = hashMessagesOnly(conversationMessages)

  // Hash system separately for tracking context changes
  const systemHash = hashSystemPrompt(system)

  // For parent hash, we need to find the previous request state
  // If we have 3+ messages, the parent likely had all messages except the last 2 (user + assistant)
  // If we have 1-2 messages, this is likely a new conversation
  let parentMessageHash: string | null = null

  if (conversationMessages.length === 1) {
    // First message in conversation, no parent
    parentMessageHash = null
  } else if (conversationMessages.length === 2) {
    // This shouldn't happen in normal Claude conversations (should be user -> assistant -> user)
    // But handle it anyway - parent would be first message only
    parentMessageHash = hashMessagesOnly(conversationMessages.slice(0, 1))
  } else {
    // Normal case: we have at least 3 messages
    // The parent request would have had all messages except the last 2
    // (removing the most recent user message and the assistant response before it)
    parentMessageHash = hashMessagesOnly(conversationMessages.slice(0, -2))
  }

  return { currentMessageHash, parentMessageHash, systemHash }
}

// Note: extractMessageHashesLegacy has been moved to test-utilities/conversation-hash-test-utils.ts
// Use extractMessageHashes for the dual hash system

/**
 * Generates a new conversation ID
 * Uses crypto.randomUUID for a v4 UUID
 */
export function generateConversationId(): string {
  return crypto.randomUUID()
}
