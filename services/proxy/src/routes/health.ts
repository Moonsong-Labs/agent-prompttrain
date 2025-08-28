import { Hono } from 'hono'
import { Pool } from 'pg'

interface HealthRouteOptions {
  pool?: Pool
  version?: string
}

export function createHealthRoutes(options: HealthRouteOptions): Hono {
  const app = new Hono()

  app.get('/', async c => {
    const health: any = {
      status: 'healthy',
      service: 'agent-prompttrain',
      version: options.version || 'unknown',
      timestamp: new Date().toISOString(),
    }

    // Check database connection if available
    if (options.pool) {
      try {
        await options.pool.query('SELECT 1')
        health.database = 'connected'
      } catch (_error) {
        health.status = 'unhealthy'
        health.database = 'disconnected'
      }
    }

    return c.json(health, health.status === 'healthy' ? 200 : 503)
  })

  app.get('/ready', async c => {
    const ready = {
      ready: true,
      timestamp: new Date().toISOString(),
    }

    // Check if database is ready if configured
    if (options.pool) {
      try {
        await options.pool.query('SELECT 1')
      } catch (_error) {
        ready.ready = false
        return c.json(ready, 503)
      }
    }

    return c.json(ready)
  })

  app.get('/live', c => {
    return c.json({
      alive: true,
      timestamp: new Date().toISOString(),
    })
  })

  return app
}
