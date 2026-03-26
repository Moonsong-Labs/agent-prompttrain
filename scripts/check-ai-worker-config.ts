#!/usr/bin/env bun
/**
 * Check AI Analysis Worker configuration
 */

import { config } from 'dotenv'

// Load environment variables
config()

console.log('AI Analysis Worker Configuration:')
console.log('================================')
console.log(`AI_WORKER_ENABLED: ${process.env.AI_WORKER_ENABLED}`)
console.log(`AI_ANALYSIS_PROJECT_ID: ${process.env.AI_ANALYSIS_PROJECT_ID || 'Not set'}`)
console.log(
  `ANTHROPIC_ANALYSIS_MODEL: ${process.env.ANTHROPIC_ANALYSIS_MODEL || 'claude-opus-4-6 (default)'}`
)
console.log(
  `AI_ANALYSIS_API_KEY: ${process.env.AI_ANALYSIS_API_KEY ? 'Set' : 'Not set (optional)'}`
)

console.log('\nWorker Configuration:')
console.log(`Poll Interval: ${process.env.AI_WORKER_POLL_INTERVAL_MS || '5000 (default)'}ms`)
console.log(`Max Concurrent Jobs: ${process.env.AI_WORKER_MAX_CONCURRENT_JOBS || '3 (default)'}`)

const isEnabled = process.env.AI_WORKER_ENABLED === 'true'
const hasProjectId = !!process.env.AI_ANALYSIS_PROJECT_ID

if (isEnabled && !hasProjectId) {
  console.log('\n❌ ERROR: AI_WORKER_ENABLED is true but AI_ANALYSIS_PROJECT_ID is not set!')
  console.log('The Analysis Worker will NOT start.')
  console.log('\nTo fix this:')
  console.log('1. Create a dedicated project in the dashboard for AI analysis')
  console.log('2. Link an account with Claude API access to the project')
  console.log('3. Add the project ID to .env: AI_ANALYSIS_PROJECT_ID=your-project-id')
  console.log('4. Or disable the worker: AI_WORKER_ENABLED=false')
} else if (isEnabled && hasProjectId) {
  console.log('\n✅ AI Analysis Worker is properly configured and will start.')
  console.log('   Requests will be routed through the local proxy using the configured project.')
  console.log('\nWhen you run "bun run dev", you should see:')
  console.log('  ✓ AI Analysis Worker started')
} else {
  console.log('\n⚠️  AI Analysis Worker is disabled.')
  console.log('\nTo enable:')
  console.log('1. Set AI_WORKER_ENABLED=true in .env')
  console.log('2. Create a dedicated project and set AI_ANALYSIS_PROJECT_ID in .env')
}
