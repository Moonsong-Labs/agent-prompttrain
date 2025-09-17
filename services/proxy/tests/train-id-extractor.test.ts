import { beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { trainIdExtractorMiddleware } from '../src/middleware/train-id-extractor'

const TRAIN_HEADER = 'MSL-Train-Id'
const TRAIN_HEADER_LOWER = TRAIN_HEADER.toLowerCase()

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

  it('falls back to default train when header missing', async () => {
    const res = await app.request('/test')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.trainId).toBe('default')
  })

  it('extracts trainId from MSL-Train-Id header', async () => {
    const res = await app.request('/test', {
      headers: {
        [TRAIN_HEADER]: 'team-alpha',
      },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.trainId).toBe('team-alpha')
  })

  it('trims whitespace from header value', async () => {
    const res = await app.request('/test', {
      headers: {
        [TRAIN_HEADER]: '  team-beta  ',
      },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.trainId).toBe('team-beta')
  })

  it('treats header names case-insensitively', async () => {
    const res = await app.request('/test', {
      headers: {
        [TRAIN_HEADER_LOWER]: 'alpha-lowercase',
      },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.trainId).toBe('alpha-lowercase')
  })
})
