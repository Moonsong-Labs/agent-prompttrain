import { Hono } from 'hono'
import { container } from '../container'
import {
  getProjectWithAccounts,
  createProject,
  updateProject,
  setProjectDefaultAccount,
  addProjectMember,
  getUserProjectsWithAccounts,
  deleteProject,
  addProjectAccount,
  removeProjectAccount,
  getProjectById,
} from '@agent-prompttrain/shared/database/queries'
import {
  validateSystemPrompt,
  type CreateProjectRequest,
  type UpdateProjectRequest,
} from '@agent-prompttrain/shared'
import type { AuthContext } from '../middleware/auth.js'
import { requireProjectOwner, requireProjectMembership } from '../middleware/project-ownership.js'

const projects = new Hono<{ Variables: { auth: AuthContext } }>()

// GET /api/projects - List user's projects with accounts
projects.get('/', async c => {
  try {
    const pool = container.getPool()
    const auth = c.get('auth')

    const trainsList = await getUserProjectsWithAccounts(pool, auth.principal)
    return c.json({ projects: trainsList })
  } catch (error) {
    console.error('Failed to list projects:', error)
    return c.json({ error: 'Failed to list projects' }, 500)
  }
})

// GET /api/projects/:projectId - Get train details with accounts (member only)
projects.get('/:projectId', requireProjectMembership, async c => {
  try {
    const pool = container.getPool()

    const projectId = c.req.param('projectId')
    const train = await getProjectWithAccounts(pool, projectId)

    if (!train) {
      return c.json({ error: 'Project not found' }, 404)
    }

    return c.json({ train })
  } catch (error) {
    console.error('Failed to get train:', error)
    return c.json({ error: 'Failed to get train' }, 500)
  }
})

// POST /api/projects - Create new train
projects.post('/', async c => {
  const pool = container.getPool()
  const auth = c.get('auth')
  const client = await pool.connect()

  try {
    const body = await c.req.json<CreateProjectRequest>()

    // Create train and auto-assign creator as owner in a transaction
    await client.query('BEGIN')
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const train = await createProject(client as any, body)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await addProjectMember(client as any, train.id, auth.principal, 'owner', auth.principal)
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
      return c.json({ error: 'Project ID already exists' }, 409)
    }
    return c.json({ error: 'Failed to create train' }, 500)
  } finally {
    client.release()
  }
})

// PUT /api/projects/:id - Update train (owner only)
projects.put('/:id', requireProjectOwner, async c => {
  try {
    const pool = container.getPool()

    const id = c.req.param('id')
    const body = await c.req.json<UpdateProjectRequest>()
    const train = await updateProject(pool, id, body)

    return c.json({ train })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    console.error('Failed to update train:', error)
    if (error.message.includes('not found')) {
      return c.json({ error: 'Project not found' }, 404)
    }
    return c.json({ error: 'Failed to update train' }, 500)
  }
})

// PUT /api/projects/:id/default-account - Set default account (owner only)
projects.put('/:id/default-account', requireProjectOwner, async c => {
  try {
    const pool = container.getPool()

    const projectId = c.req.param('id')
    const { credential_id } = await c.req.json<{ credential_id: string }>()

    const train = await setProjectDefaultAccount(pool, projectId, credential_id)

    return c.json({ train })
  } catch (error) {
    console.error('Failed to set default account:', error)
    return c.json({ error: 'Failed to set default account' }, 500)
  }
})

// PUT /api/projects/:id/system-prompt - Update system prompt (member only)
projects.put('/:id/system-prompt', requireProjectMembership, async c => {
  try {
    const pool = container.getPool()
    const id = c.req.param('id')
    const body = await c.req.json<{
      system_prompt_enabled?: boolean
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      system_prompt?: any[] | null
    }>()

    // Validate system prompt if provided
    if (body.system_prompt !== undefined) {
      const validation = validateSystemPrompt(body.system_prompt)
      if (!validation.valid) {
        return c.json({ error: `Invalid system prompt: ${validation.error}` }, 400)
      }
    }

    const train = await updateProject(pool, id, {
      system_prompt_enabled: body.system_prompt_enabled,
      system_prompt: body.system_prompt,
    })

    return c.json({ train })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    console.error('Failed to update system prompt:', error)
    if (error.message.includes('not found')) {
      return c.json({ error: 'Project not found' }, 404)
    }
    return c.json({ error: 'Failed to update system prompt' }, 500)
  }
})

// DELETE /api/projects/:id - Delete train (owner only)
projects.delete('/:id', requireProjectOwner, async c => {
  try {
    const pool = container.getPool()
    const id = c.req.param('id')

    const success = await deleteProject(pool, id)

    if (!success) {
      return c.json({ error: 'Project not found' }, 404)
    }

    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to delete train:', error)
    return c.json({ error: 'Failed to delete train' }, 500)
  }
})

// POST /api/projects/:id/accounts - Link account to project pool (owner only)
projects.post('/:id/accounts', requireProjectOwner, async c => {
  try {
    const pool = container.getPool()
    const projectId = c.req.param('id')
    const { credential_id } = await c.req.json<{ credential_id: string }>()

    if (!credential_id) {
      return c.json({ error: 'credential_id is required' }, 400)
    }

    const added = await addProjectAccount(pool, projectId, credential_id)
    return c.json({ linked: added }, added ? 201 : 200)
  } catch (error: any) {
    console.error('Failed to link account:', error)
    if (error.code === '23503') {
      return c.json({ error: 'Invalid credential ID' }, 400)
    }
    return c.json({ error: 'Failed to link account' }, 500)
  }
})

// DELETE /api/projects/:id/accounts/:credentialId - Unlink account from project pool (owner only)
projects.delete('/:id/accounts/:credentialId', requireProjectOwner, async c => {
  try {
    const pool = container.getPool()
    const projectId = c.req.param('id')
    const credentialId = c.req.param('credentialId')

    // Prevent unlinking the default account
    const project = await getProjectById(pool, projectId)
    if (project?.default_account_id === credentialId) {
      return c.json({ error: 'Cannot unlink the default account. Change the default first.' }, 400)
    }

    const removed = await removeProjectAccount(pool, projectId, credentialId)
    if (!removed) {
      return c.json({ error: 'Account was not linked to this project' }, 404)
    }

    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to unlink account:', error)
    return c.json({ error: 'Failed to unlink account' }, 500)
  }
})

export default projects
