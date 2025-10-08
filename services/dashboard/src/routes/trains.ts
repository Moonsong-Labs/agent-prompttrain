import { Hono } from 'hono'
import { container } from '../container'
import {
  getTrainWithAccounts,
  createTrain,
  updateTrain,
  setTrainDefaultAccount,
  addTrainMember,
  getUserTrainsWithAccounts,
  deleteTrain,
} from '@agent-prompttrain/shared/database/queries'
import type { CreateTrainRequest, UpdateTrainRequest } from '@agent-prompttrain/shared'
import type { AuthContext } from '../middleware/auth.js'
import { requireTrainOwner, requireTrainMembership } from '../middleware/train-ownership.js'

const trains = new Hono<{ Variables: { auth: AuthContext } }>()

// GET /api/trains - List user's trains with accounts
trains.get('/', async c => {
  try {
    const pool = container.getPool()
    const auth = c.get('auth')

    const trainsList = await getUserTrainsWithAccounts(pool, auth.principal)
    return c.json({ trains: trainsList })
  } catch (error) {
    console.error('Failed to list trains:', error)
    return c.json({ error: 'Failed to list trains' }, 500)
  }
})

// GET /api/trains/:trainId - Get train details with accounts (member only)
trains.get('/:trainId', requireTrainMembership, async c => {
  try {
    const pool = container.getPool()

    const trainId = c.req.param('trainId')
    const train = await getTrainWithAccounts(pool, trainId)

    if (!train) {
      return c.json({ error: 'Train not found' }, 404)
    }

    return c.json({ train })
  } catch (error) {
    console.error('Failed to get train:', error)
    return c.json({ error: 'Failed to get train' }, 500)
  }
})

// POST /api/trains - Create new train
trains.post('/', async c => {
  const pool = container.getPool()
  const auth = c.get('auth')
  const client = await pool.connect()

  try {
    const body = await c.req.json<CreateTrainRequest>()

    // Create train and auto-assign creator as owner in a transaction
    await client.query('BEGIN')
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const train = await createTrain(client as any, body)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await addTrainMember(client as any, train.id, auth.principal, 'owner', auth.principal)
      await client.query('COMMIT')

      return c.json({ train }, 201)
    } catch (innerError) {
      await client.query('ROLLBACK')
      throw innerError
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    console.error('Failed to create train:', error)
    if (error.code === '23505') {
      // Unique violation
      return c.json({ error: 'Train ID already exists' }, 409)
    }
    return c.json({ error: 'Failed to create train' }, 500)
  } finally {
    client.release()
  }
})

// PUT /api/trains/:id - Update train (owner only)
trains.put('/:id', requireTrainOwner, async c => {
  try {
    const pool = container.getPool()

    const id = c.req.param('id')
    const body = await c.req.json<UpdateTrainRequest>()
    const train = await updateTrain(pool, id, body)

    return c.json({ train })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    console.error('Failed to update train:', error)
    if (error.message.includes('not found')) {
      return c.json({ error: 'Train not found' }, 404)
    }
    return c.json({ error: 'Failed to update train' }, 500)
  }
})

// PUT /api/trains/:id/default-account - Set default account (owner only)
trains.put('/:id/default-account', requireTrainOwner, async c => {
  try {
    const pool = container.getPool()

    const trainId = c.req.param('id')
    const { credential_id } = await c.req.json<{ credential_id: string }>()

    const train = await setTrainDefaultAccount(pool, trainId, credential_id)

    return c.json({ train })
  } catch (error) {
    console.error('Failed to set default account:', error)
    return c.json({ error: 'Failed to set default account' }, 500)
  }
})

// DELETE /api/trains/:id - Delete train (owner only)
trains.delete('/:id', requireTrainOwner, async c => {
  try {
    const pool = container.getPool()
    const id = c.req.param('id')

    const success = await deleteTrain(pool, id)

    if (!success) {
      return c.json({ error: 'Train not found' }, 404)
    }

    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to delete train:', error)
    return c.json({ error: 'Failed to delete train' }, 500)
  }
})

export default trains
