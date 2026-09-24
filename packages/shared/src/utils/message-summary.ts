/**
 * Compact summaries of Claude messages, computed when a request is stored so
 * read paths never decompress full request bodies (ADR-037).
 */

/** Characters kept per text-like field. Must stay above 81 so every downstream length decision is unchanged. */
export const SUMMARY_TEXT_LIMIT = 200

export interface SummaryBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: { prompt: string }
  tool_use_id?: string
  is_error?: boolean
  content?: string
}

export interface LastMessageSummary {
  role: string
  content?: string | SummaryBlock[] | null
}

/**
 * Clip to SUMMARY_TEXT_LIMIT UTF-16 code units without splitting a surrogate pair:
 * PostgreSQL rejects a lone high surrogate in JSONB, which would fail the whole INSERT.
 * At least SUMMARY_TEXT_LIMIT - 1 units remain, still above 81.
 */
function clip(value: string): string {
  const clipped = value.slice(0, SUMMARY_TEXT_LIMIT)
  const last = clipped.charCodeAt(clipped.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? clipped.slice(0, -1) : clipped
}

/**
 * Trim, then clip. Non-empty whitespace-only text becomes a single space so
 * truthiness checks downstream see the same value as with the original text.
 */
function clipText(value: string): string {
  const clipped = clip(value.trim())
  return clipped.length > 0 || value.length === 0 ? clipped : ' '
}

function summarizeBlock(block: any): SummaryBlock | null {
  if (!block || typeof block !== 'object' || typeof block.type !== 'string') {
    return null
  }

  switch (block.type) {
    case 'text':
      return typeof block.text === 'string'
        ? { type: 'text', text: clipText(block.text) }
        : { type: 'text' }
    case 'tool_result': {
      const summary: SummaryBlock = { type: 'tool_result' }
      if (block.tool_use_id !== undefined) {
        summary.tool_use_id = block.tool_use_id
      }
      if (block.is_error !== undefined) {
        summary.is_error = block.is_error
      }
      if (block.content) {
        const source =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
        summary.content = clip(source)
      }
      return summary
    }
    case 'tool_use': {
      const summary: SummaryBlock = { type: 'tool_use', id: block.id, name: block.name }
      const prompt = block.input?.prompt
      if (typeof prompt === 'string' && prompt.length > 0) {
        summary.input = { prompt: clip(prompt) }
      }
      return summary
    }
    default:
      // Images, documents and unknown blocks keep only their type - never their payload
      return { type: block.type }
  }
}

/**
 * Truncated copy of a message in the same shape as the original, so existing
 * consumers (tree node types, previews, tool metrics) work unchanged.
 */
export function summarizeLastMessage(message: unknown): LastMessageSummary | null {
  if (!message || typeof message !== 'object') {
    return null
  }

  const { role, content } = message as { role?: string; content?: unknown }
  const summary: LastMessageSummary = { role: role as string }

  if (typeof content === 'string') {
    summary.content = clipText(content)
  } else if (Array.isArray(content)) {
    summary.content = content
      .map(summarizeBlock)
      .filter((block): block is SummaryBlock => block !== null)
  } else if (content !== undefined) {
    summary.content = null
  }

  return summary
}

/** A message has visible text when it carries non-whitespace string content or text blocks. */
export function hasVisibleText(message: any): boolean {
  if (!message?.content) {
    return false
  }

  if (typeof message.content === 'string') {
    return message.content.trim().length > 0
  }

  return (
    Array.isArray(message.content) &&
    message.content.some(
      (item: any) =>
        item?.type === 'text' && typeof item.text === 'string' && item.text.trim().length > 0
    )
  )
}

/** Number of user messages with visible text, or null when there is no messages array. */
export function countUserTextMessages(messages: unknown): number | null {
  if (!Array.isArray(messages)) {
    return null
  }

  let count = 0
  for (const message of messages) {
    if (message?.role === 'user' && hasVisibleText(message)) {
      count++
    }
  }
  return count
}

/** Characters removed by String.prototype.trim(), as a regex bracket body. */
const JS_TRIM_WHITESPACE = String.raw`\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff`

/**
 * SQL equivalent of countUserTextMessages over `<bodyExpr> -> 'messages'`.
 * Yields NULL when messages is not an array. Requires standard_conforming_strings (the default).
 */
export function userTextMessageCountSql(bodyExpr = 'body'): string {
  const visible = `'[^${JS_TRIM_WHITESPACE}]'`
  return `(CASE WHEN jsonb_typeof(${bodyExpr} -> 'messages') = 'array' THEN (
    SELECT count(*)::int
    FROM jsonb_array_elements(${bodyExpr} -> 'messages') AS m(msg)
    WHERE msg ->> 'role' = 'user'
      AND (
        (jsonb_typeof(msg -> 'content') = 'string' AND (msg ->> 'content') ~ ${visible})
        OR (
          jsonb_typeof(msg -> 'content') = 'array'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(msg -> 'content') AS b(block)
            WHERE block ->> 'type' = 'text'
              AND jsonb_typeof(block -> 'text') = 'string'
              AND (block ->> 'text') ~ ${visible}
          )
        )
      )
  ) END)`
}
