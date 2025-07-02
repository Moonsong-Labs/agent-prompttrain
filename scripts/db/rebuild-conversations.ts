#!/usr/bin/env bun
/**
 * IMPORTANT: This script should NOT implement any business logic.
 * All it should do is fetch requests and use StorageAdapter to process them,
 * just like the proxy does when it receives an HTTP request.
 *
 * The StorageAdapter is the single source of truth for conversation linking logic.
 */

import { Pool } from 'pg'
import { config } from 'dotenv'
import { createLoggingPool } from './utils/create-logging-pool.js'
import { enableSqlLogging } from '../../services/proxy/src/utils/sql-logger.js'
import { StorageAdapter } from '../../services/proxy/src/storage/StorageAdapter.js'
import { generateConversationId } from '@claude-nexus/shared'

// Load environment variables
config()

// Batch size for processing requests (default 1000 ~= 1GB memory)
const BATCH_SIZE = 1000

// Memory monitoring utilities
const formatMemoryUsage = () => {
  const used = process.memoryUsage()
  return {
    heap: `${Math.round(used.heapUsed / 1024 / 1024)}MB / ${Math.round(used.heapTotal / 1024 / 1024)}MB`,
    heapUsed: used.heapUsed,
    external: Math.round(used.external / 1024 / 1024),
    rss: Math.round(used.rss / 1024 / 1024),
  }
}

interface DbRequest {
  request_id: string
  domain: string
  timestamp: Date
  conversation_id: string | null
  branch_id: string | null
  current_message_hash: string | null
  parent_message_hash: string | null
  system_hash: string | null
  parent_request_id: string | null
  body: any
  message_count: number | null
  created_at: Date
  is_subtask: boolean | null
  parent_task_request_id: string | null
}

/**
 * Rebuilds conversation and branch IDs for all requests
 * This script recalculates conversation grouping based on message parent hashes
 * and includes subtask detection.
 */
class ConversationRebuilderFinal {
  private pool: Pool
  private storageAdapter: StorageAdapter
  private dryRun: boolean
  private domainFilter: string | null
  private limit: number | null
  private debugMode: boolean
  private requestIds: string[] | null

  constructor(
    pool: Pool,
    dryRun: boolean,
    domainFilter: string | null,
    limit: number | null,
    debugMode: boolean,
    requestIds: string[] | null
  ) {
    this.pool = pool
    this.dryRun = dryRun
    this.domainFilter = domainFilter
    this.limit = limit
    this.debugMode = debugMode
    this.requestIds = requestIds

    // Enable SQL logging on the pool if debug mode is enabled
    const loggingPool = enableSqlLogging(this.pool, {
      logQueries: this.debugMode,
      logSlowQueries: true,
      slowQueryThreshold: 5000,
      logStackTrace: false,
    })

    // Create StorageAdapter which handles all conversation linking logic
    this.storageAdapter = new StorageAdapter(loggingPool)
  }

  async rebuild() {
    const initialMemory = formatMemoryUsage().heapUsed

    try {
      console.log(`\nStarting conversation rebuild (final version)...`)
      console.log(`Using ConversationLinker with request-specific timestamps`)
      console.log(`Processing in batches of ${BATCH_SIZE} requests to optimize memory usage`)
      console.log(
        `\nInitial memory: Heap ${formatMemoryUsage().heap}, RSS ${formatMemoryUsage().rss}MB\n`
      )

      // Track overall progress
      let totalProcessed = 0
      let totalUpdates = 0
      let totalSubtasksDetected = 0
      let batchNumber = 0

      while (true) {
        batchNumber++
        const batchStartTime = Date.now()

        // Load batch of requests
        console.log(`\n[Batch ${batchNumber}] Loading requests...`)
        const requests = await this.loadRequestsBatch(totalProcessed)

        if (requests.length === 0) {
          break
        }

        console.log(`[Batch ${batchNumber}] Found ${requests.length} requests to process`)

        const updates: Array<{
          requestId: string
          conversationId: string
          branchId: string
          parentMessageHash: string | null
          currentMessageHash: string
          systemHash: string | null
          parentRequestId: string | null
          isSubtask: boolean
          parentTaskRequestId: string | null
        }> = []

        let batchSubtasks = 0

        for (const request of requests) {
          try {
            if (this.debugMode && totalProcessed % 100 === 0) {
              console.log(
                `\n   Processing request ${request.request_id} from ${request.timestamp.toISOString()}`
              )
            }

            // Use StorageAdapter to determine conversation linkage
            // Pass the request's timestamp for historical processing
            const linkingResult = await this.storageAdapter.linkConversation(
              request.domain,
              request.body.messages,
              request.body.system,
              request.request_id,
              request.timestamp // Historical timestamp from the request
            )

            // Log debug info if subtask detected
            if (linkingResult.isSubtask && this.debugMode) {
              console.log(
                `   ✓ Detected subtask: parent=${linkingResult.parentTaskRequestId}, sequence=${linkingResult.subtaskSequence}`
              )
              batchSubtasks++
            }

            // If no conversation ID was found, keep the existing one or generate a new one if none exists
            const conversationId =
              linkingResult.conversationId || request.conversation_id || generateConversationId()

            // Check if update is needed
            const needsUpdate =
              request.conversation_id !== conversationId ||
              request.branch_id !== linkingResult.branchId ||
              request.current_message_hash !== linkingResult.currentMessageHash ||
              request.parent_message_hash !== linkingResult.parentMessageHash ||
              request.system_hash !== linkingResult.systemHash ||
              request.parent_request_id !== linkingResult.parentRequestId ||
              request.is_subtask !== linkingResult.isSubtask ||
              request.parent_task_request_id !== linkingResult.parentTaskRequestId

            if (needsUpdate) {
              updates.push({
                requestId: request.request_id,
                conversationId: conversationId,
                branchId: linkingResult.branchId,
                parentMessageHash: linkingResult.parentMessageHash,
                currentMessageHash: linkingResult.currentMessageHash,
                systemHash: linkingResult.systemHash,
                parentRequestId: linkingResult.parentRequestId,
                isSubtask: linkingResult.isSubtask,
                parentTaskRequestId: linkingResult.parentTaskRequestId || null,
              })
            }
          } catch (error) {
            console.error(`   ❌ Failed to process request ${request.request_id}:`, error)
          }
        }

        // Apply updates if not in dry run mode
        if (!this.dryRun && updates.length > 0) {
          await this.applyUpdates(updates)
        }

        // Update overall counters
        totalProcessed += requests.length
        totalUpdates += updates.length
        totalSubtasksDetected += batchSubtasks

        // Report batch completion
        const batchDuration = Date.now() - batchStartTime
        const currentMemory = formatMemoryUsage()
        const memoryDelta = Math.round((currentMemory.heapUsed - initialMemory) / 1024 / 1024)

        console.log(`[Batch ${batchNumber}] Complete:`)
        console.log(`   Processed: ${requests.length} requests`)
        console.log(`   Updates needed: ${updates.length}`)
        console.log(`   Subtasks detected: ${batchSubtasks}`)
        console.log(`   Memory: Heap ${currentMemory.heap} (Δ+${memoryDelta}MB from baseline)`)
        console.log(`Overall progress: ${totalProcessed} requests processed`)

        // Stop if we've hit the limit
        if (this.limit && totalProcessed >= this.limit) {
          break
        }
      }

      console.log('\n=== Final Summary ===')
      console.log(`Total batches processed: ${batchNumber}`)
      console.log(`Total requests processed: ${totalProcessed}`)
      console.log(`Total updates applied: ${this.dryRun ? 0 : totalUpdates}`)
      console.log(`Total subtasks detected: ${totalSubtasksDetected}`)

      const finalMemory = formatMemoryUsage()
      const totalMemoryDelta = Math.round((finalMemory.heapUsed - initialMemory) / 1024 / 1024)
      console.log(
        `\nFinal memory: Heap ${finalMemory.heap} (Δ+${totalMemoryDelta}MB from baseline)`
      )

      // Show final statistics
      await this.showFinalStats()
    } catch (error) {
      console.error('Rebuild failed:', error)
      throw error
    } finally {
      await this.storageAdapter.close()
    }
  }

  private async loadRequestsBatch(offset: number): Promise<DbRequest[]> {
    let query = `
      SELECT 
        r.request_id,
        r.domain,
        r.timestamp,
        r.conversation_id,
        r.branch_id,
        r.current_message_hash,
        r.parent_message_hash,
        r.system_hash,
        r.parent_request_id,
        r.body,
        r.message_count,
        r.created_at,
        r.is_subtask,
        r.parent_task_request_id
      FROM api_requests r
      WHERE r.method = 'POST'
        AND r.request_type = 'inference'
    `

    const params: any[] = []

    // Apply request ID filter if specified
    if (this.requestIds && this.requestIds.length > 0) {
      query += ` AND r.request_id = ANY($${params.length + 1})`
      params.push(this.requestIds)
    } else {
      // Apply domain filter only if not filtering by request IDs
      if (this.domainFilter) {
        query += ` AND r.domain = $${params.length + 1}`
        params.push(this.domainFilter)
      }
    }

    // Order and pagination
    query += ` ORDER BY r.timestamp, r.request_id`
    query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
    params.push(Math.min(BATCH_SIZE, this.limit ? this.limit - offset : BATCH_SIZE))
    params.push(offset)

    const result = await this.pool.query(query, params)
    return result.rows
  }

  private async applyUpdates(
    updates: Array<{
      requestId: string
      conversationId: string
      branchId: string
      parentMessageHash: string | null
      currentMessageHash: string
      systemHash: string | null
      parentRequestId: string | null
      isSubtask: boolean
      parentTaskRequestId: string | null
    }>
  ) {
    const query = `
      UPDATE api_requests
      SET 
        conversation_id = $2,
        branch_id = $3,
        parent_message_hash = $4,
        current_message_hash = $5,
        system_hash = $6,
        parent_request_id = $7,
        is_subtask = $8,
        parent_task_request_id = $9
      WHERE request_id = $1
    `

    for (const update of updates) {
      await this.pool.query(query, [
        update.requestId,
        update.conversationId,
        update.branchId,
        update.parentMessageHash,
        update.currentMessageHash,
        update.systemHash,
        update.parentRequestId,
        update.isSubtask,
        update.parentTaskRequestId,
      ])
    }
  }

  private async showFinalStats() {
    console.log('\n3. Final statistics:')

    const statsQuery = `
      SELECT 
        COUNT(DISTINCT conversation_id) as total_conversations,
        COUNT(DISTINCT CONCAT(conversation_id, ':', branch_id)) as total_branches,
        COUNT(*) as total_requests,
        COUNT(*) FILTER (WHERE branch_id != 'main') as branch_requests,
        COUNT(*) FILTER (WHERE parent_message_hash IS NOT NULL) as requests_with_parent,
        COUNT(*) FILTER (WHERE is_subtask = true) as subtask_requests
      FROM api_requests
      WHERE method = 'POST' 
        AND request_type = 'inference'
        AND conversation_id IS NOT NULL
    `

    const stats = await this.pool.query(statsQuery)
    const row = stats.rows[0]

    console.log(`   Total conversations: ${row.total_conversations}`)
    console.log(`   Total branches: ${row.total_branches}`)
    console.log(`   Total requests with conversations: ${row.total_requests}`)
    console.log(`   Requests on non-main branches: ${row.branch_requests}`)
    console.log(`   Requests with parent links: ${row.requests_with_parent}`)
    console.log(`   Subtask requests: ${row.subtask_requests}`)
  }

  async close() {
    await this.storageAdapter.close()
  }
}

// Show help information
function showHelp() {
  console.log(`
Usage: bun run scripts/db/rebuild-conversations.ts [options]

Rebuilds conversation and branch IDs for all requests by reprocessing them through
the same StorageAdapter pipeline used by the proxy. This script does NOT implement
any business logic - it simply fetches requests and processes them through the
standard conversation linking logic.

Options:
  --help              Show this help message
  --execute           Actually apply changes (default is dry run)
  --domain <domain>   Filter by specific domain
  --limit <number>    Limit number of requests to process
  --requests <ids>    Process specific request IDs (comma-separated)
  --debug             Enable debug logging and SQL query logging
  --yes               Skip confirmation prompt (auto-accept)

Examples:
  # Dry run on all requests (shows what would change)
  bun run scripts/db/rebuild-conversations.ts

  # Actually apply changes to all requests
  bun run scripts/db/rebuild-conversations.ts --execute --yes

  # Process specific domain with debug output
  bun run scripts/db/rebuild-conversations.ts --domain example.com --debug

  # Process specific requests
  bun run scripts/db/rebuild-conversations.ts --requests "id1,id2,id3" --execute

  # Limit processing to first 100 requests
  bun run scripts/db/rebuild-conversations.ts --limit 100 --execute

Note: This script uses the StorageAdapter to ensure consistency with the proxy's
conversation linking logic, including subtask detection and branch management.
  `)
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2)

  // Check for help flag first
  if (args.includes('--help') || args.includes('-h')) {
    showHelp()
    process.exit(0)
  }

  const flags = {
    dryRun: !args.includes('--execute'),
    domain: null as string | null,
    limit: null as number | null,
    debug: args.includes('--debug'),
    yes: args.includes('--yes'),
    requests: null as string[] | null,
  }

  // Parse domain flag
  const domainIndex = args.indexOf('--domain')
  if (domainIndex !== -1 && args[domainIndex + 1]) {
    flags.domain = args[domainIndex + 1]
  }

  // Parse limit flag
  const limitIndex = args.indexOf('--limit')
  if (limitIndex !== -1 && args[limitIndex + 1]) {
    flags.limit = parseInt(args[limitIndex + 1], 10)
    if (isNaN(flags.limit) || flags.limit <= 0) {
      console.error('❌ Invalid limit value. Must be a positive number.')
      process.exit(1)
    }
  }

  // Parse requests flag (comma-separated list)
  const requestsIndex = args.indexOf('--requests')
  if (requestsIndex !== -1 && args[requestsIndex + 1]) {
    flags.requests = args[requestsIndex + 1]
      .split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0)
    if (flags.requests.length === 0) {
      console.error('❌ No valid request IDs provided.')
      process.exit(1)
    }
  }

  return flags
}

// Main function
async function main() {
  console.log('===========================================')
  console.log('Conversation Rebuild Script (Final Version)')
  console.log('===========================================')
  console.log('This version properly handles historical timestamps')

  const flags = parseArgs()

  // Show warnings
  console.log('\n⚠️  WARNING: This will update existing records in the database')
  console.log('It is recommended to backup your database before proceeding')

  // Show current settings
  if (flags.dryRun) {
    console.log('\n🔍 DRY RUN MODE - No changes will be made')
  } else {
    console.log('\n✏️  EXECUTE MODE - Changes WILL be applied')
  }

  if (flags.requests) {
    console.log(`🎯 Processing specific requests: ${flags.requests.join(', ')}`)
  } else if (flags.domain) {
    console.log(`🌐 Filtering by domain: ${flags.domain}`)
  }

  if (flags.limit) {
    console.log(`📊 Limiting to ${flags.limit} requests`)
  }

  if (flags.debug) {
    console.log('🐛 Debug mode enabled')
  }

  if (flags.yes) {
    console.log('✅ Auto-accepting warning prompt (--yes flag provided)')
  }

  // Show database info
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    console.error('\n❌ DATABASE_URL environment variable is not set')
    process.exit(1)
  }

  // Parse database name from URL
  const dbName = dbUrl.split('/').pop()?.split('?')[0] || 'unknown'
  console.log(`🗄️  Database: ${dbName}`)

  // Confirm with user unless --yes flag is provided
  if (!flags.yes && !flags.dryRun) {
    console.log('\nDo you want to continue? (yes/no)')
    const answer = await new Promise<string>(resolve => {
      process.stdin.once('data', data => {
        resolve(data.toString().trim().toLowerCase())
      })
    })

    if (answer !== 'yes' && answer !== 'y') {
      console.log('❌ Operation cancelled')
      process.exit(0)
    }
  }

  // Create database pool
  const pool = createLoggingPool(dbUrl, { max: 10 })

  try {
    const rebuilder = new ConversationRebuilderFinal(
      pool,
      flags.dryRun,
      flags.domain,
      flags.limit,
      flags.debug,
      flags.requests
    )
    await rebuilder.rebuild()
    console.log('\n✅ Rebuild completed successfully!')
  } catch (error) {
    console.error('\n❌ Rebuild failed:', error)
    process.exit(1)
  } finally {
    await pool.end()
    // Ensure the process exits cleanly after pool is closed
    process.exit(0)
  }
}

// Run the script
main().catch(error => {
  console.error('Unexpected error:', error)
  process.exit(1)
})
