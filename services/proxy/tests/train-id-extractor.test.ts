import { beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { trainIdExtractorMiddleware } from '../src/middleware/train-id-extractor'

describe('trainIdExtractorMiddleware', () => {
  let app: Hono

  beforeEach(() => {
    app = new Hono()
    app.use('*', trainIdExtractorMiddleware())
    app.get('/test', c => {
      return c.json({
        trainId: c.get('trainId'),
      })
    })
  })

  it('rejects requests without train-id header', async () => {
    const res = await app.request('/test')

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('bad_request')
    expect(body.error.message).toBe('train-id header is required')
  })

  it('extracts trainId from train-id header', async () => {
    const res = await app.request('/test', {
      headers: {
        'train-id': 'team-alpha',
      },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.trainId).toBe('team-alpha')
  })

  it('trims whitespace from header value', async () => {
    const res = await app.request('/test', {
      headers: {
        'train-id': '  team-beta  ',
      },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.trainId).toBe('team-beta')
  })

  it('accepts legacy x-train-id header for backward compatibility', async () => {
    const res = await app.request('/test', {
      headers: {
        'x-train-id': 'legacy-train',
      },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.trainId).toBe('legacy-train')
  })
})
