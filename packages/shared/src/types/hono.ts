/**
 * Hono application type definitions
 */

import type { Pool } from 'pg'

// Dashboard service environment
export interface DashboardEnv {
  Variables: {
    apiClient?: any // ProxyApiClient from dashboard service
    trainId?: string
  }
}

// Proxy service environment
export interface ProxyEnv {
  Variables: {
    pool?: Pool
    trainId?: string
  }
}
