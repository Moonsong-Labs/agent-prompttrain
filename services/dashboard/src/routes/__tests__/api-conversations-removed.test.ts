import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'

// PERF-04: the dashboard's own JSON /api/conversations endpoint (and its
// StorageReader.getConversationSummaries backing query) were removed because
// they were unused (the dashboard UI calls the proxy's paginated
// /api/conversations via apiClient.getConversations()) and the query never
// finished under a 30s timeout while its debug logging scanned every
// private-project request and logged user emails.

// Mock the container so building the real dashboard app never touches a
// database (see reader-conversation.test.ts / conversation-detail.test.ts
// for the same pattern). This must run before `../../app.js` is imported,
// since app.ts imports the container module statically.
mock.module('../../container.js', () => ({
  container: {
    getApiClient: () => ({
      getStats: async () => ({}),
    }),
    getStorageService: () => {
      throw new Error('storage service must not be used by this test')
    },
    getPool: () => {
      throw new Error('database pool must not be used by this test')
    },
  },
}))

const originalDevUserEmail = process.env.DASHBOARD_DEV_USER_EMAIL
beforeAll(() => {
  // Bypass dashboardAuth so requests reach routing instead of a blanket 401,
  // which would make the "route is gone" assertion meaningless.
  process.env.DASHBOARD_DEV_USER_EMAIL = 'perf04-test@example.com'
})
afterAll(() => {
  if (originalDevUserEmail === undefined) {
    delete process.env.DASHBOARD_DEV_USER_EMAIL
  } else {
    process.env.DASHBOARD_DEV_USER_EMAIL = originalDevUserEmail
  }
})

const { createDashboardApp } = await import('../../app.js')
const app = await createDashboardApp()

describe('dashboard app no longer serves GET /api/conversations', () => {
  it('returns 404 for GET /api/conversations', async () => {
    const res = await app.request('/api/conversations')
    expect(res.status).toBe(404)
  })

  it('does not mention /api/conversations in the GET /api endpoint listing', async () => {
    const res = await app.request('/api')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('conversations')
  })
})
