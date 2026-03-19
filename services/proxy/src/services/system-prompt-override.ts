import type { Pool } from 'pg'
import type { ClaudeMessagesRequest } from '@agent-prompttrain/shared'
import { getProjectSystemPrompt } from '@agent-prompttrain/shared/database/queries'
import { logger } from '../middleware/logger'

/**
 * Apply project-level system prompt override to a request.
 * Mutates rawRequest.system if the project has an enabled, non-empty system prompt.
 * Must be called AFTER conversation tracking (which needs the original system)
 * and BEFORE forwarding to Claude API.
 */
export async function applySystemPromptOverride(
  rawRequest: ClaudeMessagesRequest,
  projectId: string,
  pool: Pool
): Promise<void> {
  try {
    const config = await getProjectSystemPrompt(pool, projectId)
    if (!config || !config.enabled) {
      return
    }
    if (!config.system_prompt || config.system_prompt.length === 0) {
      return
    }

    logger.debug('Applying project system prompt override', {
      projectId,
      metadata: {
        blockCount: config.system_prompt.length,
        hadOriginalSystem: !!rawRequest.system,
      },
    })

    rawRequest.system = config.system_prompt
  } catch (error) {
    logger.warn('Failed to apply system prompt override, using original', {
      projectId,
      metadata: {
        error: error instanceof Error ? error.message : String(error),
      },
    })
  }
}
