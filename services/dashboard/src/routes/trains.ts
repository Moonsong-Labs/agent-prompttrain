import { Hono } from 'hono'
import { container } from '../container'
import {
  listTrainsWithAccounts,
  getTrainWithAccounts,
  createTrain,
  updateTrain,
  linkAccountToTrain,
  unlinkAccountFromTrain,
} from '@agent-prompttrain/shared/database/queries'
import type { CreateTrainRequest, UpdateTrainRequest } from '@agent-prompttrain/shared'

const trains = new Hono()

// GET /api/trains - List all trains with accounts
trains.get('/', async c => {
  try {
    const pool = container.getPool()

    const trainsList = await listTrainsWithAccounts(pool)
    return c.json({ trains: trainsList })
  } catch (error) {
    console.error('Failed to list trains:', error)
    return c.json({ error: 'Failed to list trains' }, 500)
  }
})

// GET /api/trains/:trainId - Get train details with accounts
trains.get('/:trainId', async c => {
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
  try {
    const pool = container.getPool()

    const body = await c.req.json<CreateTrainRequest>()
    const train = await createTrain(pool, body)

    return c.json({ train }, 201)
  } catch (error: any) {
    console.error('Failed to create train:', error)
    if (error.code === '23505') {
      // Unique violation
      return c.json({ error: 'Train ID already exists' }, 409)
    }
    return c.json({ error: 'Failed to create train' }, 500)
  }
})

// PUT /api/trains/:id - Update train
trains.put('/:id', async c => {
  try {
    const pool = container.getPool()

    const id = c.req.param('id')
    const body = await c.req.json<UpdateTrainRequest>()
    const train = await updateTrain(pool, id, body)

    return c.json({ train })
  } catch (error: any) {
    console.error('Failed to update train:', error)
    if (error.message.includes('not found')) {
      return c.json({ error: 'Train not found' }, 404)
    }
    return c.json({ error: 'Failed to update train' }, 500)
  }
})

// POST /api/trains/:id/accounts - Link account to train
trains.post('/:id/accounts', async c => {
  try {
    const pool = container.getPool()

    const trainId = c.req.param('id')
    const { credential_id } = await c.req.json<{ credential_id: string }>()

    await linkAccountToTrain(pool, trainId, credential_id)

    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to link account:', error)
    return c.json({ error: 'Failed to link account' }, 500)
  }
})

// DELETE /api/trains/:id/accounts/:credentialId - Unlink account
trains.delete('/:id/accounts/:credentialId', async c => {
  try {
    const pool = container.getPool()

    const trainId = c.req.param('id')
    const credentialId = c.req.param('credentialId')

    const success = await unlinkAccountFromTrain(pool, trainId, credentialId)

    if (!success) {
      return c.json({ error: 'Link not found' }, 404)
    }

    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to unlink account:', error)
    return c.json({ error: 'Failed to unlink account' }, 500)
  }
})

export default trains
