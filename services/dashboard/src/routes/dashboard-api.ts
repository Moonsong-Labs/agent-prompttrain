import { Hono } from 'hono'
import { ProxyApiClient } from '../services/api-client.js'

// Import route modules
import { authRoutes } from './auth.js'
import { overviewRoutes } from './overview.js'
import { requestsRoutes } from './requests.js'
import { requestDetailsRoutes } from './request-details.js'
import { tokenUsageRoutes } from './token-usage.js'
import { requestUsageRoutes } from './request-usage.js'
import { promptsRoute } from './prompts.js'
import { promptDetailRoute } from './prompt-detail.js'

export const dashboardRoutes = new Hono<{
  Variables: {
    apiClient?: ProxyApiClient
    trainId?: string
  }
}>()

// Mount routes
dashboardRoutes.route('/', authRoutes)
dashboardRoutes.route('/', overviewRoutes)
dashboardRoutes.route('/', requestsRoutes)
dashboardRoutes.route('/', requestDetailsRoutes)
dashboardRoutes.route('/', tokenUsageRoutes)
dashboardRoutes.route('/', requestUsageRoutes)
dashboardRoutes.route('/prompts', promptsRoute)
dashboardRoutes.route('/prompts', promptDetailRoute)
