import type { MiddlewareHandler } from 'hono'
import { isProjectOwner, isProjectMember } from '@agent-prompttrain/shared/database/queries'
import { container } from '../container.js'
import type { AuthContext } from './auth.js'

/**
 * Middleware to require project ownership
 * Returns 403 if the authenticated user is not an owner of the project
 */
export const requireProjectOwner: MiddlewareHandler<{
  Variables: { auth: AuthContext }
}> = async (c, next) => {
  const projectId = c.req.param('id')
  if (!projectId) {
    return c.json({ error: 'Project ID is required' }, 400)
  }

  const auth = c.get('auth')

  if (!auth.isAuthenticated) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const pool = container.getPool()
  const isOwner = await isProjectOwner(pool, projectId, auth.principal)

  if (!isOwner) {
    return c.json({ error: 'Only project owners can perform this action' }, 403)
  }

  await next()
}

/**
 * Middleware to require project membership (owner or member)
 * Returns 403 if the authenticated user is not a member of the project
 */
export const requireProjectMembership: MiddlewareHandler<{
  Variables: { auth: AuthContext }
}> = async (c, next) => {
  const projectId = c.req.param('id')
  if (!projectId) {
    return c.json({ error: 'Project ID is required' }, 400)
  }

  const auth = c.get('auth')

  if (!auth.isAuthenticated) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const pool = container.getPool()
  const isMember = await isProjectMember(pool, projectId, auth.principal)

  if (!isMember) {
    return c.json({ error: 'Access denied: You are not a member of this project' }, 403)
  }

  await next()
}
