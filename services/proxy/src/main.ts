#!/usr/bin/env node

/**
 * Proxy Service Entry Point
 * Handles CLI arguments and starts the server
 */

import { serve } from '@hono/node-server'
import { createProxyApp } from './app.js'
import * as process from 'node:process'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as dotenvConfig } from 'dotenv'
import { tokenTracker } from './services/tokenTracker.js'
import { initializeContainer, disposeContainer } from './container.js'
import { closeRateLimitStores } from './middleware/rate-limit.js'
import { CredentialStatusService } from './services/CredentialStatusService.js'
import { CredentialManager } from './services/CredentialManager.js'
import { config } from '@agent-prompttrain/shared'
import { startAnalysisWorker } from './workers/ai-analysis/index.js'
import type { AnalysisWorker } from './workers/ai-analysis/AnalysisWorker.js'

// Load .env file from multiple possible locations
const __dirname = dirname(fileURLToPath(import.meta.url))
const envPaths = [
  join(process.cwd(), '.env'),
  join(process.cwd(), '.env.local'),
  join(dirname(process.argv[1] || ''), '.env'),
  // Also check in the root directory (two levels up from src/)
  join(__dirname, '..', '..', '..', '.env'),
  join(__dirname, '..', '..', '..', '.env.local'),
]

// Debug: show current working directory
if (process.env.DEBUG) {
  console.log(`Current working directory: ${process.cwd()}`)
  console.log(`Checking for .env files in:`, envPaths)
}

for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    const result = dotenvConfig({ path: envPath })
    if (!result.error) {
      console.log(`✓ Loaded configuration from ${envPath}`)
      break
    }
  }
}

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
  console.log(`Agent Prompt Project Service v${getPackageVersion()}

Usage: agent-prompttrain-proxy [options]

Options:
  -v, --version              Show version number
  -h, --help                 Show this help message
  -p, --port PORT            Set server port (default: 3000)
  -H, --host HOST            Set server hostname (default: 0.0.0.0)
  -e, --env-file FILE        Load environment from specific file

Environment Variables:
  PORT                        Server port (default: 3000)
  HOST                        Server hostname (default: 0.0.0.0)
  CREDENTIALS_DIR             Base directory containing account and client key files (default: credentials)
  TELEMETRY_ENDPOINT          URL to send telemetry data (optional)
  DEBUG                       Enable debug logging (default: false)
  DATABASE_URL                PostgreSQL connection string (for storage)
  STORAGE_ENABLED             Enable request/response storage (default: false)
  SLACK_WEBHOOK_URL           Slack webhook URL for notifications (optional)
  SLACK_CHANNEL               Slack channel override (optional)
  SLACK_USERNAME              Slack bot username (default: Agent Prompt Project)
  SLACK_ICON_EMOJI            Slack bot icon (default: :robot_face:)
  SLACK_ENABLED               Enable/disable Slack notifications (default: false)

Examples:
  agent-prompttrain-proxy
  agent-prompttrain-proxy --port 8080
  agent-prompttrain-proxy --host localhost --port 3000
  agent-prompttrain-proxy --env-file .env.production
  PORT=8787 HOST=127.0.0.1 agent-prompttrain-proxy

Note: The proxy automatically loads .env file from the current directory.
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
let port = parseInt(process.env.PORT || '3000', 10)
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
  let analysisWorker: AnalysisWorker | null = null

  try {
    await initializeContainer()

    // Print proxy configuration
    console.log(`Agent Prompt Project Service v${getPackageVersion()}`)
    console.log('Mode: passthrough (direct proxy to Claude API)')
    console.log('Target: Claude API (https://api.anthropic.com)')

    // Show credential directory configuration
    if (process.env.CREDENTIALS_DIR) {
      console.log(`✓ Credential directory: ${process.env.CREDENTIALS_DIR}`)
    } else {
      console.log('✓ Credential directory: credentials (default)')
    }

    if (process.env.TELEMETRY_ENDPOINT) {
      console.log(`✓ Telemetry: ${process.env.TELEMETRY_ENDPOINT}`)
    }

    // Show Slack configuration if enabled
    if (process.env.SLACK_WEBHOOK_URL) {
      console.log('\nSlack Integration:')
      console.log(`  - Webhook: Configured`)
      if (process.env.SLACK_CHANNEL) {
        console.log(`  - Channel: ${process.env.SLACK_CHANNEL}`)
      }
      if (process.env.SLACK_USERNAME) {
        console.log(`  - Username: ${process.env.SLACK_USERNAME}`)
      }
      console.log(`  - Enabled: ${process.env.SLACK_ENABLED !== 'false' ? 'Yes' : 'No'}`)
    }

    // Show storage configuration
    if (
      process.env.STORAGE_ENABLED === 'true' &&
      (process.env.DATABASE_URL || process.env.DB_HOST)
    ) {
      console.log('\nStorage:')
      console.log(`  - Enabled: Yes`)
      console.log(
        `  - Database: ${process.env.DATABASE_URL ? 'URL configured' : 'Host configured'}`
      )
    }

    // Show Spark API configuration
    console.log('\nSpark API:')
    if (process.env.SPARK_API_KEY) {
      console.log('  - Enabled: Yes')
      console.log(`  - URL: ${process.env.SPARK_API_URL || 'http://localhost:8000 (default)'}`)
      console.log('  - API Key: Configured')
    } else {
      console.log('  - Enabled: No')
      console.log('  - Reason: SPARK_API_KEY not set')
    }

    // Show AI Analysis configuration
    console.log('\nAI Analysis:')
    if (process.env.AI_WORKER_ENABLED === 'true') {
      if (process.env.GEMINI_API_KEY) {
        console.log('  - Enabled: Yes')
        console.log(
          `  - Model: ${process.env.GEMINI_MODEL_NAME || 'gemini-2.0-flash-exp (default)'}`
        )
        console.log('  - API Key: Configured')
      } else {
        console.log('  - Enabled: No')
        console.log('  - Reason: GEMINI_API_KEY not set')
      }
    } else {
      console.log('  - Enabled: No')
      console.log('  - Reason: AI_WORKER_ENABLED not set to true')
    }

    // Check all credentials at startup
    console.log('\nChecking credentials...')
    const credentialService = new CredentialStatusService()
    const credentialStatuses = await credentialService.checkAllCredentials()

    if (credentialStatuses.length > 0) {
      const statusLines = credentialService.formatStatusForLogging(credentialStatuses)
      statusLines.forEach(line => console.log(line))
    } else {
      console.log('  No credential files found')
    }

    // Start credential manager periodic cleanup for long-running service
    const credentialManager = new CredentialManager()
    credentialManager.startPeriodicCleanup()

    // Start token usage tracking
    tokenTracker.startReporting(10000) // Report every 10 seconds

    // Start AI Analysis Worker
    try {
      analysisWorker = startAnalysisWorker()
      console.log('✓ AI Analysis Worker started')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log('✗ AI Analysis Worker not started:', message)
      console.log('  GEMINI_CONFIG.API_KEY:', process.env.GEMINI_API_KEY ? 'SET' : 'NOT SET')
      // Non-fatal - continue without analysis worker
    }

    // Create the app
    const app = await createProxyApp()

    // Start the server
    const server = serve({
      port: port,
      hostname: hostname,
      fetch: app.fetch,
    })

    // Set server timeout to be longer than the max request + retry time
    // This prevents the server from closing connections prematurely
    // Note: The Hono node server wraps the underlying Node.js server
    const serverTimeout = config.server.timeout

    // Access the underlying Node.js server if available
    if (server && 'timeout' in server && typeof (server as any).timeout === 'number') {
      ;(server as any).timeout = serverTimeout
      if ('headersTimeout' in server) {
        ;(server as any).headersTimeout = serverTimeout
      }
      console.log(
        `\n⏱️  Server timeout: ${serverTimeout}ms (${Math.floor(serverTimeout / 60000)} minutes)`
      )
    } else {
      console.log(`\n⏱️  Note: Server timeout configuration not applied (using framework defaults)`)
    }

    console.log(`\n✅ Server started successfully`)
    console.log(`🌐 Listening on http://${hostname}:${port}`)
    console.log(`📊 Token stats: http://${hostname}:${port}/token-stats`)
    console.log(`🔐 OAuth metrics: http://${hostname}:${port}/oauth-metrics`)

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
    const shutdown = async (signal: string) => {
      console.log(`\n${signal} received, shutting down gracefully...`)

      // Set a hard timeout to force exit if graceful shutdown hangs
      const forceExitTimeout = setTimeout(() => {
        console.error('Graceful shutdown timeout - forcing exit')
        process.exit(1)
      }, 10000) // 10 second total timeout

      try {
        // Print final token stats
        console.log('\nFinal token statistics:')
        tokenTracker.printStats()

        // Close server with timeout
        let serverClosed = false
        const serverCloseTimeout = setTimeout(() => {
          if (!serverClosed) {
            console.log('Server close timeout - forcing shutdown')
            process.exit(0)
          }
        }, 5000) // 5 second timeout

        server.close(() => {
          serverClosed = true
          clearTimeout(serverCloseTimeout)
          console.log('Server closed')
        })

        // Close rate limit stores
        closeRateLimitStores()

        // Stop credential manager cleanup
        credentialManager.stopPeriodicCleanup()

        // Stop analysis worker
        if (analysisWorker) {
          console.log('Stopping AI Analysis Worker...')
          await analysisWorker.stop()
          console.log('AI Analysis Worker stopped')
        }

        // Clean up container resources
        await disposeContainer()

        clearTimeout(forceExitTimeout)
        process.exit(0)
      } catch (error) {
        console.error('Error during shutdown:', error)
        clearTimeout(forceExitTimeout)
        process.exit(1)
      }
    }

    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGQUIT', () => shutdown('SIGQUIT'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('❌ Failed to start server:', message)
    try {
      await disposeContainer()
    } catch {
      // ignore cleanup errors during failed startup
    }
    process.exit(1)
  }
}

// Start the application
main()
