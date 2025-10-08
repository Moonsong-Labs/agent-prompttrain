import { Hono } from 'hono'
import { container } from '../container.js'
import {
  addProjectMember,
  removeProjectMember,
  updateTrainMemberRole,
  getProjectById,
} from '@agent-prompttrain/shared/database/queries'
import type { AddProjectMemberRequest, UpdateProjectMemberRequest } from '@agent-prompttrain/shared'
import { requireTrainOwner } from '../middleware/project-ownership.js'

const trainMembers = new Hono()

// POST /api/projects/:id/members - Add member (owner only)
trainMembers.post('/:id/members', requireTrainOwner, async c => {
  try {
    const pool = container.getPool()
    const projectId = c.req.param('id')
    const auth = c.get('auth')

    const train = await getProjectById(pool, projectId)
    if (!train) {
      return c.json({ error: 'Project not found' }, 404)
    }

    const body = await c.req.json<AddProjectMemberRequest>()

    if (!body.user_email || !body.role) {
      return c.json({ error: 'user_email and role are required' }, 400)
    }

    if (body.role !== 'owner' && body.role !== 'member') {
      return c.json({ error: 'role must be "owner" or "member"' }, 400)
    }

    const member = await addProjectMember(
      pool,
      projectId,
      body.user_email,
      body.role,
      auth.principal
    )

    return c.json({ member }, 201)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    console.error('Failed to add train member:', error)
    if (error.code === '23503') {
      // Foreign key violation
      return c.json({ error: 'Project not found' }, 404)
    }
    return c.json({ error: 'Failed to add train member' }, 500)
  }
})

// DELETE /api/projects/:id/members/:email - Remove member (owner only)
trainMembers.delete('/:id/members/:email', requireTrainOwner, async c => {
  try {
    const pool = container.getPool()
    const projectId = c.req.param('id')
    const userEmail = decodeURIComponent(c.req.param('email'))

    const train = await getProjectById(pool, projectId)
    if (!train) {
      return c.json({ error: 'Project not found' }, 404)
    }

    await removeProjectMember(pool, projectId, userEmail)
    return c.json({ success: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    console.error('Failed to remove train member:', error)
    if (error.message === 'Member not found') {
      return c.json({ error: 'Member not found' }, 404)
    }
    if (error.message === 'Cannot remove the last owner from a project') {
      return c.json({ error: 'Cannot remove the last owner from a project' }, 400)
    }
    return c.json({ error: 'Failed to remove train member' }, 500)
  }
})

// PATCH /api/projects/:id/members/:email - Update member role (owner only)
trainMembers.patch('/:id/members/:email', requireTrainOwner, async c => {
  try {
    const pool = container.getPool()
    const projectId = c.req.param('id')
    const userEmail = decodeURIComponent(c.req.param('email'))

    const train = await getProjectById(pool, projectId)
    if (!train) {
      return c.json({ error: 'Project not found' }, 404)
    }

    const body = await c.req.json<UpdateProjectMemberRequest>()

    if (!body.role) {
      return c.json({ error: 'role is required' }, 400)
    }

    if (body.role !== 'owner' && body.role !== 'member') {
      return c.json({ error: 'role must be "owner" or "member"' }, 400)
    }

    const member = await updateTrainMemberRole(pool, projectId, userEmail, body.role)
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
