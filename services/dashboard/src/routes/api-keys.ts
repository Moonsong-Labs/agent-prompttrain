import { Hono } from 'hono'
import { container } from '../container'
import {
  listTrainApiKeys,
  createTrainApiKey,
  revokeTrainApiKey,
  getTrainByTrainId,
} from '@agent-prompttrain/shared/database/queries'
import type { CreateApiKeyRequest } from '@agent-prompttrain/shared'

const apiKeys = new Hono()

// GET /api/trains/:trainId/api-keys - List train API keys
apiKeys.get('/:trainId/api-keys', async c => {
  try {
    const pool = container.getPool()

    const trainId = c.req.param('trainId')
    const train = await getTrainByTrainId(pool, trainId)

    if (!train) {
      return c.json({ error: 'Train not found' }, 404)
    }

    const keys = await listTrainApiKeys(pool, train.id)
    return c.json({ api_keys: keys })
  } catch (error) {
    console.error('Failed to list API keys:', error)
    return c.json({ error: 'Failed to list API keys' }, 500)
  }
})

// POST /api/trains/:trainId/api-keys - Generate new API key
apiKeys.post('/:trainId/api-keys', async c => {
  try {
    const pool = container.getPool()

    const trainId = c.req.param('trainId')
    const train = await getTrainByTrainId(pool, trainId)

    if (!train) {
      return c.json({ error: 'Train not found' }, 404)
    }

    const body = await c.req.json<CreateApiKeyRequest>()
    const generatedKey = await createTrainApiKey(pool, train.id, body)

    return c.json({ api_key: generatedKey }, 201)
  } catch (error) {
    console.error('Failed to create API key:', error)
    return c.json({ error: 'Failed to create API key' }, 500)
  }
})

// DELETE /api/trains/:trainId/api-keys/:keyId - Revoke API key
apiKeys.delete('/:trainId/api-keys/:keyId', async c => {
  try {
    const pool = container.getPool()

    const keyId = c.req.param('keyId')
    const success = await revokeTrainApiKey(pool, keyId)

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
