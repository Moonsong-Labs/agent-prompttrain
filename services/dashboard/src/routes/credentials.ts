import { Hono } from 'hono'
import { container } from '../container'
import {
  listCredentialsSafe,
  getCredentialSafeById,
} from '@agent-prompttrain/shared/database/queries'

const credentials = new Hono()

// GET /api/credentials - List all credentials (safe)
credentials.get('/', async c => {
  try {
    const pool = container.getPool()

    const creds = await listCredentialsSafe(pool)
    return c.json({ credentials: creds })
  } catch (error) {
    console.error('Failed to list credentials:', error)
    return c.json({ error: 'Failed to list credentials' }, 500)
  }
})

// GET /api/credentials/:id - Get credential details (safe)
credentials.get('/:id', async c => {
  try {
    const pool = container.getPool()

    const id = c.req.param('id')
    const credential = await getCredentialSafeById(pool, id)

    if (!credential) {
      return c.json({ error: 'Credential not found' }, 404)
    }

    return c.json({ credential })
  } catch (error) {
    console.error('Failed to get credential:', error)
    return c.json({ error: 'Failed to get credential' }, 500)
  }
})

export default credentials
