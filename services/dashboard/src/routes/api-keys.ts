import { Hono } from 'hono'
import { container } from '../container'
import {
  listTrainApiKeys,
  createTrainApiKey,
  revokeTrainApiKey,
  getProjectByProjectId,
  getTrainApiKeySafe,
  isProjectOwner,
  isTrainMember,
} from '@agent-prompttrain/shared/database/queries'
import type { CreateApiKeyRequest } from '@agent-prompttrain/shared'
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

    // Check train membership
    const isMember = await isTrainMember(pool, train.id, auth.principal)
    if (!isMember) {
      return c.json({ error: 'Access denied: You are not a member of this train' }, 403)
    }

    // Check if user is train owner
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

    // Check train membership
    const isMember = await isTrainMember(pool, train.id, auth.principal)
    if (!isMember) {
      return c.json({ error: 'Access denied: You are not a member of this train' }, 403)
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

// DELETE /api/projects/:projectId/api-keys/:keyId - Revoke API key (owner or key creator only)
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

    // Check train membership
    const isMember = await isTrainMember(pool, train.id, auth.principal)
    if (!isMember) {
      return c.json({ error: 'Access denied: You are not a member of this train' }, 403)
    }

    // Get the API key to check ownership
    const apiKey = await getTrainApiKeySafe(pool, keyId)
    if (!apiKey) {
      return c.json({ error: 'API key not found or already revoked' }, 404)
    }

    // Check if key belongs to this train
    if (apiKey.project_id !== train.id) {
      return c.json({ error: 'API key does not belong to this train' }, 403)
    }

    // Check if user is train owner OR key creator
    const isOwner = await isProjectOwner(pool, train.id, auth.principal)
    const isKeyCreator = apiKey.created_by === auth.principal

    if (!isOwner && !isKeyCreator) {
      return c.json(
        { error: 'Access denied: Only train owners or key creators can revoke API keys' },
        403
      )
    }

    const success = await revokeTrainApiKey(pool, keyId, auth.principal)

    if (!success) {
      return c.json({ error: 'API key not found or already revoked' }, 404)
    }

    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to revoke API key:', error)
    return c.json({ error: 'Failed to revoke API key' }, 500)
  }
})

export default apiKeys
