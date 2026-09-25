import { describe, it, expect, mock, spyOn, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import type { AuthContext } from '../../middleware/auth.js'
import { logger } from '../../middleware/logger.js'

const PROJECT_COUNT = 50
const VIEWER = 'viewer@projects-ui.test'
const projectId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const projects = Array.from({ length: PROJECT_COUNT }, (_, n) => ({
  id: projectId(n),
  project_id: `project-${n}`,
  name: `Project ${n}`,
  is_private: false,
  disabled: false,
  default_account_id: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
}))

let queries: string[] = []
let failProjectList = false

/** Answers the page's queries by shape; anything else returns no rows */
const pool = {
  query: async (sql: string) => {
    queries.push(sql)
    if (failProjectList && sql.includes('FROM projects ORDER BY name')) {
      throw new Error('timeout exceeded when trying to connect')
    }
    if (sql.includes('FROM projects ORDER BY name')) {
      return { rows: projects }
    }
    if (sql.includes('first_owner_email')) {
      return {
        rows: projects.map((project, n) => ({
          id: project.id,
          last_used_at: new Date(Date.UTC(2026, 8, 1 + (n % 20))),
          members_count: n + 1,
          first_owner_email: `owner-${n}@projects-ui.test`,
          is_owner: n === 7,
        })),
      }
    }
    return { rows: [] }
  },
}

mock.module('../../container.js', () => ({ container: { getPool: () => pool } }))
const { trainsUIRoutes } = await import('../projects-ui.js')

const app = new Hono<{ Variables: { auth: AuthContext } }>()
app.use('*', async (c, next) => {
  c.set('auth', { isAuthenticated: true, principal: VIEWER, source: 'dev' })
  await next()
})
app.route('/dashboard/projects', trainsUIRoutes)

describe('projects list page', () => {
  beforeEach(() => {
    queries = []
    failProjectList = false
  })

  it('reads the page with a fixed number of queries, whatever the project count', async () => {
    const res = await app.request('/dashboard/projects')

    expect(res.status).toBe(200)
    expect(queries.length).toBeLessThanOrEqual(4)
  })

  it('renders each project with its owner and member count', async () => {
    const body = await (await app.request('/dashboard/projects')).text()

    for (const n of [0, 7, PROJECT_COUNT - 1]) {
      expect(body).toContain(`/dashboard/projects/project-${n}/view`)
      // The owner cell is followed by the member count cell
      expect(body).toMatch(
        new RegExp(`owner-${n}@projects-ui\\.test\\s*</td>\\s*<td[^>]*>\\s*${n + 1}\\s*</td>`)
      )
    }
  })

  it('offers owner actions only on the projects the viewer owns', async () => {
    const body = await (await app.request('/dashboard/projects')).text()

    expect(body).toContain(`/dashboard/projects/${projectId(7)}/toggle-disabled`)
    expect(body).not.toContain(`/dashboard/projects/${projectId(8)}/toggle-disabled`)
  })

  it('answers a failure with HTTP 500 and logs it', async () => {
    failProjectList = true
    const errorLog = spyOn(logger, 'error').mockImplementation(() => {})

    const res = await app.request('/dashboard/projects')

    expect(res.status).toBe(500)
    expect(await res.text()).toContain('Failed to load projects')
    expect(errorLog).toHaveBeenCalled()
    errorLog.mockRestore()
  })
})
