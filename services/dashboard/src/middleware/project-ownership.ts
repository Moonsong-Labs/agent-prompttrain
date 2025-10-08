import type { MiddlewareHandler } from 'hono'
import { isProjectOwner, isTrainMember } from '@agent-prompttrain/shared/database/queries'
import { container } from '../container.js'
import type { AuthContext } from './auth.js'

/**
 * Middleware to require train ownership
 * Returns 403 if the authenticated user is not an owner of the project
 */
export const requireTrainOwner: MiddlewareHandler<{
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
    return c.json({ error: 'Only train owners can perform this action' }, 403)
  }

  await next()
}

/**
 * Middleware to require train membership (owner or member)
 * Returns 403 if the authenticated user is not a member of the project
 */
export const requireTrainMembership: MiddlewareHandler<{
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
  const isMember = await isTrainMember(pool, projectId, auth.principal)

  if (!isMember) {
    return c.json({ error: 'Access denied: You are not a member of this train' }, 403)
  }

  await next()
}
