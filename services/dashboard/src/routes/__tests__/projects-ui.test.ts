import { describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import type { AuthContext } from '../../middleware/auth.js'
import { logger } from '../../middleware/logger.js'
import { container } from '../../container.js'
import { trainsUIRoutes } from '../projects-ui.js'

const PROJECT_COUNT = 50
const VIEWER = 'viewer@projects-ui.test'
const projectId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const CRED_A = '10000000-0000-4000-8000-000000000001'
const CRED_B = '10000000-0000-4000-8000-000000000002'
const CRED_C = '10000000-0000-4000-8000-000000000003'
const CRED_BEDROCK = '10000000-0000-4000-8000-000000000004'

const credentials = [
  {
    id: CRED_A,
    account_id: 'acct-a',
    account_name: 'Account Alpha',
    provider: 'anthropic',
    token_limit_threshold: 0.95,
    five_hour_limit_threshold: 0.9,
    seven_day_limit_threshold: 0.95,
    oauth_access_token: 'tok',
    oauth_refresh_token: 'ref',
    oauth_expires_at: new Date('2027-01-01T00:00:00Z'),
    oauth_scopes: ['default'],
    oauth_is_max: true,
    last_refresh_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  },
  {
    id: CRED_B,
    account_id: 'acct-b',
    account_name: 'Account Beta',
    provider: 'anthropic',
    token_limit_threshold: 0.95,
    five_hour_limit_threshold: 0.9,
    seven_day_limit_threshold: 0.95,
    oauth_access_token: 'tok',
    oauth_refresh_token: 'ref',
    oauth_expires_at: new Date('2027-01-01T00:00:00Z'),
    oauth_scopes: ['default'],
    oauth_is_max: true,
    last_refresh_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  },
  {
    id: CRED_C,
    account_id: 'acct-c',
    account_name: 'Account Gamma',
    provider: 'anthropic',
    token_limit_threshold: 0.95,
    five_hour_limit_threshold: 0.9,
    seven_day_limit_threshold: 0.95,
    oauth_access_token: 'tok',
    oauth_refresh_token: 'ref',
    oauth_expires_at: new Date('2027-01-01T00:00:00Z'),
    oauth_scopes: ['default'],
    oauth_is_max: true,
    last_refresh_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  },
  {
    id: CRED_BEDROCK,
    account_id: 'acct-bedrock',
    account_name: 'Bedrock Delta',
    provider: 'bedrock',
    token_limit_threshold: 0.95,
    aws_api_key: 'aws-secret-key',
    aws_region: 'us-east-1',
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  },
]

const projects = Array.from({ length: PROJECT_COUNT }, (_, n) => ({
  id: projectId(n),
  project_id: `project-${n}`,
  name: `Project ${n}`,
  is_private: false,
  disabled: false,
  default_account_id: n === 0 || n === 1 || n === 2 ? CRED_A : null,
  system_prompt_enabled: false,
  system_prompt: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
}))

// Project 0: 0 linked accounts -> uses default (CRED_A)
// Project 1: 1 Anthropic + 1 Bedrock linked -> < 2 Anthropic, still uses default (CRED_A)
// Project 2: 2 Anthropic accounts linked (CRED_B, CRED_C) -> pool active, hides default (CRED_A)
// Project 3: 2 Anthropic accounts linked including default (CRED_A, CRED_B) -> pool active, allows unlinking CRED_A
projects[3].default_account_id = CRED_A

const projectLinks: Array<{ project_id: string; credential_id: string }> = [
  { project_id: projectId(1), credential_id: CRED_B },
  { project_id: projectId(1), credential_id: CRED_BEDROCK },
  { project_id: projectId(2), credential_id: CRED_B },
  { project_id: projectId(2), credential_id: CRED_C },
  { project_id: projectId(3), credential_id: CRED_A },
  { project_id: projectId(3), credential_id: CRED_B },
]

let queries: string[] = []
let deletedLinks: Array<{ projectId: string; credentialId: string }> = []
let failProjectList = false
let viewerIsOwnerForDetail = true

/** Answers the page's queries by shape; anything else returns no rows */
const pool = {
  query: async (sql: string, params?: unknown[]) => {
    queries.push(sql)
    if (failProjectList && sql.includes('FROM projects ORDER BY name')) {
      throw new Error('timeout exceeded when trying to connect')
    }
    if (sql.includes('FROM projects ORDER BY name')) {
      return { rows: projects }
    }
    if (sql.includes('FROM projects WHERE project_id = $1')) {
      const found = projects.find(p => p.project_id === params?.[0])
      return { rows: found ? [found] : [] }
    }
    if (sql.includes('FROM credentials ORDER BY account_name')) {
      return { rows: credentials }
    }
    if (sql.includes('FROM project_accounts WHERE project_id = ANY($1)')) {
      return { rows: projectLinks }
    }
    if (sql.includes('DELETE FROM project_accounts')) {
      deletedLinks.push({
        projectId: String(params?.[0]),
        credentialId: String(params?.[1]),
      })
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('SELECT credential_id FROM project_accounts WHERE project_id = $1')) {
      const pid = params?.[0]
      return {
        rows: projectLinks
          .filter(link => link.project_id === pid)
          .map(link => ({ credential_id: link.credential_id })),
      }
    }
    if (
      sql.includes("role = 'owner'") &&
      sql.includes('project_members') &&
      !sql.includes('first_owner_email')
    ) {
      return {
        rows: viewerIsOwnerForDetail ? [{ exists: true }] : [],
        rowCount: viewerIsOwnerForDetail ? 1 : 0,
      }
    }
    if (sql.includes('FROM project_members') && !sql.includes('first_owner_email')) {
      return { rows: [{ exists: true }], rowCount: 1 }
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

const app = new Hono<{ Variables: { auth: AuthContext } }>()
app.use('*', async (c, next) => {
  c.set('auth', { isAuthenticated: true, principal: VIEWER, source: 'dev' })
  await next()
})
app.route('/dashboard/projects', trainsUIRoutes)

describe('projects UI', () => {
  let originalGetPool: typeof container.getPool

  beforeEach(() => {
    queries = []
    deletedLinks = []
    failProjectList = false
    viewerIsOwnerForDetail = true
    originalGetPool = container.getPool
    ;(container as unknown as { getPool: () => Pool }).getPool = () => pool as unknown as Pool
  })

  afterEach(() => {
    ;(container as unknown as { getPool: typeof container.getPool }).getPool = originalGetPool
  })

  describe('projects list page', () => {
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

    it('shows Accounts header and hides default account when 2+ Anthropic accounts are linked', async () => {
      const body = await (await app.request('/dashboard/projects')).text()

      expect(body).toMatch(/<th[^>]*>\s*Accounts\s*<\/th>/)
      expect(body).not.toContain('Default Account')

      // Helper to extract the <tr> for a given project slug
      const rowFor = (slug: string) => {
        const row = body.split('</tr>').find(chunk => chunk.includes(`/${slug}/view`))
        expect(row).toBeDefined()
        return row ?? ''
      }

      // Project 0 (0 linked): shows default Account Alpha
      const row0 = rowFor('project-0')
      expect(row0).toContain('Account Alpha')
      expect(row0).not.toContain('project-linked-accounts')

      // Project 1 (1 Anthropic + 1 Bedrock linked): < 2 Anthropic, still shows default Account Alpha
      const row1 = rowFor('project-1')
      expect(row1).toContain('Account Alpha')
      expect(row1).not.toContain('project-linked-accounts')

      // Project 2 (2 Anthropic linked: Beta, Gamma; default is Alpha): hides Alpha, shows Beta & Gamma
      const row2 = rowFor('project-2')
      expect(row2).toContain('data-testid="project-linked-accounts"')
      expect(row2).toContain('Account Beta')
      expect(row2).toContain('Account Gamma')
      expect(row2).not.toContain('Account Alpha')
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

  describe('project detail page', () => {
    it('shows DEFAULT badge and Set Default buttons when fewer than 2 Anthropic accounts are linked', async () => {
      const res = await app.request('/dashboard/projects/project-1/view')
      expect(res.status).toBe(200)
      const body = await res.text()

      expect(body).toContain('data-testid="default-account-badge"')
      expect(body).toContain('data-testid="set-default-account-button"')
      expect(body).toContain('Until then, the default account is used.')
    })

    it('hides DEFAULT badge, blue styling, and Set Default buttons when 2+ Anthropic accounts are linked', async () => {
      const res = await app.request('/dashboard/projects/project-2/view')
      expect(res.status).toBe(200)
      const body = await res.text()

      expect(body).not.toContain('data-testid="default-account-badge"')
      expect(body).not.toContain('data-testid="set-default-account-button"')
      const accountsSection = body.match(
        /<!-- Accounts Section -->[\s\S]*?<!-- Members Section -->/
      )
      expect(accountsSection).not.toBeNull()
      const accountsHtml = accountsSection?.[0] ?? ''
      expect(accountsHtml).not.toContain('background: #eff6ff')
      expect(accountsHtml).toContain(
        'Automatic load balancing is active across the linked Anthropic accounts.'
      )
      expect(accountsHtml).toContain('data-testid="linked-account-badge"')
    })

    it('allows unlinking a linked account even when it matches default_account_id', async () => {
      // Project 3 has CRED_A (default) and CRED_B linked
      const viewRes = await app.request('/dashboard/projects/project-3/view')
      expect(viewRes.status).toBe(200)
      const viewBody = await viewRes.text()

      expect(viewBody).not.toContain('data-testid="default-account-badge"')
      expect(viewBody).toContain(`/dashboard/projects/${projectId(3)}/unlink-account/${CRED_A}`)
      expect(viewBody).toContain(`/dashboard/projects/${projectId(3)}/unlink-account/${CRED_B}`)

      const deleteRes = await app.request(
        `/dashboard/projects/${projectId(3)}/unlink-account/${CRED_A}`,
        { method: 'DELETE' }
      )
      expect(deleteRes.status).toBe(200)
      const deleteBody = await deleteRes.text()
      expect(deleteBody).toContain('Account removed from pool.')
      expect(deletedLinks).toEqual([{ projectId: projectId(3), credentialId: CRED_A }])
    })
  })
})
