#!/usr/bin/env node

import * as process from 'node:process'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as dotenvConfig } from 'dotenv'

// Load .env file from multiple possible locations BEFORE importing anything else
const __dirname = dirname(fileURLToPath(import.meta.url))
const envPaths = [
  join(process.cwd(), '.env'),
  join(process.cwd(), '.env.local'),
  join(dirname(process.argv[1] || ''), '.env'),
  // Check parent directories for monorepo setup
  join(__dirname, '..', '..', '..', '.env'), // Root directory
  join(__dirname, '..', '..', '.env'), // Services directory
  join(__dirname, '..', '.env'), // Dashboard directory
]

for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    const result = dotenvConfig({ path: envPath })
    if (!result.error) {
      console.log(`Loaded configuration from ${envPath}`)
      break
    }
  }
}

// Now import other modules after env is loaded
import { serve } from '@hono/node-server'
import { createDashboardApp } from './app.js'
import { container } from './container.js'

// Parse command line arguments
const args = process.argv.slice(2)

// Check for --env-file argument
const envFileIndex = args.findIndex(arg => arg === '-e' || arg === '--env-file')
if (envFileIndex !== -1 && args[envFileIndex + 1]) {
  const envFile = args[envFileIndex + 1]
  if (existsSync(envFile)) {
    const result = dotenvConfig({ path: envFile })
    if (result.error) {
      console.error(`Error loading env file ${envFile}: ${result.error.message}`)
      process.exit(1)
    } else {
      console.log(`Loaded configuration from ${envFile}`)
    }
  } else {
    console.error(`Error: Environment file not found: ${envFile}`)
    process.exit(1)
  }
}

// Get package version
function getPackageVersion(): string {
  try {
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = dirname(__filename)

    // Try multiple possible paths for package.json
    const possiblePaths = [
      join(__dirname, '..', 'package.json'), // Development
      join(__dirname, 'package.json'), // npm install
      join(__dirname, '..', '..', 'package.json'), // Other scenarios
    ]

    for (const packagePath of possiblePaths) {
      try {
        const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
        return packageJson.version
      } catch {
        continue
      }
    }

    return 'unknown'
  } catch {
    return 'unknown'
  }
}

function showHelp() {
  console.log(`Agent PromptTrain Dashboard Service v${getPackageVersion()}

Usage: agent-prompttrain-dashboard [options]

Options:
  -v, --version              Show version number
  -h, --help                 Show this help message
  -p, --port PORT            Set server port (default: 3001)
  -H, --host HOST            Set server hostname (default: 0.0.0.0)
  -e, --env-file FILE        Load environment from specific file

Environment Variables:
  PORT                        Server port (default: 3001)
  HOST                        Server hostname (default: 0.0.0.0)
  DASHBOARD_API_KEY           API key for dashboard access (optional - omit for read-only mode)
  DATABASE_URL                PostgreSQL connection string (required)
  PROXY_API_URL               URL of the proxy service for real-time updates (optional)

Examples:
  agent-prompttrain-dashboard
  agent-prompttrain-dashboard --port 8080
  agent-prompttrain-dashboard --host localhost --port 3001
  agent-prompttrain-dashboard --env-file .env.production

Dashboard Access:
  If DASHBOARD_API_KEY is set, the dashboard requires authentication.
  If DASHBOARD_API_KEY is not set, the dashboard runs in read-only mode.
  Access the dashboard at http://localhost:3001/

Note: The dashboard automatically loads .env file from the current directory.
Use --env-file to specify a different configuration file.`)
}

if (args.includes('-v') || args.includes('--version')) {
  console.log(getPackageVersion())
  process.exit(0)
}

if (args.includes('-h') || args.includes('--help')) {
  showHelp()
  process.exit(0)
}

// Parse command line options
let port = parseInt(process.env.PORT || '3001', 10)
let hostname = process.env.HOST || '0.0.0.0'

const portIndex = args.findIndex(arg => arg === '-p' || arg === '--port')
if (portIndex !== -1 && args[portIndex + 1]) {
  port = parseInt(args[portIndex + 1], 10)
  if (isNaN(port)) {
    console.error('Error: Invalid port number')
    process.exit(1)
  }
}

const hostIndex = args.findIndex(arg => arg === '-H' || arg === '--host')
if (hostIndex !== -1 && args[hostIndex + 1]) {
  hostname = args[hostIndex + 1]
}

// Main function
async function main() {
  try {
    // Note: DASHBOARD_API_KEY is now optional - if not set, dashboard runs in read-only mode

    if (!process.env.DATABASE_URL && !process.env.DB_HOST) {
      console.error('❌ Error: DATABASE_URL or DB_* environment variables are required')
      process.exit(1)
    }

    // Print dashboard configuration
    console.log(`Agent PromptTrain Dashboard Service v${getPackageVersion()}`)
    console.log('Mode: Web Dashboard for monitoring and analytics')

    console.log('\nConfiguration:')
    console.log(
      `  - Mode: ${process.env.DASHBOARD_API_KEY ? 'Authenticated (read-write)' : 'Read-only (no auth required)'}`
    )
    console.log(`  - Database: ${process.env.DATABASE_URL ? 'URL configured' : 'Host configured'}`)

    if (process.env.PROXY_API_URL) {
      console.log(`  - Proxy Service: ${process.env.PROXY_API_URL}`)
    }

    // Create the app
    const app = await createDashboardApp()

    // Start the server
    const server = serve({
      port: port,
      hostname: hostname,
      fetch: app.fetch,
    })

    console.log(`\n✅ Server started successfully`)
    console.log(`🌐 Listening on http://${hostname}:${port}`)
    console.log(`📈 Dashboard: http://${hostname}:${port}/`)

    // Get network interfaces to show accessible URLs
    try {
      const os = await import('os')
      const interfaces = os.networkInterfaces()
      const addresses = []

      for (const name in interfaces) {
        for (const iface of interfaces[name] || []) {
          if (iface.family === 'IPv4' && !iface.internal) {
            addresses.push(`http://${iface.address}:${port}`)
          }
        }
      }

      if (addresses.length > 0) {
        console.log('\nNetwork interfaces:')
        addresses.forEach(addr => console.log(`  ${addr}`))
      }
    } catch {
      // Ignore if we can't get network interfaces
    }

    console.log('\nPress Ctrl+C to stop the server')

    // Handle graceful shutdown
    const _shutdown = async (signal: string) => {
      console.log(`\n${signal} received, shutting down gracefully...`)

      // Close server
      server.close(() => {
        console.log('Server closed')
      })

      // Clean up container resources
      await container.cleanup()

      process.exit(0)
    }

    // Signal handlers - commented out due to bundling issues
    // TODO: Fix process.on not working after bundling
    // process.on('SIGINT', () => shutdown('SIGINT'))
    // process.on('SIGTERM', () => shutdown('SIGTERM'))
    // process.on('SIGQUIT', () => shutdown('SIGQUIT'))
  } catch (error: any) {
    console.error('❌ Failed to start server:', error.message)
    process.exit(1)
  }
}

// Start the application
main()
