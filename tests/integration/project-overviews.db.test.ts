import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Pool } from 'pg'
import {
  getProjectMembers,
  getProjectStats,
  isProjectOwner,
  listProjectOverviews,
} from '../../packages/shared/src/database/queries'

// Only ever runs against an explicitly named local *_test database
const databaseUrl = process.env.PROJECTS_TEST_DATABASE_URL
const enabled = !!databaseUrl && new URL(databaseUrl).pathname.endsWith('_test')

const VIEWER = 'Viewer@ProjOv.test'
const HOUR = 3_600_000

interface SeedProject {
  slug: string
  members: Array<[email: string, role: 'owner' | 'member']>
  /** last_used_at of each API key, in hours ago; null = never used; revoked keys still count */
  keys: Array<{ usedHoursAgo: number | null; revoked?: boolean }>
}

const SEED: SeedProject[] = [
  {
    // Several owners: the first owner is the one getProjectMembers lists first
    slug: 'projov-test-owners',
    members: [
      ['b-owner@projov.test', 'owner'],
      ['a-owner@projov.test', 'owner'],
      ['c-member@projov.test', 'member'],
    ],
    keys: [{ usedHoursAgo: null }, { usedHoursAgo: 5 }, { usedHoursAgo: 1, revoked: true }],
  },
  { slug: 'projov-test-empty', members: [], keys: [] },
  {
    slug: 'projov-test-no-owner',
    members: [['d-member@projov.test', 'member']],
    keys: [{ usedHoursAgo: null }],
  },
  {
    // The viewer owns this one; a case variant of the viewer is not the viewer
    slug: 'projov-test-viewer-owns',
    members: [
      [VIEWER, 'owner'],
      [VIEWER.toLowerCase(), 'member'],
    ],
    keys: [{ usedHoursAgo: 30 }],
  },
  {
    // Owned only by a case variant of the viewer: not the viewer's, as isProjectOwner
    slug: 'projov-test-variant-owns',
    members: [[VIEWER.toLowerCase(), 'owner']],
    keys: [],
  },
  {
    // The viewer is a member but not an owner
    slug: 'projov-test-viewer-member',
    members: [
      ['e-owner@projov.test', 'owner'],
      [VIEWER, 'member'],
    ],
    keys: [{ usedHoursAgo: 2 }, { usedHoursAgo: 3 }],
  },
]

describe.skipIf(!enabled)('project overviews against PostgreSQL', () => {
  let pool: Pool
  const ids = new Map<string, string>()
  const now = Date.now()

  const cleanUp = () => pool.query(`DELETE FROM projects WHERE project_id LIKE 'projov-test-%'`)

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl })
    await cleanUp()

    for (const project of SEED) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO projects (project_id, name, api_key) VALUES ($1, $1, $2) RETURNING id`,
        [project.slug, `${project.slug}-key`]
      )
      const id = rows[0].id
      ids.set(project.slug, id)
      for (const [email, role] of project.members) {
        await pool.query(
          `INSERT INTO project_members (project_id, user_email, role, added_by)
           VALUES ($1, $2, $3, 'project-overviews-test')`,
          [id, email, role]
        )
      }
      for (const [index, key] of project.keys.entries()) {
        await pool.query(
          `INSERT INTO project_api_keys
             (project_id, api_key, key_prefix, key_suffix, last_used_at, revoked_at)
           VALUES ($1, $2, 'cnp_live_', 'abcd', $3, $4)`,
          [
            id,
            `${project.slug}-api-key-${index}`,
            key.usedHoursAgo === null ? null : new Date(now - key.usedHoursAgo * HOUR),
            key.revoked ? new Date(now) : null,
          ]
        )
      }
    }
  })

  afterAll(async () => {
    await cleanUp()
    await pool.end()
  })

  /** What the projects page computed with three queries per project */
  const reference = async (projectId: string, principal: string | null) => {
    const [stats, members, isOwner] = await Promise.all([
      getProjectStats(pool, projectId),
      getProjectMembers(pool, projectId),
      principal ? isProjectOwner(pool, projectId, principal) : false,
    ])
    return {
      id: projectId,
      lastUsedAt: stats.lastUsedAt,
      membersCount: members.length,
      firstOwnerEmail: members.find(m => m.role === 'owner')?.user_email ?? null,
      isOwner,
    }
  }

  for (const principal of [VIEWER, 'nobody@projov.test', null]) {
    it(`matches the per-project queries for ${principal ?? 'a signed-out viewer'}`, async () => {
      const overviews = await listProjectOverviews(pool, principal)
      const byId = new Map(overviews.map(overview => [overview.id, overview]))

      for (const project of SEED) {
        const id = ids.get(project.slug)!
        expect(byId.get(id)).toEqual(await reference(id, principal))
      }
    })
  }

  it('reads every project in one query', async () => {
    let queries = 0
    const counting = {
      query: (...args: Parameters<Pool['query']>) => {
        queries++
        return (pool.query as (...a: unknown[]) => unknown)(...args)
      },
    } as unknown as Pool

    const overviews = await listProjectOverviews(counting, VIEWER)

    expect(queries).toBe(1)
    const seeded = overviews.filter(overview => [...ids.values()].includes(overview.id))
    expect(seeded).toHaveLength(SEED.length)
  })
})
