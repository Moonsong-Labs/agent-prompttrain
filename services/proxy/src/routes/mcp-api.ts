/**
 * REST API endpoints for MCP dashboard functionality
 */

import { Hono } from 'hono'
import type { PromptRegistryService } from '../mcp/PromptRegistryService.js'
import type { GitHubSyncService } from '../mcp/GitHubSyncService.js'
import type { SyncScheduler } from '../mcp/SyncScheduler.js'
import { logger } from '../middleware/logger.js'
import { getErrorMessage, getErrorStack, getErrorCode } from '@agent-prompttrain/shared'

export function createMcpApiRoutes(
  promptRegistry: PromptRegistryService,
  syncService: GitHubSyncService | null,
  syncScheduler: SyncScheduler | null
) {
  const mcpApi = new Hono()

  // List prompts with filtering
  mcpApi.get('/prompts', async c => {
    const search = c.req.query('search')?.toLowerCase()

    try {
      let prompts = promptRegistry.listPrompts()

      // Simple search filter
      if (search) {
        prompts = prompts.filter(
          p =>
            p.name.toLowerCase().includes(search) ||
            p.description?.toLowerCase().includes(search) ||
            p.promptId.toLowerCase().includes(search)
        )
      }

      return c.json({
        prompts,
        total: prompts.length,
      })
    } catch (error) {
      logger.error('Error listing prompts', {
        error: {
          message: getErrorMessage(error),
          stack: getErrorStack(error),
          code: getErrorCode(error),
        },
      })
      return c.json({ error: 'Failed to list prompts' }, 500)
    }
  })

  // Get prompt details
  mcpApi.get('/prompts/:id', async c => {
    const promptId = c.req.param('id')

    try {
      const prompt = promptRegistry.getPrompt(promptId)

      if (!prompt) {
        return c.json({ error: 'Prompt not found' }, 404)
      }

      // No stats in the new system
      return c.json({ prompt })
    } catch (error) {
      logger.error('Error getting prompt', {
        error: {
          message: getErrorMessage(error),
          stack: getErrorStack(error),
          code: getErrorCode(error),
        },
        metadata: {
          promptId,
        },
      })
      return c.json({ error: 'Failed to get prompt' }, 500)
    }
  })

  // Trigger manual sync
  mcpApi.post('/sync', async c => {
    if (!syncScheduler) {
      return c.json({ error: 'GitHub sync not configured' }, 501)
    }

    try {
      await syncScheduler.triggerSync()
      return c.json({ message: 'Sync triggered successfully' })
    } catch (error) {
      logger.error('Error triggering sync', {
        error: {
          message: getErrorMessage(error),
          stack: getErrorStack(error),
          code: getErrorCode(error),
        },
      })
      const message = error instanceof Error ? error.message : 'Failed to trigger sync'
      return c.json({ error: message }, 500)
    }
  })

  // Get sync status
  mcpApi.get('/sync/status', async c => {
    if (!syncService) {
      return c.json({
        repository: null,
        branch: null,
        sync_status: 'not_configured',
        last_sync_at: null,
        last_commit_sha: null,
        last_error: 'GitHub sync service not configured',
      })
    }

    try {
      const status = await syncService.getSyncStatus()
      return c.json(
        status || {
          repository: null,
          branch: null,
          sync_status: 'never_synced',
          last_sync_at: null,
          last_commit_sha: null,
          last_error: null,
        }
      )
    } catch (error) {
      logger.error('Error getting sync status', {
        error: {
          message: getErrorMessage(error),
          stack: getErrorStack(error),
          code: getErrorCode(error),
        },
      })
      return c.json({ error: 'Failed to get sync status' }, 500)
    }
  })

  return mcpApi
}
