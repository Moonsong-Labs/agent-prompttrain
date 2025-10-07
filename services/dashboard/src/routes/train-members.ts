import { Hono } from 'hono'
import { container } from '../container.js'
import {
  getTrainMembers,
  addTrainMember,
  removeTrainMember,
  updateTrainMemberRole,
  getTrainById,
} from '@agent-prompttrain/shared/database/queries'
import type { AddTrainMemberRequest, UpdateTrainMemberRequest } from '@agent-prompttrain/shared'
import { requireTrainOwner, requireTrainMembership } from '../middleware/train-ownership.js'

const trainMembers = new Hono()

// GET /api/trains/:id/members - List all members (owners + members can view)
trainMembers.get('/:id/members', requireTrainMembership, async c => {
  try {
    const pool = container.getPool()
    const trainId = c.req.param('id')

    const train = await getTrainById(pool, trainId)
    if (!train) {
      return c.json({ error: 'Train not found' }, 404)
    }

    const members = await getTrainMembers(pool, trainId)
    return c.json({ members })
  } catch (error) {
    console.error('Failed to list train members:', error)
    return c.json({ error: 'Failed to list train members' }, 500)
  }
})

// POST /api/trains/:id/members - Add member (owner only)
trainMembers.post('/:id/members', requireTrainOwner, async c => {
  try {
    const pool = container.getPool()
    const trainId = c.req.param('id')
    const auth = c.get('auth')

    const train = await getTrainById(pool, trainId)
    if (!train) {
      return c.json({ error: 'Train not found' }, 404)
    }

    const body = await c.req.json<AddTrainMemberRequest>()

    if (!body.user_email || !body.role) {
      return c.json({ error: 'user_email and role are required' }, 400)
    }

    if (body.role !== 'owner' && body.role !== 'member') {
      return c.json({ error: 'role must be "owner" or "member"' }, 400)
    }

    const member = await addTrainMember(pool, trainId, body.user_email, body.role, auth.principal)

    return c.json({ member }, 201)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    console.error('Failed to add train member:', error)
    if (error.code === '23503') {
      // Foreign key violation
      return c.json({ error: 'Train not found' }, 404)
    }
    return c.json({ error: 'Failed to add train member' }, 500)
  }
})

// DELETE /api/trains/:id/members/:email - Remove member (owner only)
trainMembers.delete('/:id/members/:email', requireTrainOwner, async c => {
  try {
    const pool = container.getPool()
    const trainId = c.req.param('id')
    const userEmail = decodeURIComponent(c.req.param('email'))

    const train = await getTrainById(pool, trainId)
    if (!train) {
      return c.json({ error: 'Train not found' }, 404)
    }

    await removeTrainMember(pool, trainId, userEmail)
    return c.json({ success: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    console.error('Failed to remove train member:', error)
    if (error.message === 'Member not found') {
      return c.json({ error: 'Member not found' }, 404)
    }
    if (error.message === 'Cannot remove the last owner from a train') {
      return c.json({ error: 'Cannot remove the last owner from a train' }, 400)
    }
    return c.json({ error: 'Failed to remove train member' }, 500)
  }
})

// PATCH /api/trains/:id/members/:email - Update member role (owner only)
trainMembers.patch('/:id/members/:email', requireTrainOwner, async c => {
  try {
    const pool = container.getPool()
    const trainId = c.req.param('id')
    const userEmail = decodeURIComponent(c.req.param('email'))

    const train = await getTrainById(pool, trainId)
    if (!train) {
      return c.json({ error: 'Train not found' }, 404)
    }

    const body = await c.req.json<UpdateTrainMemberRequest>()

    if (!body.role) {
      return c.json({ error: 'role is required' }, 400)
    }

    if (body.role !== 'owner' && body.role !== 'member') {
      return c.json({ error: 'role must be "owner" or "member"' }, 400)
    }

    const member = await updateTrainMemberRole(pool, trainId, userEmail, body.role)
    return c.json({ member })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    console.error('Failed to update train member role:', error)
    if (error.message === 'Member not found') {
      return c.json({ error: 'Member not found' }, 404)
    }
    if (error.message === 'Cannot demote the last owner') {
      return c.json({ error: 'Cannot demote the last owner' }, 400)
    }
    return c.json({ error: 'Failed to update train member role' }, 500)
  }
})

export default trainMembers
