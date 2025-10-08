import { beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { projectIdExtractorMiddleware } from '../src/middleware/project-id-extractor'

const TRAIN_HEADER = 'MSL-Project-Id'
const TRAIN_HEADER_LOWER = TRAIN_HEADER.toLowerCase()

describe('projectIdExtractorMiddleware', () => {
  let app: Hono

  beforeEach(() => {
    app = new Hono()
    app.use('*', projectIdExtractorMiddleware())
    app.get('/test', c => {
      return c.json({
        projectId: c.get('projectId'),
      })
    })
  })

  it('falls back to default train when header missing', async () => {
    const res = await app.request('/test')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.projectId).toBe('default')
  })

  it('extracts projectId from MSL-Project-Id header', async () => {
    const res = await app.request('/test', {
      headers: {
        [TRAIN_HEADER]: 'team-alpha',
      },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.projectId).toBe('team-alpha')
  })

  it('trims whitespace from header value', async () => {
    const res = await app.request('/test', {
      headers: {
        [TRAIN_HEADER]: '  team-beta  ',
      },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.projectId).toBe('team-beta')
  })

  it('treats header names case-insensitively', async () => {
    const res = await app.request('/test', {
      headers: {
        [TRAIN_HEADER_LOWER]: 'alpha-lowercase',
      },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.projectId).toBe('alpha-lowercase')
  })
})
