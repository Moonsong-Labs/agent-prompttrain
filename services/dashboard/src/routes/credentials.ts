import { Hono } from 'hono'
import { container } from '../container'
import { listCredentialsSafe } from '@agent-prompttrain/shared/database/queries'

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

export default credentials
