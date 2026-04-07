import type { Pool } from 'pg'
import type { ClaudeMessagesRequest, SystemContentBlock } from '@agent-prompttrain/shared'
import { getProjectSystemPrompt } from '@agent-prompttrain/shared/database/queries'
import { logger } from '../middleware/logger'

/**
 * Normalize the request's system field to an array of SystemContentBlock.
 * Claude API accepts both a string and an array of content blocks for the system field.
 */
function normalizeSystemToBlocks(system: ClaudeMessagesRequest['system']): SystemContentBlock[] {
  if (!system) {
    return []
  }
  if (typeof system === 'string') {
    return [{ type: 'text', text: system }]
  }
  return system as SystemContentBlock[]
}

/**
 * Apply project-level system prompt override to a request.
 * Mutates rawRequest.system if the project has an enabled, non-empty system prompt.
 * Must be called AFTER conversation tracking (which needs the original system)
 * and BEFORE forwarding to Claude API.
 *
 * Supports two modes:
 * - "replace": Replaces the entire system field with the project's system prompt (default)
 * - "prepend": Prepends the project's system prompt blocks before the original request blocks
 *
 * @returns true if a system prompt override was applied, false otherwise
 */
export async function applySystemPromptOverride(
  rawRequest: ClaudeMessagesRequest,
  projectId: string,
  pool: Pool
): Promise<boolean> {
  try {
    const config = await getProjectSystemPrompt(pool, projectId)
    if (!config || !config.enabled) {
      return false
    }
    if (!config.system_prompt || config.system_prompt.length === 0) {
      return false
    }

    const mode = config.mode || 'replace'

    logger.debug('Applying project system prompt override', {
      projectId,
      metadata: {
        mode,
        blockCount: config.system_prompt.length,
        hadOriginalSystem: !!rawRequest.system,
      },
    })

    if (mode === 'prepend') {
      const originalBlocks = normalizeSystemToBlocks(rawRequest.system)
      rawRequest.system = [...config.system_prompt, ...originalBlocks]
    } else {
      rawRequest.system = config.system_prompt
    }

    return true
  } catch (error) {
    logger.warn('Failed to apply system prompt override, using original', {
      projectId,
      metadata: {
        error: error instanceof Error ? error.message : String(error),
      },
    })
    return false
  }
}
