import { container } from '../container.js'

/**
 * Export the database pool from the service container
 */
export const db = container.getPool()
