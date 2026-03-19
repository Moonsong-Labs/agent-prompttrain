import type { SystemContentBlock } from '../types/claude.js'

const MAX_SYSTEM_PROMPT_SIZE = 1024 * 1024 // 1MB

interface ValidationResult {
  valid: boolean
  error?: string
}

export function validateSystemPrompt(
  prompt: SystemContentBlock[] | null | undefined
): ValidationResult {
  if (prompt === null || prompt === undefined) {
    return { valid: true }
  }
  if (!Array.isArray(prompt)) {
    return { valid: false, error: 'System prompt must be an array' }
  }
  if (prompt.length === 0) {
    return { valid: true }
  }
  const jsonSize = JSON.stringify(prompt).length
  if (jsonSize > MAX_SYSTEM_PROMPT_SIZE) {
    return { valid: false, error: `System prompt exceeds 1MB limit (${jsonSize} bytes)` }
  }
  for (let i = 0; i < prompt.length; i++) {
    const block = prompt[i]
    if (!block || typeof block !== 'object') {
      return { valid: false, error: `Block ${i}: must be an object` }
    }
    if (block.type !== 'text') {
      return { valid: false, error: `Block ${i}: type must be "text"` }
    }
    if (typeof block.text !== 'string') {
      return { valid: false, error: `Block ${i}: text must be a string` }
    }
    if (block.cache_control !== undefined) {
      if (
        !block.cache_control ||
        typeof block.cache_control !== 'object' ||
        block.cache_control.type !== 'ephemeral'
      ) {
        return { valid: false, error: `Block ${i}: cache_control must be { type: "ephemeral" }` }
      }
    }
  }
  return { valid: true }
}
