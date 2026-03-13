import { Hono } from 'hono'
import { container } from '../container'
import {
  listTrainApiKeys,
  createTrainApiKey,
  revokeTrainApiKey,
  updateTrainApiKeyName,
  getProjectByProjectId,
  getTrainApiKeySafe,
  isProjectOwner,
  isProjectMember,
  deleteTrainApiKey,
} from '@agent-prompttrain/shared/database/queries'
import type { CreateApiKeyRequest, UpdateApiKeyRequest } from '@agent-prompttrain/shared'
import type { AuthContext } from '../middleware/auth.js'

const apiKeys = new Hono<{ Variables: { auth: AuthContext } }>()

// GET /api/projects/:projectId/api-keys - List project API keys (members only, filtered by ownership)
apiKeys.get('/:projectId/api-keys', async c => {
  try {
    const pool = container.getPool()
    const auth = c.get('auth')

    if (!auth.isAuthenticated) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const projectId = c.req.param('projectId')
    const train = await getProjectByProjectId(pool, projectId)

    if (!train) {
      return c.json({ error: 'Project not found' }, 404)
    }

    // Check project membership
    const isMember = await isProjectMember(pool, train.id, auth.principal)
    if (!isMember) {
      return c.json({ error: 'Access denied: You are not a member of this project' }, 403)
    }

    // Check if user is project owner
    const isOwner = await isProjectOwner(pool, train.id, auth.principal)

    const allKeys = await listTrainApiKeys(pool, train.id)

    // Filter keys: owners see all, members only see their own
    const keys = isOwner ? allKeys : allKeys.filter(key => key.created_by === auth.principal)

    return c.json({ api_keys: keys })
  } catch (error) {
    console.error('Failed to list API keys:', error)
    return c.json({ error: 'Failed to list API keys' }, 500)
  }
})

// POST /api/projects/:projectId/api-keys - Generate new API key (members only)
apiKeys.post('/:projectId/api-keys', async c => {
  try {
    const pool = container.getPool()
    const auth = c.get('auth')

    if (!auth.isAuthenticated) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const projectId = c.req.param('projectId')
    const train = await getProjectByProjectId(pool, projectId)

    if (!train) {
      return c.json({ error: 'Project not found' }, 404)
    }

    // Check project membership
    const isMember = await isProjectMember(pool, train.id, auth.principal)
    if (!isMember) {
      return c.json({ error: 'Access denied: You are not a member of this project' }, 403)
    }

    const body = await c.req.json<CreateApiKeyRequest>()

    // Add creator to the request
    const generatedKey = await createTrainApiKey(pool, train.id, {
      ...body,
      created_by: auth.principal,
    })

    return c.json({ api_key: generatedKey }, 201)
  } catch (error) {
    console.error('Failed to create API key:', error)
    return c.json({ error: 'Failed to create API key' }, 500)
  }
})

// PATCH /api/projects/:projectId/api-keys/:keyId - Update API key name (owner or key creator only)
apiKeys.patch('/:projectId/api-keys/:keyId', async c => {
  try {
    const pool = container.getPool()
    const auth = c.get('auth')

    if (!auth.isAuthenticated) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const projectId = c.req.param('projectId')
    const keyId = c.req.param('keyId')

    const train = await getProjectByProjectId(pool, projectId)
    if (!train) {
      return c.json({ error: 'Project not found' }, 404)
    }

    // Check project membership
    const isMember = await isProjectMember(pool, train.id, auth.principal)
    if (!isMember) {
      return c.json({ error: 'Access denied: You are not a member of this project' }, 403)
    }

    // Get the API key to check ownership
    const apiKey = await getTrainApiKeySafe(pool, keyId)
    if (!apiKey) {
      return c.json({ error: 'API key not found' }, 404)
    }

    // Check if key belongs to this project
    if (apiKey.project_id !== train.id) {
      return c.json({ error: 'API key does not belong to this project' }, 403)
    }

    // Check if user is project owner OR key creator
    const isOwner = await isProjectOwner(pool, train.id, auth.principal)
    const isKeyCreator = apiKey.created_by === auth.principal

    if (!isOwner && !isKeyCreator) {
      return c.json(
        { error: 'Access denied: Only project owners or key creators can update API keys' },
        403
      )
    }

    const body = await c.req.json<UpdateApiKeyRequest>()

    // Reject un-revoking API keys
    if (body.revoked === false) {
      return c.json({ error: 'Un-revoking API keys is not supported' }, 400)
    }

    // Reject combined revoke + name update
    if (body.revoked === true && body.name !== undefined) {
      return c.json({ error: 'Cannot update name and revoke in the same request' }, 400)
    }

    // Handle revoke if requested
    if (body.revoked === true) {
      if (apiKey.revoked_at) {
        return c.json({ error: 'API key is already revoked' }, 400)
      }

      const success = await revokeTrainApiKey(pool, keyId, auth.principal)
      if (!success) {
        return c.json({ error: 'Failed to revoke API key' }, 500)
      }

      const updatedKey = await getTrainApiKeySafe(pool, keyId)
      return c.json({ api_key: updatedKey })
    }

    // Validate name if provided
    if (body.name !== undefined && body.name !== null && typeof body.name === 'string') {
      if (body.name.trim().length === 0) {
        body.name = null // Convert empty string to null
      } else if (body.name.length > 255) {
        return c.json({ error: 'Name must be 255 characters or less' }, 400)
      } else {
        body.name = body.name.trim() // Trim whitespace
      }
    }

    const success = await updateTrainApiKeyName(pool, keyId, body.name ?? null)

    if (!success) {
      return c.json({ error: 'API key not found or update failed' }, 404)
    }

    // Return the updated key
    const updatedKey = await getTrainApiKeySafe(pool, keyId)
    return c.json({ api_key: updatedKey })
  } catch (error) {
    console.error('Failed to update API key:', error)
    return c.json({ error: 'Failed to update API key' }, 500)
  }
})

// DELETE /api/projects/:projectId/api-keys/:keyId - Hard-delete a revoked API key (owner only)
apiKeys.delete('/:projectId/api-keys/:keyId', async c => {
  try {
    const pool = container.getPool()
    const auth = c.get('auth')

    if (!auth.isAuthenticated) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const projectId = c.req.param('projectId')
    const keyId = c.req.param('keyId')

    const train = await getProjectByProjectId(pool, projectId)
    if (!train) {
      return c.json({ error: 'Project not found' }, 404)
    }

    // Check project membership
    const isMember = await isProjectMember(pool, train.id, auth.principal)
    if (!isMember) {
      return c.json({ error: 'Access denied: You are not a member of this project' }, 403)
    }

    // Get the API key
    const apiKey = await getTrainApiKeySafe(pool, keyId)
    if (!apiKey) {
      return c.json({ error: 'API key not found' }, 404)
    }

    // Check if key belongs to this project
    if (apiKey.project_id !== train.id) {
      return c.json({ error: 'API key does not belong to this project' }, 403)
    }

    // Only project owners can hard-delete
    const isOwner = await isProjectOwner(pool, train.id, auth.principal)
    if (!isOwner) {
      return c.json({ error: 'Access denied: Only project owners can delete API keys' }, 403)
    }

    // Key must be revoked before it can be deleted
    if (!apiKey.revoked_at) {
      return c.json({ error: 'API key must be revoked before it can be deleted' }, 400)
    }

    const success = await deleteTrainApiKey(pool, keyId)

    if (!success) {
      return c.json({ error: 'Failed to delete API key' }, 500)
    }

    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to delete API key:', error)
    return c.json({ error: 'Failed to delete API key' }, 500)
  }
})

export default apiKeys
