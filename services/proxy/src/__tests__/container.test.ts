import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { container, initializeContainer, disposeContainer } from '../container.js'

const originalStorageEnabled = process.env.STORAGE_ENABLED
const originalDatabaseUrl = process.env.DATABASE_URL

describe('Container lifecycle', () => {
  beforeEach(async () => {
    await disposeContainer()
    process.env.STORAGE_ENABLED = 'false'
    delete process.env.DATABASE_URL
  })

  afterEach(async () => {
    await disposeContainer()

    if (originalStorageEnabled === undefined) {
      delete process.env.STORAGE_ENABLED
    } else {
      process.env.STORAGE_ENABLED = originalStorageEnabled
    }

    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl
    }
  })

  it('throws when accessing services before initialization', () => {
    expect(() => container.getMetricsService()).toThrow('MetricsService not initialized')
  })

  it('initializes and cleans up services', async () => {
    await initializeContainer()

    expect(() => container.getMetricsService()).not.toThrow()

    await disposeContainer()

    expect(() => container.getMetricsService()).toThrow('MetricsService not initialized')
  })
})
